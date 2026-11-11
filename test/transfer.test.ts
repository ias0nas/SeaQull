// Export and import of saved connections: the file, matching against saved ones, batching.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectionConfig, ConnectionInput } from '../src/protocol.ts'
import { connectionsFile, importBatches, MAX_FILE_BYTES, MAX_IMPORT, parseConnectionsFile } from '../src/shared/connection-file.ts'
import { ConnectionStore, LIMITS, MAX_CONNECTIONS, normalize, pageOf } from '../worker/connections.ts'
import { exportConnections, importOutcome, ImportStaging, planImport } from '../worker/transfer.ts'

const config = (name: string, extra: Partial<ConnectionInput> = {}): ConnectionConfig =>
  normalize({ name, server: 'db.example', port: 1433, database: '', auth: { kind: 'sql', user: 'sa' }, encrypt: true, trustServerCertificate: false, ...extra })

function memoryStore() {
  const storage = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  let writes = 0
  const host = {
    storage: { get: async (k: string) => structuredClone(storage.get(k) ?? null), set: async (k: string, v: unknown) => (writes++, void storage.set(k, structuredClone(v))) },
    secrets: { get: async (k: string) => secrets.get(k) ?? null, set: async (k: string, v: string) => void secrets.set(k, v), delete: async (k: string) => void secrets.delete(k) }
  }
  return { store: new ConnectionStore(host as never), storage, secrets, writes: () => writes }
}

test('the file: stable, pretty JSON with no ids and no passwords', async () => {
  const { store } = memoryStore()
  await store.save({ ...config('Prod', { folder: 'Clients/Acme', color: '#ff0000' }), id: undefined, password: 'hunter2' })
  await store.save({ ...config('Az', { auth: { kind: 'entra' } }), id: undefined })
  await store.save({ ...config('Nobody', { auth: { kind: 'sql', user: '' } }), id: undefined })
  const { text, count } = exportConnections(await store.list())
  assert.equal(count, 3)
  assert.ok(!text.includes('hunter2') && !text.includes('"id"') && !text.includes('password'))
  assert.ok(text.endsWith('}\n') && text.includes('\n  "connections": [\n'))
  const file = JSON.parse(text)
  assert.deepEqual(Object.keys(file), ['format', 'version', 'connections'])
  assert.deepEqual(file.connections[0], {
    name: 'Prod', folder: 'Clients/Acme', server: 'db.example', port: 1433, database: '', auth: { kind: 'sql', user: 'sa' },
    encrypt: true, trustServerCertificate: false, color: '#ff0000'
  })
  assert.deepEqual(file.connections[1].auth, { kind: 'entra' })
  assert.deepEqual(file.connections[2].auth, { kind: 'sql' })
  assert.equal(exportConnections(await store.list()).text, text, 'the same every time')
})

test('a folder exports with its subfolders, not folders that only start alike', () => {
  const all = [config('a', { folder: 'Clients/Acme' }), config('b', { folder: 'Clients/Acme/Prod' }), config('c', { folder: 'Clients/Acme Two' }), config('d')]
  assert.deepEqual(JSON.parse(exportConnections(all, 'Clients/Acme').text).connections.map((c: { name: string }) => c.name), ['a', 'b'])
  assert.equal(exportConnections(all, 'Nowhere').count, 0)
})

test('round trip into an empty store, new ids; importing the same file again changes nothing', async () => {
  const source = [config('Prod', { folder: 'Clients/Acme', color: '#00ff00' }), config('Dev', { database: 'AW', encrypt: false }), config('Az', { auth: { kind: 'entra' } })]
  const entries = parseConnectionsFile(connectionsFile(source))
  const { store, storage, writes } = memoryStore()
  const { items } = await store.importConnections(entries)
  assert.deepEqual(items.map((i) => i.status), ['new', 'new', 'new'])
  const imported = await store.list()
  assert.deepEqual(imported.map(({ id, ...rest }) => rest), source.map(({ id, ...rest }) => rest))
  assert.ok(imported.every((c, i) => c.id !== source[i].id && /^[0-9a-f-]{36}$/.test(c.id)))
  assert.equal(writes(), 1, 'one write')
  const before = JSON.stringify(storage.get('connections'))
  const again = (await store.importConnections(entries)).items
  assert.deepEqual(again.map((i) => i.status), ['existing', 'existing', 'existing'])
  assert.equal(JSON.stringify(storage.get('connections')), before)
  assert.equal(writes(), 1, 'nothing to write')
})

