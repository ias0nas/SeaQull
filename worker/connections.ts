// Saved connections: configs in the plugin's storage (plain JSON, never secrets), SQL login
// passwords in Orca's encrypted secrets (OS keychain), or, when given at sign-in, in this worker's
// memory (a login to remember is saved once the server has accepted it).
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionConfig, ConnectionInput, ImportItem, SignInState, TreeNode } from '../src/protocol.ts'
import { normalizeColor } from '../src/shared/colors.ts'
import { compareNames, folderSegments, movedFolder, normalizeFolder } from '../src/shared/folders.ts'
import { MAX_CONNECTIONS } from '../src/shared/connection-file.ts'
import { encodeKey } from '../src/shared/tree-keys.ts'
import { planImport } from './transfer.ts'

const STORAGE_KEY = 'connections'
const passwordKey = (id: string) => `password:${id}`

/** `remembered`: the saved user and password, not one given at sign-in. */
export type SqlLogin = { user: string; password: string; remembered: boolean }

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid_params' })

/** How long a refused login's reason is shown with the next prompt. */
const REFUSED_SHOWN_MS = 30_000

/** Whether two configs log in to the same place the same way (a name, colour or folder edit does not count). */
export const connectsTheSame = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.server === b.server && a.port === b.port && a.database === b.database && a.encrypt === b.encrypt &&
  a.trustServerCertificate === b.trustServerCertificate && JSON.stringify(a.auth) === JSON.stringify(b.auth)

/** Connecting needs a user and password the worker does not have. */
export const credentialsRequired = (config: ConnectionConfig) =>
  Object.assign(new Error(`Sign in to ${config.name} to connect.`), { code: 'credentials_required', connectionId: config.id })

export class ConnectionStore {
  private readonly orca: OrcaWorkerApi
  /** Saves and deletes read, change and write the whole list: one at a time, or two consoles
   *  saving at once would each write a list without the other's change. */
  private writes: Promise<unknown> = Promise.resolve()
  /** Logins given at sign-in, by connection id; `remember`: to be saved once accepted. */
  private readonly signedIn = new Map<string, { user: string; password: string; remember: boolean }>()
  /** Such a login the server refused: its user, why, and when. */
  private readonly refused = new Map<string, { user: string; message: string; at: number }>()
  /** Whether a password is saved, by connection id, so listing need not read every secret. */
  private readonly hasPassword = new Map<string, boolean>()

  constructor(orca: OrcaWorkerApi) {
    this.orca = orca
  }

  async list(): Promise<ConnectionConfig[]> {
    const stored = await this.orca.storage.get(STORAGE_KEY)
    if (!Array.isArray(stored)) return []
    // Folders saved before they were normalized (with `\`, say) read as if saved now.
    return (stored as unknown as ConnectionConfig[]).map((c) => {
      if (c.folder === undefined) return c
      const { folder, ...rest } = c
      const normalized = normalizeFolder(folder)
      return normalized ? { ...rest, folder: normalized } : rest
    })
  }

