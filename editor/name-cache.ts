// The object and column names the editor completes, per connection and database, shared by every
// tab of the page: one `completion.names` request per database, and `completion.columns` requests
// (columns and foreign keys) for the objects completions need, kept until something may have
// changed them.
import type { ObjectColumns, ObjectName } from '../src/protocol.ts'
import { nameIndex, objectKey, settledColumns, type NameIndex } from '../src/shared/sql-names.ts'
import { request } from './request.ts'

/** After a failure (no access, a failed login), ask again only after this: completion asks on
 *  every keystroke, and repeated failed logins could lock an account. */
const RETRY_MS = 60_000
/** Objects per completion.columns request (the worker's limit). */
const MAX_OBJECTS = 50

type Entry = {
  names: Promise<NameIndex | null>
  failedAt?: number
  /** Each object's columns and foreign keys, by `objectKey`; null for an object without columns. */
  columns: Map<string, Promise<ObjectColumns | null>>
  columnsFailedAt?: number
}

const cache = new Map<string, Entry>()
const keyOf = (connectionId: string, database: string) => `${connectionId}\u0000${database}`

const recent = (failedAt: number | undefined) => failedAt !== undefined && Date.now() - failedAt < RETRY_MS

/** The names of a database (`''`: the connection's default); null when they cannot be had. */
export function namesFor(connectionId: string, database: string): Promise<NameIndex | null> {
  const key = keyOf(connectionId, database)
  const cached = cache.get(key)
  if (cached && (cached.failedAt === undefined || recent(cached.failedAt))) return cached.names
  const entry: Entry = {
    names: request('completion.names', { connectionId, database }, { timeoutMs: 60_000 }).then(nameIndex, () => {
      entry.failedAt = Date.now()
      return null
    }),
    columns: new Map()
  }
  cache.set(key, entry)
  return entry.names
}

/** The columns and foreign keys of `objects` in a database whose names were asked for
 *  (`namesFor`), by `objectKey`: one request for those not cached yet. Objects without columns are
 *  left out (and cached as such); so are those the answer had no room for (asked for again next
 *  time), and all of them while a failed request is recent. */
export async function columnsFor(connectionId: string, database: string, objects: ObjectName[]): Promise<Map<string, ObjectColumns>> {
  const found = new Map<string, ObjectColumns>()
  const entry = cache.get(keyOf(connectionId, database))
  if (!entry) return found
  const missing = objects.filter((o) => !entry.columns.has(objectKey(o))).slice(0, MAX_OBJECTS)
  if (missing.length > 0 && !recent(entry.columnsFailedAt)) {
    const asked = request('completion.columns', { connectionId, database, objects: missing }, { timeoutMs: 60_000 }).then(
      (answer) => settledColumns(missing, answer),
      () => {
        entry.columnsFailedAt = Date.now()
        return null
      }
    )
    for (const o of missing) {
      const key = objectKey(o)
      const columns: Promise<ObjectColumns | null> = asked.then((settled) => {
        if (settled?.has(key)) return settled.get(key)!
        // Not sent (the answer was full) or the request failed: ask again next time.
        if (entry.columns.get(key) === columns) entry.columns.delete(key)
        return null
      })
      entry.columns.set(key, columns)
    }
  }
  for (const o of objects) {
    const columns = await entry.columns.get(objectKey(o))
    if (columns) found.set(objectKey(o), columns)
  }
  return found
}

/** Forgets cached names and columns: of one database (and the connection's default, which may be
 *  the same one), of a whole connection, or (no arguments) all of them. */
export function forgetNames(connectionId?: string, database?: string): void {
  if (connectionId === undefined) return cache.clear()
  for (const key of [...cache.keys()]) {
    const [id, db] = key.split('\u0000')
    if (id === connectionId && (database === undefined || db === database || db === '')) cache.delete(key)
  }
}
