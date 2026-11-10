import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CompletionColumn, CompletionNames, ObjectColumns } from '../src/protocol.ts'
import { columnOptions, completeNames, findObject, nameContext, nameIndex, needsBrackets, objectKey, planCompletion, quoteName, settledColumns, wordRest } from '../src/shared/sql-names.ts'
import { scanStatement } from '../src/shared/sql-statement.ts'

const names: CompletionNames = {
  defaultSchema: 'dbo',
  caseSensitive: false,
  schemas: [
    { name: 'dbo', objects: [['Customers', 't'], ['Order Details', 't'], ['user', 'v'], ['GetOrders', 'p'], ['fnTotal', 'f'], ['Cust', 's']] },
    { name: 'Sales', objects: [['Customer', 't'], ['vOrders', 'v']] },
    { name: 'My Schema', objects: [['x]y', 't']] },
    { name: 'sys', objects: [['objects', 'v'], ['tables', 'v'], ['dm_exec_sql_text', 'f']] },
    { name: 'INFORMATION_SCHEMA', objects: [['TABLES', 'v']] }
  ],
  truncated: false
}
const index = nameIndex(names)
const labels = (options: { label: string }[] | undefined) => options?.map((o) => o.label)

test('names that need brackets: irregular, reserved, not starting with a letter', () => {
  for (const name of ['Order Details', 'user', 'Order', 'x]y', '1st', 'a-b', '', '#temp', '@x']) assert.ok(needsBrackets(name), name)
  for (const name of ['Customers', '_x', 'a1', 'a$b#c@d', 'Élan', 'Users']) assert.ok(!needsBrackets(name), name)
  assert.equal(quoteName('x]y'), '[x]]y]')
  assert.equal(quoteName('Customers'), 'Customers')
  assert.equal(quoteName('Customers', '[', true), '[Customers]')
  assert.equal(quoteName('a"b', '"', true), '"a""b"')
})

test('top level: the default schema unqualified, then the schemas; system objects only qualified', () => {
  assert.deepEqual(labels(index.top), ['Customers', 'Order Details', 'user', 'GetOrders', 'fnTotal', 'Cust', 'dbo', 'Sales', 'My Schema', 'sys', 'INFORMATION_SCHEMA'])
  const details = Object.fromEntries(index.top.map((o) => [o.label, `${o.type}/${o.detail}`]))
  assert.deepEqual(details, {
    Customers: 'table/table', 'Order Details': 'table/table', user: 'view/view', GetOrders: 'procedure/procedure', fnTotal: 'function/function',
    Cust: 'synonym/synonym', dbo: 'schema/schema', Sales: 'schema/schema', 'My Schema': 'schema/schema', sys: 'schema/schema', INFORMATION_SCHEMA: 'schema/schema'
  })
})

test('names that need it insert bracketed; the label stays plain', () => {
  const byLabel = Object.fromEntries(index.top.map((o) => [o.label, o.apply]))
  assert.equal(byLabel['Order Details'], '[Order Details]')
  assert.equal(byLabel.user, '[user]')
  assert.equal(byLabel['My Schema'], '[My Schema]')
  assert.equal(byLabel.Customers, undefined)
  assert.equal(index.schemas.get('my schema')?.[0].apply, '[x]]y]')
})

