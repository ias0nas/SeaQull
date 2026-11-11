// Value conversion (tedious → JSON cells) and the page previews of long values, without a database.
import assert from 'node:assert/strict'
import { test } from 'node:test'
// mssql.ts before tedious: it sets up tls first (worker/tls-ip.ts).
import { baseTypeOf, isClosed, MAX_CELL_CHARS, toCell, truncateText } from '../worker/mssql.ts'
import { Connection } from 'tedious'
import type { Cell } from '../src/protocol.ts'
import { fitRow, PREVIEW_CHARS, previewRow, rowBytes } from '../worker/runs.ts'
import { checkExactValues, scaledText } from '../worker/exact-values.ts'
import { ipServernameProblem, withoutIpServername } from '../worker/tls-ip.ts'
import * as messageIoModule from 'tedious/lib/message-io.js'
import * as valueParserModule from 'tedious/lib/value-parser.js'

type Meta = Parameters<typeof toCell>[1]
const meta = (name: string, extra: Partial<Meta> = {}): Meta => ({ colName: 'c', type: { name } as Meta['type'], dataLength: 0, precision: 0, scale: 0, ...extra })

test('nullable tedious types map back to the declared SQL type', () => {
  assert.equal(baseTypeOf(meta('IntN', { dataLength: 1 })), 'tinyint')
  assert.equal(baseTypeOf(meta('IntN', { dataLength: 8 })), 'bigint')
  assert.equal(baseTypeOf(meta('FloatN', { dataLength: 4 })), 'real')
  assert.equal(baseTypeOf(meta('MoneyN', { dataLength: 8 })), 'money')
  assert.equal(baseTypeOf(meta('DateTimeN', { dataLength: 4 })), 'smalldatetime')
  assert.equal(baseTypeOf(meta('UDT', { udtInfo: { typeName: 'HierarchyId' } })), 'hierarchyid')
  assert.equal(baseTypeOf(meta('NVarChar')), 'nvarchar')
})

/** A Date as tedious makes it: UTC wall clock, sub-millisecond ticks in `nanosecondsDelta` (seconds). */
function tediousDate(iso: string, ticks = 0): Date {
  const date = new Date(`${iso}Z`)
  Object.defineProperty(date, 'nanosecondsDelta', { value: ticks / 1e7, enumerable: false })
  return date
}

test('dates and times: four-digit years, fractional digits to the column scale', () => {
  assert.equal(toCell(tediousDate('2024-05-06T07:08:09.123', 4567), meta('DateTime2', { scale: 7 })), '2024-05-06 07:08:09.1234567')
  assert.equal(toCell(tediousDate('2024-05-06T07:08:09.120'), meta('DateTime2', { scale: 2 })), '2024-05-06 07:08:09.12')
  assert.equal(toCell(tediousDate('1970-01-01T07:08:09'), meta('Time', { scale: 0 })), '07:08:09')
  assert.equal(toCell(tediousDate('0001-01-01T00:00:00'), meta('Date')), '0001-01-01')
  assert.equal(toCell(tediousDate('0999-12-31T23:59:59'), meta('DateTimeN', { dataLength: 8 })), '0999-12-31 23:59:59.000')
  assert.equal(toCell(tediousDate('2024-05-06T05:08:09.123'), meta('DateTimeOffset', { scale: 3 })), '2024-05-06 05:08:09.123 +00:00')
  assert.equal(toCell(new Date(Number.NaN), meta('DateTime2')), null)
})

test('numbers: exact bigints stay numbers, others become strings', () => {
  assert.equal(toCell('42', meta('IntN', { dataLength: 8 })), 42)
  assert.equal(toCell('9007199254740993', meta('IntN', { dataLength: 8 })), '9007199254740993')
  assert.equal(toCell(1.5, meta('FloatN', { dataLength: 8 })), 1.5)
  assert.equal(toCell(Number.POSITIVE_INFINITY, meta('FloatN', { dataLength: 8 })), 'Infinity')
  assert.equal(toCell(true, meta('BitN')), true)
})

