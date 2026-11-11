// The saved-connection store: validation, and where passwords go (secrets only, never storage).
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import type { ConnectionInput } from '../src/protocol.ts'
import { folderPaths, movedFolder } from '../src/shared/folders.ts'
import { connectionTree, ConnectionStore, normalize } from '../worker/connections.ts'

let storage: Map<string, unknown>
let secrets: Map<string, string>
let store: ConnectionStore

beforeEach(() => {
  storage = new Map()
  secrets = new Map()
  const host = {
    storage: { get: async (k: string) => storage.get(k) ?? null, set: async (k: string, v: unknown) => void storage.set(k, v) },
    secrets: {
      get: async (k: string) => secrets.get(k) ?? null,
      set: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k)
    }
  }
  store = new ConnectionStore(host as never)
})

const input = (overrides: Partial<ConnectionInput> = {}): ConnectionInput => ({
  name: 'Local',
  server: 'localhost',
  port: 1433,
  database: '',
  auth: { kind: 'sql', user: 'sa' },
  encrypt: true,
  trustServerCertificate: false,
  ...overrides
})

test('normalize trims, defaults and rejects what cannot work', () => {
  const config = normalize(input({ name: '  Local ', server: ' db.example ', database: ' AW ' }))
  assert.equal(config.name, 'Local')
  assert.equal(config.server, 'db.example')
  assert.equal(config.database, 'AW')
  assert.match(config.id, /^[0-9a-f-]{36}$/)
  for (const bad of [{ name: ' ' }, { server: '' }, { port: 0 }, { port: 70000 }, { port: 1.5 }]) {
    assert.throws(() => normalize(input(bad)), (err: Error & { code?: string }) => err.code === 'invalid_params', JSON.stringify(bad))
  }
  assert.deepEqual(normalize(input({ auth: { kind: 'entra' } })).auth, { kind: 'entra' })
  assert.deepEqual(normalize(input({ auth: { kind: 'sql', user: '  ' } })).auth, { kind: 'sql', user: '' }, 'the user is optional: asked when connecting')
})

test('passwords live in secrets; a blank one keeps the saved one', async () => {
  const saved = await store.save(input({ password: 'hunter2' }))
  assert.ok(!JSON.stringify([...storage.values()]).includes('hunter2'))
  assert.equal((await store.sqlLogin(saved)).password, 'hunter2')
  const renamed = await store.save(input({ id: saved.id, name: 'Renamed' }))
  assert.deepEqual(await store.sqlLogin(renamed), { user: 'sa', password: 'hunter2', remembered: true })
  assert.equal(await store.testPassword(input({ id: saved.id, password: 'typed' })), 'typed', 'a typed password (Test) wins')
  assert.equal(await store.testPassword(input({ id: saved.id })), 'hunter2')
  assert.equal(await store.testPassword(input({ id: saved.id, forgetPassword: true })), null)
  await store.save(input({ id: saved.id, name: 'Renamed', forgetPassword: true }))
  assert.equal(secrets.size, 0, 'forgotten')
})

test('switching to Entra ID deletes the saved password; deleting removes both', async () => {
  const saved = await store.save(input({ password: 'hunter2' }))
  await store.save(input({ id: saved.id, auth: { kind: 'entra' } }))
  assert.equal(secrets.size, 0)
  assert.equal(await store.passwordSaved(saved.id), false)
  const other = await store.save(input({ name: 'Other', password: 'x' }))
  await store.delete(other.id)
  assert.equal(secrets.size, 0)
  assert.deepEqual((await store.list()).map((c) => c.name), ['Local'])
})

test('names are unique', async () => {
  await store.save(input())
  await assert.rejects(store.save(input()), /already exists/)
})

test('saves and deletes from several consoles at once all land', async () => {
  // Storage that takes a while, like Orca's (a round trip to the host per call).
  const later = () => new Promise((r) => setTimeout(r, Math.random() * 5))
  const slow = new Map<string, unknown>()
  const host = {
    storage: {
      get: async (k: string) => (await later(), structuredClone(slow.get(k) ?? null)),
      set: async (k: string, v: unknown) => (await later(), void slow.set(k, structuredClone(v)))
    },
    secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined }
  }
  const shared = new ConnectionStore(host as never)
  const doomed = await shared.save(input({ name: 'Doomed' }))
  const names = ['A', 'B', 'C', 'D', 'E', 'F']
  await Promise.all([...names.map((name) => shared.save(input({ name }))), shared.delete(doomed.id)])
  assert.deepEqual((await shared.list()).map((c) => c.name).sort(), names)
  // A failed save does not block the ones after it.
  const results = await Promise.allSettled([shared.save(input({ name: 'A' })), shared.save(input({ name: 'G' }))])
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled'])
})

