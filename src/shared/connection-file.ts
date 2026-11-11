// The connections file (Export / Import connections): saved connections without ids or passwords,
// as stable, pretty-printed JSON. Read by the page (to check it before sending) and the worker.
import type { ConnectionConfig } from '../protocol.ts'

export const FILE_FORMAT = 'seaqull-connections'
export const FILE_VERSION = 1
/** Connections one import may hold. */
export const MAX_IMPORT = 2000
/** Saved connections at most (an import may bring them all). */
export const MAX_CONNECTIONS = MAX_IMPORT
/** A file larger than this is not read (an export of MAX_IMPORT connections, every field as long
 *  as allowed, stays under it). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

export type FileConnection = Omit<ConnectionConfig, 'id' | 'auth'> & { auth: { kind: 'sql'; user?: string } | { kind: 'entra' } }

/** One connection as the file has it, its keys always in the same order. */
export function fileConnection(c: ConnectionConfig): FileConnection {
  return {
    name: c.name,
    ...(c.folder ? { folder: c.folder } : {}),
    server: c.server,
    port: c.port,
    database: c.database,
    auth: c.auth.kind === 'sql' ? { kind: 'sql', ...(c.auth.user ? { user: c.auth.user } : {}) } : { kind: 'entra' },
    encrypt: c.encrypt,
    trustServerCertificate: c.trustServerCertificate,
    ...(c.color ? { color: c.color } : {})
  }
}

export const connectionsFile = (connections: ConnectionConfig[]) =>
  `${JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, connections: connections.map(fileConnection) }, null, 2)}\n`

/** The file's entries, unchecked (the worker checks each); throws when it is not such a file. */
export function parseConnectionsFile(text: string): unknown[] {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    throw new Error('This is not a JSON file.')
  }
  const { format, version, connections } = (file ?? {}) as { format?: unknown; version?: unknown; connections?: unknown }
  if (format !== FILE_FORMAT) throw new Error('This is not a SeaQull connections file.')
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('This connections file has no valid version.')
  if (version > FILE_VERSION) throw new Error(`This connections file is from a newer SeaQull (format version ${version}): update SeaQull to import it.`)
  if (!Array.isArray(connections)) throw new Error('This connections file has no list of connections.')
  if (connections.length > MAX_IMPORT) throw new Error(`This file has ${connections.length.toLocaleString('en-US')} connections; SeaQull imports at most ${MAX_IMPORT.toLocaleString('en-US')} at a time.`)
  return connections
}

const encoder = new TextEncoder()
const jsonSize = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/** `entries` in batches whose JSON stays under `maxBytes`; an entry too large on its own is sent
 *  as a stub the worker reports as invalid. */
export function importBatches(entries: unknown[], maxBytes = 48_000): unknown[][] {
  const batches: unknown[][] = []
  let batch: unknown[] = []
  let size = 2
  for (const entry of entries) {
    let item = entry
    let bytes = jsonSize(item) + 1
    if (bytes > maxBytes / 2) {
      const name = (entry as { name?: unknown } | null)?.name
      item = { tooLarge: true, ...(typeof name === 'string' ? { name: name.slice(0, 200) } : {}) }
      bytes = jsonSize(item) + 1
    }
    if (batch.length > 0 && size + bytes > maxBytes) {
      batches.push(batch)
      batch = []
      size = 2
    }
    batch.push(item)
    size += bytes
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}
