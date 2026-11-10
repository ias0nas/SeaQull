// Integration tests against the local dev SQL Server (npm run db:up && npm run db:seed).
// Run with: npm run test:integration
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { Connection } from 'tedious'
import { completionColumns } from '../worker/completion.ts'
import { columnNodes, databaseNodes, decodeKey, encodeKey, folderNodes, listDatabases, objectNodes, schemaNodes } from '../worker/metadata.ts'
import { openConnection, queryRows, type Credentials, type Endpoint } from '../worker/mssql.ts'
import { exportResult } from '../src/shared/export.ts'
import { newSessionText, probeTransaction, RunManager, type SessionMemory, type Target } from '../worker/runs.ts'

const endpoint: Endpoint = { server: 'localhost', port: Number(process.env.MSSQL_PORT ?? 1433), database: 'AdventureWorks2022', encrypt: true, trustServerCertificate: true }
const credentials: Credentials = { kind: 'sql', user: 'sa', password: process.env.MSSQL_SA_PASSWORD ?? '' }
const target: Target = { connectionId: 'local', database: 'AdventureWorks2022', open: () => openConnection(endpoint, credentials) }

let connection: Connection
let runs: RunManager
let maxRows = 10_000

before(async () => {
  connection = await openConnection(endpoint, credentials)
  runs = new RunManager(async () => maxRows)
})
after(() => {
  connection.close()
  runs.dispose()
})

