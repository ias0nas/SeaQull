// SeaQull workbooks (.seaqull): one file holding several query tabs, each with its own SQL,
// connection, database and id. The id names the tab's SQL session and results in the worker; it
// lives in the file's structure, where editing a tab's SQL cannot remove it. Pure functions, shared
// by the editor and tests.

export type WorkbookTab = {
  /** Session id in the worker; 1–64 of [A-Za-z0-9_-]. */
  id: string
  name: string
  /** The person renamed it: keep the name when the connection changes. */
  named?: boolean
  /** Connection by name (portable between machines with the same connection names). */
  connection: string
  database: string
  sql: string
  /** Fields this version does not know (a newer SeaQull's, or added by hand): written back as they were. */
  extra?: Record<string, unknown>
}

/** `seaqull` is the format version (1 today); a file from a newer version keeps its number. */
export type Workbook = { seaqull: number; id: string; tabs: WorkbookTab[]; extra?: Record<string, unknown> }

const TAB_KEYS = new Set(['id', 'name', 'named', 'connection', 'database', 'sql'])
const BOOK_KEYS = new Set(['seaqull', 'id', 'tabs'])

function unknownKeys(value: Record<string, unknown>, known: Set<string>): Record<string, unknown> | undefined {
  const extra = Object.fromEntries(Object.entries(value).filter(([k]) => !known.has(k)))
  return Object.keys(extra).length > 0 ? extra : undefined
}

const ID_RE = /^[\w-]{1,64}$/

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** Whether a document is a workbook rather than plain SQL (decides the editor's mode). */
export function isWorkbookText(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return false
  try {
    const value = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && 'seaqull' in value
  } catch {
    return false
  }
}

/** Reads a workbook, repairing what it must: missing, invalid or duplicate ids get new ones, bad
 *  fields become defaults. `repaired` says whether the file should be written back (only then: an
 *  editor that merely opens a file should not change it). Throws only when it is not a workbook. */
export function parseWorkbook(text: string): { book: Workbook; repaired: boolean } {
  const value = JSON.parse(text) as Record<string, unknown>
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('seaqull' in value)) throw new Error('Not a SeaQull workbook')
  let repaired = false
  const seen = new Set<string>()
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const tabs: WorkbookTab[] = (Array.isArray(value.tabs) ? value.tabs : []).map((item: unknown) => {
    const raw = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {}
    let id = str(raw.id)
    if (!ID_RE.test(id) || seen.has(id)) {
      id = newId()
      repaired = true
    }
    seen.add(id)
    const extra = unknownKeys(raw, TAB_KEYS)
    return {
      id,
      name: str(raw.name) || 'Query',
      ...(raw.named === true ? { named: true } : {}),
      connection: str(raw.connection),
      database: str(raw.database),
      sql: str(raw.sql),
      ...(extra ? { extra } : {})
    }
  })
  let id = typeof value.id === 'string' && ID_RE.test(value.id) ? value.id : ''
  if (!id) {
    id = newId()
    repaired = true
  }
  const extra = unknownKeys(value, BOOK_KEYS)
  const version = typeof value.seaqull === 'number' && Number.isInteger(value.seaqull) && value.seaqull >= 1 ? value.seaqull : 1
  return { book: { seaqull: version, id, tabs, ...(extra ? { extra } : {}) }, repaired }
}

export function serializeWorkbook(workbook: Workbook): string {
  const { extra, tabs, ...rest } = workbook
  const book = {
    ...extra,
    ...rest,
    tabs: tabs.map(({ extra: tabExtra, ...tab }) => ({ ...tabExtra, ...tab }))
  }
  return `${JSON.stringify(book, null, 2)}\n`
}

/** "<connection> · <n>" with the lowest n not taken ("Query · <n>" without a connection). The
 *  separator keeps a connection named "local 2" from reading as "local 2 1". */
export function nextTabName(tabs: Pick<WorkbookTab, 'name'>[], connection: string): string {
  const base = connection || 'Query'
  const taken = new Set(tabs.map((t) => t.name))
  for (let n = 1; ; n++) if (!taken.has(`${base} · ${n}`)) return `${base} · ${n}`
}
