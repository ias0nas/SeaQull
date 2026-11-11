// Object-tree keys, shared by the worker (which builds them) and the console (which reads them to
// insert names and build queries). A key is the node's path as `/`-joined, URI-encoded segments:
// `g:<folder>/…/c:<connId>/d:<db>/s:<schema>/f:tables/t:<name>/col:<column>`, a `g:` segment for
// each level of the connection's folder.

export type Folder = 'tables' | 'views' | 'procedures' | 'functions'

export type TreePath = {
  /** The connection's folder, by level. */
  group?: string[]
  connection?: string
  database?: string
  schema?: string
  folder?: Folder
  object?: string
  /** `t` table, `v` view, `p` procedure, `fn` function. */
  objectKind?: string
  column?: string
}

/** Tags that end a key without naming a path level (placeholder nodes). */
const PLACEHOLDER_TAGS = new Set(['more', 'error'])

export function encodeKey(path: TreePath): string {
  const parts: string[] = []
  for (const segment of path.group ?? []) parts.push(`g:${encodeURIComponent(segment)}`)
  if (path.connection) parts.push(`c:${encodeURIComponent(path.connection)}`)
  if (path.database !== undefined) parts.push(`d:${encodeURIComponent(path.database)}`)
  if (path.schema !== undefined) parts.push(`s:${encodeURIComponent(path.schema)}`)
  if (path.folder) parts.push(`f:${path.folder}`)
  if (path.object !== undefined) parts.push(`${path.objectKind ?? 'o'}:${encodeURIComponent(path.object)}`)
  if (path.column !== undefined) parts.push(`col:${encodeURIComponent(path.column)}`)
  return parts.join('/')
}

export function decodeKey(key: string): TreePath {
  const path: TreePath = {}
  for (const part of key.split('/').filter(Boolean)) {
    const colon = part.indexOf(':')
    const tag = part.slice(0, colon)
    const value = decodeURIComponent(part.slice(colon + 1))
    if (tag === 'g') (path.group ??= []).push(value)
    else if (tag === 'c') path.connection = value
    else if (tag === 'd') path.database = value
    else if (tag === 's') path.schema = value
    else if (tag === 'f') path.folder = value as Folder
    else if (tag === 'col') path.column = value
    else if (!PLACEHOLDER_TAGS.has(tag)) {
      path.object = value
      path.objectKind = tag
    }
  }
  return path
}

/** A key's folder segments (`g:…/g:…/` before a connection; a folder's whole key) and the rest. */
export function splitGroup(key: string): { prefix: string; rest: string } {
  const match = /^(?:g:[^/]*(?:\/|$))*/.exec(key)![0]
  return { prefix: match, rest: key.slice(match.length) }
}

/** `[name]`, with `]` doubled. */
export const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`

/**
 * The SQL name to insert for a node: `[schema].[object]`, prefixed with the database when it is not
 * the console's current one; a column is just `[column]`. Undefined for nodes without a SQL name.
 */
export function sqlName(path: TreePath, currentDatabase?: string): string | undefined {
  if (path.column !== undefined) return bracket(path.column)
  if (path.object !== undefined && path.schema !== undefined) {
    const twoPart = `${bracket(path.schema)}.${bracket(path.object)}`
    return path.database && path.database !== currentDatabase ? `${bracket(path.database)}.${twoPart}` : twoPart
  }
  if (path.schema !== undefined) return bracket(path.schema)
  if (path.database !== undefined) return bracket(path.database)
  return undefined
}

/** A first look at a table or view. */
export function selectTopSql(path: TreePath, rows = 100): string {
  return `SELECT TOP (${rows}) * FROM ${bracket(path.schema!)}.${bracket(path.object!)};`
}

export const isTableLike = (path: TreePath) => path.column === undefined && (path.objectKind === 't' || path.objectKind === 'v')