async function runToEnd(owner: string, sql: string, firstLine = 1) {
  const runId = await runs.start(owner, target, sql, firstLine)
  const deadline = Date.now() + 60_000
  for (;;) {
    const status = runs.status(runId)
    if (status.state !== 'running') return { runId, status }
    if (Date.now() > deadline) throw new Error(`run still going after 60 s: ${sql.slice(0, 80)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('a server given as an IP address connects over TLS (no SNI; Node 25 refuses an IP there)', async () => {
  const byIp = await openConnection({ ...endpoint, server: '127.0.0.1' }, credentials)
  try {
    const [row] = await queryRows(byIp, 'SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID')
    assert.equal(row.encrypt_option, 'TRUE')
  } finally {
    byIp.close()
  }
})

test('bad password gives a readable error', async () => {
  await assert.rejects(openConnection(endpoint, { ...credentials, password: 'nope' }), /Login failed/)
})

test('tree: databases → schemas → folders → tables → columns', async () => {
  const dbs = await databaseNodes(connection, { connection: 'local' })
  assert.ok(dbs.some((n) => n.label === 'AdventureWorks2022'))
  assert.equal(dbs.find((n) => n.label === 'master')?.description, 'system')

  const schemas = await schemaNodes(connection, decodeKey(encodeKey({ connection: 'local', database: 'AdventureWorks2022' })))
  assert.equal(schemas[0].label, 'dbo')
  assert.ok(schemas.some((n) => n.label === 'Sales'))

  const folders = folderNodes({ connection: 'local', database: 'AdventureWorks2022', schema: 'Sales' })
  assert.deepEqual(folders.map((f) => f.label), ['Tables', 'Views', 'Procedures', 'Functions'])

  const tables = await objectNodes(connection, decodeKey(folders[0].key))
  const header = tables.find((n) => n.label === 'SalesOrderHeader')!
  assert.match(header.description ?? '', /31,465 rows/)

  const columns = await columnNodes(connection, decodeKey(header.key))
  assert.equal(columns[0].label, 'SalesOrderID')
  assert.match(columns[0].description ?? '', /^int PK NOT NULL$/)
  assert.ok(columns.some((c) => c.description?.startsWith('nvarchar(25)')))
  // Alias types live in the object's database, not the metadata connection's (master).
  assert.match(columns.find((c) => c.label === 'AccountNumber')?.description ?? '', /^AccountNumber\b/)
  assert.deepEqual(decodeKey(columns[0].key), { ...decodeKey(header.key), column: 'SalesOrderID' })

  const procs = await objectNodes(connection, decodeKey(encodeKey({ connection: 'local', database: 'AdventureWorks2022', schema: 'dbo', folder: 'procedures' })))
  const params = await columnNodes(connection, decodeKey(procs.find((p) => p.label === 'uspGetBillOfMaterials')!.key))
  assert.deepEqual(params.map((p) => p.label), ['@StartProductID', '@CheckDate'])
})

test('database list: only databases the login can open, outside Azure SQL Database', async () => {
  const [{ edition }] = await queryRows(connection, "SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition")
  assert.notEqual(edition, 5, 'the dev server is not Azure SQL Database')
  const login = `seaqull_limited_${process.pid}`
  const password = `Aa1!${randomUUID()}`
  await queryRows(connection, `CREATE LOGIN [${login}] WITH PASSWORD = N'${password}', CHECK_POLICY = OFF`)
  try {
    // No user in AdventureWorks2022 (and no guest there): HAS_DBACCESS is 0, so it is left out.
    const limited = await openConnection({ ...endpoint, database: 'master' }, { kind: 'sql', user: login, password })
    try {
      const names = await listDatabases(limited)
      assert.ok(names.includes('master'))
      assert.ok(!names.includes('AdventureWorks2022'))
    } finally {
      // DROP LOGIN fails while the login still has a session.
      await new Promise((resolve) => {
        limited.once('end', resolve)
        limited.close()
      })
    }
    // Opening it anyway fails with the server's error (the tree shows it under the node).
    await assert.rejects(openConnection(endpoint, { kind: 'sql', user: login, password }), /Cannot open database|Login failed/)
  } finally {
    await queryRows(connection, `DROP LOGIN [${login}]`)
  }
})

test('tree: names needing quoting work (WideWorldImporters in-memory table)', async () => {
  const tables = await objectNodes(connection, { connection: 'local', database: 'WideWorldImporters', schema: 'Warehouse', folder: 'tables' })
  assert.ok(tables.some((t) => t.label === 'ColdRoomTemperatures'))
})

test('run: GO batches, several result sets, messages, value types', async () => {
  const { runId, status } = await runToEnd(
    'tab1',
    `SELECT TOP 3 SalesOrderID, OrderDate, TotalDue, rowguid, CAST(1 AS bit) AS flag, CAST(0x0102 AS varbinary(2)) AS bin,
            CAST(9007199254740993 AS bigint) AS big, CAST('2024-05-06T07:08:09.123+02:00' AS datetimeoffset) AS dto,
            CAST(NULL AS nvarchar(10)) AS nothing
       FROM Sales.SalesOrderHeader ORDER BY SalesOrderID;
     SELECT 2 AS two;
     GO
     PRINT 'hello';
     DECLARE @t TABLE (x int); INSERT @t VALUES (1),(2);`
  )
  assert.equal(status.state, 'done', JSON.stringify(status.messages))
  assert.equal(status.results.length, 2)
  const [first, second] = status.results
  assert.deepEqual(first.columns.slice(0, 3).map((c) => c.type), ['int', 'datetime', 'money'])
  assert.equal(first.rowCount, 3)
  assert.equal(second.batch, 1)
  const { rows } = runs.rows(runId, 0, 0, 10)
  assert.deepEqual(rows[0].slice(0, 2), [43659, '2011-05-31 00:00:00.000'])
  // money: exact text with its four decimal places.
  assert.match(String(rows[0][2]), /^\d+\.\d{4}$/)
  assert.match(String(rows[0][3]), /^[0-9A-F-]{36}$/)
  // datetimeoffset(7): seven fractional digits, as SSMS shows them, at the stored offset.
  assert.deepEqual(rows[0].slice(4), [true, '0x0102', '9007199254740993', '2024-05-06 07:08:09.1230000 +02:00', null])
  assert.ok(status.messages.some((m) => m.text === 'hello'))
  assert.ok(status.messages.some((m) => m.text === '(2 rows affected)'))
})

test('run: dates keep their full precision and four-digit years', async () => {
  const { runId } = await runToEnd(
    'tab-dates',
    `SELECT CAST('2024-05-06T07:08:09.1234567' AS datetime2(7)) AS d7, CAST('2024-05-06T07:08:09.12' AS datetime2(2)) AS d2,
            CAST('07:08:09.1234567' AS time(7)) AS t7, CAST('07:08:09' AS time(0)) AS t0,
            CAST('0001-01-01' AS date) AS first_day, CAST('0999-12-31T23:59:59' AS datetime2(0)) AS early`
  )
  assert.deepEqual(runs.rows(runId, 0, 0, 1).rows[0], [
    '2024-05-06 07:08:09.1234567',
    '2024-05-06 07:08:09.12',
    '07:08:09.1234567',
    '07:08:09',
    '0001-01-01',
    '0999-12-31 23:59:59'
  ])
})

test('run: decimal, numeric, money, smallmoney and datetimeoffset values are exact, in rows and exports', async () => {
  const { runId, status } = await runToEnd(
    'tab-exact',
    `SELECT CAST('12345678901234567890.123456789' AS decimal(38,9)) AS big_decimal,
            CAST('9007199254740993.25' AS decimal(20,2)) AS past_double,
            CAST('922337203685477.5807' AS money) AS money_max,
            CAST(1.10 AS decimal(10,2)) AS keeps_scale,
            CAST('2026-01-02 03:04:05.1234567 +05:30' AS datetimeoffset) AS own_offset,
            CAST('-12345678901234567890.123456789' AS numeric(38,9)) AS negative,
            CAST(-0.5 AS decimal(5,3)) AS negative_fraction,
            CAST(0 AS decimal(10,2)) AS zero,
            CAST(0 AS money) AS zero_money,
            CAST('-922337203685477.5808' AS money) AS money_min,
            CAST(-214748.3648 AS smallmoney) AS smallmoney_min,
            CAST(214748.3647 AS smallmoney) AS smallmoney_max,
            CAST(-1.5 AS smallmoney) AS smallmoney_negative,
            CAST('2026-01-01 23:00:00 -05:00' AS datetimeoffset(0)) AS west_offset,
            CAST(NULL AS decimal(10,2)) AS null_decimal,
            CAST(NULL AS money) AS null_money,
            CAST(NULL AS smallmoney) AS null_smallmoney,
            CAST(NULL AS datetimeoffset) AS null_offset,
            CAST(CAST(1.10 AS decimal(10,2)) AS sql_variant) AS variant_decimal,
            CAST(CAST('922337203685477.5807' AS money) AS sql_variant) AS variant_money`
  )
  assert.equal(status.state, 'done', JSON.stringify(status.messages))
  const expected = [
    '12345678901234567890.123456789',
    '9007199254740993.25',
    '922337203685477.5807',
    '1.10',
    '2026-01-02 03:04:05.1234567 +05:30',
    '-12345678901234567890.123456789',
    '-0.500',
    '0.00',
    '0.0000',
    '-922337203685477.5808',
    '-214748.3648',
    '214748.3647',
    '-1.5000',
    '2026-01-01 23:00:00 -05:00',
    null,
    null,
    null,
    null,
    '1.10',
    '922337203685477.5807'
  ]
  assert.deepEqual(runs.rows(runId, 0, 0, 1).rows[0], expected)
  assert.deepEqual(
    status.results[0].columns.slice(0, 5).map((c) => c.type),
    ['decimal(38,9)', 'decimal(20,2)', 'money', 'decimal(10,2)', 'datetimeoffset(7)']
  )

  const exported = async (format: 'csv' | 'json' | 'sql') => {
    const prepared = await runs.prepareExport(runId, 0, format, '[dbo].[T]')
    return runs.exportChunk(prepared.exportId, 0)
  }
  const csv = (await exported('csv')).split('\r\n')[1].split(',')
  assert.deepEqual(csv.slice(0, 5), expected.slice(0, 5))
  const json = JSON.parse(await exported('json'))[0]
  assert.equal(json.big_decimal, '12345678901234567890.123456789')
  assert.equal(json.keeps_scale, '1.10')
  // Numbers go into INSERTs bare, digit for digit.
  const insert = await exported('sql')
  assert.match(insert, /VALUES \(12345678901234567890\.123456789, 9007199254740993\.25, 922337203685477\.5807, 1\.10, N'2026-01-02 03:04:05\.1234567 \+05:30', -12345678901234567890\.123456789, -0\.500, 0\.00, /)
})

test('run: exact decimals also in rows sent as NBCROW (many NULLs)', async () => {
  // SQL Server sends a row with a null bitmap (NBCROW) when that is shorter: here, 30 NULLs.
  const nulls = Array.from({ length: 30 }, (_, i) => `CAST(NULL AS int) AS n${i}`).join(', ')
  const { runId, status } = await runToEnd(
    'tab-nbcrow',
    `SELECT ${nulls}, CAST('12345678901234567890.123456789' AS decimal(38,9)) AS d, CAST(1.10 AS decimal(10,2)) AS s,
            CAST('2026-01-02 03:04:05.1234567 +05:30' AS datetimeoffset) AS o`
  )
  assert.equal(status.state, 'done', JSON.stringify(status.messages))
  assert.deepEqual(runs.rows(runId, 0, 0, 1).rows[0].slice(30), ['12345678901234567890.123456789', '1.10', '2026-01-02 03:04:05.1234567 +05:30'])
})

test('run: huge binary and text values are cut so every row fits in one page', async () => {
  const { runId } = await runToEnd(
    'tab-big',
    `SELECT CAST(REPLICATE(CAST(0x41 AS varbinary(max)), 400000) AS varbinary(max)) AS bin,
            REPLICATE(CAST(N'x' AS nvarchar(max)), 300000) AS a, REPLICATE(CAST(N'y' AS nvarchar(max)), 300000) AS b`
  )
  const [row] = runs.rows(runId, 0, 0, 1).rows
  assert.ok(Buffer.byteLength(JSON.stringify(row)) < 1_000_000, 'row too large for one page')
  assert.match(String(row[0]), /^0x4141[^…]*… \[truncated, 800002 chars\]$/)
  assert.match(String(row[1]), /… \[truncated, 300000 chars\]$/)
})

/** A target whose connection opens only when released, and that says when opening started. */
function slowTarget(onOpen?: (connection: import('tedious').Connection) => void) {
  let release!: () => void
  let started!: () => void
  const openStarted = new Promise<void>((r) => (started = r))
  const gate = new Promise<void>((r) => (release = r))
  const t: Target = {
    ...target,
    open: async () => {
      started()
      await gate
      const connection = await openConnection(endpoint, credentials)
      onOpen?.(connection)
      return connection
    }
  }
  return { target: t, openStarted, release: () => release() }
}

test('run: a cancel that comes while connecting stops at once, before the first batch', async () => {
  const slow = slowTarget()
  const runId = await runs.start('tab-cancel-early', slow.target, 'CREATE TABLE ##seaqull_cancel_probe (n int)', 1)
  await slow.openStarted
  runs.cancel(runId)
  // Cancelled without waiting for the connection to open.
  for (let i = 0; i < 50 && runs.status(runId).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(runs.status(runId).state, 'cancelled')
  slow.release()
  await new Promise((r) => setTimeout(r, 300))
  const [row] = await queryRows(connection, "SELECT OBJECT_ID('tempdb..##seaqull_cancel_probe') AS id")
  assert.equal(row.id, null, 'the batch ran despite the cancel')
})

test('run: closing a tab while it connects closes the new connection', async () => {
  let opened: import('tedious').Connection | undefined
  const slow = slowTarget((c) => (opened = c))
  const runId = await runs.start('tab-close-early', slow.target, 'SELECT 1', 1)
  await slow.openStarted
  runs.closeOwner('tab-close-early')
  slow.release()
  for (let i = 0; i < 100 && !opened; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(opened, 'never connected')
  assert.equal((opened as unknown as { closed?: boolean }).closed, true, 'the connection was left open')
  assert.throws(() => runs.status(runId), /gone/)
})

test('run: errors in a loop are capped too, and the run still reports an error', async () => {
  const { status } = await runToEnd('tab-errors', "DECLARE @i int = 0; WHILE @i < 3000 BEGIN RAISERROR('boom %d', 16, 1, @i); SET @i += 1; END")
  assert.equal(status.state, 'error')
  assert.ok(status.messages.length <= 1010)
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < 700_000)
  assert.ok(status.messages.some((m) => /more errors not shown/.test(m.text)))
})

test('run: a late error is kept even after thousands of info messages', async () => {
  const { status } = await runToEnd('tab-late-error', "DECLARE @i int = 0; WHILE @i < 1500 BEGIN PRINT 'step'; SET @i += 1; END; RAISERROR('the late one', 16, 1)")
  assert.equal(status.state, 'error')
  assert.ok(status.messages.some((m) => m.kind === 'error' && m.text === 'the late one'))
  assert.ok(status.messages.some((m) => /more messages not shown/.test(m.text)))
})

test('run: many wide result sets keep the status answer well under 1 MiB', async () => {
  const columns = Array.from({ length: 40 }, (_, i) => `${i} AS column_with_a_rather_long_name_${i}`).join(', ')
  const { status } = await runToEnd('tab-wide', `DECLARE @i int = 0; WHILE @i < 700 BEGIN SELECT ${columns}; SET @i += 1; END`)
  const bytes = Buffer.byteLength(JSON.stringify(status))
  assert.ok(bytes < 700_000, `status is ${bytes} bytes`)
  assert.ok(status.results.length > 0 && status.results.length < 700)
  assert.ok(status.messages.some((m) => /more result sets not kept/.test(m.text)))
})

test('run: a connection killed mid-script stops the run quickly with "Connection lost"', async () => {
  const owner = 'tab-killed'
  const { runId: spidRun } = await runToEnd(owner, 'SELECT @@SPID AS spid')
  const spid = runs.rows(spidRun, 0, 0, 1).rows[0][0]
  const runId = await runs.start(owner, target, "WAITFOR DELAY '00:00:05'\nGO\nSELECT 1\nGO 100000", 1)
  await new Promise((r) => setTimeout(r, 300))
  await queryRows(connection, `KILL ${Number(spid)}`)
  const started = Date.now()
  while (runs.status(runId).state === 'running') await new Promise((r) => setTimeout(r, 20))
  const status = runs.status(runId)
  assert.ok(Date.now() - started < 5000, 'took too long to stop')
  assert.equal(status.state, 'error')
  assert.match(status.messages.at(-1)!.text, /Connection lost/)
})

test('run: errors keep going to the next batch and map to document lines', async () => {
  // The script starts on document line 10 (e.g. after a header and a selection offset).
  const { status } = await runToEnd('tab2', 'SELECT 1 AS ok\nGO\n\nSELECT * FROM dbo.NoSuchTable\nGO\nSELECT 3 AS after_error', 10)
  assert.equal(status.state, 'error')
  assert.equal(status.results.length, 2)
  const error = status.messages.find((m) => m.kind === 'error')!
  assert.match(error.text, /Invalid object name 'dbo.NoSuchTable'/)
  assert.equal(error.line, 13) // batch 2 starts on script line 3; its error is on its line 2 → script line 4 → document 13
})

test('run: row limit truncates and stops the batch', async () => {
  maxRows = 100
  try {
    const { runId, status } = await runToEnd('tab3', 'SELECT * FROM Sales.SalesOrderDetail; SELECT 1 AS never_runs\nGO\nSELECT 2 AS next_batch')
    assert.equal(status.results[0].rowCount, 100)
    assert.equal(status.results[0].truncated, true)
    assert.deepEqual(status.results.map((r) => r.columns[0].name), ['SalesOrderID', 'next_batch'])
    assert.ok(status.messages.some((m) => /Stopped after 100 rows/.test(m.text)))
    assert.equal(runs.rows(runId, 0, 90, 50).rows.length, 10)
  } finally {
    maxRows = 10_000
  }
})

test('run: cancel stops a long query and the session stays usable', async () => {
  const runId = await runs.start('tab4', target, "WAITFOR DELAY '00:00:30'; SELECT 1", 1)
  await new Promise((r) => setTimeout(r, 300))
  runs.cancel(runId)
  for (let i = 0; i < 200 && runs.status(runId).state === 'running'; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(runs.status(runId).state, 'cancelled')
  const { status } = await runToEnd('tab4', 'SELECT DB_NAME() AS db')
  assert.equal(status.state, 'done')
})

test('run: session keeps state between runs in the same console', async () => {
  await runToEnd('tab5', 'CREATE TABLE #scratch (x int); INSERT #scratch VALUES (42);')
  const { runId } = await runToEnd('tab5', 'SELECT x FROM #scratch')
  assert.deepEqual(runs.rows(runId, 0, 0, 1).rows, [[42]])
})

/** A RunManager of its own, with session memory in a Map (as the plugin's storage would be). */
function manager(stored: Map<string, unknown>, extra: Partial<SessionMemory> = {}, onActivity?: () => void) {
  const logs: string[] = []
  const memory: SessionMemory = {
    load: async () => stored.get('sessions') ?? null,
    save: async (records) => void stored.set('sessions', structuredClone(records)),
    log: (m) => void logs.push(m),
    ...extra
  }
  return { manager: new RunManager(async () => 1000, memory, onActivity), logs }
}

async function finish(m: RunManager, owner: string, sql: string) {
  const runId = await m.start(owner, target, sql, 1)
  while (m.status(runId).state === 'running') await new Promise((r) => setTimeout(r, 20))
  await m.settled(owner) // its @@TRANCOUNT check too
  return m.status(runId)
}
const firstMessage = (status: { messages: { text: string }[] }) => status.messages[0]?.text

test('sessions: an idle one is closed after 30 minutes, and the next run says the session is new', async () => {
  const { manager: m } = manager(new Map())
  try {
    await finish(m, 'idle', 'CREATE TABLE #t (x int)')
    m.sweep(Date.now() + 31 * 60_000)
    const next = await finish(m, 'idle', 'SELECT OBJECT_ID(\'tempdb..#t\') AS t')
    assert.equal(firstMessage(next), newSessionText('idle'))
    assert.match(firstMessage(next)!, /temp tables .* gone, and any transaction it had open was rolled back/)
    // Said once: the run after that is on the same session again.
    assert.equal(firstMessage(await finish(m, 'idle', 'SELECT 1')), undefined)
  } finally {
    m.dispose()
  }
})

test('sessions: one holding an open transaction is never closed as idle', async () => {
  let changes = 0
  const { manager: m } = manager(new Map(), {}, () => changes++)
  try {
    await finish(m, 'tx', 'BEGIN TRAN; CREATE TABLE #kept (x int)')
    assert.deepEqual(m.activity().map((a) => a.openTransaction), [true])
    m.sweep(Date.now() + 31 * 60_000)
    const still = await finish(m, 'tx', 'SELECT @@TRANCOUNT AS n')
    assert.equal(firstMessage(still), undefined, 'same session')
    await finish(m, 'tx', 'ROLLBACK')
    assert.deepEqual(m.activity().map((a) => a.openTransaction), [false])
    m.sweep(Date.now() + 31 * 60_000)
    assert.deepEqual(m.activity(), [])
    assert.ok(changes >= 6, `activity reported ${changes} times`)
  } finally {
    m.dispose()
  }
})

test('sessions: a dropped connection is reported on the next run', async () => {
  const { manager: m } = manager(new Map())
  try {
    const spidStatus = await finish(m, 'lost', 'SELECT @@SPID AS spid')
    const spid = m.rows(spidStatus.runId, 0, 0, 1).rows[0][0]
    await queryRows(connection, `KILL ${Number(spid)}`)
    // The server closes the socket; tedious may need a moment to notice.
    let next = await finish(m, 'lost', 'SELECT 1')
    for (let i = 0; i < 5 && next.state === 'error'; i++) next = await finish(m, 'lost', 'SELECT 1')
    assert.equal(next.state, 'done', JSON.stringify(next.messages))
    assert.equal(firstMessage(next), newSessionText('lost'))
  } finally {
    m.dispose()
  }
})

test('sessions: a connection that stops answering the transaction check is given up, and the run still ends', async () => {
  let changes = 0
  const { manager: m } = manager(new Map(), {}, () => changes++)
  try {
    // As on a half-dead connection: the check never gets an answer.
    m.transactionProbe = (c) => probeTransaction(c, () => new Promise(() => undefined), 100)
    const stalled = await finish(m, 'stall', 'BEGIN TRAN; SELECT 1 AS one')
    assert.equal(stalled.state, 'done')
    assert.deepEqual(m.activity().map((a) => [a.running, a.openTransaction]), [[false, false]], 'not running, no transaction kept')
    m.transactionProbe = (c) => probeTransaction(c)
    const next = await finish(m, 'stall', 'SELECT @@TRANCOUNT AS n')
    assert.equal(firstMessage(next), newSessionText('lost'))
    assert.deepEqual(m.rows(next.runId, 0, 0, 1).rows, [[0]], 'a new connection, no transaction')
  } finally {
    m.dispose()
  }
})

test('sessions: a run started while the last one is still checking @@TRANCOUNT waits for it, on the same session', async () => {
  const { manager: m } = manager(new Map())
  try {
    // The check after each run takes a while (as on a slow network).
    m.transactionProbe = async (c) => (await new Promise((r) => setTimeout(r, 300)), probeTransaction(c))
    const first = await m.start('busy', target, "CREATE TABLE #t (i int); WAITFOR DELAY '00:00:10'", 1)
    await new Promise((r) => setTimeout(r, 300))
    m.cancel(first)
    while (m.status(first).state === 'running') await new Promise((r) => setTimeout(r, 5))
    assert.equal(m.status(first).state, 'cancelled', 'the end shows at once, before the check')
    // At once, while the check still holds the connection: accepted, and a third is refused.
    const second = await m.start('busy', target, 'SELECT COUNT(*) AS n FROM #t', 1)
    await assert.rejects(m.start('busy', target, 'SELECT 2', 1), /already running/)
    while (m.status(second).state === 'running') await new Promise((r) => setTimeout(r, 20))
    const status = m.status(second)
    assert.equal(status.state, 'done', JSON.stringify(status.messages))
    assert.deepEqual(status.messages, [], 'no new-session message: same session')
    assert.deepEqual(m.rows(second, 0, 0, 1).rows, [[0]], '#t is still there')
  } finally {
    m.dispose()
  }
})

test('sessions: after the worker restarts, a console that had a session is told it is new', async () => {
  const stored = new Map<string, unknown>()
  const first = manager(stored).manager
  await finish(first, 'restart', 'SELECT 1')
  await finish(first, 'closed-tab', 'SELECT 1')
  first.closeOwner('closed-tab') // its tab closed: nothing to tell
  first.dispose() // the worker stops
  await first.flushMemory()
  assert.deepEqual(Object.keys(stored.get('sessions') as object), ['restart'])
  assert.deepEqual(Object.keys((stored.get('sessions') as Record<string, object>).restart), ['at'], 'console ids and times only')

  const second = manager(stored).manager
  try {
    assert.equal(firstMessage(await finish(second, 'restart', 'SELECT 1')), newSessionText('worker'))
    assert.equal(firstMessage(await finish(second, 'restart', 'SELECT 1')), undefined)
    assert.equal(firstMessage(await finish(second, 'never-ran', 'SELECT 1')), undefined)
  } finally {
    second.dispose()
  }
})

test('sessions: storage that fails never fails a run', async () => {
  const broken = { load: async () => Promise.reject(new Error('disk on fire')), save: async () => Promise.reject(new Error('disk on fire')) }
  const { manager: m, logs } = manager(new Map(), broken)
  try {
    const status = await finish(m, 'broken', 'SELECT 1 AS one')
    assert.equal(status.state, 'done')
    await m.flushMemory()
    assert.ok(logs.length >= 2 && logs.every((l) => /disk on fire/.test(l)), JSON.stringify(logs))
  } finally {
    m.dispose()
  }
})

test('status: only the messages after the ones the page has', async () => {
  const { runId, status } = await runToEnd('tab-messages', "PRINT 'one'; PRINT 'two'; PRINT 'three'")
  assert.deepEqual(status.messages.map((m) => m.text), ['one', 'two', 'three'])
  const later = runs.status(runId, 2)
  assert.equal(later.messagesFrom, 2)
  assert.deepEqual(later.messages.map((m) => m.text), ['three'])
  assert.deepEqual(runs.status(runId, 99).messages, [])
  assert.equal(runs.status(runId, -1).messages.length, 3)
})

test('export: formatted a chunk at a time, the same text in every format; one export per run', async () => {
  const { runId } = await runToEnd(
    'tab-lazy-export',
    `SELECT TOP 3000 o.object_id AS id, o.name, REPLICATE(N'é"x\n', 20) AS text, CAST(o.object_id AS decimal(20,2)) AS d
       FROM sys.all_objects o ORDER BY o.object_id`
  )
  const all = runs.rows(runId, 0, 0, 2000).rows.concat(runs.rows(runId, 0, 2000, 2000).rows)
  assert.equal(all.length, 3000)
  const columns = runs.status(runId).results[0].columns
  for (const format of ['csv', 'tsv', 'json', 'jsonl', 'markdown', 'sql'] as const) {
    const prepared = await runs.prepareExport(runId, 0, format, '[dbo].[T]')
    let text = ''
    for (let i = 0; i < prepared.chunks; i++) text += runs.exportChunk(prepared.exportId, i)
    assert.ok(prepared.chunks > 1, `${format}: ${prepared.chunks} chunk`)
    assert.equal(text.length, prepared.length)
    assert.equal(text, exportResult(format, { columns, rows: all, tableName: '[dbo].[T]' }), format)
  }
  const first = await runs.prepareExport(runId, 0, 'csv')
  const second = await runs.prepareExport(runId, 0, 'csv')
  assert.throws(() => runs.exportChunk(first.exportId, 0), /expired/, 'replaced by the newer export')
  // Two at once (each yields while measuring): only the one finishing last is kept.
  const [a, b] = await Promise.all([runs.prepareExport(runId, 0, 'json'), runs.prepareExport(runId, 0, 'json')])
  const kept = [a, b].filter((p) => {
    try {
      runs.exportChunk(p.exportId, 0)
      return true
    } catch {
      return false
    }
  })
  assert.equal(kept.length, 1)
  assert.throws(() => runs.exportChunk(second.exportId, 0), /expired/)
  const latest = await runs.prepareExport(runId, 0, 'csv')
  runs.exportChunk(latest.exportId, 0)
  await runToEnd('tab-lazy-export', 'SELECT 1') // a new run drops the old one, and its export
  assert.throws(() => runs.exportChunk(latest.exportId, 1), /expired/)
})

test('rows are paged under the size budget', async () => {
  const { runId, status } = await runToEnd('tab6', "SELECT TOP 500 REPLICATE(N'x', 4000) AS wide FROM sys.all_objects")
  assert.equal(status.results[0].rowCount, 500)
  const page = runs.rows(runId, 0, 0, 2000)
  assert.ok(page.rows.length > 0 && page.rows.length < 500, `got ${page.rows.length}`)
})

test('export: chunks reassemble to the full CSV', async () => {
  const { runId } = await runToEnd('tab7', 'SELECT SalesOrderID, CarrierTrackingNumber, rowguid FROM Sales.SalesOrderDetail')
  const prepared = await runs.prepareExport(runId, 0, 'csv', 'Sales.SalesOrderDetail')
  assert.match(prepared.fileName, /^Sales.SalesOrderDetail-\d{8}-\d{6}\.csv$/)
  assert.ok(prepared.chunks > 1)
  let text = ''
  for (let i = 0; i < prepared.chunks; i++) text += runs.exportChunk(prepared.exportId, i)
  assert.equal(text.length, prepared.length)
  const lines = text.trimEnd().split('\r\n')
  assert.equal(lines[0], 'SalesOrderID,CarrierTrackingNumber,rowguid')
  assert.equal(lines.length, 10_001) // header + the row limit

  const bare = await runs.prepareExport(runId, 0, 'csv', undefined, false)
  assert.match(runs.exportChunk(bare.exportId, 0), /^\d+,/) // no header row
})

test('metadata helper rejects SQL errors', async () => {
  await assert.rejects(queryRows(connection, 'SELECT * FROM nope'), /Invalid object name/)
})

test('run: a PRINT loop is capped so status stays small', async () => {
  const { status } = await runToEnd('tab8', 'DECLARE @i int = 0; WHILE @i < 1500 BEGIN PRINT @i; SET @i += 1 END')
  assert.equal(status.messages.length, 901) // 900 info messages kept, plus the summary line
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < 400_000)
  // SQL Server also reports "(1 row affected)" for each SET; only the cap matters here.
  assert.match(status.messages.at(-1)?.text ?? '', /^… \d+ more messages not shown\.$/)
})

test('completion columns: whole objects only; what does not fit is reported unsent', async () => {
  const objects = [
    { schema: 'Sales', name: 'Customer' },
    { schema: 'dbo', name: 'nope' }, // no columns: settled, not unsent
    { schema: 'Person', name: 'Person' },
    { schema: 'Sales', name: 'SalesOrderHeader' }
  ]
  const all = await completionColumns(connection, objects)
  assert.deepEqual(all.objects.map((o) => o.name), ['Customer', 'Person', 'SalesOrderHeader'])
  assert.deepEqual(all.unsent, [])
  const customer = Buffer.byteLength(JSON.stringify(all.objects[0]))
  // Room for Customer only: the rest is unsent, whole.
  const tight = await completionColumns(connection, objects, customer + 10)
  assert.deepEqual(tight.objects, [all.objects[0]])
  assert.deepEqual(tight.unsent, objects.slice(2))
  // The first object is sent even when it alone is over the limit, so a request always makes progress.
  const tiny = await completionColumns(connection, objects, 1)
  assert.deepEqual(tiny.objects.map((o) => o.name), ['Customer'])
  assert.deepEqual(tiny.unsent, objects.slice(2))
})
