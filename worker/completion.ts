// Names for the editor's completion: the current database's tables, views, procedures, functions
// and synonyms, plus the system views and functions under sys and INFORMATION_SCHEMA; the columns
// and foreign keys of some of them.
import type { Connection } from 'tedious'
import type { CompletionForeignKey, CompletionNames, NameKind, ObjectColumns, ObjectName } from '../src/protocol.ts'
import { declaredType, isPrimaryKeySql, lit, typeNameSql } from './metadata.ts'
import { queryRows } from './mssql.ts'

/** At most this many objects; the rest are left out (`truncated`). */
export const MAX_NAMES = 20_000
/** And at most this many bytes of names, to stay well under Orca's 1 MiB answer limit. */
const MAX_BYTES = 800_000

const KINDS: Record<string, NameKind> = { U: 't', V: 'v', P: 'p', PC: 'p', FN: 'f', FS: 'f', IF: 'f', TF: 'f', FT: 'f', SN: 's' }

export async function completionNames(connection: Connection): Promise<CompletionNames> {
  const [info] = await queryRows(
    connection,
    // Object names compare by the catalog's collation, which can differ from the database's
    // default (contained databases, Azure SQL Database's CATALOG_COLLATION): compare a catalog
    // column ('sys' from sys.schemas), so its collation decides, not a literal's.
    `SELECT SCHEMA_NAME() AS default_schema, DB_NAME() AS database_name,
            (SELECT CAST(CASE WHEN LOWER(name) = UPPER(name) THEN 0 ELSE 1 END AS bit)
               FROM sys.schemas WHERE schema_id = SCHEMA_ID('sys')) AS case_sensitive`
  )
  const defaultSchema = String(info?.default_schema ?? '')
  const database = String(info?.database_name ?? '')
  // User objects first (the default schema's before the others), so a cut keeps what matters most.
  const rows = await queryRows(
    connection,
    `SELECT TOP (${MAX_NAMES + 1}) s.name AS schema_name, o.name, RTRIM(o.type) AS type
       FROM (SELECT schema_id, name, type, 0 AS system FROM sys.objects
              WHERE is_ms_shipped = 0 AND type IN ('U','V','P','PC','FN','FS','IF','TF','FT','SN')
             UNION ALL
             SELECT schema_id, name, type, 1 FROM sys.system_objects
              WHERE type IN ('V','FN','IF','TF') AND schema_id IN (SCHEMA_ID('sys'), SCHEMA_ID('INFORMATION_SCHEMA'))) o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      ORDER BY o.system, CASE WHEN s.name = SCHEMA_NAME() THEN 0 ELSE 1 END, s.name, o.name`
  )
  const schemas = new Map<string, [string, NameKind][]>()
  if (defaultSchema) schemas.set(defaultSchema, [])
  let truncated = rows.length > MAX_NAMES
  let bytes = 0
  for (const row of rows.slice(0, MAX_NAMES)) {
    const schema = String(row.schema_name)
    const name = String(row.name)
    bytes += Buffer.byteLength(JSON.stringify(name)) + 8 // the pair's brackets, commas and kind
    if (bytes > MAX_BYTES) {
      truncated = true
      break
    }
    let objects = schemas.get(schema)
    if (!objects) {
      objects = []
      schemas.set(schema, objects)
      bytes += Buffer.byteLength(JSON.stringify(schema)) + 24
    }
    objects.push([name, KINDS[String(row.type)] ?? 't'])
  }
  return {
    database,
    defaultSchema,
    caseSensitive: info?.case_sensitive === true,
    schemas: [...schemas].map(([name, objects]) => ({ name, objects })),
    truncated
  }
}

/** At most this many objects per completion.columns request. */
export const MAX_COLUMN_OBJECTS = 50
/** At most this many columns of one object. */
export const MAX_COLUMNS = 1024
/** At most this many foreign keys of one object (held and referencing it), and this many bytes of
 *  them; the rest are left out. */
export const MAX_FOREIGN_KEYS = 256
const MAX_KEY_BYTES = 300_000

/** The columns and foreign keys of `objects` (validated: at most MAX_COLUMN_OBJECTS, names up to
 *  128 characters). Tables, views and table-valued functions; a synonym gives its base object's
 *  when that is in this database. Objects without columns are left out; those that did not fit in
 *  `maxBytes` are listed in `unsent`. */
