// Saved connections: configs in the plugin's storage (plain JSON, never secrets), SQL login
// passwords in Orca's encrypted secrets (OS keychain), or, when given at sign-in, in this worker's
// memory (a login to remember is saved once the server has accepted it).
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionConfig, ConnectionInput, SignInState, TreeNode } from '../src/protocol.ts'
import { normalizeColor } from '../src/shared/colors.ts'
import { compareNames, folderSegments, movedFolder, normalizeFolder } from '../src/shared/folders.ts'
import { encodeKey } from '../src/shared/tree-keys.ts'

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
      const config = await this.get(id)
      await this.saveNow({ ...config, auth: { kind: 'sql', user: given.user }, password: given.password })
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

export function normalize(input: ConnectionInput): ConnectionConfig {
  const name = input.name?.trim()
  const server = input.server?.trim()
  if (!name) throw invalid('Name is required')
  if (!server) throw invalid('Server is required')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid('Port must be 1–65535')
  }
  const color = normalizeColor(input.color)
  const folder = normalizeFolder(input.folder)
  const auth = input.auth?.kind === 'entra' ? { kind: 'entra' as const } : { kind: 'sql' as const, user: input.auth?.kind === 'sql' ? input.auth.user.trim() : '' }
  return {
    id: input.id || randomUUID(),
    name,
    server,
    port,
    database: input.database?.trim() ?? '',
    auth,
    encrypt: input.encrypt !== false,
    trustServerCertificate: input.trustServerCertificate === true,
    ...(color ? { color } : {}),
    ...(folder ? { folder } : {})
  }
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
