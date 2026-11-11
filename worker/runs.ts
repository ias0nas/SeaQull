// Query runs: one SQL Server session per console tab (named by the tab's consoleId), queries run in
// the background, the editor polls status and pages rows, exports are formatted here and fetched in
// chunks. Everything is in memory: workers can be stopped at any time and that only loses results,
// except which consoles had a session (SessionMemory), so the next run can say its session is new.
//
// Answers must stay under Orca's 1 MiB cap and the worker's memory bounded, whatever the SQL does
// (a PRINT or RAISERROR loop, thousands of result sets, huge text or binary values), so messages,
// result sets, rows, runs and the worker as a whole all have budgets below, measured in bytes.
import { randomUUID } from 'node:crypto'
import type { Connection } from 'tedious'
import type { Cell, CellRange, ExportFormat, ResultSummary, RunMessage, RunState, RunStatus, ValueCut } from '../src/protocol.ts'
import { cellText, exportParts, formatInfo, type ExportParts } from '../src/shared/export.ts'
import { jsonFit } from '../src/shared/json-bytes.ts'
import { splitBatches } from '../src/shared/sql-script.ts'
import { isClosed, MAX_CELL_CHARS, queryRows, runBatch, truncateText, truncationMarker } from './mssql.ts'

/** Stay well under Orca's 1 MiB answer cap (measured as UTF-8 JSON). */
const PAGE_BYTE_BUDGET = 700_000
/** An export chunk's text, as UTF-8 JSON, stays under this (Orca's answer cap is 1 MiB). */
export const EXPORT_CHUNK_BYTES = 900_000
const SESSION_IDLE_MS = 30 * 60_000
const RUN_TTL_MS = 60 * 60_000
const EXPORT_TTL_MS = 10 * 60_000
/** Scripts too large for one request (Orca caps request input at 64 KiB) come in parts. */
export const MAX_SCRIPT_BYTES = 10 * 1024 * 1024
const UPLOAD_TTL_MS = 5 * 60_000
/** Consoles remembered across worker restarts, and for how long. */
const MAX_SESSION_RECORDS = 500
const SESSION_RECORD_TTL_MS = 30 * 24 * 60 * 60_000
const MAX_MESSAGE_CHARS = 4000
/**
 * What a status answer may hold, as UTF-8 JSON, so it always stays under 1 MiB: info messages,
 * errors (their own reserve, so a late error is never crowded out by info messages), and result
 * set summaries (each lists its columns). The final error of a run and the summary lines saying
 * what was left out are always added on top (a few KB).
 */
const INFO_BUDGET = { count: 900, bytes: 300_000 }
const ERROR_BUDGET = { count: 100, bytes: 150_000 }
const RESULT_BUDGET = { count: 500, bytes: 200_000 }
/** query.rows sends the start of longer values (rows are kept whole); a row of many columns is cut
 *  further to fit this. */
export const PREVIEW_CHARS = 500
const ROW_BYTE_BUDGET = 600_000
/** Rows kept in memory: per run, and for all kept runs of all consoles together. */
const RUN_BYTE_BUDGET = 100_000_000
const WORKER_BYTE_BUDGET = 400_000_000
/** One row may take this much of a run's budget; its longest values are cut to fit. */
export const MAX_ROW_BYTES = RUN_BYTE_BUDGET / 2
/** Bytes counted per row and per cell on top of their text (arrays and values cost memory too). */
const ROW_OVERHEAD = 64
const CELL_OVERHEAD = 16

/** `cut`: by row, then column, the whole length of each value kept cut short (to MAX_CELL_CHARS, or
 *  to fit MAX_ROW_BYTES). */
type ResultData = { summary: ResultSummary; rows: Cell[][]; cut?: Map<number, Map<number, number>> }

type Run = {
  id: string
  owner: string
  state: RunState
  startedAt: number
  endedAt?: number
  results: ResultData[]
  messages: RunMessage[]
  abort: AbortController
  /** Bytes its rows take, counted against the worker-wide budget until the run is dropped. */
  bytes: number
  /** Its session is new because the console's previous one ended: say so first. */
  notice?: EndReason
}

/** Why a console's session ended without the console asking. */
export type EndReason = 'idle' | 'lost' | 'edited' | 'worker'

const END_REASONS: Record<EndReason, string> = {
  idle: 'it had been idle for 30 minutes',
  lost: 'its connection to the server was lost',
  edited: 'its connection was edited',
  worker: "SeaQull's worker stopped (Orca quit or restarted, the plugin was reloaded or updated, or the worker failed)"
}

export const newSessionText = (reason: EndReason) =>
  `New SQL session: the previous one ended because ${END_REASONS[reason]}. Its temp tables and SET options are gone, and any transaction it had open was rolled back.`

/** A console that had a session: when, and why it ended (none: it was live). Only the console id
 *  (the key) and these, never SQL. */
type SessionRecord = { at: number; ended?: EndReason }