test('long binary and text are kept whole up to the cell limit; over it, cut with the original length', () => {
  assert.equal(toCell(Buffer.from([1, 2, 255]), meta('VarBinary')), '0x0102FF')
  const cuts: number[] = []
  const onCut = (length: number) => cuts.push(length)
  const long = 'x'.repeat(1_000_000)
  assert.equal(toCell(long, meta('NVarChar'), onCut), long)
  assert.equal(toCell(Buffer.alloc(1_000_000, 0xab), meta('VarBinary'), onCut), `0x${'AB'.repeat(1_000_000)}`)
  assert.deepEqual(cuts, [])
  const big = toCell(Buffer.alloc(MAX_CELL_CHARS / 2), meta('VarBinary'), onCut) as string
  assert.match(big, new RegExp(`… \\[truncated, ${MAX_CELL_CHARS + 2} chars\\]$`))
  assert.ok(big.length < MAX_CELL_CHARS + 50)
  const text = toCell('x'.repeat(MAX_CELL_CHARS + 10), meta('NVarChar'), onCut) as string
  assert.match(text, new RegExp(`… \\[truncated, ${MAX_CELL_CHARS + 10} chars\\]$`))
  assert.deepEqual(cuts, [MAX_CELL_CHARS + 2, MAX_CELL_CHARS + 10])
})

test('cutting already-cut text keeps the original length in the marker', () => {
  const once = truncateText('y'.repeat(1000), 100)
  assert.equal(truncateText(once, 10), `${'y'.repeat(10)}… [truncated, 1000 chars]`)
  assert.equal(truncateText('a😀b', 2), 'a… [truncated, 4 chars]')
})

test('a row too large to keep is fitted by halving its longest values, which are listed with their whole lengths', () => {
  const cells: Cell[] = ['a'.repeat(10_000), 'b'.repeat(4000), 'c'.repeat(100), 5, null]
  const cut = new Map<number, number>()
  fitRow(cells, cut, 10_000)
  assert.ok(rowBytes(cells) <= 10_000, `row still ${rowBytes(cells)} bytes`)
  assert.deepEqual([...cut], [[0, 10_000], [1, 4000]])
  assert.match(cells[0] as string, /^a+… \[truncated, 10000 chars\]$/)
  assert.match(cells[1] as string, /^b+… \[truncated, 4000 chars\]$/)
  assert.deepEqual(cells.slice(2), ['c'.repeat(100), 5, null])

  const small: Cell[] = ['x'.repeat(100), 1]
  fitRow(small, cut, 10_000)
  assert.deepEqual(small, ['x'.repeat(100), 1])
})

test('a preview says how much of a value the worker kept, when it keeps only the start', () => {
  const kept = truncateText('x'.repeat(30_000), 20_000)
  const preview = previewRow([kept, 'y'.repeat(600)], new Map([[0, 30_000]]))
  assert.deepEqual(preview.cut, [[0, 30_000, 20_000], [1, 600]])
})

const jsonSize = (row: unknown[]) => Buffer.byteLength(JSON.stringify(row))

test('a page row sends the start of long text, ended with …, and which values were cut; the stored row stays whole', () => {
  const row = ['a'.repeat(200_000), 'b'.repeat(PREVIEW_CHARS), `0x${'AB'.repeat(1000)}`, 7, null]
  const stored = row.slice()
  const preview = previewRow(row)
  assert.deepEqual(row, stored)
  assert.deepEqual(preview.cells, [`${'a'.repeat(PREVIEW_CHARS)}…`, row[1], `0x${'AB'.repeat(249)}…`, 7, null])
  assert.deepEqual(preview.cut, [[0, 200_000], [2, 2002]])
})

test('a row of many long values is cut further to fit a page (measured as JSON bytes)', () => {
  const row = Array.from({ length: 1024 }, () => '\u0000'.repeat(1000)) // 6 bytes each in JSON: 3 KB a cell
  const preview = previewRow(row)
  assert.ok(jsonSize(preview.cells) <= 600_100, `row still ${jsonSize(preview.cells)} bytes`)
  assert.equal(preview.cut.length, 1024)
  assert.ok(preview.cut.every(([, length]) => length === 1000))
})

test('a preview never ends between the halves of a surrogate pair', () => {
  const text = `${'x'.repeat(PREVIEW_CHARS - 1)}😀${'y'.repeat(10)}`
  assert.equal(previewRow([text]).cells[0], `${'x'.repeat(PREVIEW_CHARS - 1)}…`)
})

