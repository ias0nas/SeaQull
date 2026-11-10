import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeColor } from '../src/shared/colors.ts'
import { isWorkbookText, nextTabName, parseWorkbook, serializeWorkbook, type Workbook } from '../src/shared/workbook.ts'

const book: Workbook = {
  seaqull: 1,
  id: 'book1',
  tabs: [
    { id: 'a1', name: 'local 1', connection: 'local', database: 'AW', sql: 'SELECT 1' },
    { id: 'b2', name: 'Orders', named: true, connection: 'prod', database: '', sql: '' }
  ]
}

test('workbook round-trips, unchanged files need no write-back', () => {
  assert.deepEqual(parseWorkbook(serializeWorkbook(book)), { book, repaired: false })
})

test('unknown fields survive a round trip (a newer version, or added by hand)', () => {
  const text = JSON.stringify({ seaqull: 1, id: 'b', theme: 'dark', tabs: [{ id: 't1', name: 'n', connection: '', database: '', sql: '', pinned: true }] })
  const { book: parsed, repaired } = parseWorkbook(text)
  assert.equal(repaired, false)
  const again = JSON.parse(serializeWorkbook(parsed))
  assert.equal(again.theme, 'dark')
  assert.equal(again.tabs[0].pinned, true)
})

test('workbook detection: JSON with a seaqull key only', () => {
  assert.ok(isWorkbookText(serializeWorkbook(book)))
  assert.ok(isWorkbookText('  {"seaqull":1,"tabs":[]}'))
  assert.ok(!isWorkbookText('SELECT 1'))
  assert.ok(!isWorkbookText('{"other":1}'))
  assert.ok(!isWorkbookText('{ broken'))
  assert.ok(!isWorkbookText(''))
})

test('parse repairs missing, invalid and duplicate ids and bad fields', () => {
  const { book: parsed, repaired } = parseWorkbook(JSON.stringify({ seaqull: 1, tabs: [{ id: 'x', sql: 5 }, { id: 'x' }, { id: '../bad' }, null] }))
  assert.equal(repaired, true)
  assert.match(parsed.id, /^[\w-]+$/)
  const ids = parsed.tabs.map((t) => t.id)
  assert.equal(ids[0], 'x')
  assert.equal(new Set(ids).size, 4)
  assert.ok(ids.every((id) => /^[\w-]{1,64}$/.test(id)))
  assert.equal(parsed.tabs[0].sql, '')
  assert.equal(parsed.tabs[3].name, 'Query')
  assert.throws(() => parseWorkbook('{"tabs":[]}'), /Not a SeaQull workbook/)
})

test('tab names: connection, a separator, and the lowest free number', () => {
  assert.equal(nextTabName([], 'local'), 'local · 1')
  assert.equal(nextTabName([{ name: 'local · 1' }, { name: 'local · 3' }], 'local'), 'local · 2')
  assert.equal(nextTabName([{ name: 'local · 1' }], 'prod'), 'prod · 1')
  assert.equal(nextTabName([], 'local 2'), 'local 2 · 1')
  assert.equal(nextTabName([{ name: 'Query · 1' }], ''), 'Query · 2')
})

test('colours: #rrggbb, short form expanded, anything else dropped', () => {
  assert.equal(normalizeColor('#E5534B'), '#e5534b')
  assert.equal(normalizeColor('3fb950'), '#3fb950')
  assert.equal(normalizeColor('#abc'), '#aabbcc')
  assert.equal(normalizeColor('red'), undefined)
  assert.equal(normalizeColor(''), undefined)
  assert.equal(normalizeColor(42), undefined)
})

test('a newer format version is kept, not written back as 1', () => {
  const { book } = parseWorkbook(JSON.stringify({ seaqull: 2, id: 'b', tabs: [] }))
  assert.equal(JSON.parse(serializeWorkbook(book)).seaqull, 2)
  assert.equal(parseWorkbook('{"seaqull":"x","id":"b","tabs":[]}').book.seaqull, 1)
})