test('a folder path is trimmed segment by segment; a blank one is left out', () => {
  assert.equal(normalize(input({ folder: ' Clients / Acme//Prod/ ' })).folder, 'Clients/Acme/Prod')
  assert.equal(normalize(input({ folder: 'folder1\\' })).folder, 'folder1')
  assert.equal(normalize(input({ folder: 'folder1\\nested' })).folder, 'folder1/nested')
  assert.equal(normalize(input({ folder: ' A\\ B /C\\\\D ' })).folder, 'A/B/C/D')
  for (const folder of ['', ' / ', '//', '\\', ' \\ / ']) assert.ok(!('folder' in normalize(input({ folder }))))
  assert.ok(!('folder' in normalize(input())))
})

test('connections saved before folders existed load unchanged', async () => {
  const old = { id: 'c1', name: 'Old', server: 'db', port: 1433, database: '', auth: { kind: 'sql', user: 'sa' }, encrypt: true, trustServerCertificate: false }
  storage.set('connections', [old])
  assert.deepEqual(await store.list(), [old])
  assert.deepEqual(connectionTree(await store.list()).map((n) => [n.kind, n.label, n.key]), [['connection', 'Old', 'c:c1']])
})

test('renaming a folder moves it and its subfolders in one write, and merges into an existing one', async () => {
  const save = (name: string, folder?: string) => store.save(input({ name, ...(folder ? { folder } : {}) }))
  await save('A1', 'Clients/Acme')
  await save('A2', 'Clients/Acme/Prod')
  await save('B1', 'Clients/Beta')
  await save('C1', 'Clients/Acme Two')
  await save('Loose')
  let writes = 0
  const set = (store as unknown as { orca: { storage: { set: (k: string, v: unknown) => Promise<void> } } }).orca.storage
  const original = set.set
  set.set = async (k, v) => (writes++, original(k, v))
  assert.equal(await store.renameFolder(' Clients/Acme ', 'Customers/Acme'), 2)
  assert.equal(writes, 1)
  const folders = async () => Object.fromEntries((await store.list()).map((c) => [c.name, c.folder]))
  assert.deepEqual(await folders(), { A1: 'Customers/Acme', A2: 'Customers/Acme/Prod', B1: 'Clients/Beta', C1: 'Clients/Acme Two', Loose: undefined })
  assert.equal(await store.renameFolder('Customers/Acme', 'Clients/Beta'), 2)
  assert.deepEqual(await folders(), { A1: 'Clients/Beta', A2: 'Clients/Beta/Prod', B1: 'Clients/Beta', C1: 'Clients/Acme Two', Loose: undefined })
  await assert.rejects(store.renameFolder('Clients/Beta', ' / '), /required/)
  assert.equal(await store.renameFolder('Nowhere', 'Else'), 0)
})

test('the tree lists folders first, then connections, each sorted; folders nest', () => {
  const config = (id: string, name: string, folder?: string) => ({ ...normalize(input({ name, ...(folder ? { folder } : {}) })), id })
  const all = [config('1', 'zeta'), config('2', 'Alpha'), config('3', 'p1', 'clients/Acme/Prod'), config('4', 'a1', 'clients/Acme'), config('5', 'b1', 'Beta'), config('6', 'x', 'clients')]
  const level = (group?: string[]) => connectionTree(all, group).map((n) => [n.kind, n.label, n.key])
  assert.deepEqual(level(), [
    ['group', 'Beta', 'g:Beta'],
    ['group', 'clients', 'g:clients'],
    ['connection', 'Alpha', 'c:2'],
    ['connection', 'zeta', 'c:1']
  ])
  assert.deepEqual(level(['clients']), [
    ['group', 'Acme', 'g:clients/g:Acme'],
    ['connection', 'x', 'g:clients/c:6']
  ])
  assert.deepEqual(level(['clients', 'Acme']), [
    ['group', 'Prod', 'g:clients/g:Acme/g:Prod'],
    ['connection', 'a1', 'g:clients/g:Acme/c:4']
  ])
  assert.deepEqual(level(['nowhere']), [])
})

test('folder paths in use, parents included', () => {
  assert.deepEqual(folderPaths(['b/c', undefined, 'A', 'b']), ['A', 'b', 'b/c'])
  assert.equal(movedFolder('ab/c', 'a', 'x'), undefined)
})

