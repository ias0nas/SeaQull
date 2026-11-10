// Saved connections: configs in the plugin's storage (plain JSON, never secrets), SQL login
// passwords in Orca's encrypted secrets (OS keychain).
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionConfig, ConnectionInput } from '../src/protocol.ts'
import { normalizeColor } from '../src/shared/colors.ts'

const STORAGE_KEY = 'connections'
const passwordKey = (id: string) => `password:${id}`

export class ConnectionStore {
  private readonly orca: OrcaWorkerApi
  /** Saves and deletes read, change and write the whole list: one at a time, or two consoles
   *  saving at once would each write a list without the other's change. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(orca: OrcaWorkerApi) {
    this.orca = orca
  }

  async list(): Promise<ConnectionConfig[]> {
    const stored = await this.orca.storage.get(STORAGE_KEY)
    return Array.isArray(stored) ? (stored as unknown as ConnectionConfig[]) : []
  }

  async get(id: string): Promise<ConnectionConfig> {
    const found = (await this.list()).find((c) => c.id === id)
    if (!found) throw Object.assign(new Error(`Unknown connection ${id}`), { code: 'invalid_params' })
    return found
  }

  /** Runs `change` after every write queued before it. */
  private serialized<T>(change: () => Promise<T>): Promise<T> {
    const result = this.writes.then(change)
    this.writes = result.catch(() => undefined)
    return result
  }

  save(input: ConnectionInput): Promise<ConnectionConfig> {
    return this.serialized(() => this.saveNow(input))
  }

  delete(id: string): Promise<void> {
    return this.serialized(() => this.deleteNow(id))
  }

  private async saveNow(input: ConnectionInput): Promise<ConnectionConfig> {
    const config = normalize(input)
    const all = await this.list()
    if (all.some((c) => c.name === config.name && c.id !== config.id)) {
      throw Object.assign(new Error(`A connection named "${config.name}" already exists`), { code: 'invalid_params' })
    }
    const next = all.some((c) => c.id === config.id) ? all.map((c) => (c.id === config.id ? config : c)) : [...all, config]
    await this.orca.storage.set(STORAGE_KEY, next as unknown as never)
    if (config.auth.kind === 'sql' && input.password) await this.orca.secrets.set(passwordKey(config.id), input.password)
    if (config.auth.kind !== 'sql') await this.orca.secrets.delete(passwordKey(config.id))
    return config
  }

  private async deleteNow(id: string): Promise<void> {
    await this.orca.storage.set(STORAGE_KEY, (await this.list()).filter((c) => c.id !== id) as unknown as never)
    await this.orca.secrets.delete(passwordKey(id))
  }

  /** The password to use: the one typed (testing an unsaved form) or the stored one. */
  async password(id: string | undefined, typed?: string): Promise<string> {
    if (typed) return typed
    const stored = id ? await this.orca.secrets.get(passwordKey(id)) : null
    if (stored === null) throw new Error('No password saved for this connection: edit it and enter one.')
    return stored
  }
}

export function normalize(input: ConnectionInput): ConnectionConfig {
  const name = input.name?.trim()
  const server = input.server?.trim()
  if (!name) throw Object.assign(new Error('Name is required'), { code: 'invalid_params' })
  if (!server) throw Object.assign(new Error('Server is required'), { code: 'invalid_params' })
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw Object.assign(new Error('Port must be 1–65535'), { code: 'invalid_params' })
  }
  const color = normalizeColor(input.color)
  const auth = input.auth?.kind === 'entra' ? { kind: 'entra' as const } : { kind: 'sql' as const, user: input.auth?.kind === 'sql' ? input.auth.user.trim() : '' }
  if (auth.kind === 'sql' && !auth.user) throw Object.assign(new Error('User is required for SQL login'), { code: 'invalid_params' })
  return {
    id: input.id || randomUUID(),
    name,
    server,
    port,
    database: input.database?.trim() ?? '',
    auth,
    encrypt: input.encrypt !== false,
    trustServerCertificate: input.trustServerCertificate === true,
    ...(color ? { color } : {})
  }
}
