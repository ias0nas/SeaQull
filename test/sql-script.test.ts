import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatHeader, headerEdit, parseHeader, splitBatches, withHeader } from '../src/shared/sql-script.ts'

test('header round-trips, including quotes and backslashes', () => {
  const target = { connection: 'Local "dev" \\ SQL', database: 'AdventureWorks2022' }
  assert.deepEqual(parseHeader(`${formatHeader(target)}\nSELECT 1`), target)
})

test('header keeps the console id', () => {
  const target = { connection: 'Local', database: 'AW', id: 'k3j2x9ab' }
  assert.equal(formatHeader(target), '-- seaqull: connection="Local" database="AW" id="k3j2x9ab"')
  assert.deepEqual(parseHeader(`${formatHeader(target)}\nSELECT 1`), target)
  assert.equal(parseHeader('-- seaqull: connection="a" database="b"')?.id, undefined)
})

test('no header', () => {
  assert.equal(parseHeader('SELECT 1\n-- seaqull: connection="x"'), null)
})

test('withHeader inserts, then replaces', () => {
  const once = withHeader('SELECT 1', { connection: 'a', database: 'b' })
  assert.equal(once, '-- seaqull: connection="a" database="b"\nSELECT 1')
  assert.equal(withHeader(once, { connection: 'c', database: '' }), '-- seaqull: connection="c" database=""\nSELECT 1')
  assert.equal(withHeader('', { connection: 'a', database: 'b' }), '-- seaqull: connection="a" database="b"\n')
})

test('splits on GO lines with line numbers and repeat counts', () => {
  const batches = splitBatches('SELECT 1\nGO\n\nSELECT 2\nSELECT 3\ngo 3\nPRINT 4;\n  GO  ')
  assert.deepEqual(batches, [
    { sql: 'SELECT 1', startLine: 1, repeat: 1 },
    { sql: '\nSELECT 2\nSELECT 3', startLine: 3, repeat: 3 },
    { sql: 'PRINT 4;', startLine: 7, repeat: 1 }
  ])
})

test('GO inside block comments and multi-line strings is not a separator', () => {
  const sql = "SELECT 'a\nGO\nb'\n/*\nGO\n*/\nSELECT 2"
  assert.equal(splitBatches(sql).length, 1)
})

test('GO-like words are not separators; comment-only batches are dropped', () => {
  assert.equal(splitBatches('SELECT 1 AS go\nGOTO label').length, 1)
  assert.deepEqual(splitBatches('-- only a comment\nGO\nSELECT 1').map((b) => b.sql), ['SELECT 1'])
})

test('doubled quotes stay inside the string', () => {
  assert.equal(splitBatches("SELECT 'it''s\nGO\nstill string'\nGO\nSELECT 2").length, 2)
})

test('bracketed and double-quoted identifiers hide quotes, comments and GO-like text', () => {
  const batches = splitBatches("SELECT 1 AS [Don't]\nGO\nSELECT \"it's\" AS [a -- b], [x /* y]\nGO\nCREATE VIEW v AS SELECT 1")
  assert.deepEqual(batches.map((b) => b.sql), ["SELECT 1 AS [Don't]", 'SELECT "it\'s" AS [a -- b], [x /* y]', 'CREATE VIEW v AS SELECT 1'])
  assert.deepEqual(splitBatches('SELECT [a]]\nGO\nb]\nGO\nSELECT 2').map((b) => b.sql), ['SELECT [a]]\nGO\nb]', 'SELECT 2'])
})

test('block comments nest, as in T-SQL', () => {
  const batches = splitBatches('/* outer /* inner */\nGO\nstill comment */\nSELECT 1\nGO\nSELECT 2')
  assert.deepEqual(batches.map((b) => b.sql), ['/* outer /* inner */\nGO\nstill comment */\nSELECT 1', 'SELECT 2'])
})

test('a line comment containing /* does not swallow the SQL after it', () => {
  assert.deepEqual(splitBatches('-- TODO /* debug\nUPDATE t SET x = 1\n-- */').map((b) => b.sql), ['-- TODO /* debug\nUPDATE t SET x = 1\n-- */'])
  assert.deepEqual(splitBatches('-- only\n/* comments */\nGO\nSELECT 1').map((b) => b.sql), ['SELECT 1'])
})

test('header ids the worker would refuse are ignored', () => {
  assert.equal(parseHeader('-- seaqull: connection="a" database="" id="../bad id"')?.id, undefined)
  assert.equal(parseHeader('-- seaqull: connection="a" database="" id="ok_1-2"')?.id, 'ok_1-2')
})

test('headerEdit: insert above, replace only the first line, nothing when already right', () => {
  const target = { connection: 'Local', database: 'AW', id: 'abc' }
  assert.deepEqual(headerEdit('SELECT 1', target), { start: 0, end: 0, text: '-- seaqull: connection="Local" database="AW" id="abc"\n' })
  const old = '-- seaqull: connection="Old" database="" id="abc"\nSELECT 1'
  assert.deepEqual(headerEdit(old, target), { start: 0, end: old.indexOf('\n'), text: '-- seaqull: connection="Local" database="AW" id="abc"' })
  assert.equal(headerEdit(withHeader('SELECT 1', target), target), null)
  assert.equal(withHeader('-- seaqull: connection="Old" database=""\r\nSELECT 1', target), '-- seaqull: connection="Local" database="AW" id="abc"\r\nSELECT 1')
  assert.equal(withHeader('-- seaqull: connection="Old" database=""', target), '-- seaqull: connection="Local" database="AW" id="abc"')
})
