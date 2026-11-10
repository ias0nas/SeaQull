import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ColumnInfo } from '../src/protocol.ts'
import { exportResult, uniqueKeys } from '../src/shared/export.ts'

const col = (name: string, baseType: string): ColumnInfo => ({ name, baseType, type: baseType })
const columns = [col('id', 'int'), col('name', 'nvarchar'), col('note', 'nvarchar'), col('blob', 'varbinary'), col('ok', 'bit')]
const rows = [
  [1, 'Ann', 'says "hi", ok', '0x0A0B', true],
  [2, "O'Brien", 'line1\nline2', null, false],
  [3, ' pad', null, null, null]
]

test('csv: RFC 4180 quoting, CRLF, NULL as empty', () => {
  assert.equal(
    exportResult('csv', { columns, rows }),
    'id,name,note,blob,ok\r\n' +
      '1,Ann,"says ""hi"", ok",0x0A0B,1\r\n' +
      '2,O\'Brien,"line1\nline2",,0\r\n' +
      '3," pad",,,\r\n'
  )
})

test('tsv quotes tabs and newlines', () => {
  const out = exportResult('tsv', { columns: [col('a', 'nvarchar')], rows: [['x\ty'], ['plain']] })
  assert.equal(out, 'a\r\n"x\ty"\r\nplain\r\n')
})

test('headers: false leaves out the header row (grid copy)', () => {
  assert.equal(exportResult('tsv', { columns: columns.slice(0, 2), rows: rows.map((r) => r.slice(0, 2)), headers: false }), "1\tAnn\r\n2\tO'Brien\r\n3\t\" pad\"\r\n")
  assert.equal(exportResult('csv', { columns: [col('a', 'int')], rows: [], headers: false }), '')
})

test('json keeps types and nulls; duplicate column names get suffixes', () => {
  const dup = [col('id', 'int'), col('id', 'int')]
  assert.deepEqual(uniqueKeys(dup), ['id', 'id_2'])
  assert.deepEqual(JSON.parse(exportResult('json', { columns: dup, rows: [[1, 2]] })), [{ id: 1, id_2: 2 }])
  assert.deepEqual(JSON.parse(exportResult('json', { columns, rows }))[1], {
    id: 2, name: "O'Brien", note: 'line1\nline2', blob: null, ok: false
  })
  assert.equal(exportResult('json', { columns, rows: [] }), '[]\n')
})

test('jsonl: one object per line', () => {
  const lines = exportResult('jsonl', { columns, rows }).trimEnd().split('\n')
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(lines[2]).name, ' pad')
})

test('markdown escapes pipes and newlines, right-aligns numbers', () => {
  const out = exportResult('markdown', { columns: [col('n', 'int'), col('t', 'nvarchar')], rows: [[1, 'a|b\nc'], [2, null]] })
  assert.equal(out, '| n | t |\n| ---: | --- |\n| 1 | a\\|b<br>c |\n| 2 | NULL |\n')
})

test('sql inserts: N-strings with doubled quotes, bare binary/numbers, NULL, bits', () => {
  const out = exportResult('sql', { columns, rows: rows.slice(0, 2), tableName: '[Sales].[X]' })
  assert.equal(
    out,
    `INSERT INTO [Sales].[X] ([id], [name], [note], [blob], [ok]) VALUES (1, N'Ann', N'says "hi", ok', 0x0A0B, 1);\n` +
      `INSERT INTO [Sales].[X] ([id], [name], [note], [blob], [ok]) VALUES (2, N'O''Brien', N'line1\nline2', NULL, 0);\n`
  )
})

test('sql inserts: big integers kept as strings go in bare; default table name', () => {
  const out = exportResult('sql', { columns: [col('big', 'bigint'), col('s', 'nvarchar')], rows: [['9007199254740993', '12']] })
  assert.equal(out, "INSERT INTO [dbo].[ExportedRows] ([big], [s]) VALUES (9007199254740993, N'12');\n")
})

test('sql inserts name unnamed and repeated columns, so the SQL is valid', () => {
  const out = exportResult('sql', { columns: [col('', 'int'), col('id', 'int'), col('id', 'int')], rows: [[1, 2, 3]] })
  assert.equal(out, 'INSERT INTO [dbo].[ExportedRows] ([column], [id], [id_2]) VALUES (1, 2, 3);\n')
})

test('unique keys never collide with an existing name', () => {
  assert.deepEqual(uniqueKeys([col('id', 'int'), col('id', 'int'), col('id_2', 'int')]), ['id', 'id_2', 'id_2_2'])
  assert.deepEqual(uniqueKeys([col('', 'int'), col('column', 'int')]), ['column', 'column_2'])
})
