// Pure helpers for the text of a .sql console: the SeaQull header comment and GO batch splitting.
// Shared by the editor frame and the worker; no Node or DOM APIs.

/** First-line comment that remembers a console's connection and database, e.g.
 *  `-- seaqull: connection="Local SQL" database="AdventureWorks2022" id="k3j2x9ab"`. `id` names the
 *  file's own SQL session and results in the worker: Orca gives a console page no file name or
 *  per-tab identity, and reloads the page when its tab is shown again. */
export type ConsoleTarget = { connection: string; database: string; id?: string }

const HEADER_RE = /^--\s*seaqull:(.*)$/i
const PAIR_RE = /(\w+)="((?:[^"\\]|\\.)*)"/g

export function parseHeader(text: string): ConsoleTarget | null {
  const firstLine = text.split('\n', 1)[0] ?? ''
  const match = HEADER_RE.exec(firstLine.trim())
  if (!match) return null
  const values: Record<string, string> = {}
  for (const [, key, value] of match[1].matchAll(PAIR_RE)) {
    values[key.toLowerCase()] = value.replace(/\\(.)/g, '$1')
  }
  // An id the worker would refuse (hand-edited) is ignored; the next run writes a fresh one.
  const id = values.id && /^[\w-]{1,64}$/.test(values.id) ? values.id : undefined
  return { connection: values.connection ?? '', database: values.database ?? '', ...(id ? { id } : {}) }
}

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`

export function formatHeader(target: ConsoleTarget): string {
  return `-- seaqull: connection=${quote(target.connection)} database=${quote(target.database)}${target.id ? ` id=${quote(target.id)}` : ''}`
}

/** The edit that makes `text` carry `target` in its header: replace the first line when it is a
 *  header, else insert one above the script. Null when the header already says exactly that. */
export function headerEdit(text: string, target: ConsoleTarget): { start: number; end: number; text: string } | null {
  const header = parseHeader(text)
  if (header && header.connection === target.connection && header.database === target.database && header.id === target.id) return null
  if (!header) return { start: 0, end: 0, text: `${formatHeader(target)}\n` }
  let end = text.indexOf('\n')
  if (end === -1) end = text.length
  else if (text[end - 1] === '\r') end-- // keep a CRLF line ending as it is
  return { start: 0, end, text: formatHeader(target) }
}

/** Applies headerEdit to a string (tests, and anywhere the text is not in an editor). */
export function withHeader(text: string, target: ConsoleTarget): string {
  const edit = headerEdit(text, target)
  return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text
}

export type Batch = {
  sql: string
  /** 1-based line of the batch's first line within the text that was split. */
  startLine: number
  /** `GO 5` runs the batch five times, like sqlcmd/SSMS. */
  repeat: number
}

const GO_RE = /^\s*go(?:\s+(\d+))?\s*;?\s*(?:--.*)?$/i

/** Splits a script on lines holding only `GO` (optionally `GO n`), as SSMS and sqlcmd do. A `GO`
 *  inside a block comment or a multi-line string literal is not a separator. Empty batches are
 *  dropped. */
export function splitBatches(text: string): Batch[] {
  const lines = text.split(/\r?\n/)
  const batches: Batch[] = []
  let current: string[] = []
  let startLine = 1
  let state: ScanState = { depth: 0, quote: '' }
  let hasCode = false

  const flush = (repeat: number, nextStart: number) => {
    if (hasCode) batches.push({ sql: current.join('\n'), startLine, repeat })
    current = []
    startLine = nextStart
    hasCode = false
  }

  lines.forEach((line, i) => {
    const go = state.depth === 0 && !state.quote ? GO_RE.exec(line) : null
    if (go) {
      flush(go[1] ? Math.max(1, Number(go[1])) : 1, i + 2)
      return
    }
    current.push(line)
    const scanned = scanLine(line, state)
    state = scanned.state
    hasCode ||= scanned.hasCode
  })
  flush(1, lines.length + 1)
  return batches
}

/** Where a line leaves the scanner: inside `depth` nested block comments (T-SQL nests them), or
 *  inside a quoted string or identifier closed by `quote` ('…', "…" or […]). */
type ScanState = { depth: number; quote: '' | "'" | '"' | ']' }

const OPENERS: Record<string, ScanState['quote']> = { "'": "'", '"': '"', '[': ']' }

/** Scans one line: the state it ends in, and whether it holds anything but comments and spaces. */
function scanLine(line: string, start: ScanState): { state: ScanState; hasCode: boolean } {
  let { depth, quote } = start
  let hasCode = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const next = line[i + 1]
    if (depth > 0) {
      if (c === '/' && next === '*') {
        depth++
        i++
      } else if (c === '*' && next === '/') {
        depth--
        i++
      }
    } else if (quote) {
      hasCode = true
      if (c === quote) {
        if (next === quote) i++ // '' "" ]] escape the closing character
        else quote = ''
      }
    } else if (c === '-' && next === '-') {
      break
    } else if (c === '/' && next === '*') {
      depth = 1
      i++
    } else if (OPENERS[c]) {
      quote = OPENERS[c]
      hasCode = true
    } else if (!/\s/.test(c)) {
      hasCode = true
    }
  }
  return { state: { depth, quote }, hasCode }
}
