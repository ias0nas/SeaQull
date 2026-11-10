// The explorer's locate: what the name at the cursor stands for.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CompletionNames, ObjectColumns, ObjectName } from '../src/protocol.ts'
import { locateAt, targetPath } from '../src/shared/locate.ts'
import { nameIndex, objectKey } from '../src/shared/sql-names.ts'

const names: CompletionNames = {
  database: 'Shop',
  defaultSchema: 'dbo',
  caseSensitive: false,
  schemas: [
    { name: 'dbo', objects: [['Customer', 't'], ['Order Details', 't'], ['vOrders', 'v'], ['uspGet', 'p'], ['fnTax', 'f'], ['syn', 's']] },
    { name: 'Sales', objects: [['Order', 't'], ['Customer', 't']] }
  ],
  truncated: false
}
const index = nameIndex(names)
const table = (schema: string, name: string, columns: string[], base?: ObjectName): ObjectColumns => ({
  schema, name, columns: columns.map((c) => [c, 'int', false]), truncated: false, foreignKeys: [], ...(base ? { base } : {})
})
const known = new Map<string, ObjectColumns>(
  [
    table('dbo', 'Customer', ['CustomerID', 'Name']),
    table('Sales', 'Order', ['OrderID', 'CustomerID', 'Total']),
    table('Sales', 'Customer', ['CustomerID', 'Region']),
    table('dbo', 'Order Details', ['OrderID', 'Qty']),
    table('dbo', 'syn', ['OrderID', 'CustomerID', 'Total'], { schema: 'Sales', name: 'Order' })
  ].map((o) => [objectKey(o), o])
)
const deps = { index, columns: async (objects: ObjectName[]) => new Map(objects.flatMap((o) => (known.has(objectKey(o)) ? [[objectKey(o), known.get(objectKey(o))!] as const] : []))) }

/** Locates with the cursor at `|`. */
const at = (sql: string) => locateAt(sql.replace('|', ''), sql.indexOf('|'), deps)
const object = (schema: string, name: string, type: string) => ({ kind: 'object', schema, name, type })
const column = (schema: string, name: string, type: string, col: string) => ({ kind: 'column', schema, name, type, column: col })

test('objects: by name in the default schema, schema.name, bracketed, mid-word or touching', async () => {
  assert.deepEqual(await at('SELECT * FROM Cust|omer'), object('dbo', 'Customer', 't'))
  assert.deepEqual(await at('SELECT * FROM |Customer'), object('dbo', 'Customer', 't'))
  assert.deepEqual(await at('SELECT * FROM Customer|'), object('dbo', 'Customer', 't'))
  assert.deepEqual(await at('SELECT * FROM sales.Ord|er'), object('Sales', 'Order', 't'))
  assert.deepEqual(await at('SELECT * FROM [Sales].[Ord|er] o'), object('Sales', 'Order', 't'))
  assert.deepEqual(await at('SELECT * FROM [Order Det|ails] d'), object('dbo', 'Order Details', 't'))
  assert.deepEqual(await at('SELECT * FROM "vOr|ders"'), object('dbo', 'vOrders', 'v'))
  assert.deepEqual(await at('EXEC usp|Get 1'), object('dbo', 'uspGet', 'p'))
  assert.deepEqual(await at('SELECT dbo.fnT|ax(1)'), object('dbo', 'fnTax', 'f'))
})

test('the part the cursor is in decides: schema, then object, then column', async () => {
  assert.deepEqual(await at('SELECT * FROM Sa|les.[Order]'), { kind: 'schema', schema: 'Sales' })
  assert.deepEqual(await at('SELECT Sales.[Order].To|tal FROM Sales.[Order]'), column('Sales', 'Order', 't', 'Total'))
  assert.deepEqual(await at('SELECT Sales.[Or|der].Total FROM Sales.[Order]'), object('Sales', 'Order', 't'))
  // table.column in the default schema: the first part is the table, not a schema.
  assert.deepEqual(await at('SELECT Cust|omer.Name FROM Customer'), object('dbo', 'Customer', 't'))
  assert.deepEqual(await at('SELECT Customer.na|me FROM Customer'), column('dbo', 'Customer', 't', 'Name'))
})

test('aliases: the alias itself, alias.column', async () => {
  const sql = 'SELECT o.Total FROM Sales.[Order] o JOIN Customer c ON o.CustomerID = c.CustomerID'
  const cursorAt = (needle: string, offset: number) => locateAt(sql, sql.indexOf(needle) + offset, deps)
  assert.deepEqual(await cursorAt('] o', 2), object('Sales', 'Order', 't')) // the o after the table
  assert.deepEqual(await cursorAt('c ON', 0), object('dbo', 'Customer', 't'))
  assert.deepEqual(await cursorAt('o.Total', 0), object('Sales', 'Order', 't')) // the o of o.Total
  assert.deepEqual(await cursorAt('o.Total', 4), column('Sales', 'Order', 't', 'Total'))
  assert.deepEqual(await cursorAt('c.CustomerID', 5), column('dbo', 'Customer', 't', 'CustomerID'))
  // A qualified column the table does not have still points at it (the tree stops at the table).
  assert.deepEqual(await at('SELECT o.Nop|e FROM Sales.[Order] o'), column('Sales', 'Order', 't', 'Nope'))
})