test('the text before the cursor', () => {
  assert.deepEqual(nameContext('SELECT * FROM Cu'), { word: 'Cu', path: [], quote: null })
  assert.deepEqual(nameContext('SELECT * FROM '), { word: '', path: [], quote: null })
  assert.deepEqual(nameContext('FROM sales.'), { word: '', path: ['sales'], quote: null })
  assert.deepEqual(nameContext('FROM Sales . Cu'), { word: 'Cu', path: ['Sales'], quote: null })
  assert.deepEqual(nameContext('FROM [My Schema].[x'), { word: '[x', path: ['My Schema'], quote: '[' })
  assert.deepEqual(nameContext('FROM [a]]b].'), { word: '', path: ['a]b'], quote: null })
  assert.deepEqual(nameContext('FROM "Sales"."Cu'), { word: '"Cu', path: ['Sales'], quote: '"' })
  assert.deepEqual(nameContext('FROM [Order D'), { word: '[Order D', path: [], quote: '[' })
  assert.equal(nameContext('SET @cou'), null, 'a variable')
  assert.equal(nameContext('SELECT 12'), null, 'a number')
  assert.equal(nameContext('SELECT 1.'), null, 'a decimal point')
  assert.equal(nameContext('FROM AdventureWorks.Sales.Customer.'), null, 'a four-part name')
  assert.equal(nameContext('FROM #tem'), null, 'a temp table')
})

test('completions: top level, qualified (case-insensitive), unknown qualifier', () => {
  assert.equal(completeNames(index, nameContext('FROM ')!, false), null, 'nothing typed, not asked for')
  assert.deepEqual(labels(completeNames(index, nameContext('FROM ')!, true)?.options), labels(index.top))
  assert.deepEqual(labels(completeNames(index, nameContext('FROM sales.')!, false)?.options), ['Customer', 'vOrders'])
  assert.deepEqual(labels(completeNames(index, nameContext('FROM sys.ob')!, false)?.options), ['objects', 'tables', 'dm_exec_sql_text'])
  assert.deepEqual(labels(completeNames(index, nameContext('FROM information_schema.')!, false)?.options), ['TABLES'])
  assert.equal(completeNames(index, nameContext('WHERE c.')!, false), null, 'an alias, not a schema')
  const result = completeNames(index, nameContext('FROM Cu')!, false)!
  assert.ok(result.validFor.test('Cus') && !result.validFor.test('Cu.'))
})

test('a case-sensitive database matches the schema exactly', () => {
  const sensitive = nameIndex({ ...names, caseSensitive: true })
  assert.equal(completeNames(sensitive, nameContext('FROM sales.')!, false), null)
  assert.deepEqual(labels(completeNames(sensitive, nameContext('FROM Sales.')!, false)?.options), ['Customer', 'vOrders'])
})

test('after an opening bracket every name is bracketed, and a closing one after the cursor is replaced', () => {
  const result = completeNames(index, nameContext('FROM [Or')!, false)!
  const order = result.options.find((o) => o.label === '[Order Details]')
  assert.deepEqual(order, { label: '[Order Details]', type: 'table', detail: 'table', apply: '[Order Details]' })
  assert.ok(result.options.some((o) => o.label === '[Customers]'))
  assert.equal(wordRest(']', '['), 1)
  assert.ok(result.validFor.test('[Order D') && result.validFor.test('[Order Details]') && !result.validFor.test('[a] b'))
  const quoted = completeNames(index, nameContext('FROM "Sales"."Cu')!, false)!
  assert.deepEqual(labels(quoted.options), ['"Customer"', '"vOrders"'])
  const inSchema = completeNames(index, nameContext('FROM [My Schema].[')!, false)!
  assert.deepEqual(labels(inSchema.options), ['[x]]y]'])
})

test('a default schema other than dbo; none at all', () => {
  const other = nameIndex({ ...names, defaultSchema: 'Sales' })
  assert.deepEqual(labels(other.top)!.slice(0, 2), ['Customer', 'vOrders'])
  assert.ok(!labels(other.top)!.includes('Customers'))
  const none = nameIndex({ ...names, defaultSchema: '' })
  assert.deepEqual(labels(none.top), ['dbo', 'Sales', 'My Schema', 'sys', 'INFORMATION_SCHEMA'])
})

test('two-part paths', () => {
  assert.deepEqual(nameContext('FROM Sales.Customer.'), { word: '', path: ['Sales', 'Customer'], quote: null })
  assert.deepEqual(nameContext('SELECT [My Schema].[x]]y].[A'), { word: '[A', path: ['My Schema', 'x]y'], quote: '[' })
  assert.deepEqual(nameContext('WHERE c.Na'), { word: 'Na', path: ['c'], quote: null })
})

