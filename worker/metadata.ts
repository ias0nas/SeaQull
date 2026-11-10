// The object tree: server → databases → schemas → Tables/Views/Procedures/Functions → columns.
// Node keys encode their path (src/shared/tree-keys.ts).
import type { Connection } from 'tedious'
import type { TreeNode } from '../src/protocol.ts'
import { bracket, encodeKey, type Folder, type TreePath } from '../src/shared/tree-keys.ts'
import { queryRows } from './mssql.ts'

export { decodeKey, encodeKey } from '../src/shared/tree-keys.ts'

/** Long levels are cut short, with a "… N more" node: the tree is for browsing, not listing. */
export const MAX_CHILDREN = 500

const FOLDERS: { folder: Folder; label: string }[] = [
  { folder: 'tables', label: 'Tables' },
  { folder: 'views', label: 'Views' },
  { folder: 'procedures', label: 'Procedures' },
  { folder: 'functions', label: 'Functions' }
]

/** A string literal: `N'…'` with quotes doubled. */
export const lit = (value: string) => `N'${value.replace(/'/g, "''")}'`

/** SQL for a column's (or parameter's, `alias` p) type name, from the catalog views `db` prefixes
 *  (`[db].`, or '' for the connection's own database): TYPE_NAME() would miss alias types (dbo.Name)
 *  of a database other than the connection's. */
export const typeNameSql = (db = '', alias = 'c') => `(SELECT t.name FROM ${db}sys.types t WHERE t.user_type_id = ${alias}.user_type_id)`

/** SQL for a bit: is the sys.columns row `c` part of its object's primary key. */
export const isPrimaryKeySql = (db = '') =>
  `CAST(CASE WHEN EXISTS (SELECT 1 FROM ${db}sys.index_columns ic JOIN ${db}sys.indexes i
        ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1
        WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS bit)`

function capped(nodes: TreeNode[], parentKey: string): TreeNode[] {
  if (nodes.length <= MAX_CHILDREN) return nodes
  return [
    ...nodes.slice(0, MAX_CHILDREN),
    { key: `${parentKey}/more:`, label: `… ${nodes.length - MAX_CHILDREN} more (not shown)`, kind: 'more', hasChildren: false }
  ]
}

/** Online databases the login can open. On Azure SQL Database (EngineEdition 5) HAS_DBACCESS is
 *  NULL for every database but the current one, so all online databases are listed there; opening
 *  one without access fails with the server's error under its node. */
export async function listDatabases(connection: Connection): Promise<string[]> {
  const rows = await queryRows(
    connection,
    `SELECT name FROM sys.databases
      WHERE state_desc = 'ONLINE' AND (HAS_DBACCESS(name) = 1 OR CAST(SERVERPROPERTY('EngineEdition') AS int) = 5)
      ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name`
  )
  return rows.map((r) => String(r.name))
}

export async function databaseNodes(connection: Connection, path: TreePath): Promise<TreeNode[]> {
  const names = await listDatabases(connection)
  const system = new Set(['master', 'model', 'msdb', 'tempdb'])
  const parentKey = encodeKey({ connection: path.connection })
  return capped(
    names.map((name) => ({
      key: encodeKey({ connection: path.connection, database: name }),
      label: name,
      description: system.has(name) ? 'system' : undefined,
      kind: 'database' as const,
      hasChildren: true
    })),
    parentKey
  )
}

/** Schemas that own at least one object, plus dbo; role-owned empty schemas are noise. */
export async function schemaNodes(connection: Connection, path: TreePath): Promise<TreeNode[]> {
  const db = `[${path.database!.replace(/]/g, ']]')}]`
  const rows = await queryRows(
    connection,
    `SELECT s.name, COUNT(o.object_id) AS objects
       FROM ${db}.sys.schemas s
       LEFT JOIN ${db}.sys.objects o ON o.schema_id = s.schema_id AND o.is_ms_shipped = 0
            AND o.type IN ('U','V','P','FN','IF','TF','FS','FT','PC')
      GROUP BY s.name
     HAVING COUNT(o.object_id) > 0 OR s.name = 'dbo'
      ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name`
  )
  return capped(
    rows.map((r) => ({
      key: encodeKey({ connection: path.connection, database: path.database, schema: String(r.name) }),
      label: String(r.name),
      description: `${r.objects} objects`,
      kind: 'schema' as const,
      hasChildren: true
    })),
    encodeKey(path)
  )
}

