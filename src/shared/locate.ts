// What the name at the editor's cursor stands for, for the explorer's locate (⌥F1): an object, a
// column of one, or a schema, by the names completion uses. DOM-free, unit-tested.
//
// The part of a multi-part name the cursor is in decides: in `Sales.Customer.Name`, `Sales` is the
// schema, `Customer` the table, `Name` its column; in `c.Name`, `c` is the table c stands for.
// Not resolved (the explorer then shows the tab's database): keywords, built-in
// functions, CTEs, temp tables, table variables, names in another database, and names the index
// does not have (it has no system objects the explorer would show, nor any it was cut short of).
import type { NameKind, ObjectColumns, ObjectName } from '../protocol.ts'
import { objectKey, RESERVED_WORDS, type NameIndex } from './sql-names.ts'
import { statementNames, type Token } from './sql-statement.ts'
import type { Folder, TreePath } from './tree-keys.ts'

export type LocateTarget =
  | { kind: 'schema'; schema: string }
  | { kind: 'object'; schema: string; name: string; type: Exclude<NameKind, 's'> }
  | { kind: 'column'; schema: string; name: string; type: Exclude<NameKind, 's'>; column: string }

export type LocateDeps = {
  index: NameIndex
  /** Columns (and a synonym's base) of these objects, by objectKey; missing ones are unknown. */
  columns(objects: ObjectName[]): Promise<Map<string, ObjectColumns>>
}

type Found = { schema: string; name: string; type: NameKind }
/** An object the explorer shows (not a synonym). */
type Real = { schema: string; name: string; type: Exclude<NameKind, 's'> }