/** Where the worker keeps its SessionRecords across restarts (the plugin's storage). */
export type SessionMemory = {
  load(): Promise<unknown>
  save(records: Record<string, SessionRecord>): Promise<void>
  log(message: string): void
}

type Upload = { owner: string; parts: string[]; length: number; utf8: number; touched: number }

type Session = {
  key: string
  label: string
  connection?: Connection
  opening?: Promise<Connection>
  activeRun?: Run
  lastUsed: number
  /** Closed and out of the map; a connection that finishes opening now is closed at once. */
  retired?: boolean
  /** Its connection was edited or deleted while a query ran: close it once the query ends. */
  closeWhenIdle?: boolean
  /** Its connection ended without being closed here (server, network, KILL). */
  lost?: boolean
  /** @@TRANCOUNT was above 0 after the last run (or could not be read): never swept as idle. */
  openTransaction?: boolean
  /** The latest run's execute, until it is completely done: its status shows the end at once,
   *  but the @@TRANCOUNT check still uses the connection for a moment after. The next run waits
   *  for it, and the session is not swept or closed under it. */
  busy?: Promise<void>
}

/**
 * An export, formatted a chunk at a time: the text is the pieces head, row 0 … row n-1, tail, and
 * `ends[i]` is where piece i ends in it. Only these offsets are kept (8 bytes a row), not the text.
 */
type PreparedExport = {
  runId: string
  parts: ExportParts
  rows: Cell[][]
  ends: Float64Array
  createdAt: number
  bytes: number
  /** A row whose text the last chunk ended inside (a long value spans many chunks); in `bytes`. */
  last?: { piece: number; text: string }
}

/** Where a run goes: the session key parts, how to open a connection there, and how to name it to
 *  the user (the status-bar item's tooltip). */
export type Target = { connectionId: string; database: string; open: () => Promise<Connection>; label?: string }

