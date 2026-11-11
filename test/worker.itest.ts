// Drives the real worker (activate) through a fake Orca host against the local dev SQL Server,
// checking every answer is strict plain JSON: Orca refuses answers containing `undefined`.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { CompletionNames, ObjectColumns } from '../src/protocol.ts'
import { completeNames, nameContext, nameIndex, objectKey, planCompletion } from '../src/shared/sql-names.ts'
import { scanStatement } from '../src/shared/sql-statement.ts'
import { sendRun } from '../src/shared/upload.ts'
import activate, { deactivate } from '../worker/main.ts'

type Handler = (input: unknown, context: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
const storage = new Map<string, unknown>()
const secrets = new Map<string, string>()
const statusBar: unknown[] = []
const logs: string[] = []

const fakeOrca = {
  host: {
    call: async (method: string, params: unknown) => {
      if (method !== 'statusBar.update') throw new Error(`unexpected host call ${method}`)
      statusBar.push(params)
      return { ok: true }
    }
  },
  log: (message: string) => void logs.push(message),
  panels: { handle: (name: string, handler: Handler) => (handlers.set(name, handler), { dispose() {} }), post() {} },
  storage: {
    get: async (key: string) => storage.get(key) ?? null,
    set: async (key: string, value: unknown) => void storage.set(key, value),
    delete: async (key: string) => void storage.delete(key),
    keys: async () => [...storage.keys()],
    onDidChange: () => ({ dispose() {} })
  },
  secrets: {
    get: async (key: string) => secrets.get(key) ?? null,
    set: async (key: string, value: string) => void secrets.set(key, value),
    delete: async (key: string) => void secrets.delete(key)
  },
  settings: { get: async (key: string) => (key === 'maxRows' ? 500 : ''), set: async () => {}, onDidChange: () => ({ dispose() {} }) }
}

const context = { panel: { id: 'editor-1', surface: 'editor', contributionId: 'console' }, signal: new AbortController().signal }

/** Calls a handler and asserts its answer survives JSON exactly (no undefined, NaN, Dates…). */
async function call<T = any>(name: string, input: unknown): Promise<T> {
  const handler = handlers.get(name)
  assert.ok(handler, `no handler ${name}`)
  const answer = await handler(input, context)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(answer)), answer, `${name} answered non-JSON values`)
  return answer as T
}

let connectionId = ''

before(async () => {
  await activate(fakeOrca as never)
  const saved = await call('connections.save', {
    name: 'Local', server: 'localhost', port: Number(process.env.MSSQL_PORT ?? 1433), database: '',
    auth: { kind: 'sql', user: 'sa' }, password: process.env.MSSQL_SA_PASSWORD, encrypt: true, trustServerCertificate: true
  })
  connectionId = saved.id
})
after(() => deactivate()) // closes the worker's sessions and explorer connections

test('password goes to secrets, never to storage', () => {
  assert.ok(!JSON.stringify([...storage.values()]).includes(process.env.MSSQL_SA_PASSWORD!))
  assert.equal([...secrets.values()][0], process.env.MSSQL_SA_PASSWORD)
})

test('tree answers are plain JSON at every level', async () => {
  const [root] = await call('tree.children', { key: '' })
  const dbs = await call('tree.children', { key: root.key })
  const aw = dbs.find((d: any) => d.label === 'AdventureWorks2022')
  const schemas = await call('tree.children', { key: aw.key })
  const folders = await call('tree.children', { key: schemas.find((s: any) => s.label === 'Sales').key })
  const tables = await call('tree.children', { key: folders[0].key })
  const columns = await call('tree.children', { key: tables[0].key })
  assert.ok(columns.length > 0)
})