test('objects with columns: default schema, any case, not procedures', () => {
  assert.deepEqual(findObject(index, undefined, 'customers'), { schema: 'dbo', name: 'Customers' })
  assert.deepEqual(findObject(index, 'SALES', 'customer'), { schema: 'Sales', name: 'Customer' })
  assert.deepEqual(findObject(index, 'dbo', 'Cust'), { schema: 'dbo', name: 'Cust' }, 'a synonym')
  assert.equal(findObject(index, 'dbo', 'GetOrders'), null, 'a procedure')
  assert.equal(findObject(index, undefined, 'Customer'), null, 'not in the default schema')
  assert.equal(findObject(index, 'nope', 'Customer'), null)
})

test('column options: type and PK as detail, key icon, brackets, the source of shared names', () => {
  const fold = (n: string) => n.toLowerCase()
  assert.deepEqual(columnOptions([{ columns: [['CustomerID', 'int', true], ['Order Date', 'datetime', false]] }], fold), [
    { label: 'CustomerID', type: 'key', detail: 'int PK' },
    { label: 'Order Date', type: 'column', detail: 'datetime', apply: '[Order Date]' }
  ])
  const options = columnOptions([{ columns: [['ID', 'int', true], ['Name', 'Name', false]], source: 'c' }, { columns: [['id', 'int', false], ['Total', 'money', false]], source: 'h' }], fold, 1)
  assert.deepEqual(options.map((o) => `${o.label}: ${o.detail}`), ['ID: int PK · c', 'Name: Name', 'id: int · h', 'Total: money'])
  assert.ok(options.every((o) => o.boost === 1))
})

/** completion.columns entries, by `objectKey`. */
const entries = (list: (ObjectColumns | [schema: string, name: string, columns: CompletionColumn[]])[]) =>
  new Map(list.map((e) => (Array.isArray(e) ? { schema: e[0], name: e[1], columns: e[2], truncated: false, foreignKeys: [] } : e)).map((e) => [objectKey(e), e]))
const columns = entries([
  ['Sales', 'Customer', [['CustomerID', 'int', true], ['TerritoryID', 'int', false]]],
  ['dbo', 'Customers', [['CustomerID', 'int', true], ['Name', 'nvarchar(50)', false]]],
  ['dbo', 'Sales', [['Region', 'nvarchar(20)', false]]]
])
/** The plan for `sql`, whose `|` marks the cursor, and its completions given `columns`. */
function plan(sql: string, idx = index, explicit = false, known = columns) {
  const cursor = sql.indexOf('|')
  const text = sql.slice(0, cursor) + sql.slice(cursor + 1)
  const p = planCompletion(idx, nameContext(text.slice(text.lastIndexOf('\n', cursor - 1) + 1, cursor))!, scanStatement(text, cursor), explicit)
  return { objects: p?.objects.map(objectKey), result: p?.complete(known) ?? null }
}
const labelsOf = (sql: string, idx = index) => labels(plan(sql, idx).result?.options)

test('schema.object. lists its columns', () => {
  assert.deepEqual(plan('SELECT Sales.Customer.|').objects, [objectKey({ schema: 'Sales', name: 'Customer' })])
  assert.deepEqual(labelsOf('SELECT Sales.Customer.|'), ['CustomerID', 'TerritoryID'])
  assert.deepEqual(labelsOf('SELECT sales.customer.T|'), ['CustomerID', 'TerritoryID'])
  assert.equal(plan('SELECT dbo.GetOrders.|').result, null, 'a procedure has no columns')
})

