// Exact decimal, numeric, money, smallmoney and datetimeoffset values from tedious.
//
// tedious reads the first four into JS numbers, which round past 15–17 significant digits and
// drop the scale's trailing zeros (decimal(10,2) 1.10 becomes 1.1), and datetimeoffset into a UTC
// Date, which loses the stored offset. It has no option for anything else, so this module wraps its
// value reader: tedious's own `readValue` still runs (it checks the bytes are all there, waits for
// more otherwise, and tells where the value ends), then the bytes it consumed are decoded again,
// exactly, into text:
//   decimal, numeric       `-12.30`, all `scale` digits (from the integer on the wire, via BigInt)
//   money, smallmoney      `1.0000`, four decimal places, the type's scale
//   datetimeoffset         `2026-01-02 03:04:05.1234567 +05:30`, wall clock at its own offset
// sql_variant values of these types too. Everything else is left as tedious reads it.
//
// The row parsers look `readValue` up on the module's exports at every call (Babel's CommonJS
// output: `(0, _valueParser.readValue)(…)`), so replacing the export reaches them. That is tedious
// internals: package.json pins its exact version, and `checkExactValues` (run when this module
// loads) pushes a value through both row parsers and throws if it did not come out exact, so a
// tedious upgrade that changes this fails at once, in tests and when the worker starts, rather than
// quietly showing rounded numbers. Tests, the preview and the bundled worker all run this same code.
import * as valueParserModule from 'tedious/lib/value-parser.js'
import * as rowParserModule from 'tedious/lib/token/row-token-parser.js'
import * as nbcRowParserModule from 'tedious/lib/token/nbcrow-token-parser.js'
import type { Metadata } from 'tedious/lib/metadata-parser.js'

type ReadValue = typeof valueParserModule.readValue
type RowParser = (parser: unknown) => Promise<unknown>

/** A CommonJS module's `module.exports` (the `default` of its namespace, in Node and in esbuild's
 *  bundle alike): the object the row parsers read `readValue` from, which a namespace cannot set. */
function exportsOf<T>(namespace: T): T {
  const exports = (namespace as { default?: T }).default
  if (!exports) throw new Error('SeaQull: cannot reach tedious internals (no CommonJS exports object). Check the tedious version.')
  return exports
}

/** A row parser function, whichever way the CommonJS default export came through. */
function parserOf(namespace: unknown): RowParser {
  const exports = exportsOf(namespace) as RowParser | { default?: RowParser }
  const parse = typeof exports === 'function' ? exports : exports.default
  if (typeof parse !== 'function') throw new Error('SeaQull: cannot find tedious row parser. Check the tedious version.')
  return parse
}

// --- Decoding -----------------------------------------------------------------------------------

/** `units` in 10^-scale, as decimal text with exactly `scale` fraction digits. */
export function scaledText(units: bigint, scale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${digits.slice(digits.length - scale)}` : ''}`
}

/** An unsigned little-endian integer of `length` bytes. */
function unsignedLE(buf: Buffer, offset: number, length: number): bigint {
  let value = 0n
  for (let i = offset + length - 1; i >= offset; i--) value = (value << 8n) | BigInt(buf[i])
  return value
}

/** decimal/numeric: a sign byte (1 positive, 0 negative), then the unscaled magnitude. */
function numericText(buf: Buffer, offset: number, length: number, scale: number): string {
  const magnitude = unsignedLE(buf, offset + 1, length - 1)
  return scaledText(buf[offset] === 0 ? -magnitude : magnitude, scale)
}

/** money: a signed 64-bit count of 1/10000, sent as its high 32 bits then its low 32 bits. */
const moneyText = (buf: Buffer, offset: number) =>
  scaledText((BigInt(buf.readInt32LE(offset)) << 32n) | BigInt(buf.readUInt32LE(offset + 4)), 4)
const smallMoneyText = (buf: Buffer, offset: number) => scaledText(BigInt(buf.readInt32LE(offset)), 4)

const TICKS_PER_DAY = 86_400 * 10_000_000
const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** datetimeoffset: the UTC time of day (units of 10^-scale s), the UTC date (days since
 *  0001-01-01, 3 bytes), then the offset in minutes (signed 16 bits). Shown at that offset. */
function dateTimeOffsetText(buf: Buffer, offset: number, length: number, scale: number): string {
  const timeLength = length - 5
  let ticks = Number(unsignedLE(buf, offset, timeLength)) * 10 ** (7 - scale)
  let days = buf.readUIntLE(offset + timeLength, 3)
  const minutes = buf.readInt16LE(offset + timeLength + 3)
  ticks += minutes * 60 * 10_000_000
  if (ticks < 0) (ticks += TICKS_PER_DAY), days--
  else if (ticks >= TICKS_PER_DAY) (ticks -= TICKS_PER_DAY), days++
  // Day 0 is 0001-01-01; 2000-01-01 is day 730119.
  const date = new Date(Date.UTC(2000, 0, 1) + (days - 730_119) * 86_400_000)
  const seconds = Math.floor(ticks / 10_000_000)
  const fraction = pad(ticks % 10_000_000, 7).slice(0, scale)
  const sign = minutes < 0 ? '-' : '+'
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${fraction ? `.${fraction}` : ''} ` +
    `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
  )
}