test('a connection in a folder: the folder levels, then its own levels under the folder keys; renaming the folder moves it', async () => {
  const saved = await call('connections.save', {
    name: 'Foldered', folder: 'Team/Dev', server: 'localhost', port: Number(process.env.MSSQL_PORT ?? 1433), database: '',
    auth: { kind: 'sql', user: 'sa' }, password: process.env.MSSQL_SA_PASSWORD, encrypt: true, trustServerCertificate: true
  })
  try {
    const root = await call('tree.children', { key: '' })
    const team = root.find((n: any) => n.kind === 'group' && n.label === 'Team')
    assert.ok(team, JSON.stringify(root))
    assert.ok(root.findIndex((n: any) => n.kind === 'group') < root.findIndex((n: any) => n.kind === 'connection'))
    const [dev] = await call('tree.children', { key: team.key })
    assert.deepEqual([dev.kind, dev.label], ['group', 'Dev'])
    const [connection] = await call('tree.children', { key: dev.key })
    assert.deepEqual([connection.kind, connection.label, connection.key], ['connection', 'Foldered', `g:Team/g:Dev/c:${saved.id}`])
    const dbs = await call('tree.children', { key: connection.key })
    const aw = dbs.find((d: any) => d.label === 'AdventureWorks2022')
    assert.equal(aw.key, `g:Team/g:Dev/c:${saved.id}/d:AdventureWorks2022`)
    const schemas = await call('tree.children', { key: aw.key })
    assert.ok(schemas.length > 0 && schemas.every((n: any) => n.key.startsWith(`${aw.key}/s:`)), JSON.stringify(schemas.slice(0, 2)))

    assert.deepEqual(await call('connections.renameFolder', { from: 'Team', to: 'Squad' }), { moved: 1 })
    const [moved] = await call('tree.children', { key: 'g:Squad/g:Dev' })
    assert.equal(moved.key, `g:Squad/g:Dev/c:${saved.id}`)
  } finally {
    await call('connections.delete', { id: saved.id })
  }
})

test('a connection without a saved login: requests ask for one; a wrong one given at sign-in is refused, then forgotten', async () => {
  const base = { server: 'localhost', port: Number(process.env.MSSQL_PORT ?? 1433), database: '', encrypt: true, trustServerCertificate: true }
  const saved = await call('connections.save', { ...base, name: 'No login', auth: { kind: 'sql', user: '' } })
  try {
    assert.ok(!(await call('connections.list', {})).find((c: any) => c.id === saved.id).passwordSaved)
    const key = `c:${saved.id}`
    await assert.rejects(call('tree.children', { key }), /Sign in to No login/)
    await assert.rejects(call('databases.list', { connectionId: saved.id }), /Sign in to No login/)
    await assert.rejects(call('query.run', { consoleId: 'tab-login', connectionId: saved.id, database: '', sql: 'SELECT 1', firstLine: 1 }), /Sign in to No login/)
    assert.deepEqual(await call('connections.signInState', { id: saved.id }), { needed: true, name: 'No login', user: '' })
    assert.deepEqual(await call('connections.test', { ...base, id: saved.id, name: 'No login', auth: { kind: 'sql', user: 'sa' } }), { ok: false, error: 'Enter a user and password to test.' })

    await call('connections.signIn', { id: saved.id, user: 'sa', password: 'wrong', remember: false })
    // Not an error row: the page asks again, with why.
    await assert.rejects(call('tree.children', { key }), /Login failed/)
    const state = await call('connections.signInState', { id: saved.id })
    assert.equal(state.needed, true)
    assert.match(state.failure, /Login failed/)

    await call('connections.signIn', { id: saved.id, user: 'sa', password: process.env.MSSQL_SA_PASSWORD, remember: false })
    assert.ok((await call('tree.children', { key })).some((n: any) => n.label === 'master'))
    assert.ok(!JSON.stringify([...storage.values()]).includes(process.env.MSSQL_SA_PASSWORD!) && ![...secrets.keys()].includes(`password:${saved.id}`), 'not remembered')

  } finally {
    await call('connections.delete', { id: saved.id })
  }
})

test('a sign-in to remember is saved only once the server accepts it', async () => {
  const base = { server: 'localhost', port: Number(process.env.MSSQL_PORT ?? 1433), database: '', encrypt: true, trustServerCertificate: true }
  const saved = await call('connections.save', { ...base, name: 'Remember me', auth: { kind: 'sql', user: '' } })
  const key = `c:${saved.id}`
  try {
    await call('connections.signIn', { id: saved.id, user: 'sa', password: 'typo', remember: true })
    await assert.rejects(call('tree.children', { key }), /Login failed/)
    assert.ok(![...secrets.keys()].includes(`password:${saved.id}`), 'a refused login is not saved')
    assert.deepEqual((await call('connections.list', {})).find((c: any) => c.id === saved.id).auth, { kind: 'sql', user: '' })
    assert.equal((await call('connections.signInState', { id: saved.id })).needed, true)
    await call('connections.signIn', { id: saved.id, user: 'sa', password: process.env.MSSQL_SA_PASSWORD, remember: true })
    assert.ok((await call('tree.children', { key })).some((n: any) => n.label === 'master'))
    const listed = (await call('connections.list', {})).find((c: any) => c.id === saved.id)
    assert.deepEqual([listed.auth, listed.passwordSaved], [{ kind: 'sql', user: 'sa' }, true])
  } finally {
    await call('connections.delete', { id: saved.id })
  }
})

