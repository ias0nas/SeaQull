// Export and import of saved connections (src/shared/connection-file.ts is the file). Imports only
// add: a connection already saved under the same name (or as an earlier import's "Name (n)") with
// the same settings is skipped, one whose name is taken by different settings gets "Name (2)", and
// every import gets a new id.
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ConnectionInput, ImportItem, ImportOutcome } from '../src/protocol.ts'
import { normalizeColor } from '../src/shared/colors.ts'
import { connectionsFile, MAX_IMPORT } from '../src/shared/connection-file.ts'
import { normalize } from './connections.ts'

const IMPORT_TTL_MS = 5 * 60_000
/** Imports staged at once; a new one drops the oldest. */
const MAX_STAGED = 4
const MAX_LISTED_NAME = 200

const inFolder = (c: ConnectionConfig, folder: string) => c.folder === folder || (c.folder ?? '').startsWith(`${folder}/`)

/** The file for all connections, or for a folder and its subfolders. */
export function exportConnections(connections: ConnectionConfig[], folder?: string): { text: string; count: number } {
  const chosen = folder ? connections.filter((c) => inFolder(c, folder)) : connections
  return { text: connectionsFile(chosen), count: chosen.length }
}

/** The same place, the same way: who logs in, the folder and the colour do not count. */
const sameSettings = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.server === b.server &&
  a.port === b.port &&
  a.database === b.database &&
  a.encrypt === b.encrypt &&
  a.trustServerCertificate === b.trustServerCertificate &&
  a.auth.kind === b.auth.kind

const listedName = (name: unknown) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_LISTED_NAME) : '(no name)')

/** Only what the file may set: never an id or a password. */
function fileInput(entry: unknown): ConnectionInput {
  const e = (entry ?? {}) as Record<string, unknown>
  const auth = e.auth as { kind?: unknown; user?: unknown } | undefined
  if (typeof e.name !== 'string') throw new Error('No name')
  if (typeof e.server !== 'string') throw new Error('No server')
  if (auth?.kind !== 'sql' && auth?.kind !== 'entra') throw new Error('Authentication must be sql or entra')
  if (auth.user !== undefined && typeof auth.user !== 'string') throw new Error('The user must be text')
  const port = e.port === undefined ? 1433 : typeof e.port === 'string' && /^\d{1,5}$/.test(e.port) ? Number(e.port) : e.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Port must be a whole number from 1 to 65535')
  for (const key of ['database', 'folder', 'color'] as const) if (e[key] !== undefined && typeof e[key] !== 'string') throw new Error(`${key} must be text`)
  for (const key of ['encrypt', 'trustServerCertificate'] as const) if (e[key] !== undefined && typeof e[key] !== 'boolean') throw new Error(`${key} must be true or false`)
  return {
    name: e.name,
    server: e.server,
    port,
    database: (e.database as string | undefined) ?? '',
    auth: auth.kind === 'sql' ? { kind: 'sql', user: (auth.user as string | undefined) ?? '' } : { kind: 'entra' },
    encrypt: e.encrypt !== false,
    trustServerCertificate: e.trustServerCertificate === true,
    ...(typeof e.folder === 'string' ? { folder: e.folder } : {}),
    ...(typeof e.color === 'string' ? { color: e.color } : {})
  }
}

/** What importing `entries` does against `saved`, in file order, with the connections to add. */
export function planImport(saved: ConnectionConfig[], entries: unknown[]): { items: ImportItem[]; added: ConnectionConfig[] } {
  const byName = new Map(saved.map((c) => [c.name, c]))
  const items: ImportItem[] = []
  const added: ConnectionConfig[] = []
  for (const entry of entries) {
    const name = listedName((entry as { name?: unknown } | null)?.name)
    let config: ConnectionConfig
    try {
      if ((entry as { tooLarge?: unknown } | null)?.tooLarge === true) throw new Error('Too large')
      const input = fileInput(entry)
      if (input.color?.trim() && !normalizeColor(input.color)) throw new Error('The colour must be #rrggbb')
      config = { ...normalize(input), id: randomUUID() }
    } catch (err) {
      items.push({ status: 'invalid', name, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    const place = { server: config.server, ...(config.folder ? { folder: config.folder } : {}) }
    const risky = [...(config.encrypt ? [] : ['not encrypted']), ...(config.trustServerCertificate ? ['trusts any certificate'] : [])]
    // Already there under its name, or as an earlier import's "Name (n)": importing again changes nothing.
    const copy = new RegExp(`^${config.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)$`)
    const same = [...byName.values()].find((c) => (c.name === config.name || copy.test(c.name)) && sameSettings(c, config))
    if (same) {
      items.push({ status: 'existing', name: config.name, ...(same.name !== config.name ? { newName: same.name } : {}), ...place })
      continue
    }
    let newName = config.name
    for (let n = 2; byName.has(newName); n++) newName = `${config.name} (${n})`
    const final = { ...config, name: newName }
    byName.set(newName, final)
    added.push(final)
    const flags = risky.length ? { risky } : {}
    items.push(newName === config.name ? { status: 'new', name: config.name, ...place, ...flags } : { status: 'renamed', name: config.name, newName, ...place, ...flags })
  }
  return { items, added }
}

/** The counts an import reports, from what it did and what it added. */
export function importOutcome({ items, added }: { items: ImportItem[]; added: ConnectionConfig[] }): ImportOutcome {
  const count = (status: ImportItem['status']) => items.filter((i) => i.status === status).length
  return {
    added: added.length,
    renamed: count('renamed'),
    existing: count('existing'),
    invalid: count('invalid'),
    sqlLogins: added.filter((c) => c.auth.kind === 'sql').length
  }
}

const expired = () => Object.assign(new Error('That import expired: choose the file again.'), { code: 'invalid_params' })

/** Files being imported, sent in parts; each is dropped once used, cancelled, replaced by newer
 *  ones (at most MAX_STAGED), or left for 5 minutes. */
export class ImportStaging {
  private readonly imports = new Map<string, { entries: unknown[]; timer: ReturnType<typeof setTimeout> }>()
  private readonly ttlMs: number

  constructor(ttlMs = IMPORT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  append(importId: string | undefined, entries: unknown): { importId: string; count: number } {
    if (!Array.isArray(entries)) throw Object.assign(new Error('entries must be a list'), { code: 'invalid_params' })
    const id = importId ?? randomUUID()
    const staged = importId ? this.imports.get(importId) : undefined
    if (importId && !staged) throw expired()
    const list = staged?.entries ?? []
    if (list.length + entries.length > MAX_IMPORT) throw Object.assign(new Error(`SeaQull imports at most ${MAX_IMPORT} connections at a time.`), { code: 'invalid_params' })
    if (!staged) {
      // Oldest first (a Map keeps insertion order).
      for (const old of [...this.imports.keys()].slice(0, Math.max(0, this.imports.size - MAX_STAGED + 1))) this.drop(old)
    } else clearTimeout(staged.timer)
    list.push(...entries)
    const timer = setTimeout(() => this.imports.delete(id), this.ttlMs)
    timer.unref?.()
    this.imports.set(id, { entries: list, timer })
    return { importId: id, count: list.length }
  }

  entries(importId: string): unknown[] {
    const staged = this.imports.get(importId)
    if (!staged) throw expired()
    return staged.entries
  }

  drop(importId: string): void {
    const staged = this.imports.get(importId)
    if (!staged) return
    clearTimeout(staged.timer)
    this.imports.delete(importId)
  }

  get size(): number {
    return this.imports.size
  }
}