/** TDS type ids inside a sql_variant (MS-TDS 2.2.5.4.1). */
const VARIANT = { money: 0x3c, smallMoney: 0x7a, decimal: 0x6a, numeric: 0x6c, dateTimeOffset: 0x2b }

/** sql_variant: total length (4 bytes), base type, property byte count, properties, value. */
function variantText(buf: Buffer, offset: number): string | undefined {
  const total = buf.readUInt32LE(offset)
  const baseType = buf[offset + 4]
  const propBytes = buf[offset + 5]
  const props = offset + 6
  const value = props + propBytes
  const length = total - 2 - propBytes
  switch (baseType) {
    case VARIANT.money:
      return moneyText(buf, value)
    case VARIANT.smallMoney:
      return smallMoneyText(buf, value)
    case VARIANT.decimal:
    case VARIANT.numeric:
      return numericText(buf, value, length, buf[props + 1])
    case VARIANT.dateTimeOffset:
      return dateTimeOffsetText(buf, value, length, buf[props])
    default:
      return undefined
  }
}

/** The exact text of the value at `offset`, which tedious has read (so it is complete and not
 *  NULL); undefined for the types left alone. */
function exactText(buf: Buffer, offset: number, metadata: Metadata): string | undefined {
  switch (metadata.type.name) {
    case 'DecimalN':
    case 'NumericN':
      return numericText(buf, offset + 1, buf[offset], metadata.scale ?? 0)
    case 'Money':
      return moneyText(buf, offset)
    case 'SmallMoney':
      return smallMoneyText(buf, offset)
    case 'MoneyN':
      return buf[offset] === 4 ? smallMoneyText(buf, offset + 1) : moneyText(buf, offset + 1)
    case 'DateTimeOffset':
      return dateTimeOffsetText(buf, offset + 1, buf[offset], metadata.scale ?? 7)
    case 'Variant':
      return variantText(buf, offset)
    default:
      return undefined
  }
}

// --- Installing and checking ------------------------------------------------------------------

const valueParser = exportsOf(valueParserModule)
const tediousReadValue: ReadValue = valueParser.readValue
if (typeof tediousReadValue !== 'function') throw new Error('SeaQull: cannot find tedious readValue. Check the tedious version.')

/** Sees every value read through the wrapper, for the check below. */
let probe: ((value: unknown) => void) | undefined

const exactReadValue: ReadValue = (buf, offset, metadata, options) => {
  const result = tediousReadValue(buf, offset, metadata, options)
  if (result.value !== null) {
    const exact = exactText(buf, offset, metadata)
    if (exact !== undefined) result.value = exact
  }
  probe?.(result.value)
  return result
}
valueParser.readValue = exactReadValue

/**
 * Feeds one decimal(9,2) value of 1.10 through tedious's ROW and NBCROW parsers (SQL Server uses
 * either) and throws unless both read it through the exact-value reader and got '1.10'. Both
 * parsers run synchronously up to and including the value read when the whole row is in the
 * buffer, so the check is synchronous; the returned promise gives the values each parser's row
 * token ended up with, for the tests to compare too.
 */
export function checkExactValues(): Promise<unknown[][]> {
  const metadata = { type: { name: 'DecimalN' }, precision: 9, scale: 2, dataLength: 5 }
  // 110 hundredths, positive, 4 bytes; NBCROW starts with a null bitmap (no NULLs).
  const value = [5, 1, 110, 0, 0, 0]
  const parsers: [string, RowParser, number[]][] = [
    ['ROW', parserOf(rowParserModule), value],
    ['NBCROW', parserOf(nbcRowParserModule), [0, ...value]]
  ]
  const rows: Promise<unknown[]>[] = []
  for (const [name, parse, bytes] of parsers) {
    const seen: unknown[] = []
    probe = (v) => seen.push(v)
    try {
      const fakeParser = {
        colMetadata: [metadata],
        buffer: Buffer.from(bytes),
        position: 0,
        options: {},
        waitForChunk: () => Promise.reject(new Error('the check row is incomplete'))
      }
      const row = parse(fakeParser) as Promise<{ columns: { value: unknown }[] }>
      rows.push(row.then((token) => token.columns.map((c) => c.value)))
    } finally {
      probe = undefined
    }
    if (seen.length !== 1 || seen[0] !== '1.10') {
      throw new Error(`SeaQull: tedious's ${name} parser no longer reads values through the exact-value reader (got ${JSON.stringify(seen)}); decimals would be rounded. Check the tedious version.`)
    }
  }
  return Promise.all(rows)
}

// Throws at import if the reader is not in place (the promise only matters to the tests).
checkExactValues().catch(() => undefined)
