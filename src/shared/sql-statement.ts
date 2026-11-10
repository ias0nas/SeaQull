// The T-SQL statement around the cursor, for completion (unit-tested, no DOM): the tables it uses,
// with their aliases, and whether the cursor is where a column or a table name goes, or where a
// JOIN's condition starts.
//
// Pragmatic, not a parser. Known limits:
// - Statements end at `;`, a GO line, or a statement keyword at parenthesis depth 0 (see
//   `startsStatement`). A keyword used otherwise at depth 0 can end one early: harmless for
//   completion, which then sees fewer tables.
// - Tables in subqueries count for the whole statement (over-inclusion is fine for completion).
// - Temp tables (#t), table variables (@t), CTEs, derived tables `(SELECT …) x` and three- or
//   four-part names are not resolved: their aliases are known, but give no columns.
// - Only the text near the cursor is read (`WINDOW` characters each way, within its GO batch).

import { RESERVED_WORDS } from './sql-names.ts'

export type TableRef = { schema?: string; name: string; alias?: string }

/** A name that qualifies columns in the statement (an alias, or a table's own name), and the table
 *  it stands for: null for one this does not resolve (a CTE, a derived table, #temp, @table). */
export type Qualifier = { name: string; table: TableRef | null }

/** Right after `JOIN t [AS] [alias] ON`: the table joined there, and the tables before it in the
 *  same FROM clause, in order (those of a nested `(a JOIN b ON …)` included). */
export type JoinPlace = { table: TableRef; earlier: TableRef[] }

export type Place =
  /** Where a column goes (a SELECT list, WHERE, ON, GROUP BY, ORDER BY, HAVING, SET); `only`: the
   *  column list of `INSERT INTO t (…)`, which takes only t's columns; `join`: where a JOIN's
   *  condition starts. */
  | { kind: 'column'; only?: TableRef; join?: JoinPlace }
  /** Where a table or other object name goes: after FROM, JOIN, UPDATE, INTO, APPLY, EXEC… */
  | { kind: 'table' }
  | { kind: 'other' }

export type StatementScan = { tables: TableRef[]; qualifiers: Qualifier[]; place: Place }

/** Characters read on each side of the cursor. */
export const WINDOW = 25_000
/** Tables kept per statement (one columns request covers them). */
export const MAX_TABLES = 50

type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'variable' | 'temp' | 'punct' | 'go'
type Token = { kind: TokenKind; text: string; start: number; end: number }

