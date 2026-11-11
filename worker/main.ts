// SeaQull worker: a separate Node process (execution: trusted-worker). All network and database I/O
// lives here; the .sql console runs in a sandboxed frame with no network and reaches it through
// plugin.request (handlers below).
import { createHash } from 'node:crypto'
import type { Connection } from 'tedious'
import type { PluginRequestInput, PluginRequestOutput, PluginRequests } from 'orca'
import type { Activate, PanelRequestContext } from 'orca/worker'
import type { ConnectionConfig, ConnectionInput, ConnectionTestResult, TreeNode } from '../src/protocol.ts'
import { clearTokenCache, getSqlAccessToken } from './az.ts'
import { completionColumns, completionNames, MAX_COLUMN_OBJECTS } from './completion.ts'
import { connectionTree, connectsTheSame, ConnectionStore, MAX_CONNECTIONS, normalize, pageOf } from './connections.ts'
import { exportConnections, importOutcome, ImportStaging, planImport } from './transfer.ts'
import { jsonFit } from '../src/shared/json-bytes.ts'
import { columnNodes, databaseNodes, decodeKey, folderNodes, listDatabases, objectNodes, schemaNodes } from './metadata.ts'
import { splitGroup } from '../src/shared/tree-keys.ts'
import { isClosed, isLoginRefused, openConnection, queryRows, type Credentials, type Endpoint } from './mssql.ts'
import { ActivityIndicator } from './activity.ts'
import { EXPORT_CHUNK_BYTES, RunManager, type SessionMemory } from './runs.ts'

const DEFAULT_MAX_ROWS = 10_000
const SESSIONS_KEY = 'sessions'
/** The status-bar item's id in orca-plugin.json. */
const STATUS_ITEM = 'activity'
const META_IDLE_MS = 5 * 60_000
/** Explorer queries give up after this, so one blocked by a lock cannot hold up the tree forever. */
const META_REQUEST_TIMEOUT_MS = 30_000

const endpointOf = (c: ConnectionConfig, database = c.database): Endpoint => ({
  server: c.server,
  port: c.port,
  database,
  encrypt: c.encrypt,
  trustServerCertificate: c.trustServerCertificate
})

/** Answers must be plain JSON: Orca refuses `undefined` anywhere (e.g. an optional `description`),
 *  so every answer goes through a JSON round trip, which drops undefined keys. */
export function plainJson<T>(value: T): T {
  return value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T)
}

/** A console's session key. Orca's caller id is the same for every console page, so each .sql
 *  file carries its own id in its header (src/shared/sql-script.ts). */
function ownerOf(consoleId: unknown): string {
  if (typeof consoleId !== 'string' || !/^[\w-]{1,64}$/.test(consoleId)) {
    throw Object.assign(new Error('consoleId must be 1–64 letters, digits, _ or -'), { code: 'invalid_params' })
  }
  return `console:${consoleId}`
}

/** Set by activate: closes every session and explorer connection. */
let shutdown: (() => void) | undefined