/** What one console session is doing (the status-bar item). */
export type SessionActivity = { label: string; running: boolean; openTransaction: boolean }

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid_params' })
const cancelled = () => Object.assign(new Error('Cancelled.'), { cancelled: true })
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/** Settles with `promise`, or rejects as cancelled as soon as `signal` aborts (the promise goes on). */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export class RunManager {
  private sessions = new Map<string, Session>()
  private runs = new Map<string, Run>()
  private exports = new Map<string, PreparedExport>()
  private uploads = new Map<string, Upload>()
  private sweeper: ReturnType<typeof setInterval>
  private readonly maxRows: () => Promise<number>
  /** Bytes held by kept runs' rows, prepared exports and uploads in progress. */
  private keptBytes = 0
  private readonly memory?: SessionMemory
  /** By owner: consoles that have or had a session (see SessionRecord). */
  private records: Record<string, SessionRecord> = {}
  private readonly loaded: Promise<void>
  private saving: Promise<void> = Promise.resolve()
  /** Told whenever a run starts or ends, or a session's open transaction comes or goes. */
  private readonly onActivity?: () => void
  /** Asks after each run whether a transaction is open (replaced in tests, to stall it). */
  transactionProbe: (connection: Connection) => ReturnType<typeof probeTransaction> = (connection) => probeTransaction(connection)

  constructor(maxRows: () => Promise<number>, memory?: SessionMemory, onActivity?: () => void) {
    this.maxRows = maxRows
    this.memory = memory
    this.onActivity = onActivity
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref?.()
    // A session still live when the previous worker stopped ended with it.
    this.loaded = (async () => {
      if (!memory) return
      try {
        const stored = await memory.load()
        if (!stored || typeof stored !== 'object') return
        for (const [owner, value] of Object.entries(stored as Record<string, unknown>)) {
          const record = value as Partial<SessionRecord> | null
          if (typeof record?.at !== 'number') continue
          const ended = record.ended && record.ended in END_REASONS ? record.ended : 'worker'
          this.records[owner] = { at: record.at, ended }
        }
      } catch (err) {
        memory.log(`SeaQull: could not read which consoles had sessions: ${(err as Error).message}`)
      }
    })()
  }

  /** What every session is doing: running a query, holding a transaction. */
  activity(): SessionActivity[] {
    return [...this.sessions.values()].map((s) => ({ label: s.label, running: s.activeRun?.state === 'running', openTransaction: !!s.openTransaction }))
  }

  private changed(): void {
    try {
      this.onActivity?.()
    } catch {
      // The status bar never gets in the way of runs.
    }
  }

  /** Records (or with no record, forgets) a console's session and saves the lot, newest first,
   *  capped and expired. A failed save is logged, never passed on. */
  private remember(owner: string, record: SessionRecord | undefined): void {
    if (record) this.records[owner] = record
    else delete this.records[owner]
    const memory = this.memory
    if (!memory) return
    const cutoff = Date.now() - SESSION_RECORD_TTL_MS
    const kept = Object.entries(this.records)
      .filter(([, r]) => r.at >= cutoff)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_SESSION_RECORDS)
    this.records = Object.fromEntries(kept)
    const snapshot = { ...this.records }
    this.saving = this.saving
      .then(() => memory.save(snapshot))
      .catch((err) => memory.log(`SeaQull: could not save which consoles have sessions: ${(err as Error).message}`))
  }

  /** Starts `sql` on the owner's session; resolves once the run is registered, not when it ends.
   *  `firstLine` is where `sql` starts in the editor (0: it is not in the editor, so messages
   *  get no line links). */
  async start(owner: string, target: Target, sql: string, firstLine: number): Promise<string> {
    await this.loaded
    const sessionKey = `${target.connectionId}\u0000${target.database}`
    let session = this.sessions.get(owner)
    if (session?.activeRun?.state === 'running') {
      throw Object.assign(new Error('A query is already running in this console: cancel it or wait.'), { code: 'conflict' })
    }
    let notice: EndReason | undefined
    if (session && session.key !== sessionKey) {
      // The console moved to another connection or database: it knows it gets a new session.
      this.retire(owner, session)
      session = undefined
    } else if (session?.closeWhenIdle) {
      // Its connection was edited while the last run finished: this run gets a new session.
      this.retire(owner, session, 'edited')
      session = undefined
    }
    if (!session) {
      notice = this.records[owner]?.ended
      session = { key: sessionKey, label: target.label ?? (target.database || target.connectionId), lastUsed: Date.now() }
      this.sessions.set(owner, session)
      this.remember(owner, { at: Date.now() })
    }
    // Keep only this console's latest run: older results are replaced in the editor anyway.
    for (const run of [...this.runs.values()]) if (run.owner === owner) this.drop(run)

    const run: Run = { id: randomUUID(), owner, state: 'running', startedAt: Date.now(), results: [], messages: [], abort: new AbortController(), bytes: 0, notice }
    this.runs.set(run.id, run)
    session.activeRun = run
    session.lastUsed = Date.now()
    this.changed()
    // Registered above before any await, so a second start meanwhile is refused as running. This
    // run waits for the previous one to be completely done before it touches the connection.
    const done = this.execute(session, target, run, sql, firstLine, session.busy)
    const current = session
    current.busy = done
    void done.finally(() => {
      if (current.busy === done) current.busy = undefined
    })
    return run.id
  }

  /** Forgets a run (and its export) and gives their bytes back to the worker-wide budget. */
  private drop(run: Run): void {
    if (this.runs.get(run.id) !== run) return
    this.runs.delete(run.id)
    this.keptBytes -= run.bytes
    for (const [id, prepared] of this.exports) if (prepared.runId === run.id) this.dropExport(id)
  }

  /** Ends a session: closes its connection now, or as soon as one that is still opening opens.
   *  `reason`: it ended without the console asking, so its next run says so. */
  private retire(owner: string, session: Session, reason?: EndReason): void {
    if (session.retired) return
    session.retired = true
    session.connection?.close()
    session.connection = undefined
    if (this.sessions.get(owner) === session) this.sessions.delete(owner)
    if (reason) this.remember(owner, { at: Date.now(), ended: reason })
    this.changed()
  }

  private async connect(session: Session, target: Target, signal: AbortSignal): Promise<Connection> {
    if (session.connection && !isClosed(session.connection)) return session.connection
    session.opening ??= (async () => {
      const connection = await target.open()
      if (session.retired) {
        // The tab closed (or the target changed) while connecting: never keep this connection.
        connection.close()
        throw cancelled()
      }
      connection.on('end', () => {
        if (session.connection !== connection) return
        session.connection = undefined
        // Not closed by retire: the server or the network ended it (and any transaction with it).
        if (!session.retired) session.lost = true
        if (session.openTransaction) {
          session.openTransaction = false
          this.changed()
        }
      })
      session.connection = connection
      return connection
    })().finally(() => (session.opening = undefined))
    // A cancel takes effect at once; the connection still opening is kept for the next run.
    return unlessAborted(session.opening, signal)
  }

  /** Never rejects: whatever happens ends up in the run's state and messages. */
  private async execute(session: Session, target: Target, run: Run, sql: string, firstLine: number, previous?: Promise<void>): Promise<void> {
    const used = { info: { count: 0, bytes: 0 }, error: { count: 0, bytes: 0 }, result: { count: 0, bytes: 0 } }
    const dropped = { info: 0, error: 0, results: 0 }
    let sawError = false
    let memoryLimit = ''
    let overCap = 0
    /** Keeps a message if its kind's budget allows; `always` for the run's final error. */
    const note = (message: RunMessage, always = false) => {
      if (message.kind === 'error') sawError = true
      const text = message.text.length > MAX_MESSAGE_CHARS ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : message.text
      const kept = { ...message, text }
      const budget = message.kind === 'error' ? ERROR_BUDGET : INFO_BUDGET
      const tally = used[message.kind]
      const bytes = jsonBytes(kept)
      if (!always && (tally.count >= budget.count || tally.bytes + bytes > budget.bytes)) {
        if (message.kind === 'error') dropped.error++
        else dropped.info++
        return
      }
      tally.count++
      tally.bytes += bytes
      run.messages.push(kept)
    }
    // Line in the editor, when the SQL came from it (firstLine ≥ 1).
    const docLine = (batchStart: number, line?: number) => (line && firstLine >= 1 ? firstLine + batchStart - 2 + line : undefined)
    // The previous run on this session may still be checking @@TRANCOUNT (5 s at most).
    if (previous) await previous.catch(() => undefined)
    if (!run.notice && (session.lost || (session.connection && isClosed(session.connection)))) {
      run.notice = 'lost'
      session.lost = false
      this.remember(run.owner, { at: Date.now() })
    }
    if (run.notice) note({ kind: 'info', text: newSessionText(run.notice) })
    let connection: Connection | undefined
    try {
      if (run.abort.signal.aborted) throw cancelled() // cancelled while it waited
      const maxRows = await this.maxRows()
      connection = await this.connect(session, target, run.abort.signal)
      const batches = splitBatches(sql)
      if (batches.length === 0) note({ kind: 'info', text: 'Nothing to run.' })
      batchLoop: for (const [b, batch] of batches.entries()) {
        for (let repeat = 0; repeat < batch.repeat; repeat++) {
          // A cancel that came before the batch started (say while connecting) stops it here.
          if (run.abort.signal.aborted) throw cancelled()
          if (isClosed(connection)) {
            session.lost = true
            throw connectionLost()
          }
          let current: ResultData | undefined
          const outcome = await runBatch(
            connection,
            batch.sql,
            {
              onColumns: (columns) => {
                current = undefined
                const summary: ResultSummary = { index: run.results.length, batch: b + 1, columns, rowCount: 0, truncated: false }
                const bytes = jsonBytes(summary) + 32 // rowCount and truncated grow a little
                if (used.result.count >= RESULT_BUDGET.count || used.result.bytes + bytes > RESULT_BUDGET.bytes) {
                  dropped.results++
                  return
                }
                used.result.count++
                used.result.bytes += bytes
                current = { summary, rows: [] }
                run.results.push(current)
              },
              onRow: (cells, capped) => {
                if (!current) return true
                if (current.rows.length >= maxRows) {
                  current.summary.truncated = true
                  return false
                }
                const cut = new Map(capped)
                fitRow(cells, cut)
                const bytes = rowBytes(cells) + ROW_OVERHEAD + cells.length * CELL_OVERHEAD
                if (run.bytes + bytes > RUN_BYTE_BUDGET) memoryLimit = 'this run'
                else if (this.keptBytes + bytes > WORKER_BYTE_BUDGET) memoryLimit = 'all open results together'
                if (memoryLimit) {
                  current.summary.truncated = true
                  return false
                }
                run.bytes += bytes
                this.keptBytes += bytes
                current.rows.push(cells)
                current.summary.rowCount = current.rows.length
                if (cut.size > 0) {
                  ;(current.cut ??= new Map()).set(current.rows.length - 1, cut)
                  overCap += cut.size
                }
                return true
              },
              onStatementDone: (rowCount, hadResult) => {
                if (hadResult) current = undefined
                else if (rowCount !== undefined) note({ kind: 'info', text: `(${rowCount} row${rowCount === 1 ? '' : 's'} affected)` })
              },
              onInfo: (text, line) => note({ kind: 'info', text, line: docLine(batch.startLine, line) }),
              onError: (text, line) => note({ kind: 'error', text, line: docLine(batch.startLine, line) })
            },
            run.abort.signal
          )
          if (outcome === 'lost') {
            session.lost = true
            throw connectionLost()
          }
          if (outcome === 'stopped') {
            note({
              kind: 'info',
              text: memoryLimit
                ? `Stopped: results passed SeaQull's memory budget for ${memoryLimit}; the rest of batch ${b + 1} did not run. Close tabs you no longer need, or narrow the query.`
                : `Stopped after ${maxRows.toLocaleString('en-US')} rows (SeaQull row limit setting); the rest of batch ${b + 1} did not run.`
            })
            if (memoryLimit) break batchLoop
          }
          if (outcome === 'cancelled' || run.abort.signal.aborted) throw cancelled()
        }
      }
    } catch (err) {
      if ((err as { cancelled?: boolean }).cancelled || run.abort.signal.aborted) {
        run.state = 'cancelled'
        note({ kind: 'error', text: 'Cancelled.' }, true)
      } else {
        run.state = 'error'
        note({ kind: 'error', text: err instanceof Error ? err.message : String(err) }, true)
      }
    }
    // What was left out goes in after the budgets, so it always shows.
    if (dropped.results > 0) {
      run.messages.push({ kind: 'info', text: `… ${dropped.results} more result sets not kept (SeaQull keeps at most ${RESULT_BUDGET.count} per run).` })
    }
    if (overCap > 0) {
      const values = overCap === 1 ? '1 value was' : `${overCap.toLocaleString('en-US')} values were`
      run.messages.push({
        kind: 'info',
        text: `${values} cut short: SeaQull keeps up to ${MAX_CELL_CHARS.toLocaleString('en-US')} characters of a value, and about ${(MAX_ROW_BYTES / 2).toLocaleString('en-US')} of a row. The grid, copies and exports all have the cut values.`
      })
    }
    if (dropped.error > 0) run.messages.push({ kind: 'error', text: `… ${dropped.error} more errors not shown.` })
    if (dropped.info > 0) run.messages.push({ kind: 'info', text: `… ${dropped.info} more messages not shown.` })
    if (run.state === 'running') run.state = sawError ? 'error' : 'done'
    run.endedAt = Date.now()
    session.lastUsed = Date.now()
    // The run is over as far as anyone can see (status, the status-bar item)…
    this.changed()
    // …but the session is still busy (session.busy) until this check is done with the connection.
    // A session holding a transaction is never closed as idle (closing would roll it back).
    if (connection && !isClosed(connection)) {
      const transaction = await this.transactionProbe(connection)
      if (transaction === 'lost') {
        // No answer: the connection is dead in all but name. Give it up (the next run opens a new
        // one and says so); no transaction survives on it.
        session.lost = true
        session.openTransaction = false
        if (session.connection === connection) session.connection = undefined
        connection.close()
      } else session.openTransaction = transaction !== 'none'
    }
    if (session.activeRun === run) session.activeRun = undefined
    // Not if a newer run already took the session over: its own end closes it.
    if (session.closeWhenIdle && !session.activeRun) this.retire(run.owner, session, 'edited')
    this.changed()
  }

  private get(runId: string): Run {
    const run = this.runs.get(runId)
    if (!run) throw invalid('That result is gone (the worker restarted or a newer query replaced it). Run the query again.')
    return run
  }

  private result(runId: string, result: number): ResultData {
    const data = Number.isInteger(result) ? this.get(runId).results[result] : undefined
    if (!data) throw invalid(`No result ${result}`)
    return data
  }

  /** `messagesFrom`: the messages the caller already has (they only ever grow at the end): just
   *  the ones after them are sent, rather than up to a few hundred KB again on every poll. */
  status(runId: string, messagesFrom = 0): RunStatus {
    const run = this.get(runId)
    const from = Number.isInteger(messagesFrom) ? Math.min(Math.max(messagesFrom, 0), run.messages.length) : 0
    return {
      runId: run.id,
      state: run.state,
      elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt,
      results: run.results.map((r) => r.summary),
      messages: from > 0 ? run.messages.slice(from) : run.messages,
      messagesFrom: from
    }
  }

  /** The owner's latest run (one is kept per owner), so a console reloaded by Orca gets its results back. */
  latest(owner: string): RunStatus | null {
    const run = [...this.runs.values()].find((r) => r.owner === owner)
    return run ? this.status(run.id) : null
  }

  cancel(runId: string): void {
    const run = this.get(runId)
    if (run.state === 'running') run.abort.abort()
  }

  /** Rows from `offset`, as many as fit in one answer, with long values cut short (see ValueCut). */
  rows(runId: string, result: number, offset: number, limit: number): { offset: number; rows: Cell[][]; cut: ValueCut[] } {
    const data = this.result(runId, result)
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw invalid('offset and limit must be whole numbers ≥ 0 and ≥ 1')
    const rows: Cell[][] = []
    const cut: ValueCut[] = []
    let bytes = 0
    for (let i = offset; i < Math.min(offset + limit, data.rows.length); i++) {
      const preview = previewRow(data.rows[i], data.cut?.get(i))
      const entries = preview.cut.map((entry): ValueCut => [rows.length, ...entry])
      const size = jsonBytes(preview.cells) + entries.reduce((sum, entry) => sum + jsonBytes(entry) + 1, 0)
      if (rows.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break
      cut.push(...entries)
      rows.push(preview.cells)
      bytes += size
    }
    return { offset, rows, cut }
  }

  /**
   * Gets an export ready: works out where each row's text starts, a few thousand rows at a time so
   * other requests get through, but keeps no text; export.chunk formats its stretch on demand. One
   * export per run (a new one replaces the last), counted in the worker's memory budget.
   * `selection`: only those rows and columns (a grid selection); `raw`: one selected cell's text.
   */
  async prepareExport(runId: string, result: number, format: ExportFormat, tableName?: string, headers = true, selection?: CellRange, raw = false) {
    let info: ReturnType<typeof formatInfo>
    try {
      info = formatInfo(format)
    } catch (err) {
      throw invalid((err as Error).message)
    }
    const data = this.result(runId, result)
    const range = selection ?? { r0: 0, r1: data.rows.length - 1, c0: 0, c1: data.summary.columns.length - 1 }
    if (selection !== undefined && !withinResult(selection, data.rows.length, data.summary.columns.length)) {
      throw invalid('selection must be rows r0…r1 and columns c0…c1 of the result')
    }
    if (raw && (!selection || range.r0 !== range.r1 || range.c0 !== range.c1)) throw invalid('raw needs a selection of one cell')
    for (const [id, prepared] of this.exports) if (prepared.runId === runId) this.dropExport(id)
    const rows = data.rows.slice(range.r0, range.r1 + 1) // the rows as they are now (a run still going adds more)
    const bytes = (rows.length + 2) * 8 + rows.length * 8
    if (this.keptBytes + bytes > WORKER_BYTE_BUDGET) {
      throw new Error('Not enough of SeaQull\'s memory left to export this result: close tabs whose results you no longer need, then try again.')
    }
    const allColumns = range.c0 === 0 && range.c1 === data.summary.columns.length - 1
    const columns = data.summary.columns.slice(range.c0, range.c1 + 1)
    const formatted = exportParts(format, { columns, rows, tableName, headers })
    const parts: ExportParts = raw
      ? { head: '', row: (cells) => cellText(cells[range.c0]), tail: '' }
      : allColumns
        ? formatted
        : { ...formatted, row: (cells, i) => formatted.row(cells.slice(range.c0, range.c1 + 1), i) }
    const ends = new Float64Array(rows.length + 2)
    let end = parts.head.length
    ends[0] = end
    for (let i = 0; i < rows.length; i++) {
      end += parts.row(rows[i], i).length
      ends[i + 1] = end
      if (i % 5000 === 4999) await new Promise((resolve) => setImmediate(resolve))
    }
    ends[rows.length + 1] = end + parts.tail.length
    const length = ends[rows.length + 1]
    // The run may have been replaced while this ran, or another export of it prepared meanwhile:
    // the newest one wins.
    if (!this.runs.has(runId)) throw invalid('That result is gone (a newer query replaced it). Run the query again.')
    for (const [id, prepared] of this.exports) if (prepared.runId === runId) this.dropExport(id)
    const exportId = randomUUID()
    this.exports.set(exportId, { runId, parts, rows, ends, createdAt: Date.now(), bytes })
    this.keptBytes += bytes
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const base = tableName?.replace(/[\[\]]/g, '').replace(/[^\w.-]+/g, '_') || 'result'
    return { exportId, length, fileName: `${base}-${stamp}.${info.extension}`, mimeType: info.mimeType }
  }

  /** The export's text from character `offset`, as much as fits in EXPORT_CHUNK_BYTES, formatted
   *  now; `next` is where the following chunk starts (null: this was the last). */
  exportChunk(exportId: string, offset: number): { text: string; next: number | null } {
    const prepared = this.exports.get(exportId)
    const length = prepared?.ends[prepared.ends.length - 1] ?? 0
    if (!prepared || !Number.isInteger(offset) || offset < 0 || offset > length) throw invalid('Export expired: export again.')
    const { ends, parts, rows } = prepared
    // The first piece ending after `offset` (piece 0 the head, 1…n the rows, n + 1 the tail).
    let lo = 0
    let hi = ends.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ends[mid] > offset) hi = mid
      else lo = mid + 1
    }
    let text = ''
    let at = offset
    let budget = EXPORT_CHUNK_BYTES
    for (let piece = lo; piece < ends.length && at < length; piece++) {
      const start = piece === 0 ? 0 : ends[piece - 1]
      if (ends[piece] <= at) continue
      const isRow = piece > 0 && piece < ends.length - 1
      const whole =
        piece === 0 ? parts.head : !isRow ? parts.tail : prepared.last?.piece === piece ? prepared.last.text : parts.row(rows[piece - 1], piece - 1)
      const [end, bytes] = jsonFit(whole, at - start, budget)
      text += whole.slice(at - start, end)
      budget -= bytes
      at = start + end
      if (isRow) this.keepPiece(prepared, end < whole.length ? { piece, text: whole } : undefined)
      if (end < whole.length) break
    }
    const next = at < length ? at : null
    if (next === null) setTimeout(() => this.dropExport(exportId), 60_000).unref?.()
    return { text, next }
  }

  private keepPiece(prepared: PreparedExport, last: PreparedExport['last']): void {
    if (prepared.last === last || (prepared.last && last && prepared.last.piece === last.piece)) return
    const change = (last?.text.length ?? 0) * 2 - (prepared.last?.text.length ?? 0) * 2
    prepared.last = last
    prepared.bytes += change
    this.keptBytes += change
  }

  private dropExport(exportId: string): void {
    const prepared = this.exports.get(exportId)
    if (!prepared) return
    this.exports.delete(exportId)
    this.keptBytes -= prepared.bytes
  }

  /**
   * Adds part of a script too large for one request: `offset` is where it goes (the length so far,
   * so a part sent twice or skipped is caught). No `uploadId` starts a new upload, replacing the
   * console's unfinished one. Counted in the worker's memory budget; dropped after 5 idle minutes.
   */
  append(owner: string, uploadId: string | undefined, offset: number, part: string): { uploadId: string } {
    if (typeof part !== 'string' || !Number.isInteger(offset) || offset < 0) throw invalid('part must be text and offset a whole number ≥ 0')
    let id = uploadId
    let upload = id ? this.uploads.get(id) : undefined
    if (id && (!upload || upload.owner !== owner)) throw invalid('That script upload expired: run again.')
    if (!upload) {
      for (const [other, existing] of this.uploads) if (existing.owner === owner) this.dropUpload(other)
      id = randomUUID()
      upload = { owner, parts: [], length: 0, utf8: 0, touched: Date.now() }
      this.uploads.set(id, upload)
    }
    if (offset !== upload.length) {
      this.dropUpload(id!)
      throw invalid(`Script upload out of order (part at ${offset}, expected ${upload.length}): run again.`)
    }
    const utf8 = Buffer.byteLength(part)
    if (upload.utf8 + utf8 > MAX_SCRIPT_BYTES) {
      this.dropUpload(id!)
      throw invalid(`Script too large: SeaQull runs at most ${MAX_SCRIPT_BYTES / 1024 / 1024} MB at once. Run it in parts (select one, then ⌘↵).`)
    }
    if (this.keptBytes + part.length * 2 > WORKER_BYTE_BUDGET) {
      this.dropUpload(id!)
      throw new Error("Not enough of SeaQull's memory left for this script: close tabs whose results you no longer need, then run again.")
    }
    upload.parts.push(part)
    upload.length += part.length
    upload.utf8 += utf8
    upload.touched = Date.now()
    this.keptBytes += part.length * 2
    return { uploadId: id! }
  }

  /** The whole uploaded script, which is then forgotten. */
  takeUpload(owner: string, uploadId: string): string {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.owner !== owner) throw invalid('That script upload expired: run again.')
    this.dropUpload(uploadId)
    return upload.parts.join('')
  }

  private dropUpload(uploadId: string): void {
    const upload = this.uploads.get(uploadId)
    if (!upload) return
    this.uploads.delete(uploadId)
    this.keptBytes -= upload.length * 2
  }

  /** A console tab closed: stop its query, end its SQL session, drop its results. */
  closeOwner(owner: string): void {
    const session = this.sessions.get(owner)
    if (session?.activeRun?.state === 'running') session.activeRun.abort.abort()
    if (session) this.retire(owner, session)
    for (const run of [...this.runs.values()]) if (run.owner === owner) this.drop(run)
    for (const [id, upload] of this.uploads) if (upload.owner === owner) this.dropUpload(id)
    if (this.records[owner]) this.remember(owner, undefined)
  }

  /** Closes every session on a connection (after its server, login or database changed, or it was
   *  deleted); one running a query closes when the query ends, so the next run uses the new settings. */
  closeConnection(connectionId: string): void {
    for (const [owner, session] of this.sessions) {
      if (!session.key.startsWith(`${connectionId}\u0000`)) continue
      if (session.busy) session.closeWhenIdle = true
      else this.retire(owner, session, 'edited')
    }
  }

  /** Closes idle sessions (never one with a transaction open), drops old runs, exports and
   *  unfinished uploads. Every minute; `now` is for tests. */
  sweep(now = Date.now()): void {
    for (const [owner, session] of this.sessions) {
      if (!session.busy && !session.openTransaction && now - session.lastUsed > SESSION_IDLE_MS) {
        this.retire(owner, session, session.lost ? 'lost' : 'idle')
      }
    }
    for (const run of [...this.runs.values()]) if (run.endedAt && now - run.endedAt > RUN_TTL_MS) this.drop(run)
    for (const [id, prepared] of this.exports) if (now - prepared.createdAt > EXPORT_TTL_MS) this.dropExport(id)
    for (const [id, upload] of this.uploads) if (now - upload.touched > UPLOAD_TTL_MS) this.dropUpload(id)
  }

  /** Stops the sweeper and closes every session (worker deactivate, tests). */
  dispose(): void {
    clearInterval(this.sweeper)
    // Their records stay live: the next worker tells each console its session ended with this one.
    for (const [owner, session] of this.sessions) this.retire(owner, session)
  }

  /** Resolves once the console's latest run is completely done, its @@TRANCOUNT check included (tests). */
  async settled(owner: string): Promise<void> {
    while (this.sessions.get(owner)?.busy) await this.sessions.get(owner)!.busy
  }

  /** Writes still in flight to the session memory (tests). */
  flushMemory(): Promise<void> {
    return this.saving
  }
}