test('small rows are sent as they are', () => {
  const small = ['x', 1]
  assert.deepEqual(previewRow(small), { cells: small, cut: [] })
  assert.equal(rowBytes(small), 2 + 16)
})

// --- Exact values: tedious's value reader, as worker/exact-values.ts wraps it -----------------

const valueParser = (valueParserModule as unknown as { default: typeof valueParserModule }).default
/** Reads one value as the row parsers do, from TDS bytes. */
function read(typeName: string, bytes: number[] | Buffer, extra: Record<string, unknown> = {}): unknown {
  const metadata = { type: { name: typeName }, precision: 38, scale: 0, dataLength: 0, ...extra }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const result = valueParser.readValue(buffer, 0, metadata as never, { useUTC: true } as never)
  assert.equal(result.offset, buffer.length, 'read the whole value')
  return result.value
}
const le = (value: bigint, length: number) => Array.from({ length }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn))
/** decimal/numeric: length, sign (1 positive), magnitude. */
const decimal = (units: bigint, length = 17) => [length, units < 0n ? 0 : 1, ...le(units < 0n ? -units : units, length - 1)]
/** money: high 32 bits, then low 32 bits. */
const money = (units: bigint) => {
  const raw = BigInt.asUintN(64, units)
  return [...le(raw >> 32n, 4), ...le(raw & 0xffffffffn, 4)]
}
/** datetimeoffset as SQL Server sends it: UTC time of day and date, then the offset in minutes. */
function dateTimeOffset(utc: string, ticks: number, minutes: number, scale = 7): number[] {
  const date = new Date(`${utc}Z`)
  const days = Math.floor((date.getTime() - Date.UTC(2000, 0, 1)) / 86_400_000) + 730_119
  const units = BigInt((((date.getTime() % 86_400_000) + 86_400_000) % 86_400_000) * 10_000 + ticks) / 10n ** BigInt(7 - scale)
  const timeLength = scale <= 2 ? 3 : scale <= 4 ? 4 : 5
  return [timeLength + 5, ...le(units, timeLength), ...le(BigInt(days), 3), ...le(BigInt.asUintN(16, BigInt(minutes)), 2)]
}

test('exact text for decimals: every digit, the whole scale, the sign', () => {
  assert.equal(scaledText(110n, 2), '1.10')
  assert.equal(scaledText(-5n, 3), '-0.005')
  assert.equal(scaledText(0n, 2), '0.00')
  assert.equal(scaledText(42n, 0), '42')
  assert.equal(read('DecimalN', decimal(12345678901234567890123456789n), { scale: 9 }), '12345678901234567890.123456789')
  assert.equal(read('NumericN', decimal(-12345678901234567890123456789n), { scale: 9 }), '-12345678901234567890.123456789')
  assert.equal(read('DecimalN', decimal(110n, 5), { scale: 2 }), '1.10')
  assert.equal(read('DecimalN', decimal(900719925474099325n, 9), { scale: 2 }), '9007199254740993.25')
  assert.equal(read('DecimalN', decimal(10n ** 38n - 1n), { scale: 0 }), '9'.repeat(38))
  assert.equal(read('DecimalN', decimal(1n), { scale: 38 }), `0.${'0'.repeat(37)}1`)
  // Negative zero (sign 0, magnitude 0) has no minus.
  assert.equal(read('DecimalN', [5, 0, 0, 0, 0, 0], { scale: 2 }), '0.00')
  assert.equal(read('DecimalN', [0], { scale: 2 }), null)
})

test('exact text for money and smallmoney: four decimal places, the full range', () => {
  assert.equal(read('Money', money(9223372036854775807n)), '922337203685477.5807')
  assert.equal(read('MoneyN', [8, ...money(-9223372036854775808n)]), '-922337203685477.5808')
  assert.equal(read('MoneyN', [8, ...money(-15000n)]), '-1.5000')
  assert.equal(read('MoneyN', [8, ...money(0n)]), '0.0000')
  assert.equal(read('SmallMoney', le(2147483647n, 4)), '214748.3647')
  assert.equal(read('MoneyN', [4, ...le(BigInt.asUintN(32, -2147483648n), 4)]), '-214748.3648')
  assert.equal(read('MoneyN', [0]), null)
})