const SPACE = /\s+/y
const WORD = /[\p{L}_][\p{L}\p{N}_@#$]*/uy
const VARIABLE = /@@?[\p{L}\p{N}_@#$]*/uy
const TEMP = /##?[\p{L}\p{N}_@#$]*/uy
const NUMBER = /0x[0-9a-f]*|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy
const GO_REST = /[ \t]*(?:\d+)?[ \t]*(?:--[^\n]*)?(?:\r?\n|$)/y

function match(re: RegExp, text: string, at: number): number {
  re.lastIndex = at
  return re.test(text) ? re.lastIndex : at
}

/** Tokens without whitespace and comments. A bracketed or double-quoted name runs to its closing
 *  delimiter or, unclosed (being typed), to the end of its line; a string runs to its closing quote. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  let lineHasToken = false
  const n = text.length
  while (at < n) {
    const c = text[at]
    if (c === '\n') {
      at++
      lineHasToken = false
      continue
    }
    if (/\s/.test(c)) {
      const end = match(SPACE, text, at)
      if (text.slice(at, end).includes('\n')) lineHasToken = false
      at = end
      continue
    }
    const start = at
    let kind: TokenKind
    if (c === '-' && text[at + 1] === '-') {
      const end = text.indexOf('\n', at)
      at = end < 0 ? n : end
      continue
    }
    if (c === '/' && text[at + 1] === '*') {
      // Block comments nest in T-SQL.
      let depth = 0
      const from = at
      while (at < n) {
        if (text[at] === '/' && text[at + 1] === '*') {
          depth++
          at += 2
        } else if (text[at] === '*' && text[at + 1] === '/') {
          depth--
          at += 2
          if (depth === 0) break
        } else at++
      }
      if (text.slice(from, at).includes('\n')) lineHasToken = false
      continue
    }
    if (c === "'" || ((c === 'N' || c === 'n') && text[at + 1] === "'")) {
      at += c === "'" ? 1 : 2
      while (at < n) {
        if (text[at] === "'") {
          if (text[at + 1] === "'") at += 2
          else {
            at++
            break
          }
        } else at++
      }
      kind = 'string'
    } else if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"'
      at++
      while (at < n && text[at] !== '\n') {
        if (text[at] === close) {
          if (text[at + 1] === close) at += 2
          else {
            at++
            break
          }
        } else at++
      }
      kind = 'ident'
    } else if (/[\p{L}_]/u.test(c)) {
      at = match(WORD, text, at)
      kind = 'word'
      // GO alone on its line (with an optional count) separates batches.
      if (!lineHasToken && at - start === 2 && text.slice(start, at).toUpperCase() === 'GO') {
        GO_REST.lastIndex = at
        if (GO_REST.test(text)) {
          kind = 'go'
          // The count and comment are part of it; the line break is not.
          at = GO_REST.lastIndex - (text[GO_REST.lastIndex - 1] === '\n' ? 1 : 0)
          if (text[at - 1] === '\r') at--
        }
      }
    } else if (c === '@') {
      at = match(VARIABLE, text, at)
      kind = 'variable'
    } else if (c === '#') {
      at = match(TEMP, text, at)
      kind = 'temp'
    } else if (/[\d.]/.test(c) && match(NUMBER, text, at) > at) {
      at = match(NUMBER, text, at)
      kind = 'number'
    } else {
      at++
      kind = 'punct'
    }
    tokens.push({ kind, text: text.slice(start, at), start, end: at })
    lineHasToken = true
  }
  return tokens
}

const upper = (t: Token | undefined) => (t?.kind === 'word' ? t.text.toUpperCase() : '')
/** A word in upper case, punctuation as itself, anything else ''. */
const sym = (t: Token | undefined) => (t === undefined ? '' : t.kind === 'word' ? t.text.toUpperCase() : t.kind === 'punct' ? t.text : '')
const isName = (t: Token | undefined) => t !== undefined && (t.kind === 'ident' || (t.kind === 'word' && !RESERVED_WORDS.has(t.text.toLowerCase())))

/** The name a word or delimited identifier stands for. */
function nameOf(t: Token): string {
  if (t.kind !== 'ident') return t.text
  const close = t.text[0] === '[' ? ']' : '"'
  const body = t.text.length > 1 && t.text.endsWith(close) ? t.text.slice(1, -1) : t.text.slice(1)
  return body.split(close + close).join(close)
}

// --- Statements -------------------------------------------------------------------------------

/** Keywords that start a statement wherever they appear at depth 0 (with the exceptions in
 *  `startsStatement`). */
const STATEMENT_WORDS = new Set(
  'declare if while begin end else exec execute create alter drop truncate print return use grant deny revoke raiserror throw break continue goto waitfor commit rollback save dbcc backup restore kill checkpoint reconfigure bulk'
    .toUpperCase()
    .split(' ')
)
const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])

type SplitState = { head: string; depth: number; caseDepth: number; insertBody: boolean; last?: Token }