const unquote = (t: Token) =>
  t.kind !== 'ident' ? t.text : t.text.startsWith('[') ? t.text.slice(1).replace(/\]$/, '').replace(/]]/g, ']') : t.text.slice(1).replace(/"$/, '').replace(/""/g, '"')
const isName = (t: Token | undefined) => !!t && (t.kind === 'word' || t.kind === 'ident')
const isDot = (t: Token | undefined) => !!t && t.kind === 'punct' && t.text === '.'

/** The dotted name the cursor is in or touching: its tokens, and which of them the cursor is on.
 *  A temp table or variable at the cursor counts as one (it is then not resolved). */
export function nameAt(tokens: Token[], cursor: number): { parts: Token[]; at: number; next?: Token } | null {
  const named = (t: Token) => isName(t) || t.kind === 'temp' || t.kind === 'variable'
  // Inside a name first, then one ending at the cursor, then one starting there.
  let i = tokens.findIndex((t) => named(t) && t.start < cursor && cursor < t.end)
  if (i === -1) i = tokens.findIndex((t) => named(t) && t.end === cursor)
  if (i === -1) i = tokens.findIndex((t) => named(t) && t.start === cursor)
  if (i === -1) return null
  let first = i
  while (isDot(tokens[first - 1]) && named(tokens[first - 2])) first -= 2
  let last = i
  while (isDot(tokens[last + 1]) && named(tokens[last + 2])) last += 2
  const parts = tokens.slice(first, last + 1).filter((t) => !isDot(t))
  return { parts, at: (i - first) / 2, next: tokens[last + 1] }
}

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

/** How long to wait for columns before giving up on them. */
export const COLUMNS_WAIT_MS = 1000

export async function locateAt(text: string, cursor: number, deps: LocateDeps): Promise<LocateTarget | null> {
  const { index } = deps
  const fold = index.fold
  const statement = statementNames(text, cursor)
  const found = nameAt(statement.tokens, cursor)
  if (!found || found.parts.some((t) => !isName(t))) return null
  const parts = found.parts.slice(0, found.at + 1)
  const names = parts.map(unquote)
  const columnsOf = (objects: ObjectName[]) => withTimeout(deps.columns(objects), COLUMNS_WAIT_MS, new Map<string, ObjectColumns>())

  /** Any object the index knows, by schema (default: the default schema) and name. */
  const object = (schema: string | undefined, name: string): Found | null => {
    const owner = index.catalog.get(fold(schema ?? index.defaultSchema))
    const hit = owner?.objects.get(fold(name))
    return owner && hit ? { schema: owner.name, name: hit[0], type: hit[1] } : null
  }
  /** A synonym stands for its base object (the explorer has no synonyms); others for themselves. */
  const real = async (o: Found | null): Promise<Real | null> => {
    if (!o) return null
    if (o.type !== 's') return o as Real
    const base = (await columnsOf([o])).get(objectKey(o))?.base
    const target = base ? object(base.schema, base.name) : null
    return target && target.type !== 's' ? (target as Real) : null
  }
  const objectTarget = async (o: Found | null): Promise<LocateTarget | null> => {
    const r = await real(o)
    return r && { kind: 'object', schema: r.schema, name: r.name, type: r.type }
  }
  /** Column `name` of `o`, with the catalog's spelling when its columns are known. */
  const columnTarget = async (o: Found | null, name: string): Promise<LocateTarget | null> => {
    const r = await real(o)
    if (!r) return null
    const known = (await columnsOf([r])).get(objectKey(r))?.columns.find(([c]) => fold(c) === fold(name))
    return { kind: 'column', schema: r.schema, name: r.name, type: r.type, column: known?.[0] ?? name }
  }
  /** The table an alias or table name of the statement stands for: undefined when it is none,
   *  null when it is one this does not resolve (a CTE, a derived table, #temp, @table). */
  const qualified = (name: string): Found | null | undefined => {
    const q = statement.qualifiers.find((x) => fold(x.name) === fold(name))
    if (!q) return undefined
    return q.table ? object(q.table.schema, q.table.name) : null
  }

  if (parts.length === 1) {
    const [token] = parts
    const [name] = names
    if (token.kind === 'word' && RESERVED_WORDS.has(name.toLowerCase())) return null
    if (statement.ctes.has(name.toLowerCase())) return null
    const table = qualified(name)
    if (table !== undefined) return objectTarget(table)
    // The first part of a longer name: a schema when the next part is one of its objects.
    const schema = index.catalog.get(fold(name))
    if (schema && found.parts.length > 1 && object(name, unquote(found.parts[1]))) return { kind: 'schema', schema: schema.name }
    const own = object(undefined, name)
    // A call: an object (a function, a procedure) or nothing (COUNT, GETDATE…).
    if (found.parts.length === 1 && found.next?.text === '(') return objectTarget(own)
    if (own) return objectTarget(own)
    if (schema) return { kind: 'schema', schema: schema.name }
    if (found.parts.length > 1) return null
    // A column of the statement's tables: the one table that has it; else its only table.
    const tables = (await Promise.all(statement.tables.map((t) => real(object(t.schema, t.name))))).filter((t) => t !== null)
    const unique = [...new Map(tables.map((t) => [objectKey(t), t])).values()]
    const columns = await columnsOf(unique)
    const holders = unique.filter((t) => columns.get(objectKey(t))?.columns.some(([c]) => fold(c) === fold(name)))
    if (holders.length === 1) return columnTarget(holders[0], name)
    return unique.length === 1 ? objectTarget(unique[0]) : null
  }
  if (parts.length === 2) {
    const [first, second] = names
    // database.schema(.object): the schema, in this database.
    if (found.parts.length === 3 && index.database && fold(first) === fold(index.database)) {
      const schema = index.catalog.get(fold(second))
      return schema ? { kind: 'schema', schema: schema.name } : null
    }
    const table = qualified(first)
    if (table !== undefined) return table && columnTarget(table, second)
    const own = object(first, second)
    if (own) return objectTarget(own)
    const parent = object(undefined, first)
    return parent && (parent.type === 't' || parent.type === 'v' || parent.type === 's') ? columnTarget(parent, second) : null
  }
  if (parts.length === 3) {
    const [first, second, third] = names
    // database.schema.object in this database, or schema.table.column.
    if (index.database && fold(first) === fold(index.database)) return objectTarget(object(second, third))
    return columnTarget(object(first, second), third)
  }
  return null
}

const FOLDERS: Record<Exclude<NameKind, 's'>, [Folder, string]> = {
  t: ['tables', 't'],
  v: ['views', 'v'],
  p: ['procedures', 'p'],
  f: ['functions', 'fn']
}

/** Where a target is in the explorer's tree (src/shared/tree-keys.ts). */
export function targetPath(target: LocateTarget, connection: string, database: string): TreePath {
  if (target.kind === 'schema') return { connection, database, schema: target.schema }
  const [folder, objectKind] = FOLDERS[target.type]
  const path: TreePath = { connection, database, schema: target.schema, folder, object: target.name, objectKind }
  return target.kind === 'column' ? { ...path, column: target.column } : path
}