const activate: Activate = async (orca) => {
  console.log(`SeaQull worker started (node ${process.version})`)
  const handle = <K extends keyof PluginRequests>(
    name: K,
    handler: (input: PluginRequestInput<K>, context: PanelRequestContext) => Promise<PluginRequestOutput<K>>
  ) => orca.panels.handle(name, async (input, context) => plainJson(await handler(input, context)))
  const store = new ConnectionStore(orca)
  // Which consoles had a SQL session, kept in the plugin's storage so that after this worker stops
  // (Orca quits, the plugin is reloaded, the worker fails), a console's next run says its session
  // is new. Console ids and times only.
  const sessionMemory: SessionMemory = {
    load: () => orca.storage.get(SESSIONS_KEY),
    save: (records) => orca.storage.set(SESSIONS_KEY, records as unknown as never),
    log: (message) => orca.log(message)
  }
  // The status-bar item (worker/activity.ts): shown while a query runs or a transaction is open.
  // Contributing it also keeps this worker running while the plugin is enabled.
  const indicator = new ActivityIndicator(
    (patch) => orca.host.call('statusBar.update', { id: STATUS_ITEM, ...patch }),
    (message) => orca.log(message)
  )
  indicator.reset()
  const runs: RunManager = new RunManager(
    async () => {
      const value = Number(await orca.settings.get('maxRows'))
      return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ROWS
    },
    sessionMemory,
    () => indicator.set(runs.activity())
  )

  const entraCredentials = async (): Promise<Credentials> => {
    const azPath = await orca.settings.get('azPath')
    return { kind: 'entra', token: await getSqlAccessToken(typeof azPath === 'string' ? azPath : undefined) }
  }

  /** Opens a connection. A failed Entra login drops cached tokens (say after `az login` as someone
   *  else); a refused login given at sign-in is forgotten, so the next attempt asks again. */
  const open = async (config: ConnectionConfig, database: string, options?: { requestTimeout?: number }, password?: string) => {
    if (config.auth.kind === 'entra') {
      try {
        return await openConnection(endpointOf(config, database), await entraCredentials(), options)
      } catch (err) {
        clearTokenCache()
        throw err
      }
    }
    const login = password !== undefined ? { user: config.auth.user, password, remembered: true } : await store.sqlLogin(config)
    try {
      const connection = await openConnection(endpointOf(config, database), { kind: 'sql', user: login.user, password: login.password }, options)
      if (!login.remembered) await store.loginAccepted(config.id, login).catch((err) => orca.log(`SeaQull: could not save the login: ${err instanceof Error ? err.message : err}`))
      return connection
    } catch (err) {
      if (isLoginRefused(err) && !login.remembered) {
        store.loginRefused(config.id, login, err instanceof Error ? err.message : String(err))
        throw Object.assign(err as Error, { signInRefused: true })
      }
      throw err
    }
  }

  const meta = new MetadataConnections(async (connectionId, database) => {
    const config = await store.get(connectionId)
    return open(config, database ?? config.database, { requestTimeout: META_REQUEST_TIMEOUT_MS })
  })

  handle('connections.list', async ({ offset }) => {
    const all = await store.list()
    const { items, next } = pageOf(all, offset ?? 0)
    const connections = await Promise.all(items.map(async (c) => (c.auth.kind === 'sql' && (await store.passwordSaved(c.id)) ? { ...c, passwordSaved: true } : c)))
    return { connections, next, version: createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 16) }
  })

  handle('connections.save', async (input) => {
    const before = input.id ? (await store.list()).find((c) => c.id === input.id) : undefined
    const saved = await store.save(input)
    // Only what changes the connection itself resets its sessions (rolling back open transactions,
    // dropping temp tables); a new name or colour does not.
    const reconnect = !before || !!input.password || !connectsTheSame(before, saved)
    if (reconnect) {
      meta.close(saved.id)
      runs.closeConnection(saved.id)
    } else if (input.forgetPassword) meta.close(saved.id) // the explorer asks next time; open sessions carry on
    return saved
  })

  handle('connections.delete', async ({ id }) => {
    await store.delete(id)
    meta.close(id)
    runs.closeConnection(id)
    return { ok: true as const }
  })

  handle('connections.signInState', async ({ id }) => store.signInState(id))
  handle('connections.signIn', async ({ id, user, password, remember }) => {
    await store.signIn(id, user, password, remember === true)
    return { ok: true as const }
  })

  handle('connections.export', async ({ folder, offset }) => {
    const { text, count } = exportConnections(await store.list(), typeof folder === 'string' && folder ? folder : undefined)
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw Object.assign(new Error('offset is out of range'), { code: 'invalid_params' })
    const [end] = jsonFit(text, offset, EXPORT_CHUNK_BYTES)
    return { text: text.slice(offset, end), next: end < text.length ? end : null, length: text.length, count }
  })
  const imports = new ImportStaging()
  handle('connections.importAppend', async ({ importId, entries }) => imports.append(importId, entries))
  handle('connections.importPlan', async ({ importId, offset }) => {
    const saved = await store.list()
    const { items, next } = pageOf(planImport(saved, imports.entries(importId)).items, offset ?? 0)
    return { items, next, room: Math.max(0, MAX_CONNECTIONS - saved.length) }
  })
  handle('connections.importApply', async ({ importId }) => {
    const outcome = importOutcome(await store.importConnections(imports.entries(importId)))
    imports.drop(importId)
    return outcome
  })
  handle('connections.importDrop', async ({ importId }) => {
    imports.drop(importId)
    return { ok: true as const }
  })

  handle('connections.renameFolder', async ({ from, to }) => ({ moved: await store.renameFolder(from, to) }))

  handle('connections.test', async (input: ConnectionInput): Promise<ConnectionTestResult> => {
    const started = Date.now()
    let connection: Connection | undefined
    try {
      const config = { ...normalize(input), id: input.id ?? '' }
      if (config.auth.kind === 'entra') clearTokenCache() // Test means "try it now", with a fresh token
      const password = config.auth.kind === 'sql' ? await store.testPassword(input) : undefined
      if (config.auth.kind === 'sql' && (!config.auth.user || !password)) return { ok: false, error: 'Enter a user and password to test.' }
      connection = await open(config, config.database, { requestTimeout: META_REQUEST_TIMEOUT_MS }, password ?? undefined)
      const [row] = await queryRows(connection, `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(32)) AS version, SUSER_SNAME() AS login`)
      return { ok: true, ms: Date.now() - started, serverVersion: String(row?.version), login: String(row?.login) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      connection?.close()
    }
  })

  handle('tree.children', async ({ key }): Promise<TreeNode[]> => {
    if (typeof key !== 'string') throw Object.assign(new Error('key must be text'), { code: 'invalid_params' })
    // Keys below a connection start with its folder's segments; the levels under it are the same
    // wherever it is listed.
    const { prefix, rest } = splitGroup(key)
    if (rest === '') return connectionTree(await store.list(), decodeKey(prefix).group ?? [])
    return (await objectChildren(rest)).map((node) => ({ ...node, key: prefix + node.key }))
  })

  const objectChildren = async (key: string): Promise<TreeNode[]> => {
    let path: ReturnType<typeof decodeKey>
    try {
      path = decodeKey(key)
    } catch {
      throw Object.assign(new Error(`Not a tree key: ${key}`), { code: 'invalid_params' })
    }
    if (!path.connection) throw Object.assign(new Error(`Not a tree key: ${key}`), { code: 'invalid_params' })
    if (path.schema !== undefined && !path.folder && path.object === undefined) return folderNodes(path)
    try {
      // Within a database, use a connection to that database: Azure SQL Database refuses
      // references to other databases ([db].sys...), so one server-level connection cannot do it.
      return await meta.use(path.connection, path.database, async (connection) => {
        if (path.object !== undefined) return columnNodes(connection, path)
        if (path.folder) return objectNodes(connection, path)
        if (path.database !== undefined) return schemaNodes(connection, path)
        return databaseNodes(connection, path)
      })
    } catch (err) {
      // The page asks for a login (again, with why) and tries again.
      if ((err as { code?: string }).code === 'credentials_required' || (err as { signInRefused?: boolean }).signInRefused) throw err
      // Show the failure inside the tree, under the node that failed.
      return [{ key: `${key}/error:`, label: err instanceof Error ? err.message : String(err), kind: 'error', hasChildren: false }]
    }
  }

  handle('databases.list', async ({ connectionId }) => meta.use(connectionId, undefined, listDatabases))

  /** A completion request's connection and database (`''`: the connection's default). */
  const validateTarget = (connectionId: unknown, database: unknown) => {
    if (typeof connectionId !== 'string' || !connectionId) throw Object.assign(new Error('connectionId is required'), { code: 'invalid_params' })
    if (typeof database !== 'string' || database.length > 128) {
      throw Object.assign(new Error('database must be a name of at most 128 characters'), { code: 'invalid_params' })
    }
  }

  handle('completion.names', async ({ connectionId, database }) => {
    validateTarget(connectionId, database)
    await store.get(connectionId) // an unknown connection is the caller's mistake (invalid_params), not a failed login
    return meta.use(connectionId, database || undefined, completionNames)
  })

  handle('completion.columns', async ({ connectionId, database, objects }) => {
    validateTarget(connectionId, database)
    const isName = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128
    if (!Array.isArray(objects) || objects.length > MAX_COLUMN_OBJECTS || !objects.every((o) => isName(o?.schema) && isName(o?.name))) {
      throw Object.assign(new Error(`objects must be at most ${MAX_COLUMN_OBJECTS} { schema, name } pairs of 1–128 characters`), { code: 'invalid_params' })
    }
    await store.get(connectionId)
    // Only the names: anything else in the request is not passed on.
    const names = objects.map(({ schema, name }) => ({ schema, name }))
    return meta.use(connectionId, database || undefined, (connection) => completionColumns(connection, names))
  })

  handle('query.run', async ({ consoleId, connectionId, database, sql, firstLine, uploadId }) => {
    const owner = ownerOf(consoleId)
    const config = await store.get(connectionId)
    if (config.auth.kind === 'sql') await store.sqlLogin(config) // ask for a missing login before the run starts
    const target = { connectionId, database, open: () => open(config, database || config.database), label: `${config.name} · ${database || config.database || 'default database'}` }
    const script = typeof uploadId === 'string' ? runs.takeUpload(owner, uploadId) : sql
    return { runId: await runs.start(owner, target, script, firstLine) }
  })
  handle('query.append', async ({ consoleId, uploadId, offset, part }) => runs.append(ownerOf(consoleId), uploadId, offset, part))
  handle('query.status', async ({ runId, messagesFrom }) => runs.status(runId, messagesFrom))
  handle('query.latest', async ({ consoleId }) => ({ status: runs.latest(ownerOf(consoleId)) }))
  handle('query.close', async ({ consoleId }) => {
    runs.closeOwner(ownerOf(consoleId))
    return { ok: true as const }
  })
  handle('query.cancel', async ({ runId }) => {
    runs.cancel(runId)
    return { ok: true as const }
  })
  handle('query.rows', async ({ runId, result, offset, limit }) => runs.rows(runId, result, offset, Math.min(limit, 2000)))
  handle('export.prepare', async ({ runId, result, format, tableName, headers, selection, raw }) =>
    runs.prepareExport(runId, result, format, tableName, headers !== false, selection, raw === true)
  )
  handle('export.chunk', async ({ exportId, offset }) => runs.exportChunk(exportId, offset))

  shutdown = () => {
    runs.dispose()
    meta.dispose()
  }
}