test('the same name with other settings is imported as "Name (2)", "(3)"…, also against names earlier in the file', () => {
  const saved = [config('Prod'), config('Prod (2)', { server: 'two' })]
  const file = [config('Prod', { server: 'other' }), config('Prod', { server: 'third' }), config('Prod', { server: 'third' }), config('Prod', { folder: 'X', color: '#123456', auth: { kind: 'sql', user: 'bob' } })]
  const { items, added } = planImport(saved, parseConnectionsFile(connectionsFile(file)))
  assert.deepEqual(items.map((i) => [i.status, i.name, i.newName]), [
    ['renamed', 'Prod', 'Prod (3)'],
    ['renamed', 'Prod', 'Prod (4)'],
    ['existing', 'Prod', 'Prod (4)'],
    ['existing', 'Prod', undefined]
  ])
  assert.deepEqual(added.map((c) => [c.name, c.server]), [['Prod (3)', 'other'], ['Prod (4)', 'third']])
  // Importing the same file again finds the copies it made.
  const again = planImport([...saved, ...added], parseConnectionsFile(connectionsFile(file)))
  assert.deepEqual(again.items.map((i) => [i.status, i.newName]), [['existing', 'Prod (3)'], ['existing', 'Prod (4)'], ['existing', 'Prod (4)'], ['existing', undefined]])
  assert.equal(again.added.length, 0)
  // Names with characters that mean something in a pattern.
  const odd = [config('a.b (x)+')]
  assert.equal(planImport(odd, parseConnectionsFile(connectionsFile([config('a.b (x)+', { server: 'other' })]))).added[0].name, 'a.b (x)+ (2)')
})

test('invalid entries are listed with why and skipped; the rest still import', () => {
  const entries = [
    { name: 'Good', server: 's', auth: { kind: 'sql' } },
    null,
    { server: 's', auth: { kind: 'sql' } },
    { name: 'No server', auth: { kind: 'sql' } },
    { name: 'Bad port', server: 's', port: 99999, auth: { kind: 'sql' } },
    { name: 'Bad auth', server: 's', auth: { kind: 'kerberos' } },
    { name: 'Bad colour', server: 's', auth: { kind: 'sql' }, color: 'blue' },
    { name: 'Bad flag', server: 's', auth: { kind: 'sql' }, encrypt: 'yes' },
    { tooLarge: true, name: 'Huge' },
    { name: 'Sneaky', server: 's', auth: { kind: 'sql' }, id: 'chosen', password: 'p' }
  ]
  const { items, added } = planImport([], entries)
  assert.deepEqual(items.map((i) => [i.status, i.name, i.reason]), [
    ['new', 'Good', undefined],
    ['invalid', '(no name)', 'No name'],
    ['invalid', '(no name)', 'No name'],
    ['invalid', 'No server', 'No server'],
    ['invalid', 'Bad port', 'Port must be a whole number from 1 to 65535'],
    ['invalid', 'Bad auth', 'Authentication must be sql or entra'],
    ['invalid', 'Bad colour', 'The colour must be #rrggbb'],
    ['invalid', 'Bad flag', 'encrypt must be true or false'],
    ['invalid', 'Huge', 'Too large'],
    ['new', 'Sneaky', undefined]
  ])
  assert.notEqual(added[1].id, 'chosen')
  assert.ok(!('password' in added[1]))
})

test('the file is checked: JSON, format, version (a newer one refused), a list, the size of the list', () => {
  assert.throws(() => parseConnectionsFile('nope'), /not a JSON file/)
  assert.throws(() => parseConnectionsFile('{"format":"other","version":1,"connections":[]}'), /not a SeaQull connections file/)
  assert.throws(() => parseConnectionsFile('{"format":"seaqull-connections","version":2,"connections":[]}'), /newer SeaQull \(format version 2\)/)
  assert.throws(() => parseConnectionsFile('{"format":"seaqull-connections","version":0,"connections":[]}'), /no valid version/)
  assert.throws(() => parseConnectionsFile('{"format":"seaqull-connections","version":1}'), /no list of connections/)
  const many = JSON.stringify({ format: 'seaqull-connections', version: 1, connections: Array.from({ length: MAX_IMPORT + 1 }, () => ({})) })
  assert.throws(() => parseConnectionsFile(many), /at most 2,000/)
  assert.deepEqual(parseConnectionsFile('{"format":"seaqull-connections","version":1,"connections":[{"name":"a"}]}'), [{ name: 'a' }])
})