test('a sign-in whose database cannot be opened is kept: only a refused login is forgotten', async () => {
  const base = { server: 'localhost', port: Number(process.env.MSSQL_PORT ?? 1433), encrypt: true, trustServerCertificate: true }
  const saved = await call('connections.save', { ...base, database: 'NoSuchDatabase', name: 'No such database', auth: { kind: 'sql', user: '' } })
  try {
    await call('connections.signIn', { id: saved.id, user: 'sa', password: process.env.MSSQL_SA_PASSWORD, remember: false })
    const [failed] = await call('tree.children', { key: `c:${saved.id}` })
    assert.equal(failed.kind, 'error')
    assert.match(failed.label, /Cannot open database/)
    assert.equal((await call('connections.signInState', { id: saved.id })).needed, false, 'the login is kept')
  } finally {
    await call('connections.delete', { id: saved.id })
  }
})

test('tree errors come back as an error node', async () => {
  const nodes = await call('tree.children', { key: 'c:no-such-connection' })
  assert.equal(nodes[0].kind, 'error')
})

test('run → status → rows → export, all plain JSON', async () => {
  const { runId } = await call('query.run', { consoleId: 'tab-a', connectionId, database: 'AdventureWorks2022', sql: "PRINT 'hi'\nSELECT TOP 3 * FROM Sales.Customer", firstLine: 1 })
  let status: any
  // A real delay: awaiting only resolved promises would starve the socket I/O the query needs.
  for (status = await call('query.status', { runId }); status.state === 'running'; status = await call('query.status', { runId })) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.equal(status.state, 'done')
  assert.equal(status.messages[0].text, 'hi')
  const page = await call('query.rows', { runId, result: 0, offset: 0, limit: 10 })
  assert.equal(page.rows.length, 3)
  const exp = await call('export.prepare', { runId, result: 0, format: 'json' })
  const { text } = await call('export.chunk', { exportId: exp.exportId, offset: 0 })
  assert.equal(JSON.parse(text).length, 3)
})

test('databases.list feeds the editor picker', async () => {
  const names = await call<string[]>('databases.list', { connectionId })
  assert.ok(names.includes('WideWorldImporters'))
})