test('folders stored with backslashes list nested, and rename by their normalized path', async () => {
  const stored = (id: string, name: string, folder?: string) => ({ id, name, server: 'db', port: 1433, database: '', auth: { kind: 'sql', user: 'sa' }, encrypt: true, trustServerCertificate: false, ...(folder === undefined ? {} : { folder }) })
  storage.set('connections', [stored('4', 'local4', 'folder1\\'), stored('3', 'local 3', 'folder1\\nested'), stored('5', 'blank', ' \\ ')])
  assert.deepEqual((await store.list()).map((c) => [c.name, c.folder]), [['local4', 'folder1'], ['local 3', 'folder1/nested'], ['blank', undefined]])
  assert.ok(!('folder' in (await store.list())[2]))
  const tree = await store.list()
  assert.deepEqual(connectionTree(tree).map((n) => n.label), ['folder1', 'blank'])
  assert.deepEqual(connectionTree(tree, ['folder1']).map((n) => [n.kind, n.label]), [['group', 'nested'], ['connection', 'local4']])
  assert.deepEqual(connectionTree(tree, ['folder1', 'nested']).map((n) => n.label), ['local 3'])
  assert.equal(await store.renameFolder('folder1\\', 'Team\\One'), 2)
  assert.deepEqual((await store.list()).map((c) => c.folder), ['Team/One', 'Team/One/nested', undefined])
  assert.deepEqual((storage.get('connections') as { folder?: string }[]).map((c) => c.folder), ['Team/One', 'Team/One/nested', undefined])
})

const credentialsRequired = (err: Error & { code?: string; connectionId?: string }) => err.code === 'credentials_required' && /Sign in to/.test(err.message)

test('without a user or a saved password, connecting needs a sign-in', async () => {
  const noUser = await store.save(input({ name: 'No user', auth: { kind: 'sql', user: '' } }))
  const noPassword = await store.save(input({ name: 'No password' }))
  for (const config of [noUser, noPassword]) {
    await assert.rejects(store.sqlLogin(config), (err: Error & { connectionId?: string }) => credentialsRequired(err) && err.connectionId === config.id)
    assert.deepEqual(await store.signInState(config.id), { needed: true, name: config.name, user: config.auth.kind === 'sql' ? config.auth.user : '' })
  }
  const entra = await store.save(input({ name: 'Entra', auth: { kind: 'entra' } }))
  assert.equal((await store.signInState(entra.id)).needed, false)
  await assert.rejects(store.signIn(entra.id, 'sa', 'x', false), /does not sign in/)
  await assert.rejects(store.signIn(noUser.id, ' ', 'x', false), /User is required/)
  await assert.rejects(store.signIn(noUser.id, 'sa', '', false), /Password is required/)
})

test('a sign-in not remembered stays in memory only, kept through name, colour and folder edits, dropped when the login or endpoint changes', async () => {
  const config = await store.save(input({ auth: { kind: 'sql', user: '' } }))
  const before = JSON.stringify([...storage.values()])
  await store.signIn(config.id, ' bob ', 's3cret', false)
  assert.equal(JSON.stringify([...storage.values()]), before, 'nothing written')
  assert.equal(secrets.size, 0)
  assert.deepEqual(await store.sqlLogin(config), { user: 'bob', password: 's3cret', remembered: false })
  assert.deepEqual(await store.signInState(config.id), { needed: false, name: 'Local', user: 'bob' })
  // A fresh store (the worker restarted) has nothing.
  await assert.rejects(new ConnectionStore((store as unknown as { orca: never }).orca).sqlLogin(config), credentialsRequired)
  await store.save(input({ id: config.id, name: 'Renamed', auth: { kind: 'sql', user: '' }, color: '#ff0000', folder: 'Team' }))
  assert.equal((await store.sqlLogin(config)).user, 'bob', 'kept')
  await store.save(input({ id: config.id, name: 'Renamed', auth: { kind: 'sql', user: '' }, server: 'elsewhere' }))
  await assert.rejects(store.sqlLogin(config), credentialsRequired)
  await store.signIn(config.id, 'bob', 's3cret', false)
  await store.save(input({ id: config.id, name: 'Renamed', auth: { kind: 'sql', user: 'alice' }, server: 'elsewhere' }))
  await assert.rejects(store.sqlLogin(await store.get(config.id)), credentialsRequired, 'a new user drops it')
})

test('a sign-in to remember is saved only once the server accepts it; a fresh store then connects', async () => {
  const config = await store.save(input({ auth: { kind: 'sql', user: '' }, folder: 'Team' }))
  const before = JSON.stringify([...storage.values()])
  await store.signIn(config.id, 'bob', 's3cret', true)
  assert.equal(JSON.stringify([...storage.values()]), before, 'nothing written yet')
  assert.equal(secrets.size, 0)
  const login = await store.sqlLogin(config)
  assert.deepEqual(login, { user: 'bob', password: 's3cret', remembered: false })
  assert.equal(await store.loginAccepted(config.id, login), true)
  const saved = await store.get(config.id)
  assert.deepEqual(saved.auth, { kind: 'sql', user: 'bob' })
  assert.equal(saved.folder, 'Team')
  assert.ok(!JSON.stringify([...storage.values()]).includes('s3cret'))
  assert.deepEqual(await store.sqlLogin(saved), { user: 'bob', password: 's3cret', remembered: true })
  assert.deepEqual(await new ConnectionStore((store as unknown as { orca: never }).orca).sqlLogin(saved), { user: 'bob', password: 's3cret', remembered: true })
  assert.equal(await store.loginAccepted(config.id, login), false, 'saved once')
})