  async get(id: string): Promise<ConnectionConfig> {
    const found = (await this.list()).find((c) => c.id === id)
    if (!found) throw invalid(`Unknown connection ${id}`)
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

  /** The user and password to connect with; throws `credentials_required` without them. */
  async sqlLogin(config: ConnectionConfig): Promise<SqlLogin> {
    const given = this.signedIn.get(config.id)
    if (given) return { user: given.user, password: given.password, remembered: false }
    const user = config.auth.kind === 'sql' ? config.auth.user : ''
    const password = user ? await this.orca.secrets.get(passwordKey(config.id)) : null
    if (user) this.hasPassword.set(config.id, password !== null)
    if (!user || password === null) throw credentialsRequired(config)
    return { user, password, remembered: true }
  }

  async signInState(id: string): Promise<SignInState> {
    const config = await this.get(id)
    const user = config.auth.kind === 'sql' ? config.auth.user : ''
    const given = this.signedIn.get(id)
    const needed = config.auth.kind === 'sql' && !given && (!user || !(await this.passwordSaved(id)))
    const refused = needed ? this.refused.get(id) : undefined
    const failure = refused && Date.now() - refused.at < REFUSED_SHOWN_MS ? refused.message : undefined
    return {
      needed,
      name: config.name,
      user: given?.user ?? (user || refused?.user || ''),
      ...(failure ? { failure } : {}),
      ...(given?.remember ? { saving: true } : {})
    }
  }

  /** Kept in memory; one to remember is saved by loginAccepted. */
  signIn(id: string, user: unknown, password: unknown, remember: boolean): Promise<void> {
    return this.serialized(async () => {
      const config = await this.get(id)
      if (config.auth.kind !== 'sql') throw invalid('This connection does not sign in with a user and password')
      const name = typeof user === 'string' ? user.trim() : ''
      if (!name) throw invalid('User is required')
      if (typeof password !== 'string' || !password) throw invalid('Password is required')
      this.refused.delete(id)
      this.signedIn.set(id, { user: name, password, remember })
    })
  }

  /** The server accepted a login: one given at sign-in to remember is saved now, like an edit
   *  (user in the config, password in the secrets). True when it was. */
  loginAccepted(id: string, login: SqlLogin): Promise<boolean> {
    return this.serialized(async () => {
      const given = this.signedIn.get(id)
      if (login.remembered || !given?.remember || given.user !== login.user || given.password !== login.password) return false
      // Only the login changes: the rest is saved as it is, even if it predates the field limits.
      await this.orca.secrets.set(passwordKey(id), given.password)
      this.hasPassword.set(id, true)
      const all = await this.list()
      if (!all.some((c) => c.id === id)) return false
      await this.orca.storage.set(STORAGE_KEY, all.map((c) => (c.id === id ? { ...c, auth: { kind: 'sql' as const, user: given.user } } : c)) as unknown as never)
      this.signedIn.delete(id)
      this.refused.delete(id)
      return true
    })
  }

  /** The server refused a login: one given at sign-in is forgotten, so the next attempt asks again. */
  loginRefused(id: string, login: SqlLogin, message: string): void {
    if (login.remembered || this.signedIn.get(id)?.password !== login.password) return
    this.signedIn.delete(id)
    this.refused.set(id, { user: login.user, message, at: Date.now() })
  }

  async passwordSaved(id: string): Promise<boolean> {
    let saved = this.hasPassword.get(id)
    if (saved === undefined) {
      saved = (await this.orca.secrets.get(passwordKey(id))) !== null
      this.hasPassword.set(id, saved)
    }
    return saved
  }

  /** Adds what a connections file has that is not saved yet, in one write (see transfer.ts). */
  importConnections(entries: unknown[]): Promise<{ items: ImportItem[]; added: ConnectionConfig[] }> {
    return this.serialized(async () => {
      const all = await this.list()
      const { items, added } = planImport(all, entries)
      const room = Math.max(0, MAX_CONNECTIONS - all.length)
      if (added.length > room) {
        throw invalid(`Only ${room.toLocaleString('en-US')} more connections fit (SeaQull keeps at most ${MAX_CONNECTIONS.toLocaleString('en-US')}), and this file would add ${added.length.toLocaleString('en-US')}.`)
      }
      if (added.length > 0) await this.orca.storage.set(STORAGE_KEY, [...all, ...added] as unknown as never)
      return { items, added }
    })
  }

  /** How many connections moved. */
  renameFolder(from: string, to: string): Promise<number> {
    return this.serialized(async () => {
      const source = normalizeFolder(from)
      const target = normalizeFolder(to)
      if (!source) throw invalid('Which folder?')
      if (!target) throw invalid('Folder name is required')
      let moved = 0
      const next = (await this.list()).map((c) => {
        const folder = movedFolder(c.folder, source, target)
        if (folder === undefined) return c
        checkFolder(folder)
        moved++
        return { ...c, folder }
      })
      if (moved > 0 && source !== target) await this.orca.storage.set(STORAGE_KEY, next as unknown as never)
      return moved
    })
  }

  private async saveNow(input: ConnectionInput): Promise<ConnectionConfig> {
    const config = normalize(input)
    if (config.auth.kind === 'sql' && input.password && !config.auth.user) throw invalid('Enter the user this password is for')
    const all = await this.list()
    if (all.some((c) => c.name === config.name && c.id !== config.id)) throw invalid(`A connection named "${config.name}" already exists`)
    const before = all.find((c) => c.id === config.id)
    if (!before && all.length >= MAX_CONNECTIONS) throw invalid(`SeaQull keeps at most ${MAX_CONNECTIONS.toLocaleString('en-US')} connections: delete some to add more`)
    // The secret first: the page reloads the list when it sees the storage write.
    if (config.auth.kind === 'sql' && input.password) {
      await this.orca.secrets.set(passwordKey(config.id), input.password)
      this.hasPassword.set(config.id, true)
    } else if (config.auth.kind !== 'sql' || input.forgetPassword) {
      await this.orca.secrets.delete(passwordKey(config.id))
      this.hasPassword.set(config.id, false)
    }
    const next = before ? all.map((c) => (c.id === config.id ? config : c)) : [...all, config]
    await this.orca.storage.set(STORAGE_KEY, next as unknown as never)
    // A login given at sign-in still applies after a name, colour or folder edit.
    if (!before || input.password || !connectsTheSame(before, config)) {
      this.signedIn.delete(config.id)
      this.refused.delete(config.id)
    }
    return config
  }

  private async deleteNow(id: string): Promise<void> {
    await this.orca.storage.set(STORAGE_KEY, (await this.list()).filter((c) => c.id !== id) as unknown as never)
    await this.orca.secrets.delete(passwordKey(id))
    this.hasPassword.delete(id)
    this.signedIn.delete(id)
    this.refused.delete(id)
  }

  /** The password Test uses: the one typed, else the saved one (unless it is to be forgotten). */
  async testPassword(input: ConnectionInput): Promise<string | null> {
    if (input.password) return input.password
    return input.id && !input.forgetPassword ? this.orca.secrets.get(passwordKey(input.id)) : null
  }
}

/** Field lengths, in characters; with MAX_CONNECTIONS they keep every list, export and import
 *  within what SeaQull pages through. */
export const LIMITS = { name: 128, server: 255, database: 128, user: 128, folder: 255, folderLevels: 10 }
export { MAX_CONNECTIONS }

const CONTROL = /[\u0000-\u001f\u007f]/

function checkText(label: string, value: string, max: number): void {
  if (value.length > max) throw invalid(`${label} must be at most ${max} characters`)
  if (CONTROL.test(value)) throw invalid(`${label} must not contain control characters`)
}

function checkFolder(folder: string): void {
  checkText('Folder', folder, LIMITS.folder)
  if (folderSegments(folder).length > LIMITS.folderLevels) throw invalid(`Folder must be at most ${LIMITS.folderLevels} levels deep`)
}

export function normalize(input: ConnectionInput): ConnectionConfig {
  const name = input.name?.trim()
  const server = input.server?.trim()
  if (!name) throw invalid('Name is required')
  if (!server) throw invalid('Server is required')
  checkText('Name', name, LIMITS.name)
  checkText('Server', server, LIMITS.server)
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid('Port must be 1–65535')
  }
  const color = normalizeColor(input.color)
  const folder = normalizeFolder(input.folder)
  checkFolder(folder)
  const auth = input.auth?.kind === 'entra' ? { kind: 'entra' as const } : { kind: 'sql' as const, user: input.auth?.kind === 'sql' ? input.auth.user.trim() : '' }
  if (auth.kind === 'sql') checkText('User', auth.user, LIMITS.user)
  const database = input.database?.trim() ?? ''
  checkText('Database', database, LIMITS.database)
  return {
    id: input.id || randomUUID(),
    name,
    server,
    port,
    database,
    auth,
    encrypt: input.encrypt !== false,
    trustServerCertificate: input.trustServerCertificate === true,
    ...(color ? { color } : {}),
    ...(folder ? { folder } : {})
  }
}