test('batches keep each request well under the 64 KiB input cap, in order; an entry too large on its own becomes a stub', () => {
  const entries = Array.from({ length: 1500 }, (_, i) => ({ ...config(`Connection ${i} ${'é'.repeat(i % 50)}`, { folder: 'Clients/Ünïcode/😀' }), id: undefined }))
  entries.splice(700, 0, { ...entries[0], name: `Huge ${'x'.repeat(100_000)}` })
  const batches = importBatches(entries)
  assert.ok(batches.length > 1)
  for (const batch of batches) {
    const request = JSON.stringify({ importId: '00000000-0000-0000-0000-000000000000', entries: batch })
    assert.ok(Buffer.byteLength(request) < 64 * 1024, `${Buffer.byteLength(request)} bytes`)
  }
  const flat = batches.flat() as { name?: string; tooLarge?: boolean }[]
  assert.equal(flat.length, entries.length)
  assert.deepEqual(flat[700], { tooLarge: true, name: `Huge ${'x'.repeat(195)}` })
  assert.equal(flat[701].name, entries[701].name)
})

test('staged imports: parts add up, at most 2,000 entries, an unknown id is refused', () => {
  const staging = new ImportStaging()
  const { importId } = staging.append(undefined, [1, 2])
  assert.deepEqual(staging.append(importId, [3]), { importId, count: 3 })
  assert.deepEqual(staging.entries(importId), [1, 2, 3])
  assert.throws(() => staging.append(importId, Array.from({ length: MAX_IMPORT }, () => 0)), /at most 2000/)
  assert.throws(() => staging.append('nope', []), /expired/)
  staging.drop(importId)
  assert.throws(() => staging.entries(importId), /expired/)
})

test('two imports at once: the second sees the first, so no name is used twice', async () => {
  const { store } = memoryStore()
  await store.save({ ...config('Prod'), id: undefined })
  const file = parseConnectionsFile(connectionsFile([config('Prod', { server: 'other' })]))
  const [a, b] = (await Promise.all([store.importConnections(file), store.importConnections(file)])).map((r) => r.items)
  assert.deepEqual([a[0].newName, b[0].status], ['Prod (2)', 'existing'])
  assert.deepEqual((await store.list()).map((c) => c.name), ['Prod', 'Prod (2)'])
})

test('field caps, shared by the dialog and imports, with clear messages', () => {
  const tooLong = (n: number) => 'x'.repeat(n + 1)
  const cases: [Partial<ConnectionInput>, RegExp][] = [
    [{ name: tooLong(LIMITS.name) }, /Name must be at most 128 characters/],
    [{ server: tooLong(LIMITS.server) }, /Server must be at most 255 characters/],
    [{ database: tooLong(LIMITS.database) }, /Database must be at most 128 characters/],
    [{ auth: { kind: 'sql', user: tooLong(LIMITS.user) } }, /User must be at most 128 characters/],
    [{ folder: tooLong(LIMITS.folder) }, /Folder must be at most 255 characters/],
    [{ folder: Array.from({ length: 11 }, (_, i) => `f${i}`).join('/') }, /at most 10 levels/],
    [{ name: 'tab\there' }, /Name must not contain control characters/],
    [{ server: 'a\nb' }, /Server must not contain control characters/]
  ]
  for (const [extra, message] of cases) assert.throws(() => config('ok', extra), message, JSON.stringify(extra).slice(0, 60))
  assert.doesNotThrow(() => config('x'.repeat(LIMITS.name), { folder: Array.from({ length: 10 }, () => 'f').join('/') }))
})