test('x. : an alias or table of the statement, else a schema and a default-schema object', () => {
  assert.deepEqual(labelsOf('SELECT c.| FROM Sales.Customer c'), ['CustomerID', 'TerritoryID'])
  assert.deepEqual(labelsOf('SELECT Customer.| FROM Sales.Customer'), ['CustomerID', 'TerritoryID'])
  assert.deepEqual(labelsOf('SELECT Customers.|'), ['CustomerID', 'Name'], 'an object in the default schema')
  assert.deepEqual(labelsOf('SELECT [c].[|] FROM Sales.Customer c'), ['[CustomerID]', '[TerritoryID]'])
  assert.equal(plan('WITH x AS (SELECT 1 AS a) SELECT x.| FROM x').result, null, 'a CTE gives nothing')
  assert.equal(plan('SELECT d.| FROM (SELECT 1 AS a) d').result, null, 'a derived table gives nothing')
  // An alias hides a schema of the same name.
  assert.deepEqual(labelsOf('SELECT Sales.| FROM dbo.Customers AS Sales'), ['CustomerID', 'Name'])
})

test('a name that is both a schema and a table gives both', () => {
  const both = nameIndex({ ...names, schemas: [{ name: 'dbo', objects: [...names.schemas[0].objects, ['Sales', 't']] }, ...names.schemas.slice(1)] })
  assert.deepEqual(labelsOf('SELECT Sales.|', both), ['Region', 'Customer', 'vOrders'])
})

test('unqualified where a column goes: the statement\'s columns first, then names and keywords', () => {
  const sql = 'SELECT C|\nFROM Sales.Customer c JOIN Customers AS cu ON 1 = 1'
  const { objects, result } = plan(sql)
  assert.deepEqual(objects, [objectKey({ schema: 'Sales', name: 'Customer' }), objectKey({ schema: 'dbo', name: 'Customers' })])
  const shown = result!.options.map((o) => `${o.label}:${o.detail}:${o.boost ?? 0}`)
  assert.deepEqual(shown.slice(0, 4), ['CustomerID:int PK · c:1', 'TerritoryID:int:1', 'CustomerID:int PK · cu:1', 'Name:nvarchar(50):1'])
  assert.ok(shown.includes('Customers:table:0'), 'object names still offered')
  // Where a table goes, only names; no columns are fetched.
  assert.deepEqual(plan('SELECT * FROM Sales.Customer c JOIN C|').objects, [])
  assert.ok(!labelsOf('SELECT * FROM Sales.Customer c JOIN C|')!.includes('TerritoryID'))
  // INSERT INTO t (…) takes only t's columns.
  assert.deepEqual(plan('INSERT INTO Customers (N|) SELECT * FROM Sales.Customer').objects, [objectKey({ schema: 'dbo', name: 'Customers' })])
})

test('columns that could not be fetched leave the names', () => {
  const cursor = 'SELECT C'.length
  const text = 'SELECT C FROM Sales.Customer'
  const p = planCompletion(index, nameContext(text.slice(0, cursor))!, scanStatement(text, cursor), false)!
  assert.deepEqual(labels(p.complete(new Map())?.options), labels(index.top))
  assert.equal(planCompletion(index, nameContext('SELECT c.')!, scanStatement('SELECT c. FROM Sales.Customer c', 9), false)!.complete(new Map()), null)
})

test('the rest of the word after the cursor is replaced too', () => {
  assert.equal(wordRest('omer FROM t', null), 4)
  assert.equal(wordRest(' FROM t', null), 0)
  assert.equal(wordRest('ID, x', null), 2)
  assert.equal(wordRest('er Details] AS od', '['), 'er Details]'.length)
  assert.equal(wordRest(']', '['), 1)
  assert.equal(wordRest('a]]b] x', '['), 5)
  assert.equal(wordRest('er + [x]', '['), 2, 'an unclosed name: not into the next one')
  assert.equal(wordRest('omer"."x"', '"'), 5)
  assert.equal(wordRest('omer', '"'), 4, 'no closing quote on the line')
})