test('each console id has its own session and latest run (Orca gives every console page the same caller id)', async () => {
  const run = (consoleId: string, sql: string) => call('query.run', { consoleId, connectionId, database: '', sql, firstLine: 1 })
  const waitDone = async (runId: string) => {
    while ((await call('query.status', { runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
  }
  const a = await run('tab-a', 'CREATE TABLE #mine (n int); INSERT #mine VALUES (1); SELECT n FROM #mine')
  await waitDone(a.runId)
  const b = await run('tab-b', 'SELECT OBJECT_ID(\'tempdb..#mine\') AS other_tabs_temp_table')
  await waitDone(b.runId)
  // Same Orca caller for both, yet separate sessions: tab-b cannot see tab-a's temp table.
  const rows = await call('query.rows', { runId: b.runId, result: 0, offset: 0, limit: 10 })
  assert.deepEqual(rows.rows, [[null]])
  assert.equal((await call('query.latest', { consoleId: 'tab-a' })).status.runId, a.runId)
  assert.equal((await call('query.latest', { consoleId: 'tab-b' })).status.runId, b.runId)
  assert.deepEqual(await call('query.latest', { consoleId: 'tab-c' }), { status: null })
  await assert.rejects(call('query.latest', { consoleId: '../etc' }), /consoleId/)
})

test('query.close ends a tab session: its results and temp tables are gone', async () => {
  const run = await call('query.run', { consoleId: 'tab-close', connectionId, database: '', sql: 'CREATE TABLE #gone (n int); SELECT 1 AS one', firstLine: 1 })
  while ((await call('query.status', { runId: run.runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(await call('query.close', { consoleId: 'tab-close' }), { ok: true })
  assert.deepEqual(await call('query.latest', { consoleId: 'tab-close' }), { status: null })
  const again = await call('query.run', { consoleId: 'tab-close', connectionId, database: '', sql: "SELECT OBJECT_ID('tempdb..#gone') AS t", firstLine: 1 })
  while ((await call('query.status', { runId: again.runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual((await call('query.rows', { runId: again.runId, result: 0, offset: 0, limit: 1 })).rows, [[null]])
})

test('connection colours are normalised, and bad ones dropped', async () => {
  const base = { server: 'localhost', port: 1433, database: '', auth: { kind: 'sql', user: 'sa' }, encrypt: true, trustServerCertificate: true }
  assert.equal((await call('connections.save', { ...base, name: 'Coloured', color: '#E5534B' })).color, '#e5534b')
  assert.equal('color' in (await call('connections.save', { ...base, name: 'Plain', color: 'red' })), false)
})

test('saving only a new colour or name keeps open sessions (temp tables survive)', async () => {
  const wait = async (runId: string) => {
    while ((await call('query.status', { runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
  }
  const first = await call('query.run', { consoleId: 'tab-keep', connectionId, database: '', sql: 'CREATE TABLE #kept (n int)', firstLine: 1 })
  await wait(first.runId)
  const [config] = await call('connections.list', {})
  await call('connections.save', { ...config, color: '#3fb950', name: 'Local (green)' })
  const second = await call('query.run', { consoleId: 'tab-keep', connectionId, database: '', sql: "SELECT OBJECT_ID('tempdb..#kept') AS t", firstLine: 1 })
  await wait(second.runId)
  const rows = (await call('query.rows', { runId: second.runId, result: 0, offset: 0, limit: 1 })).rows
  assert.notEqual(rows[0][0], null, 'the session was reset by a cosmetic change')
})

test('completion.names: default schema, other schemas, bracketed names, synonyms, sys views qualified', async () => {
  const runToEnd = async (sql: string) => {
    const { runId } = await call('query.run', { consoleId: 'tab-names', connectionId, database: 'AdventureWorks2022', sql, firstLine: 1 })
    let status: any
    while ((status = await call('query.status', { runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
    assert.equal(status.state, 'done', JSON.stringify(status.messages))
  }
  const cleanup = `DROP SYNONYM IF EXISTS [seaqull test].syn; DROP TABLE IF EXISTS [seaqull test].[Order Details], [seaqull test].[select];
    IF SCHEMA_ID('seaqull test') IS NOT NULL DROP SCHEMA [seaqull test];`
  await runToEnd(`${cleanup}\nGO\nCREATE SCHEMA [seaqull test]\nGO\nCREATE TABLE [seaqull test].[Order Details] (n int); CREATE TABLE [seaqull test].[select] (n int);
    CREATE SYNONYM [seaqull test].syn FOR Sales.Customer;`)
  try {
    const names = await call<CompletionNames>('completion.names', { connectionId, database: 'AdventureWorks2022' })
    assert.ok(JSON.stringify(names).length < 1024 * 1024)
    assert.equal(names.defaultSchema, 'dbo') // sa's default schema
    assert.equal(names.database, 'AdventureWorks2022')
    assert.equal(names.caseSensitive, false)
    assert.equal(names.truncated, false)
    const schema = (name: string) => new Map(names.schemas.find((s) => s.name === name)?.objects)
    assert.equal(names.schemas[0].name, 'dbo', 'the default schema first')
    assert.equal(schema('dbo').get('uspGetBillOfMaterials'), 'p')
    assert.equal(schema('dbo').get('ufnGetContactInformation'), 'f')
    assert.equal(schema('Sales').get('Customer'), 't')
    assert.equal(schema('Sales').get('vIndividualCustomer'), 'v')
    assert.deepEqual([...schema('seaqull test')], [['Order Details', 't'], ['select', 't'], ['syn', 's']])
    assert.equal(schema('sys').get('objects'), 'v')
    assert.equal(schema('sys').get('dm_exec_sql_text'), 'f')
    assert.equal(schema('INFORMATION_SCHEMA').get('TABLES'), 'v')

    // As the editor sees them: brackets where needed, system views only qualified.
    const index = nameIndex(names)
    const at = (before: string) => completeNames(index, nameContext(before)!, false)?.options ?? []
    assert.deepEqual(at('FROM [seaqull test].').map((o) => o.apply ?? o.label), ['[Order Details]', '[select]', 'syn'])
    assert.ok(at('FROM sales.').some((o) => o.label === 'Customer'))
    assert.ok(at('FROM sys.').some((o) => o.label === 'tables'))
    assert.ok(!at('FROM ta').some((o) => o.label === 'tables'), 'sys views are not offered unqualified')
    assert.ok(index.top.some((o) => o.label === 'seaqull test' && o.apply === '[seaqull test]'))
  } finally {
    await runToEnd(cleanup)
  }
})

test('completion.names: each database its own; Microsoft-shipped objects left out; bad input refused', async () => {
  const wwi = await call<CompletionNames>('completion.names', { connectionId, database: 'WideWorldImporters' })
  assert.ok(wwi.schemas.some((s) => s.name === 'Warehouse'))
  assert.ok(!wwi.schemas.some((s) => s.name === 'HumanResources'))
  const master = await call<CompletionNames>('completion.names', { connectionId, database: 'master' })
  assert.ok(!master.schemas.find((s) => s.name === 'dbo')?.objects.some(([name]) => name === 'spt_values'))
  const fallback = await call<CompletionNames>('completion.names', { connectionId, database: '' })
  assert.ok(fallback.schemas.length > 0, "'' is the connection's default database")
  assert.equal(fallback.database, 'master', 'named, so the explorer can find it') // sa's default database
  await assert.rejects(call('completion.names', { connectionId: '', database: '' }), /connectionId/)
  await assert.rejects(call('completion.names', { connectionId: 'nope', database: '' }), /Unknown connection/)
  await assert.rejects(call('completion.names', { connectionId, database: 'x'.repeat(129) }), /database/)
})

test('completion.columns: tables, views, table-valued functions, synonyms; types and primary keys', async () => {
  const runToEnd = async (sql: string) => {
    const { runId } = await call('query.run', { consoleId: 'tab-columns', connectionId, database: 'AdventureWorks2022', sql, firstLine: 1 })
    let status: any
    while ((status = await call('query.status', { runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
    assert.equal(status.state, 'done', JSON.stringify(status.messages))
  }
  const cleanup = `DROP SYNONYM IF EXISTS [seaqull cols].syn, [seaqull cols].far; DROP FUNCTION IF EXISTS [seaqull cols].fnTop;
    DROP TABLE IF EXISTS [seaqull cols].[Order Details]; IF SCHEMA_ID('seaqull cols') IS NOT NULL DROP SCHEMA [seaqull cols];`
  await runToEnd(`${cleanup}\nGO\nCREATE SCHEMA [seaqull cols]\nGO
CREATE TABLE [seaqull cols].[Order Details] ([a]]b] int PRIMARY KEY, Note nvarchar(max) NULL, Price decimal(19,4), Who Name);
CREATE SYNONYM [seaqull cols].syn FOR Sales.Customer;
CREATE SYNONYM [seaqull cols].far FOR WideWorldImporters.Sales.Customers;
GO
CREATE FUNCTION [seaqull cols].fnTop (@n int) RETURNS TABLE AS RETURN (SELECT TOP (@n) CustomerID, AccountNumber FROM Sales.Customer)`)
  try {
    const objects = [
      { schema: 'Sales', name: 'Customer' },
      { schema: 'sales', name: 'vIndividualCustomer' }, // the catalog's collation decides: case-insensitive here
      { schema: 'dbo', name: 'ufnGetContactInformation' }, // multi-statement table-valued function
      { schema: 'seaqull cols', name: 'fnTop' }, // inline table-valued function
      { schema: 'seaqull cols', name: 'syn' },
      { schema: 'seaqull cols', name: 'far' }, // a synonym of another database's table: left out
      { schema: 'seaqull cols', name: 'Order Details' },
      { schema: 'Person', name: 'Person' },
      { schema: 'dbo', name: 'uspGetBillOfMaterials' }, // a procedure: left out
      { schema: 'dbo', name: "no'such" }
    ]
    const { objects: found } = await call<{ objects: ObjectColumns[] }>('completion.columns', { connectionId, database: 'AdventureWorks2022', objects })
    const byName = new Map(found.map((o) => [`${o.schema}.${o.name}`, o]))
    assert.deepEqual([...byName.keys()], ['Sales.Customer', 'sales.vIndividualCustomer', 'dbo.ufnGetContactInformation', 'seaqull cols.fnTop', 'seaqull cols.syn', 'seaqull cols.Order Details', 'Person.Person'])
    const column = (key: string, name: string) => byName.get(key)!.columns.find(([n]) => n === name)
    assert.deepEqual(column('Sales.Customer', 'CustomerID'), ['CustomerID', 'int', true])
    assert.deepEqual(column('Sales.Customer', 'AccountNumber'), ['AccountNumber', 'varchar(10)', false])
    assert.deepEqual(byName.get('Sales.Customer')!.columns.map(([n]) => n), byName.get('seaqull cols.syn')!.columns.map(([n]) => n), 'the synonym has its base table\'s columns')
    assert.deepEqual(column('sales.vIndividualCustomer', 'FirstName'), ['FirstName', 'Name', false]) // alias type
    assert.deepEqual(column('dbo.ufnGetContactInformation', 'FirstName'), ['FirstName', 'nvarchar(50)', false])
    assert.deepEqual(byName.get('seaqull cols.fnTop')!.columns, [['CustomerID', 'int', false], ['AccountNumber', 'varchar(10)', false]])
    assert.deepEqual(byName.get('seaqull cols.Order Details')!.columns, [['a]b', 'int', true], ['Note', 'nvarchar(max)', false], ['Price', 'decimal(19,4)', false], ['Who', 'Name', false]])
    assert.deepEqual(column('Person.Person', 'BusinessEntityID'), ['BusinessEntityID', 'int', true])
    assert.ok(found.every((o) => o.truncated === false))
  } finally {
    await runToEnd(cleanup)
  }
})

test('completion.columns: foreign keys both ways, in key order; disabled ones left out; JOIN conditions', async () => {
  const runToEnd = async (sql: string) => {
    const { runId } = await call('query.run', { consoleId: 'tab-keys', connectionId, database: 'AdventureWorks2022', sql, firstLine: 1 })
    let status: any
    while ((status = await call('query.status', { runId })).state === 'running') await new Promise((r) => setTimeout(r, 20))
    assert.equal(status.state, 'done', JSON.stringify(status.messages))
  }
  const cleanup = `DROP SYNONYM IF EXISTS [seaqull fk].syn;
    DROP TABLE IF EXISTS [seaqull fk].Note, [seaqull fk].[Order Line], [seaqull fk].[Order], [seaqull fk].Employee, [seaqull fk].Customer;
    IF SCHEMA_ID('seaqull fk') IS NOT NULL DROP SCHEMA [seaqull fk];`
  await runToEnd(`${cleanup}\nGO\nCREATE SCHEMA [seaqull fk]\nGO
CREATE TABLE [seaqull fk].Customer (Id int PRIMARY KEY);
CREATE TABLE [seaqull fk].[Order] (Id int, Region char(2), CustomerId int REFERENCES [seaqull fk].Customer (Id), PRIMARY KEY (Id, Region));
-- Columns in another order than the key's.
CREATE TABLE [seaqull fk].[Order Line] (Region char(2), Line int, [Order Id] int,
  CONSTRAINT FK_Line_Order FOREIGN KEY ([Order Id], Region) REFERENCES [seaqull fk].[Order] (Id, Region));
CREATE TABLE [seaqull fk].Employee (Id int PRIMARY KEY, ManagerId int REFERENCES [seaqull fk].Employee (Id));
CREATE TABLE [seaqull fk].Note (Id int, CustomerId int CONSTRAINT FK_Note_Customer REFERENCES [seaqull fk].Customer (Id));
ALTER TABLE [seaqull fk].Note NOCHECK CONSTRAINT FK_Note_Customer;
CREATE SYNONYM [seaqull fk].syn FOR [seaqull fk].Customer;`)
  try {
    const schema = 'seaqull fk'
    const object = (name: string) => ({ schema, name })
    const objects = ['Customer', 'Order', 'Order Line', 'Employee', 'Note', 'syn'].map(object)
    const answer = await call<{ objects: ObjectColumns[]; unsent: unknown[] }>('completion.columns', { connectionId, database: 'AdventureWorks2022', objects })
    const byName = new Map(answer.objects.map((o) => [o.name, o]))
    const orderCustomer = { from: object('Order'), to: object('Customer'), columns: [['CustomerId', 'Id']] }
    const lineOrder = { from: object('Order Line'), to: object('Order'), columns: [['Order Id', 'Id'], ['Region', 'Region']] }
    assert.deepEqual(byName.get('Customer')!.foreignKeys, [orderCustomer], 'referenced by Order; the disabled key from Note left out')
    assert.deepEqual([...byName.get('Order')!.foreignKeys].sort((a, b) => a.from.name.localeCompare(b.from.name)), [orderCustomer, lineOrder], 'held and referencing it')
    assert.deepEqual(byName.get('Order Line')!.foreignKeys, [lineOrder])
    assert.deepEqual(byName.get('Employee')!.foreignKeys, [{ from: object('Employee'), to: object('Employee'), columns: [['ManagerId', 'Id']] }], 'self-referencing: once')
    assert.deepEqual(byName.get('Note')!.foreignKeys, [])
    assert.deepEqual(byName.get('syn')!.base, object('Customer'))
    assert.deepEqual(byName.get('syn')!.foreignKeys, [orderCustomer], "a synonym: its base table's keys")
    assert.ok(!('base' in byName.get('Customer')!))

    // As the editor sees them.
    const index = nameIndex(await call<CompletionNames>('completion.names', { connectionId, database: 'AdventureWorks2022' }))
    const known = new Map(answer.objects.map((o) => [objectKey(o), o]))
    const joins = (sql: string) => {
      const cursor = sql.length
      const p = planCompletion(index, nameContext(sql)!, scanStatement(sql, cursor), false)
      assert.ok(p, sql)
      assert.ok(p.objects.every((o) => known.has(objectKey(o))), 'the objects were fetched above')
      return (p.complete(known)?.options ?? []).filter((o) => o.type === 'join').map((o) => o.label)
    }
    assert.deepEqual(joins('SELECT * FROM [seaqull fk].Customer c JOIN [seaqull fk].[Order] o ON '), ['o.CustomerId = c.Id'])
    assert.deepEqual(joins('SELECT * FROM [seaqull fk].[Order] o JOIN [seaqull fk].[Order Line] ON '), ['[Order Line].[Order Id] = o.Id AND [Order Line].Region = o.Region'])
    assert.deepEqual(joins('SELECT * FROM [seaqull fk].Employee e JOIN [seaqull fk].Employee m ON '), ['m.ManagerId = e.Id', 'm.Id = e.ManagerId'])
    assert.deepEqual(joins('SELECT * FROM [seaqull fk].syn s JOIN [seaqull fk].[Order] o ON '), ['o.CustomerId = s.Id'])
    assert.deepEqual(joins('SELECT * FROM [seaqull fk].Customer c JOIN [seaqull fk].Note n ON '), [])
  } finally {
    await runToEnd(cleanup)
  }
})

test('completion.columns: bad input refused', async () => {
  const objects = (n: number) => Array.from({ length: n }, (_, i) => ({ schema: 'dbo', name: `t${i}` }))
  assert.deepEqual(await call('completion.columns', { connectionId, database: 'AdventureWorks2022', objects: objects(50) }), { objects: [], unsent: [] })
  await assert.rejects(call('completion.columns', { connectionId, database: '', objects: objects(51) }), /objects/)
  await assert.rejects(call('completion.columns', { connectionId, database: '', objects: [{ schema: '', name: 'x' }] }), /objects/)
  await assert.rejects(call('completion.columns', { connectionId, database: '', objects: [{ schema: 'dbo', name: 'x'.repeat(129) }] }), /objects/)
  await assert.rejects(call('completion.columns', { connectionId, database: '', objects: 'dbo.x' }), /objects/)
  await assert.rejects(call('completion.columns', { connectionId: '', database: '', objects: [] }), /connectionId/)
  await assert.rejects(call('completion.columns', { connectionId: 'nope', database: '', objects: [] }), /Unknown connection/)
})

/** Polls a run to its end through the handlers. */
async function runThrough(consoleId: string, sql: string) {
  const request = async (name: string, input: Record<string, unknown>) => {
    // What Orca would refuse: more than 64 KiB of JSON input.
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 64 * 1024, `${name} input over 64 KiB`)
    return call(name, input)
  }
  const { runId } = await sendRun(request as never, { consoleId, connectionId, database: 'tempdb', sql, firstLine: 1 })
  for (;;) {
    const status = await call('query.status', { runId })
    if (status.state !== 'running') return status
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('a script of about 1 MB, heavy in quotes and newlines, is sent in parts and runs exactly', async () => {
  // 250 literals of 4,000 characters: doubled quotes, double quotes, newlines (each 2 bytes in JSON).
  // LF only: splitBatches turns CRLF into LF (the editor sends LF anyway).
  const chunk = `it''s "quoted"\n`.repeat(300).slice(0, 4000)
  const value = chunk.replace(/''/g, "'")
  const statements = Array.from({ length: 250 }, () => `INSERT #upload VALUES (N'${chunk}');`)
  const sql = `CREATE TABLE #upload (s nvarchar(max));\nGO\n${statements.join('\n')}\nGO\nSELECT COUNT(*) AS n, SUM(CAST(DATALENGTH(s) AS bigint)) / 2 AS chars, MIN(s) AS sample FROM #upload`
  assert.ok(Buffer.byteLength(JSON.stringify(sql)) > 1_000_000)
  const status = await runThrough('upload-1', sql)
  assert.equal(status.state, 'done', JSON.stringify(status.messages.slice(-3)))
  const { rows } = await call('query.rows', { runId: status.runId, result: 0, offset: 0, limit: 1 })
  assert.deepEqual(rows[0].slice(0, 2), [250, 250 * value.length])
  const prepared = await call('export.prepare', { runId: status.runId, result: 0, format: 'tsv', selection: { r0: 0, r1: 0, c0: 2, c1: 2 }, raw: true })
  assert.deepEqual(await call('export.chunk', { exportId: prepared.exportId, offset: 0 }), { text: value, next: null })
})

test('long values: a short preview in pages; copies and exports of the whole values through export.prepare', async () => {
  const status = await runThrough('tab-long', `SELECT REPLICATE(CAST(N'q' AS nvarchar(max)), 300000) AS q, CAST(REPLICATE(CAST(0xBEEF AS varbinary(max)), 300000) AS varbinary(max)) AS bin`)
  assert.equal(status.state, 'done', JSON.stringify(status.messages))
  const page = await call('query.rows', { runId: status.runId, result: 0, offset: 0, limit: 10 })
  assert.deepEqual(page.cut, [[0, 0, 300_000], [0, 1, 1_200_002]])
  const whole = async (input: Record<string, unknown>) => {
    const prepared = await call('export.prepare', { runId: status.runId, result: 0, ...input })
    let text = ''
    for (let offset: number | null = 0; offset !== null; ) {
      const chunk: { text: string; next: number | null } = await call('export.chunk', { exportId: prepared.exportId, offset })
      text += chunk.text
      offset = chunk.next
    }
    return text
  }
  const bin = `0x${'BEEF'.repeat(300_000)}`
  assert.equal(await whole({ format: 'tsv', selection: { r0: 0, r1: 0, c0: 0, c1: 0 }, raw: true }), 'q'.repeat(300_000))
  assert.equal(await whole({ format: 'tsv', selection: { r0: 0, r1: 0, c0: 1, c1: 1 }, raw: true }), bin)
  assert.equal(await whole({ format: 'csv', headers: false }), `${'q'.repeat(300_000)},${bin}\r\n`)
})

test('the status-bar item shows only for a query running past 3 seconds, and hides after', async () => {
  statusBar.length = 0
  await runThrough('quick', 'SELECT 1')
  assert.deepEqual(statusBar, [], 'a quick query does not show it')
  const status = await runThrough('slow', "WAITFOR DELAY '00:00:04'")
  assert.equal(status.state, 'done')
  assert.equal(statusBar.length, 2, JSON.stringify(statusBar))
  const { tooltip, ...shown } = statusBar[0] as { tooltip: string }
  assert.deepEqual(shown, { id: 'activity', text: 'SeaQull: 1 query running', icon: 'database', tone: 'accent', visible: true })
  assert.match(tooltip, /^Running: Local.* · tempdb$/) // connection name (an earlier test renames it) · database
  assert.deepEqual(statusBar[1], { id: 'activity', visible: false })
})
