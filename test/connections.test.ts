// The saved-connection store: validation, and where passwords go (secrets only, never storage).
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import type { ConnectionInput } from '../src/protocol.ts'
import { ConnectionStore, normalize } from '../worker/connections.ts'

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
  for (const bad of [{ name: ' ' }, { server: '' }, { port: 0 }, { port: 70000 }, { port: 1.5 }, { auth: { kind: 'sql' as const, user: ' ' } }]) {
    assert.throws(() => normalize(input(bad)), (err: Error & { code?: string }) => err.code === 'invalid_params', JSON.stringify(bad))
  }
  assert.deepEqual(normalize(input({ auth: { kind: 'entra' } })).auth, { kind: 'entra' })
})

test('passwords live in secrets; a blank one keeps the saved one', async () => {
  const saved = await store.save(input({ password: 'hunter2' }))
  assert.ok(!JSON.stringify([...storage.values()]).includes('hunter2'))
  assert.equal(await store.password(saved.id), 'hunter2')
  await store.save(input({ id: saved.id, name: 'Renamed' }))
  assert.equal(await store.password(saved.id), 'hunter2')
  assert.equal((await store.get(saved.id)).name, 'Renamed')
  assert.equal(await store.password(saved.id, 'typed'), 'typed', 'a typed password (Test) wins')
})

test('switching to Entra ID deletes the saved password; deleting removes both', async () => {
  const saved = await store.save(input({ password: 'hunter2' }))
  await store.save(input({ id: saved.id, auth: { kind: 'entra' } }))
  assert.equal(secrets.size, 0)
  await assert.rejects(store.password(saved.id), /No password saved/)
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