export function folderNodes(path: TreePath): TreeNode[] {
  return FOLDERS.map(({ folder, label }) => ({
    key: encodeKey({ ...path, folder }),
    label,
    kind: 'folder' as const,
    hasChildren: true
  }))
}

const OBJECT_TYPES: Record<Folder, { types: string; kind: TreeNode['kind']; tag: string; hasChildren: boolean }> = {
  tables: { types: `'U'`, kind: 'table', tag: 't', hasChildren: true },
  views: { types: `'V'`, kind: 'view', tag: 'v', hasChildren: true },
  procedures: { types: `'P','PC'`, kind: 'procedure', tag: 'p', hasChildren: true },
  functions: { types: `'FN','IF','TF','FS','FT'`, kind: 'function', tag: 'fn', hasChildren: true }
}

export async function objectNodes(connection: Connection, path: TreePath): Promise<TreeNode[]> {
  const db = `[${path.database!.replace(/]/g, ']]')}]`
  const spec = OBJECT_TYPES[path.folder!]
  const rows = await queryRows(
    connection,
    `SELECT o.name, o.type,
            (SELECT SUM(p.rows) FROM ${db}.sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0,1)) AS row_count
       FROM ${db}.sys.objects o
       JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = ${lit(path.schema!)} AND o.type IN (${spec.types}) AND o.is_ms_shipped = 0
      ORDER BY o.name`
  )
  return capped(
    rows.map((r) => ({
      key: encodeKey({ ...path, object: String(r.name), objectKind: spec.tag }),
      label: String(r.name),
      description: spec.kind === 'table' && r.row_count !== null ? `${Number(r.row_count).toLocaleString('en-US')} rows` : undefined,
      kind: spec.kind,
      hasChildren: spec.hasChildren
    })),
    encodeKey(path)
  )
}

/** Columns of a table/view, or parameters of a procedure/function. */
export async function columnNodes(connection: Connection, path: TreePath): Promise<TreeNode[]> {
  const db = `[${path.database!.replace(/]/g, ']]')}]`
  // OBJECT_ID needs the database in the name to resolve objects outside the current database, and
  // type names come from that database's sys.types: TYPE_NAME() would miss its alias types (dbo.Name).
  const objectId = `OBJECT_ID(${lit(`${bracket(path.database!)}.${bracket(path.schema!)}.${bracket(path.object!)}`)})`
  const isRoutine = path.objectKind === 'p' || path.objectKind === 'fn'
  const rows = isRoutine
    ? await queryRows(
        connection,
        `SELECT p.name, ${typeNameSql(`${db}.`, 'p')} AS type_name, p.max_length, p.precision, p.scale, p.is_output, CAST(0 AS bit) AS is_nullable, CAST(0 AS bit) AS is_pk
           FROM ${db}.sys.parameters p WHERE p.object_id = ${objectId} ORDER BY p.parameter_id`
      )
    : await queryRows(
        connection,
        `SELECT c.name, ${typeNameSql(`${db}.`)} AS type_name, c.max_length, c.precision, c.scale, CAST(0 AS bit) AS is_output, c.is_nullable,
                ${isPrimaryKeySql(`${db}.`)} AS is_pk
           FROM ${db}.sys.columns c WHERE c.object_id = ${objectId} ORDER BY c.column_id`
      )
  return rows.map((r) => {
    const flags = [r.is_pk ? 'PK' : '', r.is_output ? 'OUTPUT' : '', isRoutine || r.is_nullable ? '' : 'NOT NULL'].filter(Boolean)
    return {
      key: encodeKey({ ...path, column: String(r.name) || '(return)' }),
      label: String(r.name) || '(return value)',
      description: [declaredType(r), ...flags].join(' '),
      kind: 'column' as const,
      hasChildren: false
    }
  })
}

/** A column's type as declared, e.g. `nvarchar(50)`, from type_name, max_length, precision, scale. */
export function declaredType(r: Record<string, unknown>): string {
  const type = String(r.type_name)
  const len = Number(r.max_length)
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) return `${type}(${len === -1 ? 'max' : len})`
  if (['nvarchar', 'nchar'].includes(type)) return `${type}(${len === -1 ? 'max' : len / 2})`
  if (['decimal', 'numeric'].includes(type)) return `${type}(${r.precision},${r.scale})`
  if (['datetime2', 'time', 'datetimeoffset'].includes(type)) return `${type}(${r.scale})`
  return type
}