test('unqualified columns: the one table that has it; else the only table; else nothing', async () => {
  const join = 'FROM Sales.[Order] o JOIN Customer c ON o.CustomerID = c.CustomerID'
  assert.deepEqual(await at(`SELECT Tot|al ${join}`), column('Sales', 'Order', 't', 'Total'))
  assert.deepEqual(await at(`SELECT na|me ${join}`), column('dbo', 'Customer', 't', 'Name'))
  assert.equal(await at(`SELECT Customer|ID ${join}`), null, 'in both tables')
  assert.deepEqual(await at('SELECT Nope| FROM Customer'), object('dbo', 'Customer', 't'))
  assert.equal(await at(`SELECT Nope| ${join}`), null)
})

test('a synonym stands for its base object', async () => {
  assert.deepEqual(await at('SELECT * FROM sy|n'), object('Sales', 'Order', 't'))
  assert.deepEqual(await at('SELECT s.Tot|al FROM syn s'), column('Sales', 'Order', 't', 'Total'))
})

test('three-part names: this database resolves, another does not', async () => {
  assert.deepEqual(await at('SELECT * FROM Shop.dbo.Cust|omer'), object('dbo', 'Customer', 't'))
  assert.deepEqual(await at('SELECT * FROM Shop.Sal|es.[Order]'), { kind: 'schema', schema: 'Sales' })
  assert.equal(await at('SELECT * FROM Other.dbo.Cust|omer'), null)
  assert.equal(await at('SELECT * FROM Sh|op.dbo.Customer'), null)
  assert.equal(await at('SELECT * FROM a.b.c.Cust|omer'), null)
})

test('nothing to locate: keywords, built-ins, CTEs, temp tables, variables, unknown names, strings', async () => {
  assert.equal(await at('SEL|ECT * FROM Customer'), null)
  assert.equal(await at('SELECT * FR|OM Customer'), null)
  assert.equal(await at('SELECT COU|NT(*) FROM Customer'), null)
  assert.equal(await at('WITH x AS (SELECT 1 AS a) SELECT * FROM |x'), null)
  // A CTE hides a table of the same name.
  assert.equal(await at('WITH Customer AS (SELECT 1 AS a) SELECT * FROM Cust|omer'), null)
  assert.equal(await at('SELECT * FROM #te|mp'), null)
  assert.equal(await at('SELECT * FROM @t|able'), null)
  assert.equal(await at('SELECT * FROM Nowh|ere x JOIN Elsewhere y ON 1 = 1'), null)
  assert.equal(await at("SELECT 'Cust|omer'"), null)
  assert.equal(await at('-- Cust|omer'), null)
  assert.equal(await at('SELECT 1 |'), null)
})

test('columns that do not come back in time are not waited for', async () => {
  const slow = { index, columns: () => new Promise<Map<string, ObjectColumns>>(() => undefined) }
  const started = Date.now()
  // Unqualified, two tables: nothing known about their columns, so nothing to pick.
  assert.equal(await locateAt('SELECT Total FROM Sales.[Order] o JOIN Customer c ON 1 = 1', 9, slow), null)
  assert.ok(Date.now() - started < 1500)
})

test('targets map to the explorer tree’s paths', () => {
  assert.deepEqual(targetPath({ kind: 'column', schema: 'Sales', name: 'Order', type: 't', column: 'Total' }, 'c1', 'Shop'), {
    connection: 'c1', database: 'Shop', schema: 'Sales', folder: 'tables', object: 'Order', objectKind: 't', column: 'Total'
  })
  assert.deepEqual(targetPath({ kind: 'object', schema: 'dbo', name: 'fnTax', type: 'f' }, 'c1', 'Shop'), {
    connection: 'c1', database: 'Shop', schema: 'dbo', folder: 'functions', object: 'fnTax', objectKind: 'fn'
  })
  assert.deepEqual(targetPath({ kind: 'object', schema: 'dbo', name: 'uspGet', type: 'p' }, 'c1', 'Shop').folder, 'procedures')
  assert.deepEqual(targetPath({ kind: 'object', schema: 'dbo', name: 'vOrders', type: 'v' }, 'c1', 'Shop').objectKind, 'v')
  assert.deepEqual(targetPath({ kind: 'schema', schema: 'Sales' }, 'c1', 'Shop'), { connection: 'c1', database: 'Shop', schema: 'Sales' })
})