/** As many of `items` from `offset` as fit in `budget` bytes of JSON (always at least one), and
 *  where the next page starts: answers are capped at 1 MiB. */
export function pageOf<T>(items: T[], offset: number, budget = 700_000): { items: T[]; next: number | null } {
  if (!Number.isInteger(offset) || offset < 0 || offset > items.length) throw invalid('offset is out of range')
  let end = offset
  for (let bytes = 0; end < items.length; end++) {
    const size = Buffer.byteLength(JSON.stringify(items[end])) + 1
    if (end > offset && bytes + size > budget) break
    bytes += size
  }
  return { items: items.slice(offset, end), next: end < items.length ? end : null }
}

/** The tree level of the folder `group` (top level: []): its subfolders, then its connections,
 *  each sorted by name. */
export function connectionTree(connections: ConnectionConfig[], group: string[] = []): TreeNode[] {
  const inside = connections
    .map((c) => ({ c, segments: folderSegments(c.folder) }))
    .filter(({ segments }) => segments.length >= group.length && group.every((g, i) => segments[i] === g))
  const subfolders = new Set(inside.filter(({ segments }) => segments.length > group.length).map(({ segments }) => segments[group.length]))
  const folders: TreeNode[] = [...subfolders].sort(compareNames).map((name) => ({
    key: encodeKey({ group: [...group, name] }),
    label: name,
    kind: 'group',
    hasChildren: true
  }))
  const own: TreeNode[] = inside
    .filter(({ segments }) => segments.length === group.length)
    .map(({ c }) => c)
    .sort((a, b) => compareNames(a.name, b.name))
    .map((c) => ({
      key: encodeKey({ group, connection: c.id }),
      label: c.name,
      description: `${c.server}${c.port === 1433 ? '' : `:${c.port}`}${c.auth.kind === 'entra' ? ' · Entra ID' : ''}`,
      kind: 'connection',
      hasChildren: true
    }))
  return [...folders, ...own]
}