export async function completionColumns(
  connection: Connection,
  objects: ObjectName[],
  maxBytes = MAX_BYTES
): Promise<{ objects: ObjectColumns[]; unsent: ObjectName[] }> {
  if (objects.length === 0) return { objects: [], unsent: [] }
  const requested = objects.map((o, i) => `(${i}, ${lit(o.schema)}, ${lit(o.name)})`).join(', ')
  // Names compare by the catalog columns' collation (a literal yields to a column). A synonym's
  // base object counts only without a server part and in this database.
  const found = `WITH requested AS (SELECT i, s, n FROM (VALUES ${requested}) v (i, s, n)),
     found AS (
       SELECT r.i, o.type, CASE WHEN o.type <> 'SN' THEN o.object_id
                                WHEN PARSENAME(sy.base_object_name, 4) IS NULL
                                 AND ISNULL(PARSENAME(sy.base_object_name, 3), DB_NAME()) = DB_NAME()
                                THEN OBJECT_ID(sy.base_object_name) END AS object_id
         FROM requested r
         JOIN sys.schemas s ON s.name = r.s
         JOIN sys.objects o ON o.schema_id = s.schema_id AND o.name = r.n
         LEFT JOIN sys.synonyms sy ON sy.object_id = o.object_id
        WHERE o.type IN ('U','V','IF','TF','FT','SN'))`
  const rows = await queryRows(
    connection,
    `${found},
     cols AS (
       SELECT f.i, f.type, f.object_id, c.column_id, c.name, ${typeNameSql()} AS type_name, c.max_length, c.precision, c.scale,
              ${isPrimaryKeySql()} AS is_pk, ROW_NUMBER() OVER (PARTITION BY f.i ORDER BY c.column_id) AS n
         FROM found f JOIN sys.columns c ON c.object_id = f.object_id)
     SELECT c.i, c.name, c.type_name, c.max_length, c.precision, c.scale, c.is_pk,
            CASE WHEN c.type = 'SN' AND c.n = 1 THEN bs.name END AS base_schema,
            CASE WHEN c.type = 'SN' AND c.n = 1 THEN bo.name END AS base_name
       FROM cols c
       JOIN sys.objects bo ON bo.object_id = c.object_id
       JOIN sys.schemas bs ON bs.schema_id = bo.schema_id
      WHERE c.n <= ${MAX_COLUMNS + 1} ORDER BY c.i, c.column_id`
  )
  const byIndex = new Map<number, ObjectColumns>()
  for (const row of rows) {
    const i = Number(row.i)
    let entry = byIndex.get(i)
    if (!entry) {
      entry = { ...objects[i], columns: [], truncated: false, foreignKeys: [] }
      if (row.base_name !== null) entry.base = { schema: String(row.base_schema), name: String(row.base_name) }
      byIndex.set(i, entry)
    }
    if (entry.columns.length >= MAX_COLUMNS) entry.truncated = true
    else entry.columns.push([String(row.name), declaredType(row), row.is_pk === true])
  }
  if (byIndex.size > 0) await addForeignKeys(connection, found, byIndex)
  // Whole objects only, in the order asked, while they fit: the rest are reported unsent (to be
  // asked for again), never as objects without columns. The first object with columns is always
  // sent, so every request makes progress; it fits: 1024 columns whose names and types are 128
  // ASCII characters each come to under 300 KB, and its foreign keys to at most MAX_KEY_BYTES,
  // well under the 1 MiB answer limit.
  const sent: ObjectColumns[] = []
  let bytes = 0
  for (let i = 0; i < objects.length; i++) {
    const entry = byIndex.get(i)
    if (!entry) continue // no columns
    const size = Buffer.byteLength(JSON.stringify(entry))
    if (sent.length > 0 && bytes + size > maxBytes) return { objects: sent, unsent: objects.slice(i) }
    sent.push(entry)
    bytes += size
  }
  return { objects: sent, unsent: [] }
}

/** Adds to each entry (by request index) the enabled foreign keys its object holds, then those it
 *  is referenced by: at most MAX_FOREIGN_KEYS and about MAX_KEY_BYTES each, a self-referencing one
 *  once. `found`
 *  is the WITH clause that resolves the requested objects. */
async function addForeignKeys(connection: Connection, found: string, byIndex: Map<number, ObjectColumns>): Promise<void> {
  const rows = await queryRows(
    connection,
    `${found},
     keys AS (
       SELECT f.i, k.object_id, k.parent_object_id, k.referenced_object_id,
              -- The keys an object holds first: each key is always in its own table's list, so a
              -- cut only drops keys that also come with the table holding them.
              ROW_NUMBER() OVER (PARTITION BY f.i ORDER BY CASE WHEN k.parent_object_id = f.object_id THEN 0 ELSE 1 END, k.object_id) AS n
         FROM found f
         JOIN sys.foreign_keys k ON (k.parent_object_id = f.object_id OR k.referenced_object_id = f.object_id) AND k.is_disabled = 0)
     SELECT k.i, k.n, ps.name AS from_schema, po.name AS from_name, rs.name AS to_schema, ro.name AS to_name,
            pc.name AS from_column, rc.name AS to_column
       FROM keys k
       JOIN sys.objects po ON po.object_id = k.parent_object_id
       JOIN sys.schemas ps ON ps.schema_id = po.schema_id
       JOIN sys.objects ro ON ro.object_id = k.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
       JOIN sys.foreign_key_columns kc ON kc.constraint_object_id = k.object_id
       JOIN sys.columns pc ON pc.object_id = kc.parent_object_id AND pc.column_id = kc.parent_column_id
       JOIN sys.columns rc ON rc.object_id = kc.referenced_object_id AND rc.column_id = kc.referenced_column_id
      WHERE k.n <= ${MAX_FOREIGN_KEYS}
      ORDER BY k.i, k.n, kc.constraint_column_id`
  )
  let current: { i: number; n: number; key: CompletionForeignKey } | undefined
  for (const row of rows) {
    const i = Number(row.i)
    const n = Number(row.n)
    if (current?.i !== i || current.n !== n) {
      current = {
        i,
        n,
        key: {
          from: { schema: String(row.from_schema), name: String(row.from_name) },
          to: { schema: String(row.to_schema), name: String(row.to_name) },
          columns: []
        }
      }
      byIndex.get(i)?.foreignKeys.push(current.key)
    }
    current.key.columns.push([String(row.from_column), String(row.to_column)])
  }
  for (const entry of byIndex.values()) {
    let bytes = 0
    const kept = entry.foreignKeys.findIndex((key) => (bytes += Buffer.byteLength(JSON.stringify(key)) + 1) > MAX_KEY_BYTES)
    if (kept >= 0) entry.foreignKeys.length = kept
  }
}