test('a schema being typed after FROM still lists its objects', () => {
  assert.deepEqual(labelsOf('SELECT * FROM Sales.|'), ['Customer', 'vOrders'])
  assert.deepEqual(labelsOf('SELECT * FROM sales.Cu|'), ['Customer', 'vOrders'])
})

test('a columns answer settles what was sent; what was not is asked for again', () => {
  const a = { schema: 'dbo', name: 'A' }
  const b = { schema: 'dbo', name: 'B' }
  const c = { schema: 'dbo', name: 'C' }
  const d = { schema: 'dbo', name: 'D' }
  const answerA: ObjectColumns = { ...a, columns: [['id', 'int', true]], truncated: false, foreignKeys: [] }
  const settled = settledColumns([a, b, c, d], { objects: [answerA], unsent: [c, d] })
  assert.deepEqual([...settled], [
    [objectKey(a), answerA],
    [objectKey(b), null] // no columns: confirmed
  ])
  assert.ok(!settled.has(objectKey(c)) && !settled.has(objectKey(d)), 'not sent: unknown, not "no columns"')
})

// --- JOIN conditions from foreign keys ------------------------------------------------------------

const shop = nameIndex({
  defaultSchema: 'dbo',
  caseSensitive: false,
  schemas: [
    { name: 'dbo', objects: [['Customer', 't'], ['Orders', 't'], ['OrderLines', 't'], ['Employee', 't'], ['Order Details', 't'], ['Cust', 's'], ['Note', 't']] },
    { name: 'Sales', objects: [['Region', 't']] }
  ],
  truncated: false
})
const dbo = (name: string) => ({ schema: 'dbo', name })
const fk = (from: string, to: string, ...columns: [string, string][]) => ({ from: dbo(from), to: dbo(to), columns })
const ordersCustomer = fk('Orders', 'Customer', ['CustomerId', 'Id'])
const linesOrders = fk('OrderLines', 'Orders', ['OrderId', 'Id'], ['Region', 'Region'])
const detailsOrders = fk('Order Details', 'Orders', ['Order Id', 'Id'])
const manager = fk('Employee', 'Employee', ['ManagerId', 'Id'])
const regionCustomer = { from: dbo('Customer'), to: { schema: 'Sales', name: 'Region' }, columns: [['RegionId', 'Id']] as [string, string][] }
const entry = (schema: string, name: string, foreignKeys: ObjectColumns['foreignKeys'], base?: ObjectColumns['base']): ObjectColumns => ({
  schema, name, columns: [['Id', 'int', true]], truncated: false, foreignKeys, ...(base ? { base } : {})
})
const shopColumns = entries([
  entry('dbo', 'Customer', [ordersCustomer, regionCustomer]),
  entry('dbo', 'Orders', [ordersCustomer, linesOrders, detailsOrders]),
  entry('dbo', 'OrderLines', [linesOrders]),
  entry('dbo', 'Order Details', [detailsOrders]),
  entry('dbo', 'Employee', [manager]),
  entry('dbo', 'Cust', [ordersCustomer, regionCustomer], dbo('Customer')), // a synonym: its base table's keys
  entry('dbo', 'Note', []),
  entry('Sales', 'Region', [regionCustomer])
])
const joins = (sql: string, explicit = false) => {
  const options = plan(sql, shop, explicit, shopColumns).result?.options ?? []
  return options.filter((o) => o.type === 'join').map((o) => o.label)
}