/** Orca awaits this before it stops the worker (plugin disabled, updated or restarted). */
export function deactivate(): void {
  shutdown?.()
  shutdown = undefined
}

type MetaEntry = { connection?: Promise<Connection>; queue: Promise<unknown>; lastUsed: number; closed?: boolean }

/** Connections for the explorer and the database picker: one per saved connection and database
 *  (no database: the connection's own, for the database list). Requests on each are serialized
 *  (TDS runs one at a time); idle ones close after a few minutes. */
class MetadataConnections {
  private entries = new Map<string, MetaEntry>()
  private readonly open: (connectionId: string, database: string | undefined) => Promise<Connection>
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(open: (connectionId: string, database: string | undefined) => Promise<Connection>) {
    this.open = open
    this.sweeper = setInterval(() => {
      for (const [key, entry] of this.entries) if (Date.now() - entry.lastUsed > META_IDLE_MS) this.closeEntry(key, entry)
    }, 60_000)
    this.sweeper.unref?.()
  }

  dispose(): void {
    clearInterval(this.sweeper)
    for (const [key, entry] of this.entries) this.closeEntry(key, entry)
  }

  use<T>(connectionId: string, database: string | undefined, fn: (connection: Connection) => Promise<T>): Promise<T> {
    const key = `${connectionId}\u0000${database ?? '\u0000'}`
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { queue: Promise.resolve(), lastUsed: Date.now() }
      this.entries.set(key, entry)
    }
    const current = entry
    current.lastUsed = Date.now()
    const task = current.queue.then(async () => {
      if (current.closed) throw new Error('The connection was edited or removed: try again.')
      let connection: Connection
      try {
        current.connection ??= this.open(connectionId, database)
        connection = await current.connection
        if (isClosed(connection)) {
          // Dropped since last use (server restart, network): reconnect once, inline.
          current.connection = this.open(connectionId, database)
          connection = await current.connection
        }
      } catch (err) {
        current.connection = undefined // retry on the next request
        throw err
      }
      try {
        return await fn(connection)
      } finally {
        // Closed while this request ran (connection edited or deleted): do not leave it open.
        if (current.closed) connection.close()
      }
    })
    current.queue = task.catch(() => undefined)
    return task
  }

  /** Closes every connection of a saved connection (it was edited or deleted). */
  close(connectionId: string): void {
    for (const [key, entry] of this.entries) if (key.startsWith(`${connectionId}\u0000`)) this.closeEntry(key, entry)
  }

  private closeEntry(key: string, entry: MetaEntry): void {
    entry.closed = true
    this.entries.delete(key)
    void entry.connection?.then((c) => c.close()).catch(() => undefined)
  }
}

export default activate
