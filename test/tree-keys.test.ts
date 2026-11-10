import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeKey, encodeKey, isTableLike, selectTopSql, sqlName, type TreePath } from '../src/shared/tree-keys.ts'

const table: TreePath = { connection: 'c1', database: 'Sales DB', schema: 'dbo', folder: 'tables', object: 'Order/Lines]', objectKind: 't' }

test('keys round-trip, special characters included', () => {
  for (const path of [{ connection: 'c1' }, { connection: 'c1', database: '' }, table, { ...table, column: 'Qty ]x' }]) {
    assert.deepEqual(decodeKey(encodeKey(path)), path)
  }
})

test('a column key keeps its object', () => {
  const path = decodeKey(encodeKey({ ...table, column: 'Id' }))
  assert.equal(path.object, 'Order/Lines]')
  assert.equal(path.objectKind, 't')
  assert.equal(path.column, 'Id')
})

test('placeholder keys decode to their parent', () => {
  assert.deepEqual(decodeKey(`${encodeKey(table)}/more:`), table)
  assert.deepEqual(decodeKey('c:c1/error:'), { connection: 'c1' })
})

test('sqlName brackets names and adds the database only when it differs', () => {
  assert.equal(sqlName(table, 'Sales DB'), '[dbo].[Order/Lines]]]')
  assert.equal(sqlName(table, 'master'), '[Sales DB].[dbo].[Order/Lines]]]')
  assert.equal(sqlName(table), '[Sales DB].[dbo].[Order/Lines]]]')
  assert.equal(sqlName({ ...table, column: 'Qty' }), '[Qty]')
  assert.equal(sqlName({ connection: 'c1', database: 'X', schema: 'Sales' }), '[Sales]')
  assert.equal(sqlName({ connection: 'c1' }), undefined)
})

test('select top uses a two-part name (the run itself targets the object database)', () => {
  assert.equal(selectTopSql(table), 'SELECT TOP (100) * FROM [dbo].[Order/Lines]]];')
  assert.ok(isTableLike(table))
  assert.ok(isTableLike({ ...table, objectKind: 'v' }))
  assert.ok(!isTableLike({ ...table, objectKind: 'p' }))
  assert.ok(!isTableLike({ ...table, column: 'Id' }))
})