function startsStatement(tokens: Token[], i: number, state: SplitState): boolean {
  if (state.depth > 0 || !state.last) return false
  const word = upper(tokens[i])
  const before = sym(state.last)
  const after = sym(tokens[i + 1])
  switch (word) {
    case 'SELECT':
      // UNION SELECT, INSERT … SELECT, a CTE's main SELECT, DECLARE c CURSOR FOR SELECT, CREATE VIEW v AS SELECT
      if (['UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'FOR', 'AS', ',', 'GRANT', 'DENY', 'REVOKE'].includes(before)) return false
      return !(state.head === 'WITH' || (state.head === 'INSERT' && !state.insertBody))
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'MERGE':
      // MERGE … THEN UPDATE, ON DELETE CASCADE, FOR UPDATE, AFTER INSERT, UPDATE, BULK INSERT
      if (['THEN', 'ON', 'FOR', 'AFTER', 'OF', 'INSTEAD', ',', 'GRANT', 'DENY', 'REVOKE', 'BULK'].includes(before)) return false
      if ((word === 'UPDATE' && after === '(') || (word === 'MERGE' && after === 'JOIN')) return false // IF UPDATE(col), LEFT MERGE JOIN
      return state.head !== 'WITH'
    case 'SET':
      return !['UPDATE', 'MERGE', 'ALTER', 'CREATE'].includes(state.head) && before !== 'DELETE' && before !== 'UPDATE'
    case 'WITH': {
      // WITH name AS (…) or WITH name (columns) AS (…) starts one; WITH (NOLOCK), WITH TIES… do not.
      if (state.head === 'CREATE' || state.head === 'ALTER') return false
      const next = tokens[i + 1]
      const then = sym(tokens[i + 2])
      return next !== undefined && (next.kind === 'word' || next.kind === 'ident') && (then === 'AS' || then === '(')
    }
    case 'END':
    case 'ELSE':
      return state.caseDepth === 0
    case 'IF':
      return !['DROP', 'CREATE', 'ALTER'].includes(state.head) // DROP TABLE IF EXISTS
    case 'EXEC':
    case 'EXECUTE':
      if (state.head === 'INSERT' && !state.insertBody) return false // INSERT … EXEC
      return !['AS', 'WITH', ',', 'GRANT', 'DENY', 'REVOKE'].includes(before)
    case 'ALTER':
      return before !== 'OR' // CREATE OR ALTER
    default:
      return STATEMENT_WORDS.has(word)
  }
}

type Statement = { start: number; tokens: Token[] }

/** A batch's statements; `start` is where each begins (after a `;`, or at its first keyword). */
function splitStatements(tokens: Token[], batchStart: number): Statement[] {
  const statements: Statement[] = []
  let current: Statement = { start: batchStart, tokens: [] }
  let state: SplitState = { head: '', depth: 0, caseDepth: 0, insertBody: false }
  const next = (start: number) => {
    statements.push(current)
    current = { start, tokens: [] }
    state = { head: '', depth: 0, caseDepth: 0, insertBody: false }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === 'punct' && token.text === ';') {
      next(token.end)
      continue
    }
    const word = upper(token)
    if (word && startsStatement(tokens, i, state)) next(token.start)
    if (word) {
      if (current.tokens.length === 0) state.head = word
      else if (state.head === 'WITH' && state.depth === 0 && DML.has(word) && sym(state.last) === ')') state.head = word // the CTEs' main statement
      if (state.head === 'INSERT' && state.depth === 0 && ['VALUES', 'SELECT', 'EXEC', 'EXECUTE'].includes(word)) state.insertBody = true
      if (word === 'CASE') state.caseDepth++
      else if (word === 'END' && state.caseDepth > 0) state.caseDepth--
    } else if (token.kind === 'punct' && token.text === '(') state.depth++
    else if (token.kind === 'punct' && token.text === ')') state.depth = Math.max(0, state.depth - 1)
    current.tokens.push(token)
    state.last = token
  }
  statements.push(current)
  return statements
}

// --- Tables -----------------------------------------------------------------------------------

/** Words after a table that are not its alias (keywords that T-SQL does not reserve). */
const NOT_ALIAS = new Set(['apply', 'using', 'output', 'offset', 'window', 'matched', 'go'])

/** The index after the parenthesis group starting at `i` (a `(`). */
function skipGroup(tokens: Token[], i: number): number {
  let depth = 0
  for (; i < tokens.length; i++) {
    const s = sym(tokens[i])
    if (s === '(') depth++
    else if (s === ')' && --depth === 0) return i + 1
  }
  return i
}

type Context = 'from' | 'join' | 'apply' | 'using' | 'into' | 'target'

/** The names of the statement's CTEs (`WITH a [(cols)] AS (…), b AS (…) …`), in lower case. */
function cteNames(tokens: Token[]): Set<string> {
  const ctes = new Set<string>()
  if (upper(tokens[0]) !== 'WITH') return ctes
  for (let i = 1; i < tokens.length; ) {
    const name = tokens[i]
    if (!name || (name.kind !== 'word' && name.kind !== 'ident')) break
    i++
    if (sym(tokens[i]) === '(') i = skipGroup(tokens, i)
    if (sym(tokens[i]) !== 'AS' || sym(tokens[i + 1]) !== '(') break
    ctes.add(nameOf(name).toLowerCase())
    i = skipGroup(tokens, i + 1)
    if (sym(tokens[i]) !== ',') break
    i++
  }
  return ctes
}

/** An alias at `i` (AS optional); returns it and the index after it. */
function aliasAt(tokens: Token[], i: number): [string | undefined, number] {
  if (sym(tokens[i]) === 'AS' && tokens[i + 1] && (tokens[i + 1].kind === 'word' || tokens[i + 1].kind === 'ident')) return [nameOf(tokens[i + 1]), i + 2]
  const t = tokens[i]
  if (isName(t) && !NOT_ALIAS.has(t.text.toLowerCase())) return [nameOf(t), i + 1]
  return [undefined, i]
}

/** `WITH (hints)` at `i`: the index after it. */
const hintsAt = (tokens: Token[], i: number) => (sym(tokens[i]) === 'WITH' && sym(tokens[i + 1]) === '(' ? skipGroup(tokens, i + 1) : i)

/** A table source: the table (null for one not resolved: a derived table, CTE, #temp, @table or
 *  three-part name), the name that qualifies its columns (none when there is no source here),
 *  and the index after it. */
type Source = { table: TableRef | null; qualifier?: string; end: number }

/** The table source at `i`. */
function readSource(tokens: Token[], i: number, context: Context, ctes: Set<string>): Source {
  if (context === 'target' && sym(tokens[i]) === 'TOP' && sym(tokens[i + 1]) === '(') {
    i = skipGroup(tokens, i + 1)
    if (sym(tokens[i]) === 'PERCENT') i++
  }
  const first = tokens[i]
  if (!first) return { table: null, end: i }
  if (sym(first) === '(') {
    // A derived table, or APPLY (SELECT …): its alias gives no columns here.
    if (context === 'into') return { table: null, end: i }
    const [name, after] = aliasAt(tokens, skipGroup(tokens, i))
    return { table: null, ...(name ? { qualifier: name } : {}), end: after }
  }
  if (first.kind === 'temp' || first.kind === 'variable') {
    const [name, after] = aliasAt(tokens, hintsAt(tokens, i + 1))
    return { table: null, qualifier: name ?? first.text, end: after }
  }
  if (!isName(first)) return { table: null, end: i }
  const parts = [nameOf(first)]
  let j = i + 1
  while (sym(tokens[j]) === '.') {
    const part = tokens[j + 1]
    if (part && (part.kind === 'word' || part.kind === 'ident')) {
      parts.push(nameOf(part))
      j += 2
    } else if (sym(part) === '.') {
      parts.push('') // db..table
      j += 1
    } else break
  }
  // A table-valued function's arguments; INSERT INTO t (…) is a column list, read elsewhere.
  if (sym(tokens[j]) === '(' && context !== 'into') j = skipGroup(tokens, j)
  j = hintsAt(tokens, j)
  const [name, after] = context === 'into' ? [undefined, j] : aliasAt(tokens, j)
  j = hintsAt(tokens, after)
  const table = parts.length > 2 || (parts.length === 1 && ctes.has(parts[0].toLowerCase())) ? null : { ...(parts.length === 2 ? { schema: parts[0] } : {}), name: parts[parts.length - 1], ...(name ? { alias: name } : {}) }
  return { table, qualifier: name ?? parts[parts.length - 1], end: j }
}

function tables(tokens: Token[]): { tables: TableRef[]; qualifiers: Qualifier[] } {
  const refs: { table: TableRef | null; qualifier: string; target: boolean }[] = []
  const ctes = cteNames(tokens)

  /** One table source at `i`; returns the index after it. */
  const source = (i: number, context: Context): number => {
    const { table, qualifier, end } = readSource(tokens, i, context, ctes)
    if (qualifier === undefined) return end
    refs.push({ table, qualifier, target: context === 'target' })
    if (table?.alias) refs.push({ table, qualifier: table.name, target: false }) // the table's own name qualifies too
    return end
  }

  for (let i = 0; i < tokens.length; i++) {
    const word = upper(tokens[i])
    const before = sym(tokens[i - 1])
    if (word === 'FROM' && before !== 'DISTINCT') {
      let j = source(i + 1, 'from')
      while (sym(tokens[j]) === ',') j = source(j + 1, 'from')
    } else if (word === 'JOIN') source(i + 1, 'join')
    else if (word === 'APPLY') source(i + 1, 'apply')
    else if (word === 'USING') source(i + 1, 'using')
    else if (word === 'INTO') source(i + 1, upper(tokens[i - 1]) === 'MERGE' ? 'target' : 'into')
    else if ((word === 'UPDATE' || word === 'DELETE') && !['THEN', 'ON', 'FOR', ','].includes(before) && sym(tokens[i + 1]) !== '(') source(i + 1, 'target')
    else if (word === 'INSERT' && upper(tokens[i + 1]) !== 'INTO' && before !== 'THEN') source(i + 1, 'into')
    else if (word === 'MERGE' && upper(tokens[i + 1]) !== 'INTO' && sym(tokens[i + 1]) !== 'JOIN') source(i + 1, 'target')
  }

  // UPDATE x … FROM t x, DELETE x FROM t x: the target is an alias of a table in FROM.
  const aliases = new Set(refs.filter((r) => r.table?.alias).map((r) => r.table!.alias!.toLowerCase()))
  const kept = refs.filter((r) => !(r.target && r.table && !r.table.schema && !r.table.alias && aliases.has(r.table.name.toLowerCase())))
  const seen = new Set<string>()
  const list: TableRef[] = []
  for (const { table } of kept) {
    if (!table) continue
    const key = `${table.schema ?? ''}\u0000${table.name}\u0000${table.alias ?? ''}`.toLowerCase()
    if (seen.has(key) || list.length >= MAX_TABLES) continue
    seen.add(key)
    list.push(table)
  }
  return { tables: list, qualifiers: kept.map((r) => ({ name: r.qualifier, table: r.table })) }
}

// --- Where the cursor is ----------------------------------------------------------------------

const COLUMN_WORDS = new Set(['SELECT', 'WHERE', 'ON', 'BY', 'HAVING', 'SET'])
const TABLE_WORDS = new Set(['FROM', 'JOIN', 'APPLY', 'UPDATE', 'INTO', 'USING', 'MERGE', 'EXEC', 'EXECUTE', 'TABLE', 'DELETE', 'INSERT'])
const OTHER_WORDS = new Set(['VALUES', 'DECLARE', 'PRINT', 'RETURN', 'OUTPUT', 'OPTION', 'IF', 'WHILE', 'RAISERROR', 'THROW'])

/** The place of the cursor after `before`, the statement's tokens up to it. */
function placeAt(before: Token[], tableList: TableRef[]): Place {
  for (let k = before.length - 1; k >= 0; k--) {
    const s = sym(before[k])
    if (s === ')') {
      // Skip the whole group.
      let depth = 0
      for (; k >= 0; k--) {
        const t = sym(before[k])
        if (t === ')') depth++
        else if (t === '(' && --depth === 0) break
      }
      continue
    }
    if (s === '(') {
      // Inside a group: INSERT INTO t (…) and MERGE … THEN INSERT (…) list columns of the target.
      const prev = sym(before[k - 1])
      if (prev === 'INSERT') return { kind: 'column', ...(tableList[0] ? { only: tableList[0] } : {}) }
      if (prev === 'WITH' || prev === 'VALUES') return { kind: 'other' }
      let j = k - 1
      const parts: string[] = []
      while (j >= 0 && (before[j].kind === 'word' || before[j].kind === 'ident') && isName(before[j])) {
        parts.unshift(nameOf(before[j]))
        if (sym(before[j - 1]) !== '.') break
        j -= 2
      }
      const keyword = sym(before[j - 1])
      if (parts.length > 0 && parts.length <= 2 && (keyword === 'INTO' || keyword === 'INSERT')) {
        return { kind: 'column', only: parts.length === 2 ? { schema: parts[0], name: parts[1] } : { name: parts[0] } }
      }
      continue
    }
    if (COLUMN_WORDS.has(s)) return { kind: 'column' }
    if (TABLE_WORDS.has(s)) return { kind: 'table' }
    if (OTHER_WORDS.has(s)) return { kind: 'other' }
  }
  return { kind: 'other' }
}

/** The sources of a FROM clause in `tokens[from, to)` (from just after FROM, or after the `(` of
 *  a nested join), in order: the tables of each (none for a derived table, CTE…; several for a
 *  nested join), whether a JOIN brought it in, and the index after it. */
function fromSources(tokens: Token[], from: number, to: number, ctes: Set<string>): { tables: TableRef[]; joined: boolean; end: number }[] {
  const sources: { tables: TableRef[]; joined: boolean; end: number }[] = []
  let expect: 'from' | 'join' | 'apply' | null = 'from'
  for (let i = from; i < to; ) {
    if (expect) {
      const inner = upper(tokens[i + 1])
      if (sym(tokens[i]) === '(' && inner !== 'SELECT' && inner !== 'WITH' && inner !== 'VALUES') {
        // A nested join, (b JOIN c ON …): its tables count, and it has no alias.
        const end = Math.min(skipGroup(tokens, i), to)
        sources.push({ tables: fromSources(tokens, i + 1, end - 1, ctes).flatMap((s) => s.tables), joined: expect === 'join', end })
        i = end
      } else {
        const { table, end } = readSource(tokens, i, expect === 'apply' ? 'apply' : 'from', ctes)
        if (end > i) sources.push({ tables: table ? [table] : [], joined: expect === 'join', end })
        i = Math.max(end, i + 1)
      }
      expect = null
      continue
    }
    const s = sym(tokens[i])
    if (s === '(') {
      i = skipGroup(tokens, i)
      continue
    }
    if (s === ',') expect = 'from'
    else if (s === 'JOIN') expect = 'join'
    else if (s === 'APPLY') expect = 'apply'
    i++
  }
  return sources
}

/** The JOIN whose ON is the last of `before` (the statement's tokens up to the cursor), if any. */
function joinAt(before: Token[], ctes: Set<string>): JoinPlace | undefined {
  const on = before.length - 1
  if (upper(before[on]) !== 'ON') return undefined
  // Back to the start of the FROM clause, over parenthesis groups (subqueries, conditions): its
  // FROM, or the `(` of the nested join the ON is in.
  let start = -1
  for (let k = on - 1; k >= 0 && start < 0; k--) {
    const s = sym(before[k])
    if (s === ')') {
      for (let depth = 0; k >= 0; k--) {
        const t = sym(before[k])
        if (t === ')') depth++
        else if (t === '(' && --depth === 0) break
      }
    } else if (s === '(' || (s === 'FROM' && sym(before[k - 1]) !== 'DISTINCT')) start = k + 1
  }
  if (start < 0) return undefined
  const sources = fromSources(before, start, on, ctes)
  const last = sources.pop()
  if (!last?.joined || last.end !== on || last.tables.length !== 1 || sources.length === 0) return undefined
  return { table: last.tables[0], earlier: sources.flatMap((s) => s.tables) }
}

/** The tokens without the (qualified) name being typed at the cursor: `FROM Sales.|` is not a
 *  table named Sales, nor `FROM Sales.Cust|` one named Cust. */
function withoutNameAt(tokens: Token[], cursor: number): Token[] {
  const isPart = (t: Token) => t.kind === 'word' || t.kind === 'ident'
  let end = tokens.length
  while (end > 0 && tokens[end - 1].start >= cursor) end--
  const last = tokens[end - 1]
  if (!last || last.end < cursor || !(isPart(last) || sym(last) === '.')) return tokens
  let first = end - 1
  while (first > 0) {
    const [previous, current] = [tokens[first - 1], tokens[first]]
    if ((sym(current) === '.' && isPart(previous)) || (isPart(current) && sym(previous) === '.')) first--
    else break
  }
  return [...tokens.slice(0, first), ...tokens.slice(end)]
}

/** The statement around `cursor` in `text`: its tables, the names that qualify their columns,
 *  and what goes at the cursor. */
/** The tokens of the statement around `cursor` (offsets in `text`): its GO batch, then the
 *  statement in it the cursor is in. */
function statementTokensAt(text: string, cursor: number): Token[] {
  const offset = Math.max(0, cursor - WINDOW)
  const tokens = tokenize(text.slice(offset, Math.min(text.length, cursor + WINDOW))).map((t) => ({ ...t, start: t.start + offset, end: t.end + offset }))
  // The GO batch around the cursor.
  let from = 0
  let to = tokens.length
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'go') continue
    if (tokens[i].end <= cursor) from = i + 1
    else if (tokens[i].start >= cursor) {
      to = i
      break
    }
  }
  const batch = tokens.slice(from, to)
  const statements = splitStatements(batch, from > 0 ? tokens[from - 1].end : offset)
  return (statements.filter((s) => s.start <= cursor).pop() ?? statements[0]).tokens
}

export function scanStatement(text: string, cursor: number): StatementScan {
  const tokens = statementTokensAt(text, cursor)
  const { tables: tableList, qualifiers } = tables(withoutNameAt(tokens, cursor))
  // The name being typed at the cursor is not part of what comes before it.
  const before = tokens.filter((t) => t.end < cursor || (t.end === cursor && (t.kind === 'punct' || t.kind === 'string')))
  const place = placeAt(before, tableList)
  const join = place.kind === 'column' && !place.only ? joinAt(before, cteNames(tokens)) : undefined
  return { tables: tableList, qualifiers, place: join ? { kind: 'column', join } : place }
}

/** A statement's names, for finding what a name in it stands for (the explorer's locate): its
 *  tables and qualifiers, the name at the cursor included (scanStatement leaves that out, as the
 *  one being typed), its CTEs (lower case), and its tokens. */
export function statementNames(text: string, cursor: number): { tables: TableRef[]; qualifiers: Qualifier[]; ctes: Set<string>; tokens: Token[] } {
  const tokens = statementTokensAt(text, cursor)
  return { ...tables(tokens), ctes: cteNames(tokens), tokens }
}

export type { Token }