test('port: a whole number 1–65535, or a string of digits; anything else is invalid', () => {
  const entry = (port: unknown) => ({ name: 'p', server: 's', auth: { kind: 'sql' }, port })
  const { items, added } = planImport([], [entry(1433), entry('1434'), entry(true), entry([1433]), entry('14 33'), entry(1.5), entry(0), entry('99999'), entry(null)])
  assert.deepEqual(items.map((i) => i.status), ['new', 'renamed', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid'])
  assert.deepEqual(added.map((c) => c.port), [1433, 1434])
  assert.ok(items.slice(2).every((i) => i.reason === 'Port must be a whole number from 1 to 65535'))
})

test('connections with encryption off or trusting any certificate are flagged in the preview', () => {
  const file = [config('a', { encrypt: false }), config('b', { trustServerCertificate: true }), config('c', { encrypt: false, trustServerCertificate: true }), config('d')]
  const { items } = planImport([], parseConnectionsFile(connectionsFile(file)))
  assert.deepEqual(items.map((i) => i.risky), [['not encrypted'], ['trusts any certificate'], ['not encrypted', 'trusts any certificate'], undefined])
})

test('at most 2,000 saved connections: a new one past that, or an import that would pass it, is refused', async () => {
  const { store, storage } = memoryStore()
  storage.set('connections', Array.from({ length: MAX_CONNECTIONS - 1 }, (_, i) => config(`c${i}`)))
  const last = await store.save({ ...config('last'), id: undefined })
  await assert.rejects(store.save({ ...config('one more'), id: undefined }), /at most 2,000 connections/)
  await store.save({ ...last, color: '#ff0000' })
  storage.set('connections', (storage.get('connections') as ConnectionConfig[]).slice(3))
  const file = parseConnectionsFile(connectionsFile([config('n1'), config('n2'), config('n3'), config('n4')]))
  await assert.rejects(store.importConnections(file), /Only 3 more connections fit \(SeaQull keeps at most 2,000\), and this file would add 4/)
  assert.equal((storage.get('connections') as unknown[]).length, MAX_CONNECTIONS - 3, 'nothing written')
})

test('at the caps, with every field as long as allowed: the list and the plan page under 1 MiB, the file stays under the read limit, and it imports back', () => {
  const wide = (n: number, i: number) => `${i}`.padEnd(n, '€') // 3 bytes a character in UTF-8
  const all = Array.from({ length: MAX_CONNECTIONS }, (_, i) =>
    config(wide(LIMITS.name, i), {
      server: wide(LIMITS.server, i),
      database: wide(LIMITS.database, i),
      auth: { kind: 'sql', user: wide(LIMITS.user, i) },
      folder: Array.from({ length: LIMITS.folderLevels }, () => '€'.repeat(24)).join('/'),
      color: '#123456'
    })
  )
  const { text } = exportConnections(all)
  assert.ok(Buffer.byteLength(text) < MAX_FILE_BYTES, `${Buffer.byteLength(text)} bytes`)
  const ONE_MIB = 1024 * 1024
  for (const list of [all.map((c) => ({ ...c, passwordSaved: true })), planImport([], parseConnectionsFile(text)).items]) {
    let pages = 0
    for (let offset: number | null = 0; offset !== null; pages++) {
      const page: { items: unknown[]; next: number | null } = pageOf(list as unknown[], offset)
      assert.ok(Buffer.byteLength(JSON.stringify({ items: page.items, next: page.next, room: 0 })) < ONE_MIB * 0.75)
      offset = page.next
    }
    assert.ok(pages > 1)
  }
  const { items, added } = planImport([], parseConnectionsFile(text))
  assert.equal(added.length, MAX_CONNECTIONS)
  assert.ok(items.every((i) => i.status === 'new'))
  for (const batch of importBatches(parseConnectionsFile(text))) assert.ok(!(batch as { tooLarge?: boolean }[]).some((e) => e.tooLarge))
})

test('staged imports are dropped when used or cancelled, after the TTL, and the oldest when a fifth starts', async () => {
  const staging = new ImportStaging(30)
  const ids = Array.from({ length: 4 }, () => staging.append(undefined, [1]).importId)
  assert.equal(staging.size, 4)
  const fifth = staging.append(undefined, [2]).importId
  assert.equal(staging.size, 4)
  assert.throws(() => staging.entries(ids[0]), /expired/, 'the oldest went')
  staging.drop(ids[1])
  assert.throws(() => staging.entries(ids[1]), /expired/)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(staging.size, 0, 'the TTL holds without further calls')
  assert.throws(() => staging.entries(fifth), /expired/)
})

test('what an import reports: added (with the renamed), and how many sign in with a SQL login', () => {
  const saved = [config('Prod')]
  const file = parseConnectionsFile(connectionsFile([config('Prod', { server: 'other' }), config('Az', { auth: { kind: 'entra' } }), config('Prod'), config('New')]))
  assert.deepEqual(importOutcome(planImport(saved, [...file, { name: 'bad' }])), { added: 3, renamed: 1, existing: 1, invalid: 1, sqlLogins: 2 })
})
