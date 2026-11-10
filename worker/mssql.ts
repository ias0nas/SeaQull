// SQL Server access over tedious (pure JavaScript TDS driver). No Orca APIs here, so it can be
// exercised directly against the local dev container (test/*.itest.ts).
// First, before tedious loads: lets servers given as IP addresses use TLS (Node 25 refuses an IP
// as the TLS server name).
import { ipServernameProblem } from './tls-ip.ts'
import { Connection, Request, type ConnectionConfiguration } from 'tedious'
import * as messageIoModule from 'tedious/lib/message-io.js'
// Makes tedious read decimal, numeric, money, smallmoney and datetimeoffset values exactly, as text.
import './exact-values.ts'
// Not re-exported from the package root.
import type { ColumnMetadata } from 'tedious/lib/token/colmetadata-token-parser'
import type { Cell, ColumnInfo } from '../src/protocol.ts'

{
  const problem = ipServernameProblem(messageIoModule)
  if (problem) console.warn(`SeaQull: servers given as IP addresses may fail to connect over TLS: ${problem}`)
}

export type Endpoint = {
  server: string
  port: number
  database: string
  encrypt: boolean
  trustServerCertificate: boolean
}

export type Credentials = { kind: 'sql'; user: string; password: string } | { kind: 'entra'; token: string }

/** Longest text kept per cell; anything longer (nvarchar(max), xml…) is cut with a marker. */
export const MAX_CELL_CHARS = 200_000

/** `requestTimeout` 0 (the default) lets queries run until done or cancelled; the explorer passes
 *  a finite one so a blocked catalog query cannot hold up its connection forever. */
export function openConnection(endpoint: Endpoint, credentials: Credentials, { requestTimeout = 0 } = {}): Promise<Connection> {
  const authentication: ConnectionConfiguration['authentication'] =
    credentials.kind === 'sql'
      ? { type: 'default', options: { userName: credentials.user, password: credentials.password } }
      : { type: 'azure-active-directory-access-token', options: { token: credentials.token } }
  const connection = new Connection({
    server: endpoint.server,
    authentication,
    options: {
      port: endpoint.port,
      database: endpoint.database || undefined,
      encrypt: endpoint.encrypt,
      trustServerCertificate: endpoint.trustServerCertificate,
      appName: 'SeaQull',
      connectTimeout: 20_000,
      requestTimeout,
      cancelTimeout: 10_000,
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false
    }
  })
  return new Promise((resolve, reject) => {
    connection.once('connect', (err) => {
      if (err) {
        connection.close()
        reject(new Error(describeConnectError(err)))
      } else resolve(connection)
    })
    // Socket errors after connect would otherwise crash the worker.
    connection.on('error', () => undefined)
    connection.connect()
  })
}

/** The connection has ended (closed by us, the server or the network): nothing more can run on it.
 *  tedious keeps this in a field it does not document (`closed`); its version is pinned, and
 *  test/values.test.ts fails if the field goes away. */
export const isClosed = (connection: Connection): boolean => (connection as unknown as { closed?: boolean }).closed === true

function describeConnectError(err: Error & { code?: string; cause?: unknown }): string {
  const cause = err.cause instanceof AggregateError ? err.cause.errors.map((e: Error) => e.message).join('; ') : ''
  return [err.message, cause].filter(Boolean).join(' ')
}

export type BatchEvents = {
  /** A new result set starts. */
  onColumns(columns: ColumnInfo[]): void
  /** Return false to stop (the row limit): the batch is cancelled after this row. */
  onRow(cells: Cell[]): boolean
  /** A statement finished; `hadResult` when it produced the result set that just ended. */
  onStatementDone(rowCount: number | undefined, hadResult: boolean): void
  onInfo(text: string, line?: number): void
  onError(text: string, line?: number): void
}

/** `lost`: the connection is gone (closed by the server, a KILL, the network); nothing more can run on it. */
export type BatchOutcome = 'done' | 'error' | 'cancelled' | 'stopped' | 'lost'

const LOST_CODES = new Set(['EINVALIDSTATE', 'ECLOSE', 'ESOCKET', 'ECONNRESET'])