test('a sign-in to remember that the server refuses is not saved, and the prompt comes back with why', async () => {
  const config = await store.save(input({ auth: { kind: 'sql', user: '' } }))
  const before = JSON.stringify([...storage.values()])
  await store.signIn(config.id, 'bob', 'typo', true)
  store.loginRefused(config.id, await store.sqlLogin(config), "Login failed for user 'bob'.")
  assert.equal(JSON.stringify([...storage.values()]), before)
  assert.equal(secrets.size, 0)
  assert.deepEqual(await store.signInState(config.id), { needed: true, name: 'Local', user: 'bob', failure: "Login failed for user 'bob'." })
  await assert.rejects(store.sqlLogin(config), credentialsRequired)
})

test('saving or deleting the connection drops a sign-in still waiting to be saved', async () => {
  const config = await store.save(input({ auth: { kind: 'sql', user: '' } }))
  await store.signIn(config.id, 'bob', 's3cret', true)
  const login = await store.sqlLogin(config)
  await store.save(input({ id: config.id, auth: { kind: 'sql', user: '' }, port: 1434 }))
  assert.equal(await store.loginAccepted(config.id, login), false)
  assert.equal(secrets.size, 0)
  await store.signIn(config.id, 'bob', 's3cret', true)
  await store.delete(config.id)
  assert.equal(await store.loginAccepted(config.id, login), false)
})

test('a refused login given at sign-in is forgotten, and the next sign-in state says why; a remembered one is kept', async () => {
  const config = await store.save(input({ auth: { kind: 'sql', user: '' } }))
  await store.signIn(config.id, 'bob', 'wrong', false)
  const login = await store.sqlLogin(config)
  store.loginRefused(config.id, login, "Login failed for user 'bob'.")
  await assert.rejects(store.sqlLogin(config), credentialsRequired)
  assert.deepEqual(await store.signInState(config.id), { needed: true, name: 'Local', user: 'bob', failure: "Login failed for user 'bob'." })
  await store.signIn(config.id, 'bob', 'right', false)
  assert.equal((await store.signInState(config.id)).failure, undefined)

  const kept = await store.save(input({ name: 'Kept', password: 'old' }))
  const remembered = await store.sqlLogin(kept)
  store.loginRefused(kept.id, remembered, 'Login failed')
  assert.deepEqual(await store.sqlLogin(kept), remembered)
})

test('a password is only saved with the user it is for', async () => {
  await assert.rejects(store.save(input({ auth: { kind: 'sql', user: ' ' }, password: 'x' })), /Enter the user this password is for/)
  assert.equal(secrets.size, 0)
})

test('whether a password is saved is read from the secrets once, then kept up to date', async () => {
  let reads = 0
  const get = (store as unknown as { orca: { secrets: { get: (k: string) => Promise<string | null> } } }).orca.secrets
  const original = get.get
  get.get = async (k) => (reads++, original(k))
  const config = await store.save(input({ password: 'p' }))
  assert.equal(await store.passwordSaved(config.id), true)
  assert.equal(await store.passwordSaved(config.id), true)
  assert.equal(reads, 0, 'known from the save')
  const fresh = new ConnectionStore((store as unknown as { orca: never }).orca)
  assert.equal(await fresh.passwordSaved(config.id), true)
  assert.equal(await fresh.passwordSaved(config.id), true)
  assert.equal(reads, 1)
  await fresh.save(input({ id: config.id, forgetPassword: true }))
  assert.equal(await fresh.passwordSaved(config.id), false)
  await fresh.signIn(config.id, 'sa', 'q', true)
  await fresh.loginAccepted(config.id, await fresh.sqlLogin(config))
  assert.equal(await fresh.passwordSaved(config.id), true)
  await fresh.delete(config.id)
  assert.equal(reads, 1)
})

test("a refused login's reason is shown for a short while only", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const config = await store.save(input({ auth: { kind: 'sql', user: '' } }))
  await store.signIn(config.id, 'bob', 'wrong', false)
  store.loginRefused(config.id, await store.sqlLogin(config), 'Login failed')
  assert.equal((await store.signInState(config.id)).failure, 'Login failed')
  t.mock.timers.tick(60_000)
  assert.deepEqual(await store.signInState(config.id), { needed: true, name: 'Local', user: 'bob' })
})