test('datetimeoffset keeps its own offset, across midnight and at both ends of its range', () => {
  assert.equal(read('DateTimeOffset', dateTimeOffset('2026-01-01T21:34:05.123', 4567, 330), { scale: 7 }), '2026-01-02 03:04:05.1234567 +05:30')
  // 04:00 UTC on the 2nd is 23:00 on the 1st at -05:00.
  assert.equal(read('DateTimeOffset', dateTimeOffset('2026-01-02T04:00:00', 0, -300, 0), { scale: 0 }), '2026-01-01 23:00:00 -05:00')
  assert.equal(read('DateTimeOffset', dateTimeOffset('2026-01-02T04:00:00.120', 0, -570, 2), { scale: 2 }), '2026-01-01 18:30:00.12 -09:30')
  assert.equal(read('DateTimeOffset', dateTimeOffset('0001-01-01T14:00:00', 0, -840), { scale: 7 }), '0001-01-01 00:00:00.0000000 -14:00')
  assert.equal(read('DateTimeOffset', dateTimeOffset('9999-12-31T09:59:59.999', 9999, 840), { scale: 7 }), '9999-12-31 23:59:59.9999999 +14:00')
  assert.equal(read('DateTimeOffset', [0], { scale: 7 }), null)
})

test('sql_variant holding a decimal, money, smallmoney or datetimeoffset is exact too; other types are left alone', () => {
  const variant = (baseType: number, props: number[], value: number[]) => {
    const body = [baseType, props.length, ...props, ...value]
    return [...le(BigInt(body.length), 4), ...body]
  }
  assert.equal(read('Variant', variant(0x6a, [10, 2], decimal(110n, 5).slice(1))), '1.10')
  assert.equal(read('Variant', variant(0x6c, [38, 9], decimal(-12345678901234567890123456789n).slice(1))), '-12345678901234567890.123456789')
  assert.equal(read('Variant', variant(0x3c, [], money(9223372036854775807n))), '922337203685477.5807')
  assert.equal(read('Variant', variant(0x7a, [], le(15000n, 4))), '1.5000')
  assert.equal(read('Variant', variant(0x2b, [7], dateTimeOffset('2026-01-01T21:34:05', 0, 330).slice(1))), '2026-01-02 03:04:05.0000000 +05:30')
  assert.equal(read('Variant', variant(0x38, [], le(42n, 4))), 42) // int
})

test("the exact-value reader is what tedious's row parsers call, and what their rows hold", async () => {
  assert.deepEqual(await checkExactValues(), [['1.10'], ['1.10']])
})

test("isClosed reads tedious's own `closed` field, which must still exist", () => {
  // Never connected: constructing does not open a socket.
  const connection = new Connection({ server: 'localhost', options: { port: 1 } })
  connection.on('error', () => undefined)
  assert.equal(Object.hasOwn(connection, 'closed'), true, 'tedious no longer has a `closed` field: update isClosed (worker/mssql.ts)')
  assert.equal(isClosed(connection), false)
  connection.close()
  assert.equal(isClosed(connection), true)
})

test("tedious's TLS start goes through the wrapper that handles IP servers", () => {
  // The worker only logs a warning when this fails (IP servers alone are affected): here it fails.
  assert.equal(ipServernameProblem(messageIoModule), undefined)
})

test('TLS to an IP: no SNI, the IP checked as the host; names are left alone', () => {
  assert.deepEqual(withoutIpServername({ servername: '10.0.0.5', socket: 1 }), { socket: 1, host: '10.0.0.5' })
  assert.deepEqual(withoutIpServername({ servername: '::1' }), { host: '::1' })
  assert.deepEqual(withoutIpServername({ servername: 'fe80::1%lo0' }), { host: 'fe80::1%lo0' })
  assert.deepEqual(withoutIpServername({ servername: '10.0.0.5', host: 'db' }), { host: 'db' })
  const named = { servername: 'db.example.com' }
  assert.equal(withoutIpServername(named), named)
  assert.equal(withoutIpServername(undefined), undefined)
  assert.equal(withoutIpServername(1433), 1433)
})