/** How long the @@TRANCOUNT check may take before the connection counts as dead. */
export const TRANSACTION_PROBE_MS = 5000

/**
 * Whether the connection holds an open transaction (@@TRANCOUNT > 0), asked with a query of its own
 * after the run, so nothing shows in the run's results or messages. 'unknown' when the query fails
 * (treated as open: play safe); 'lost' when it gets no answer within `timeoutMs`: the user's
 * connections have no request timeout, so on a half-dead connection (the network gone without a
 * reset) it would wait forever. `query` is for tests.
 */
export async function probeTransaction(
  connection: Connection,
  query: (connection: Connection, sql: string) => Promise<Record<string, unknown>[]> = queryRows,
  timeoutMs = TRANSACTION_PROBE_MS
): Promise<'open' | 'none' | 'unknown' | 'lost'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'lost'>((resolve) => (timer = setTimeout(() => resolve('lost'), timeoutMs)))
  const asked = query(connection, 'SELECT @@TRANCOUNT AS n').then(
    ([row]) => (Number(row?.n) > 0 ? ('open' as const) : ('none' as const)),
    () => (isClosed(connection) ? ('none' as const) : ('unknown' as const))
  )
  try {
    return await Promise.race([asked, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

const withinResult = (range: unknown, rows: number, columns: number): range is CellRange => {
  const { r0, r1, c0, c1 } = (range ?? {}) as Record<string, unknown>
  const index = (n: unknown, size: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < size
  return index(r0, rows) && index(r1, rows) && index(c0, columns) && index(c1, columns) && r0 <= r1 && c0 <= c1
}

const connectionLost = () =>
  new Error('Connection lost (the server closed it, or the network dropped): the rest of the script did not run. Run again to reconnect.')

/** Memory a row's values take, roughly: strings are 2 bytes a character. */
export function rowBytes(cells: Cell[]): number {
  let chars = 0
  for (const c of cells) if (typeof c === 'string') chars += c.length
  return chars * 2 + cells.length * 8
}

/** Cuts a row's longest text values in half, in place, until the row takes at most `maxBytes`;
 *  `cut` gets the whole length of each value cut. */
export function fitRow(cells: Cell[], cut: Map<number, number>, maxBytes = MAX_ROW_BYTES): void {
  let bytes = rowBytes(cells)
  while (bytes > maxBytes) {
    let largest = -1
    cells.forEach((c, i) => {
      if (typeof c === 'string' && (largest === -1 || c.length > (cells[largest] as string).length)) largest = i
    })
    const text = largest === -1 ? '' : (cells[largest] as string)
    if (text.length < 1000) return
    const whole = cut.get(largest) ?? text.length
    cells[largest] = truncateText(text, Math.floor(text.length / 2), whole)
    cut.set(largest, whole)
    bytes += ((cells[largest] as string).length - text.length) * 2
  }
}

/**
 * A row as query.rows sends it: text longer than PREVIEW_CHARS cut to that and ended with `…`, then
 * shortened further while the row, as UTF-8 JSON, is over ROW_BYTE_BUDGET (a page must stay under
 * Orca's 1 MiB answer cap). `stored`: the whole lengths of values the stored row has cut short.
 * `cut`: [column, whole length, characters kept when the stored value is cut short] of each value
 * not sent whole.
 */
export function previewRow(cells: Cell[], stored?: Map<number, number>): { cells: Cell[]; cut: [number, number, number?][] } {
  let out = cells
  const kept = new Map<number, number>()
  const shorten = (i: number, keep: number) => {
    const full = cells[i] as string
    // Not between the halves of a surrogate pair.
    const high = full.charCodeAt(keep - 1)
    const end = high >= 0xd800 && high <= 0xdbff ? keep - 1 : keep
    if (out === cells) out = cells.slice()
    out[i] = `${full.slice(0, end)}…`
    kept.set(i, end)
  }
  cells.forEach((c, i) => {
    if (typeof c === 'string' && c.length > PREVIEW_CHARS) shorten(i, PREVIEW_CHARS)
  })
  // No character takes more than 6 bytes in JSON, nor any other value 24 (with its comma, quotes),
  // so most rows need no measuring.
  const chars = out.reduce<number>((sum, c) => sum + (typeof c === 'string' ? c.length : 0), 0)
  if (chars * 6 + cells.length * 27 > ROW_BYTE_BUDGET) {
    const size = (c: Cell) => (typeof c === 'string' ? jsonBytes(c) : 24) + 1
    const sizes = out.map(size)
    let total = sizes.reduce((sum, n) => sum + n, 0)
    while (total > ROW_BYTE_BUDGET) {
      // Halve the largest text cell; a handful of rounds always gets there.
      let largest = -1
      out.forEach((c, i) => {
        if (typeof c === 'string' && (largest === -1 || sizes[i] > sizes[largest])) largest = i
      })
      if (largest === -1) break
      const keep = Math.floor((kept.get(largest) ?? (out[largest] as string).length) / 2)
      shorten(largest, keep)
      const after = size(out[largest])
      total += after - sizes[largest]
      sizes[largest] = after
      if (keep === 0) break
    }
  }
  const columns = [...new Set([...kept.keys(), ...(stored?.keys() ?? [])])].sort((a, b) => a - b)
  return {
    cells: out,
    cut: columns.map((i) => {
      const text = cells[i] as string
      const whole = stored?.get(i)
      return whole === undefined ? [i, text.length] : [i, whole, text.length - truncationMarker(whole).length]
    })
  }
}