test('JOIN conditions from foreign keys: either way, aliases or names as written', () => {
  assert.deepEqual(joins('SELECT * FROM Customer c JOIN Orders o ON |'), ['o.CustomerId = c.Id'])
  assert.deepEqual(joins('SELECT * FROM Orders o JOIN Customer c ON |'), ['c.Id = o.CustomerId'])
  assert.deepEqual(joins('SELECT * FROM Customer JOIN dbo.Orders ON |'), ['Orders.CustomerId = Customer.Id'], 'no alias: the table name')
  assert.deepEqual(joins('SELECT * FROM CUSTOMER JOIN orders ON |'), ['orders.CustomerId = CUSTOMER.Id'], 'as written, in any case')
  assert.deepEqual(joins('SELECT * FROM Customer c JOIN Sales.Region r ON |'), ['r.Id = c.RegionId'], 'another schema')
  // Several columns, in key order; names that need brackets.
  assert.deepEqual(joins('SELECT * FROM Orders o JOIN OrderLines l ON |'), ['l.OrderId = o.Id AND l.Region = o.Region'])
  assert.deepEqual(joins('SELECT * FROM Orders [all] JOIN [Order Details] ON |'), ['[Order Details].[Order Id] = [all].Id'])
  // The most recently joined table first; a table without keys to it gives nothing.
  assert.deepEqual(joins('SELECT * FROM Customer c JOIN Note n ON 1 = 1 JOIN Orders o ON o.CustomerId = c.Id JOIN OrderLines l ON 1 = 1 JOIN Orders o2 ON |'), [
    'o2.Id = l.OrderId AND o2.Region = l.Region',
    'o2.CustomerId = c.Id'
  ])
  // A synonym stands for its base table, either side.
  assert.deepEqual(joins('SELECT * FROM Cust c JOIN Orders o ON |'), ['o.CustomerId = c.Id'])
  assert.deepEqual(joins('SELECT * FROM Orders o JOIN Cust c ON |'), ['c.Id = o.CustomerId'])
})

test('JOIN conditions: a self-referencing key gives both ways', () => {
  assert.deepEqual(joins('SELECT * FROM Employee e JOIN Employee m ON |'), ['m.ManagerId = e.Id', 'm.Id = e.ManagerId'])
  assert.deepEqual(joins('SELECT * FROM Employee JOIN Employee ON |'), [], 'the same name twice: nothing to tell them apart')
})

test('JOIN conditions rank first and show by themselves; columns still complete', () => {
  const { objects, result } = plan('SELECT * FROM Customer c JOIN Orders o ON |', shop, false, shopColumns)
  assert.deepEqual(objects, [objectKey(dbo('Customer')), objectKey(dbo('Orders'))])
  const options = result!.options
  assert.deepEqual(options.map((o) => o.type).slice(0, 3), ['join', 'key', 'key'], 'then the columns')
  assert.deepEqual(options[0], { label: 'o.CustomerId = c.Id', type: 'join', detail: 'fk', boost: 3 })
  assert.ok(options.some((o) => o.label === 'Customer' && o.type === 'table'), 'and the names')
  // Ordered by boost, all above the columns' 1.
  const ranked = plan('SELECT * FROM Customer c JOIN OrderLines l ON 1 = 1 JOIN Orders o ON |', shop, false, shopColumns).result!.options.filter((o) => o.type === 'join')
  assert.ok(ranked[0].boost! > ranked[1].boost! && ranked[1].boost! > 1)
  // With a partly typed word, the same (the editor filters them).
  assert.deepEqual(joins('SELECT * FROM Customer c JOIN Orders o ON o|'), ['o.CustomerId = c.Id'])
  // Nothing typed and none to offer: no pop-up by itself; asked for, the usual list.
  assert.equal(plan('SELECT * FROM Customer c JOIN Note n ON |', shop, false, shopColumns).result, null)
  assert.ok(plan('SELECT * FROM Customer c JOIN Note n ON |', shop, true, shopColumns).result!.options.length > 0)
  // A condition already started, or a `[` name being typed: no conditions.
  assert.deepEqual(joins('SELECT * FROM Customer c JOIN Orders o ON o.CustomerId = c.Id AND |', true), [])
  assert.deepEqual(joins('SELECT * FROM Customer c JOIN Orders o ON [|'), [])
  // Keys not fetched (yet): nothing about them.
  assert.equal(plan('SELECT * FROM Customer c JOIN Orders o ON |', shop, false, new Map()).result, null)
})