/** Runs one batch, streaming result sets, rows and messages to `events`. */
export function runBatch(connection: Connection, sql: string, events: BatchEvents, signal?: AbortSignal): Promise<BatchOutcome> {
  // An abort listener added to an already-aborted signal never fires: check first.
  if (signal?.aborted) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    let inResult = false
    let stopped = false
    let sawError = false
    const onInfo = (info: { message: string; lineNumber?: number }) => events.onInfo(info.message, info.lineNumber)
    const onError = (info: { message: string; lineNumber?: number }) => {
      sawError = true
      events.onError(info.message, info.lineNumber)
    }
    connection.on('infoMessage', onInfo)
    connection.on('errorMessage', onError)
    const onAbort = () => connection.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })

    const endStatement = (rowCount: number | undefined) => {
      events.onStatementDone(rowCount, inResult)
      inResult = false
    }

    const request = new Request(sql, (err) => {
      connection.removeListener('infoMessage', onInfo)
      connection.removeListener('errorMessage', onError)
      signal?.removeEventListener('abort', onAbort)
      if (inResult) endStatement(undefined)
      const code = (err as { code?: string } | undefined)?.code
      if (stopped) resolve('stopped')
      else if (code === 'ECANCEL') resolve('cancelled')
      else if (code && LOST_CODES.has(code)) resolve('lost')
      else if (err) {
        // errorMessage usually reported it already; report driver-level errors that it did not.
        if (!sawError) events.onError(err.message, (err as { lineNumber?: number }).lineNumber)
        resolve('error')
      } else resolve(sawError ? 'error' : 'done')
    })
    request.on('columnMetadata', (columns) => {
      if (inResult) endStatement(undefined)
      inResult = true
      // An array, since useColumnNames is false.
      events.onColumns((Array.isArray(columns) ? columns : Object.values(columns)).map(describeColumn))
    })
    request.on('row', (columns: { value: unknown; metadata: ColumnMetadata }[]) => {
      if (stopped) return
      const keepGoing = events.onRow(columns.map((c) => toCell(c.value, c.metadata)))
      if (!keepGoing) {
        stopped = true
        connection.cancel()
      }
    })
    request.on('doneInProc', (rowCount?: number) => endStatement(rowCount))
    request.on('done', (rowCount?: number) => endStatement(rowCount))
    // A plain SQL batch, like SSMS: execSql would wrap it in sp_executesql, whose scope drops
    // temp tables and SET options when it ends, so they would not survive between runs.
    connection.execSqlBatch(request)
  })
}

/** Runs a query and returns all its rows as objects (metadata queries; small results only). */
export function queryRows(connection: Connection, sql: string): Promise<Record<string, Cell>[]> {
  const rows: Record<string, Cell>[] = []
  let columns: ColumnInfo[] = []
  const errors: string[] = []
  return runBatch(connection, sql, {
    onColumns: (c) => (columns = c),
    onRow: (cells) => {
      rows.push(Object.fromEntries(columns.map((c, i) => [c.name, cells[i]])))
      return true
    },
    onStatementDone: () => undefined,
    onInfo: () => undefined,
    onError: (text) => errors.push(text)
  }).then((outcome) => {
    if (outcome !== 'done') throw new Error(errors.join('\n') || `Query ${outcome}`)
    return rows
  })
}

// --- Types and values -----------------------------------------------------------------------

type Meta = Pick<ColumnMetadata, 'colName' | 'type' | 'dataLength' | 'precision' | 'scale'> & {
  udtInfo?: { typeName?: string }
}

/** tedious reports nullable columns as IntN, FloatN…; map back to the declared SQL type. */
export function baseTypeOf(meta: Meta): string {
  const name = meta.type.name
  const len = meta.dataLength ?? 0
  switch (name) {
    case 'IntN':
      return ({ 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' } as Record<number, string>)[len] ?? 'int'
    case 'FloatN':
      return len === 4 ? 'real' : 'float'
    case 'MoneyN':
      return len === 4 ? 'smallmoney' : 'money'
    case 'DateTimeN':
      return len === 4 ? 'smalldatetime' : 'datetime'
    case 'DecimalN':
      return 'decimal'
    case 'NumericN':
      return 'numeric'
    case 'BitN':
      return 'bit'
    case 'Variant':
      return 'sql_variant'
    case 'UDT':
      return (meta.udtInfo?.typeName ?? 'udt').toLowerCase()
    default:
      return name.toLowerCase()
  }
}

function describeColumn(meta: ColumnMetadata): ColumnInfo {
  const baseType = baseTypeOf(meta)
  const len = meta.dataLength ?? 0
  const isMax = len === 0xffff || len > 8000
  let type = baseType
  if (['char', 'varchar', 'binary', 'varbinary'].includes(baseType)) type = `${baseType}(${isMax ? 'max' : len})`
  else if (['nchar', 'nvarchar'].includes(baseType)) type = `${baseType}(${isMax ? 'max' : len / 2})`
  else if (['decimal', 'numeric'].includes(baseType)) type = `${baseType}(${meta.precision},${meta.scale})`
  else if (['datetime2', 'time', 'datetimeoffset'].includes(baseType) && meta.scale !== undefined) type = `${baseType}(${meta.scale})`
  return { name: meta.colName, type, baseType }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')
const datePart = (d: Date) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
/** Seconds with `scale` fractional digits: milliseconds from the Date, the 100 ns ticks beyond them
 *  from tedious's `nanosecondsDelta` (time, datetime2, datetimeoffset). */
function timePart(d: Date, scale = 3): string {
  const ticks = Math.round(((d as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0) * 1e7)
  const fraction = `${pad(d.getUTCMilliseconds(), 3)}${pad(ticks, 4)}`.slice(0, Math.max(0, Math.min(7, scale)))
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${fraction ? `.${fraction}` : ''}`
}
const TRUNCATED_RE = /… \[truncated, (\d+) chars\]$/
/** Cuts text to `keep` characters with a marker giving the original length (kept from an earlier cut). */
export function truncateText(text: string, keep: number, originalLength = text.length): string {
  const marked = TRUNCATED_RE.exec(text)
  const length = marked ? Number(marked[1]) : originalLength
  const body = marked ? text.slice(0, marked.index) : text
  return `${body.slice(0, keep)}… [truncated, ${length} chars]`
}
const truncated = (text: string, length: number) => truncateText(text, MAX_CELL_CHARS, length)

/** Converts a tedious value to a JSON-safe cell. tedious returns datetimes as UTC-based Dates
 *  (useUTC), so UTC getters give back the stored wall-clock value. Decimal, numeric, money,
 *  smallmoney and datetimeoffset values arrive as exact text already (exact-values.ts). */
export function toCell(value: unknown, meta: Meta): Cell {
  if (value === null || value === undefined) return null
  const baseType = baseTypeOf(meta)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    // datetime and smalldatetime have no scale: milliseconds, as SSMS shows them.
    const scale = ['time', 'datetime2', 'datetimeoffset'].includes(baseType) ? (meta.scale ?? 7) : 3
    switch (baseType) {
      case 'date':
        return datePart(value)
      case 'time':
        return timePart(value, scale)
      case 'datetimeoffset':
        return `${datePart(value)} ${timePart(value, scale)} +00:00`
      default:
        return `${datePart(value)} ${timePart(value, scale)}`
    }
  }
  if (Buffer.isBuffer(value)) {
    // Hex is two characters a byte: cap the bytes before converting (varbinary(max) can be huge).
    const hex = `0x${value.subarray(0, MAX_CELL_CHARS / 2).toString('hex').toUpperCase()}`
    return value.length * 2 + 2 > MAX_CELL_CHARS ? truncated(hex, value.length * 2 + 2) : hex
  }
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (typeof value === 'number' || typeof value === 'boolean') return Number.isFinite(value as number) || typeof value === 'boolean' ? value : String(value)
  if (typeof value === 'string') {
    // tedious returns bigint as a string; keep it a number when that is exact.
    if (baseType === 'bigint' && Number.isSafeInteger(Number(value))) return Number(value)
    return value.length > MAX_CELL_CHARS ? truncated(value, value.length) : value
  }
  return String(value)
}
