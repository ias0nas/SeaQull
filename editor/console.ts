// SeaQull console: the custom editor for .seaqull workbooks and .sql files, with its own object
// explorer. A workbook holds several query tabs (src/shared/workbook.ts); a .sql file is one tab
// whose first-line `-- seaqull:` comment remembers its connection, database and id. Each tab has
// its own editor, results and SQL session in the worker (named by the tab's id: Orca gives every
// console page the same caller id, and reloads the page whenever its Orca tab is shown again).
// Queries run in the worker; this page polls status and pages rows.
import type { Cell, CellRange, ConnectionConfig, ExportFormat, RunStatus, SavedConnection } from '../src/protocol.ts'
import { cellText, EXPORT_FORMATS, exportResult } from '../src/shared/export.ts'
import { compareNames, folderPaths, normalizeFolder } from '../src/shared/folders.ts'
import { headerEdit, parseHeader } from '../src/shared/sql-script.ts'
import { locateAt, targetPath } from '../src/shared/locate.ts'
import { WINDOW } from '../src/shared/sql-statement.ts'
import { sendRun } from '../src/shared/upload.ts'
import { selectTopSql, sqlName, type TreePath } from '../src/shared/tree-keys.ts'
import { isWorkbookText, newId, nextTabName, parseWorkbook, serializeWorkbook, type WorkbookTab } from '../src/shared/workbook.ts'
import { confirmDialog, openConnectionDialog, promptDialog, signInDialog } from './connection-dialog.ts'
import { Explorer } from './explorer.ts'
import { importedText, openImportDialog } from './import-dialog.ts'
import { showMenu } from './menu.ts'
import { Grid, type CopyKind, type Range } from './grid.ts'
import { icon } from './icons.ts'
import { columnsFor, forgetNames, namesFor } from './name-cache.ts'
import { installSignIn, request } from './request.ts'
import { isSignInCancelled, SignInGate } from './sign-in.ts'
import { watchRun } from './run-watch.ts'
import {
  closeCompletionPopup,
  createEditor,
  editorText,
  insertAtCursor,
  replaceRange,
  replaceText,
  runnableText,
  selectLine,
  type EditorView,
  type NameSource
} from './sql-editor.ts'
import { installTooltips, keys } from './tooltip.ts'
import { errorText, onDrag } from './util.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  app: $<HTMLDivElement>('app'),
  console: $<HTMLElement>('console'),
  explorer: $<HTMLElement>('explorer'),
  explorerSplitter: $<HTMLDivElement>('explorer-splitter'),
  explorerToggle: $<HTMLButtonElement>('explorer-toggle'),
  connectionIcon: $<HTMLSpanElement>('connection-icon'),
  databaseIcon: $<HTMLSpanElement>('database-icon'),
  explorerAdd: $<HTMLButtonElement>('explorer-add'),
  explorerLocate: $<HTMLButtonElement>('explorer-locate'),
  explorerRefresh: $<HTMLButtonElement>('explorer-refresh'),
  explorerCollapse: $<HTMLButtonElement>('explorer-collapse'),
  explorerSide: $<HTMLButtonElement>('explorer-side'),
  explorerMore: $<HTMLButtonElement>('explorer-more'),
  tree: $<HTMLDivElement>('tree'),
  queryTabs: $<HTMLElement>('query-tabs'),
  connection: $<HTMLSelectElement>('connection'),
  database: $<HTMLSelectElement>('database'),
  run: $<HTMLButtonElement>('run'),
  cancel: $<HTMLButtonElement>('cancel'),
  status: $<HTMLSpanElement>('status'),
  editors: $<HTMLDivElement>('editors'),
  splitter: $<HTMLDivElement>('splitter'),
  tabs: $<HTMLElement>('tabs'),
  resultBar: $<HTMLDivElement>('result-bar'),
  resultInfo: $<HTMLSpanElement>('result-info'),
  format: $<HTMLSelectElement>('format'),
  tableName: $<HTMLInputElement>('table-name'),
  includeHeaders: $<HTMLInputElement>('include-headers'),
  copyResult: $<HTMLButtonElement>('copy-result'),
  saveResult: $<HTMLButtonElement>('save-result'),
  readyDialog: $<HTMLDialogElement>('ready-dialog'),
  readyTitle: $<HTMLSpanElement>('ready-title'),
  readyWhy: $<HTMLSpanElement>('ready-why'),
  readySize: $<HTMLParagraphElement>('ready-size'),
  readyText: $<HTMLParagraphElement>('ready-text'),
  readyOk: $<HTMLButtonElement>('ready-ok'),
  readyCancel: $<HTMLButtonElement>('ready-cancel'),
  grid: $<HTMLDivElement>('grid'),
  messages: $<HTMLOListElement>('messages'),
  empty: $<HTMLDivElement>('empty')
}

installTooltips()
ui.connectionIcon.innerHTML = icon('connection')
ui.databaseIcon.innerHTML = icon('database')
ui.run.title = `Run the selected text, or everything in this tab when nothing is selected (${keys.run})`
ui.cancel.title = `Cancel the running query (${keys.cancel})`
ui.includeHeaders.closest('label')!.title =
  `Header row in CSV and TSV copies and saves.\n${keys.copy} in the grid follows this box; ${keys.copyOther} does the opposite.\nJSON, Markdown and SQL INSERT always name their columns.`

const LAST_TARGET_KEY = 'seaqull.lastTarget'
const EDITOR_HEIGHT_KEY = 'seaqull.editorHeight'
const FORMAT_KEY = 'seaqull.exportFormat'
const HEADERS_KEY = 'seaqull.includeHeaders'
const EXPLORER_WIDTH_KEY = 'seaqull.explorerWidth'
const EXPLORER_HIDDEN_KEY = 'seaqull.explorerHidden'
const activeTabKey = (workbookId: string) => `seaqull.activeTab.${workbookId}`

const storageGet = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const storageSet = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: not essential */
  }
}

// --- Tabs -------------------------------------------------------------------------------------

type Tab = {
  /** The tab's SQL session and results in the worker. */
  id: string
  name: string
  named: boolean
  /** Connection by name, as files store it; `connectionId()` resolves it. */
  connectionName: string
  database: string
  /** Its own editor (shown while the tab is active), keeping its own undo history. */
  editor: EditorView
  status: RunStatus | null
  /** The result (or 'messages') shown below the editor. */
  view: number | 'messages'
  /** Column widths the user set, by result, then column; for the run shown. */
  widths?: Map<number, Map<number, number>>
  running: boolean
  pollTimer: number
  statusText: string
  statusError: boolean
  /** Workbook fields this version does not know, written back unchanged. */
  extra?: Record<string, unknown>
  /** Its SQL used CRLF line endings: the editor turns them into LF, so they are put back on save. */
  crlf: boolean
  /** The run this tab shows: polls for any other (an older run, a restore) are ignored. */
  runId?: string
  /** Cancel was pressed before the worker named the new run: cancel it as soon as it does. */
  cancelPending?: boolean
  /** The worker stopped answering while `runId` ran, so it may still be running: Cancel stays on. */
  maybeRunning?: boolean
  /** The running SQL may create, change or drop objects on this connection: its names, cached
   *  for completion, are forgotten when the run ends. */
  changesNames?: string
}

/** Text as stored: with CRLF line endings when the original used them. */
const withLineEndings = (text: string, crlf: boolean) => (crlf ? text.replace(/\r?\n/g, '\r\n') : text)
const hasCrlf = (text: string) => text.includes('\r\n')

const doc = await orca.document!.session()
/** A .seaqull workbook (several tabs) or a plain .sql file (one tab, target in its header). */
const workbookMode = isWorkbookText(doc.value)
let workbookId = ''
let workbookVersion = 1
/** Top-level workbook fields this version does not know, written back unchanged. */
let workbookExtra: Record<string, unknown> | undefined
/** The file itself used CRLF line endings (kept on save). */
let docCrlf = hasCrlf(doc.value)
let tabs: Tab[] = []
let activeId = ''
let connections: SavedConnection[] = []
let grid: Grid | null = null

const active = (): Tab => tabs.find((t) => t.id === activeId) ?? tabs[0]
const connectionOf = (tab: Tab) => connections.find((c) => c.name === tab.connectionName)
const colorOf = (connectionId: string) => connections.find((c) => c.id === connectionId)?.color

type TabInit = Pick<Tab, 'id' | 'name' | 'named' | 'connectionName' | 'database'> & { sql: string; extra?: Record<string, unknown> }

function createTab({ sql, ...init }: TabInit): Tab {
  // Orca keeps no undo history for custom editors: each tab's editor keeps its own.
  const editor = createEditor(ui.editors, sql, doc.readOnly, () => onEdit(tab), () => tabNames(tab))
  const tab: Tab = { ...init, editor, crlf: hasCrlf(sql), status: null, view: 0, running: false, pollTimer: 0, statusText: '', statusError: false }
  return tab
}

/** The names to complete in a tab: those of its connection and database at the time. */
async function tabNames(tab: Tab): Promise<NameSource | null> {
  const connection = connectionOf(tab)
  if (!connection) return null
  const database = tab.database
  const index = await namesFor(connection.id, database)
  return index && { index, columns: (objects) => columnsFor(connection.id, database, objects) }
}

function disposeTab(tab: Tab): void {
  clearTimeout(tab.pollTimer)
  tab.editor.destroy()
}

const text = (tab: Tab) => editorText(tab.editor)

function lastTarget(): { connection: string; database: string } {
  try {
    const value = JSON.parse(storageGet(LAST_TARGET_KEY) ?? 'null')
    return { connection: String(value?.connection ?? ''), database: String(value?.database ?? '') }
  } catch {
    return { connection: '', database: '' }
  }
}

// --- Workbook mode: the file is JSON holding every tab ----------------------------------------

function toWorkbookTab(tab: Tab): WorkbookTab {
  return {
    id: tab.id,
    name: tab.name,
    ...(tab.named ? { named: true } : {}),
    connection: tab.connectionName,
    database: tab.database,
    sql: withLineEndings(text(tab), tab.crlf),
    ...(tab.extra ? { extra: tab.extra } : {})
  }
}

/** Writes every tab back to the file (Orca debounces, saves and tracks dirty state). */
function saveWorkbook(): void {
  if (!workbookMode || doc.readOnly) return
  const text = serializeWorkbook({ seaqull: workbookVersion, id: workbookId, tabs: tabs.map(toWorkbookTab), ...(workbookExtra ? { extra: workbookExtra } : {}) })
  doc.change(withLineEndings(text, docCrlf))
}

/** Reads the workbook into tabs; returns the tabs it removed (gone from the file). */
function loadWorkbook(text: string): Tab[] {
  const { book, repaired } = parseWorkbook(text)
  workbookId = book.id
  workbookVersion = book.seaqull
  workbookExtra = book.extra
  docCrlf = hasCrlf(text)
  // Keep tabs that still exist (their editors keep undo and selection); add new ones; drop the rest.
  const next: Tab[] = book.tabs.map((saved) => {
    const init = { id: saved.id, name: saved.name, named: saved.named === true, connectionName: saved.connection, database: saved.database, sql: saved.sql, extra: saved.extra }
    const existing = tabs.find((t) => t.id === saved.id)
    if (!existing) return createTab(init)
    Object.assign(existing, { name: init.name, named: init.named, connectionName: init.connectionName, database: init.database, extra: init.extra, crlf: hasCrlf(saved.sql) })
    const sql = saved.sql.replace(/\r\n/g, '\n')
    replaceText(existing.editor, sql)
    return existing
  })
  const removed = tabs.filter((t) => !next.includes(t))
  for (const tab of removed) disposeTab(tab)
  tabs = next
  const empty = tabs.length === 0
  if (empty) {
    const target = lastTarget()
    tabs = [createTab({ id: newId(), name: nextTabName([], target.connection), named: false, connectionName: target.connection, database: target.database, sql: '' })]
  }
  // Only real repairs (new ids) or a first tab are written back: just opening a file must not
  // change it (or mark it unsaved).
  if (repaired || empty) saveWorkbook()
  return removed
}

// --- .sql mode: one tab; the header comment holds the target and the id -----------------------

/** The editor's first line as last seen, to notice when the person edits the header comment. */
let headerText = ''
/** The first line of LF text (the editor's): compared with `headerText`. */
const firstLineOf = (value: string) => value.split('\n', 1)[0]
let headerTimer = 0

/** The header's id, else the last one this page saw there (deleting the header, say with
 *  select-all and delete, keeps the session; the next run writes it back). */
function headerId(tab: Tab): string {
  const id = parseHeader(text(tab))?.id
  if (id) tab.id = id
  return tab.id
}

function adoptHeader(tab: Tab): void {
  const header = parseHeader(text(tab))
  const target = header ?? lastTarget()
  tab.connectionName = target.connection
  tab.database = target.database
  headerId(tab)
}

/** Set while writeHeader edits, so onEdit does not take the edit for a hand-edited header. */
let writingHeader = false

/** Writes the header comment so the file remembers its target and id (not for read-only documents). */
function writeHeader(tab: Tab): void {
  if (workbookMode || doc.readOnly || !tab.connectionName) return
  const edit = headerEdit(text(tab), { connection: tab.connectionName, database: tab.database, id: headerId(tab) })
  if (!edit) return
  writingHeader = true
  try {
    // One undo step; the selection and scroll position stay put.
    replaceRange(tab.editor, edit.start, edit.end, edit.text)
  } finally {
    writingHeader = false
  }
  const value = text(tab)
  headerText = firstLineOf(value)
  doc.change(withLineEndings(value, tab.crlf))
}

// --- Editing ----------------------------------------------------------------------------------

function onEdit(tab: Tab): void {
  if (workbookMode) return saveWorkbook()
  if (writingHeader) return // writeHeader saves and records the header itself
  const value = text(tab)
  doc.change(withLineEndings(value, tab.crlf))
  // A hand-edited (or pasted) header line picks the connection and database, as on open.
  const first = firstLineOf(value)
  if (first === headerText) return
  headerText = first
  headerId(tab) // remember the header's id before it can be deleted
  clearTimeout(headerTimer)
  headerTimer = window.setTimeout(() => {
    if (!parseHeader(text(tab))) return
    adoptHeader(tab)
    void syncPickers()
  }, 400)
}

doc.onReplace((text) => {
  // The file changed outside this editor (another program, git, Orca's revert).
  if (tabs.length === 0) return // still starting: the start-up code reads doc.value
  if (workbookMode) {
    if (!isWorkbookText(text)) return setStatus('The file is no longer a SeaQull workbook; reopen it to see it as text.', true)
    const removed = loadWorkbook(text)
    // Tabs the change removed: end their SQL sessions, as closing them would.
    for (const tab of removed) void request('query.close', { consoleId: tab.id }).catch(() => undefined)
    // Keep focus, the grid and any rename in progress unless the active tab itself went away.
    if (!tabs.some((t) => t.id === activeId)) showTab(tabs[0].id, { focus: false })
    else {
      for (const t of tabs) t.editor.dom.hidden = t.id !== activeId
      renderTabBar()
      void syncPickers()
    }
    return
  }
  const tab = active()
  tab.crlf = hasCrlf(text)
  replaceText(tab.editor, text.replace(/\r\n/g, '\n'))
  headerText = firstLineOf(editorText(tab.editor))
  adoptHeader(tab)
  void syncPickers()
})

// --- The tab bar (workbooks) ------------------------------------------------------------------

/** Tab elements by tab id, updated in place: rebuilding them between two clicks would lose a
 *  double-click (rename). */
const tabElements = new Map<string, HTMLElement>()
let addTabButton: HTMLButtonElement | null = null

function tabElement(tab: Tab): HTMLElement {
  let item = tabElements.get(tab.id)
  if (item) return item
  item = document.createElement('div')
  item.className = 'qtab'
  item.setAttribute('role', 'tab')
  item.dataset.id = tab.id
  const state = document.createElement('span')
  state.className = 'qtab-state'
  const name = document.createElement('span')
  name.className = 'qtab-name'
  item.append(state, name)
  if (!doc.readOnly) {
    const close = document.createElement('button')
    close.className = 'qtab-close'
    close.title = 'Close tab (or middle-click the tab)'
    close.innerHTML = icon('close')
    close.onclick = (event) => {
      event.stopPropagation()
      void closeTab(tab)
    }
    item.append(close)
  }
  item.onclick = () => {
    if (tab.id !== activeId) showTab(tab.id)
  }
  item.onauxclick = (event) => {
    if (event.button === 1 && !doc.readOnly) void closeTab(tab)
  }
  name.ondblclick = () => renameTab(tab, name)
  tabElements.set(tab.id, item)
  return item
}

function renderTabBar(): void {
  ui.queryTabs.hidden = !workbookMode
  if (!workbookMode) return
  for (const [id, item] of tabElements) {
    if (!tabs.some((t) => t.id === id)) {
      item.remove()
      tabElements.delete(id)
    }
  }
  const items = tabs.map((tab) => {
    const item = tabElement(tab)
    item.setAttribute('aria-selected', String(tab.id === activeId))
    item.tabIndex = tab.id === activeId ? 0 : -1
    const color = connectionOf(tab)?.color
    if (color) item.style.setProperty('--conn', color)
    else item.style.removeProperty('--conn')
    const state = item.querySelector<HTMLElement>('.qtab-state')!
    const failed = !tab.running && tab.status?.state === 'error'
    state.className = `qtab-state${tab.running ? ' running' : failed ? ' error' : ''}`
    state.innerHTML = failed ? icon('error') : ''
    state.title = tab.running ? 'Running' : failed ? 'The last run ended with errors' : ''
    const name = item.querySelector<HTMLElement>('.qtab-name')
    if (name && name.textContent !== tab.name) name.textContent = tab.name
    item.querySelector('.qtab-close')?.setAttribute('aria-label', `Close ${tab.name}`)
    item.title = `${tab.name}${tab.connectionName ? ` · ${tab.connectionName}${tab.database ? ` / ${tab.database}` : ''}` : ''}${doc.readOnly ? '' : '\nDouble-click to rename'}`
    return item
  })
  if (!addTabButton) {
    addTabButton = document.createElement('button')
    addTabButton.className = 'qtab-add icon-button'
    addTabButton.title = 'New tab on the same connection'
    addTabButton.setAttribute('aria-label', 'New tab')
    addTabButton.innerHTML = icon('add')
    addTabButton.onclick = () => {
      const tab = active()
      newTab(connectionOf(tab)?.id ?? '', tab.database)
    }
    addTabButton.hidden = doc.readOnly
  }
  // Only move elements when the order changed.
  const wanted = [...items, addTabButton]
  const current = Array.from(ui.queryTabs.children)
  if (wanted.length !== current.length || wanted.some((el, i) => el !== current[i])) ui.queryTabs.replaceChildren(...wanted)
  ui.queryTabs.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

ui.queryTabs.addEventListener('keydown', (event) => {
  const index = tabs.findIndex((t) => t.id === activeId)
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step || !(event.target as HTMLElement).classList.contains('qtab')) return
  event.preventDefault()
  showTab(tabs[(index + step + tabs.length) % tabs.length].id)
  ui.queryTabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
})

function renameTab(tab: Tab, label: HTMLElement): void {
  if (doc.readOnly) return
  const input = document.createElement('input')
  input.className = 'qtab-rename'
  input.value = tab.name
  input.size = Math.max(6, tab.name.length)
  label.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    const name = input.value.trim()
    if (save && name && name !== tab.name) {
      tab.name = name
      tab.named = true
      saveWorkbook()
    }
    input.replaceWith(label)
    renderTabBar()
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') finish(true)
    else if (event.key === 'Escape') finish(false)
    event.stopPropagation()
  }
  input.onblur = () => finish(true)
  input.onclick = (event) => event.stopPropagation()
}

/** Opens a tab on a connection and database, after the active one. */
function newTab(connectionId: string, database: string, sql = ''): Tab {
  const connectionName = connections.find((c) => c.id === connectionId)?.name ?? ''
  const tab = createTab({ id: newId(), name: nextTabName(tabs, connectionName), named: false, connectionName, database, sql })
  tabs.splice(tabs.indexOf(active()) + 1, 0, tab)
  saveWorkbook()
  showTab(tab.id)
  return tab
}

async function closeTab(tab: Tab): Promise<void> {
  if (text(tab).trim() && !(await confirmDialog(`Close "${tab.name}"? Its SQL is removed from the workbook.`, 'Close tab'))) return
  const index = tabs.indexOf(tab)
  tabs = tabs.filter((t) => t !== tab)
  disposeTab(tab)
  // Ends its SQL session in the worker (a running query is cancelled; temp tables go).
  void request('query.close', { consoleId: tab.id }).catch(() => undefined)
  if (tabs.length === 0) {
    tabs = [createTab({ id: newId(), name: nextTabName([], tab.connectionName), named: false, connectionName: tab.connectionName, database: tab.database, sql: '' })]
  }
  saveWorkbook()
  showTab(tab.id === activeId ? tabs[Math.min(index, tabs.length - 1)].id : activeId)
}

/** Shows a tab: its editor, results, status, connection pickers and colour. */
function showTab(id: string, { focus = true } = {}): void {
  activeId = id
  const tab = active()
  if (workbookMode) storageSet(activeTabKey(workbookId), tab.id)
  for (const t of tabs) t.editor.dom.hidden = t !== tab
  renderTabBar()
  renderStatus()
  setRunning(tab.running)
  renderResults()
  void syncPickers()
  if (focus) tab.editor.focus()
}

/** The tab's connection colour along the top of the toolbar. */
function renderColor(): void {
  const color = connectionOf(active())?.color
  if (color) ui.console.style.setProperty('--tab-color', color)
  else ui.console.style.removeProperty('--tab-color')
  ui.console.classList.toggle('colored', !!color)
}

// --- Connection and database pickers ----------------------------------------------------------

const databaseLists = new Map<string, Promise<string[]>>()

/** All saved connections, in as many requests as their size needs; started again (a few times at
 *  most) when they change between pages. */
async function listConnections(): Promise<SavedConnection[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const all: SavedConnection[] = []
    let version: string | undefined
    let changed = false
    for (let offset: number | null = 0; offset !== null; ) {
      const page: { connections: SavedConnection[]; next: number | null; version: string } = await request('connections.list', { offset })
      if (version !== undefined && page.version !== version) {
        changed = true
        break
      }
      version = page.version
      all.push(...page.connections)
      offset = page.next
    }
    if (!changed) return all
  }
  throw new Error('The connections kept changing while loading them: try again.')
}

async function loadConnections(): Promise<void> {
  connections = await listConnections()
  databaseLists.clear()
  // Unfiled connections first, then one group per folder (optgroups cannot nest: full paths).
  const byFolder = new Map<string, ConnectionConfig[]>()
  for (const c of [...connections].sort((a, b) => compareNames(a.name, b.name))) {
    const folder = c.folder ?? ''
    if (!byFolder.has(folder)) byFolder.set(folder, [])
    byFolder.get(folder)!.push(c)
  }
  ui.connection.replaceChildren(
    option('', connections.length ? 'Choose a connection…' : 'No connections'),
    ...(byFolder.get('') ?? []).map((c) => option(c.id, c.name)),
    ...[...byFolder.keys()]
      .filter(Boolean)
      .sort(compareNames)
      .map((folder) => {
        const group = document.createElement('optgroup')
        group.label = folder
        group.append(...byFolder.get(folder)!.map((c) => option(c.id, c.name)))
        return group
      })
  )
  renderTabBar()
  // Not awaited: the database list may wait for a sign-in, which must not hold up the explorer.
  void syncPickers()
}

let pickerGeneration = 0

/** Each picker's tooltip is its whole current value (long names are cut off at its max width). */
function pickerTitles(): void {
  for (const [select, what] of [[ui.connection, 'Connection'], [ui.database, 'Database']] as const) {
    const text = select.selectedOptions[0]?.textContent ?? ''
    select.title = text ? `${what}: ${text}` : what
  }
}
ui.connection.addEventListener('change', pickerTitles)
ui.database.addEventListener('change', pickerTitles)

/** Shows the active tab's connection and database in the toolbar pickers. `byUser`: the person
 *  chose them, so listing the databases may ask for a sign-in again after a cancel. */
async function syncPickers(byUser = false): Promise<void> {
  const generation = ++pickerGeneration
  const tab = active()
  const connection = connectionOf(tab)
  ui.connection.value = connection?.id ?? ''
  renderColor()
  explorer.setCurrent(connection?.id ?? '', tab.database)
  const first = option('', connection ? `default${connection.database ? ` (${connection.database})` : ''}` : '—')
  // Show the tab's database at once; the full list follows when it has loaded.
  ui.database.replaceChildren(first, ...(connection && tab.database ? [option(tab.database, tab.database)] : []))
  ui.database.value = connection ? tab.database : ''
  ui.database.disabled = !connection
  pickerTitles()
  if (!connection) return
  if (!doc.readOnly) void namesFor(connection.id, tab.database) // ready before the first keystroke
  let names: string[] = []
  try {
    if (!databaseLists.has(connection.id)) {
      databaseLists.set(connection.id, request('databases.list', { connectionId: connection.id }, { timeoutMs: 60_000 }, byUser))
    }
    names = await databaseLists.get(connection.id)!
    // An earlier connection's failure no longer applies.
    if (tab.statusError && tab.statusText.startsWith('Could not list databases')) setStatus('', false, tab)
  } catch (err) {
    databaseLists.delete(connection.id)
    if (!isSignInCancelled(err)) setStatus(`Could not list databases: ${errorText(err)}`, true, tab)
  }
  if (generation !== pickerGeneration) return // a newer call (tab switch, target change) owns the pickers
  const wanted = tab.database
  if (wanted && !names.includes(wanted)) names = [wanted, ...names]
  ui.database.replaceChildren(first, ...names.map((name) => option(name, name)))
  ui.database.value = wanted
  pickerTitles()
}

/** Points a tab at a connection and database; an unrenamed tab takes the connection's name. */
async function setTarget(tab: Tab, connectionId: string, database: string): Promise<void> {
  const connectionName = connections.find((c) => c.id === connectionId)?.name ?? ''
  if (workbookMode && !tab.named && connectionName !== tab.connectionName) {
    tab.name = nextTabName(tabs.filter((t) => t !== tab), connectionName)
  }
  tab.connectionName = connectionName
  tab.database = database
  if (connectionName) storageSet(LAST_TARGET_KEY, JSON.stringify({ connection: connectionName, database }))
  writeHeader(tab)
  saveWorkbook()
  renderTabBar()
  if (tab === active()) await syncPickers(true)
}

ui.connection.addEventListener('change', () => void setTarget(active(), ui.connection.value, ''))
ui.database.addEventListener('change', () => void setTarget(active(), ui.connection.value, ui.database.value))

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

// --- Running ----------------------------------------------------------------------------------

function setStatus(text: string, isError = false, tab: Tab = active()): void {
  tab.statusText = text
  tab.statusError = isError
  if (tab === active()) renderStatus()
}

function renderStatus(): void {
  const tab = active()
  ui.status.textContent = tab.statusText
  ui.status.title = tab.statusText // long errors are cut off with an ellipsis
  ui.status.classList.toggle('error', tab.statusError)
}

function setRunning(running: boolean, tab: Tab = active()): void {
  const changed = tab.running !== running
  tab.running = running
  if (tab === active()) {
    ui.run.disabled = running
    ui.cancel.disabled = !running && !tab.maybeRunning
  }
  if (changed) renderTabBar()
}

async function run(): Promise<void> {
  const tab = active()
  closeCompletionPopup(tab.editor)
  if (tab.running) return
  if (!workbookMode) {
    // The header comment wins over the pickers if they disagree (just edited by hand).
    const header = parseHeader(text(tab))
    if (header && (header.connection !== tab.connectionName || header.database !== tab.database)) {
      clearTimeout(headerTimer)
      adoptHeader(tab)
      await syncPickers()
    }
  }
  const connection = connectionOf(tab)
  if (!connection) {
    setStatus('Choose a connection first.', true, tab)
    ui.connection.focus()
    return
  }
  // Before reading the text: adding the header shifts every line, and error lines must match.
  writeHeader(tab)
  const { sql, firstLine } = runnableText(tab.editor)
  await startRun(tab, connection.id, tab.database, sql, firstLine)
}

/** SQL that may create, change or drop objects (the names the editor completes). A USE in the
 *  script can switch databases, so a match forgets all of the connection's names. */
const CHANGES_NAMES = /\b(?:create|alter|drop|sp_rename)\b/i

/** A run has ended (or can no longer be followed): forget names it may have changed. */
function runEnded(tab: Tab): void {
  if (tab.changesNames) forgetNames(tab.changesNames)
  tab.changesNames = undefined
}

/** Runs `sql` on the tab's session and shows its results there; `firstLine` maps error lines. */
async function startRun(tab: Tab, connectionId: string, database: string, sql: string, firstLine: number): Promise<void> {
  setRunning(true, tab)
  setStatus('Running…', false, tab)
  try {
    const id = workbookMode ? tab.id : headerId(tab)
    tab.runId = undefined
    tab.cancelPending = false
    tab.changesNames = CHANGES_NAMES.test(sql) ? connectionId : undefined
    // Large scripts go in parts (Orca caps a request at 64 KiB).
    const { runId } = await sendRun((name, input) => request(name, input), { consoleId: id, connectionId, database, sql, firstLine })
    tab.maybeRunning = false
    tab.runId = runId
    // The worker dropped the previous run's results: take its grid down rather than leave it dead.
    tab.status = null
    tab.view = 0
    tab.widths = undefined
    if (tab === active()) renderResults()
    if (tab.cancelPending) void request('query.cancel', { runId }).catch(() => undefined)
    void follow(tab, runId)
  } catch (err) {
    setRunning(false, tab)
    setStatus(errorText(err), !isSignInCancelled(err), tab)
  }
}

/** Polls the run until it ends and shows how it went (run-watch.ts retries failed polls). */
async function follow(tab: Tab, runId: string, initial?: RunStatus): Promise<void> {
  const current = () => tab.runId === runId && tabs.includes(tab)
  const end = await watchRun(
    runId,
    {
      status: (id, messagesFrom) => request('query.status', { runId: id, messagesFrom }),
      latest: async () => (await request('query.latest', { consoleId: workbookMode ? tab.id : headerId(tab) })).status,
      sleep: (ms) => new Promise((resolve) => (tab.pollTimer = window.setTimeout(resolve, ms))),
      current,
      progress: (status) => {
        tab.status = status
        setStatus(`Running… ${(status.elapsedMs / 1000).toFixed(1)} s`, false, tab)
      }
    },
    initial
  )
  if (end.kind === 'stale') return
  runEnded(tab)
  if (end.kind === 'gone') {
    setRunning(false, tab)
    setStatus(`${errorText(end.error)} The query is no longer running.`, true, tab)
    return
  }
  if (end.kind === 'unreachable') {
    // It may still be running in the worker: keep Cancel, and let Run report a conflict if so.
    tab.maybeRunning = true
    setRunning(false, tab)
    setStatus(`Lost contact with SeaQull's worker (${errorText(end.error)}). The query may still be running: Cancel stops it.`, true, tab)
    return
  }
  const status = end.status
  tab.status = status
  const rows = status.results.reduce((sum, r) => sum + r.rowCount, 0)
  const errors = status.messages.filter((m) => m.kind === 'error').length
  const summary = `${status.results.length} result${status.results.length === 1 ? '' : 's'}, ${rows.toLocaleString()} rows · ${formatMs(status.elapsedMs)}`
  setStatus(
    status.state === 'done' ? summary : status.state === 'cancelled' ? `Cancelled · ${formatMs(status.elapsedMs)}` : `${errors} error${errors === 1 ? '' : 's'} · ${summary}`,
    status.state !== 'done',
    tab
  )
  tab.view = status.results.length > 0 ? 0 : 'messages'
  setRunning(false, tab) // also redraws the tab bar (spinner off, error icon on)
  if (tab === active()) renderResults()
}

const formatMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`)

async function cancel(): Promise<void> {
  const tab = active()
  if (!tab.running && tab.maybeRunning && tab.runId) {
    // Contact was lost while it ran: ask the worker to cancel, and follow the run again if it can.
    const runId = tab.runId
    setStatus('Cancelling…', false, tab)
    try {
      await request('query.cancel', { runId })
    } catch (err) {
      if ((err as { code?: string }).code === 'invalid_params') {
        // The worker no longer has the run (it restarted): nothing is running.
        tab.maybeRunning = false
        setRunning(false, tab)
        setStatus(`${errorText(err)} The query is no longer running.`, true, tab)
      } else setStatus(`Could not reach SeaQull's worker to cancel: ${errorText(err)}`, true, tab)
      return
    }
    tab.maybeRunning = false
    setRunning(true, tab)
    void follow(tab, runId)
    return
  }
  if (!tab.running) return
  setStatus('Cancelling…', false, tab)
  if (!tab.runId) {
    tab.cancelPending = true // the run is still being registered: startRun cancels it
    return
  }
  await request('query.cancel', { runId: tab.runId }).catch(() => undefined)
}

ui.run.addEventListener('click', () => void run())
ui.cancel.addEventListener('click', () => void cancel())

// --- Results ----------------------------------------------------------------------------------

function renderResults(): void {
  const tab = active()
  const status = tab.status
  grid?.dispose()
  grid = null
  resetExport()
  if (!status || (tab.running && status.results.length === 0)) {
    ui.tabs.replaceChildren()
    ui.grid.hidden = ui.messages.hidden = ui.resultBar.hidden = true
    ui.empty.hidden = false
    ui.empty.textContent = tab.running ? 'Running…' : 'Run a query to see results here.'
    return
  }
  const resultTabs: HTMLButtonElement[] = status.results.map((r, i) => {
    const button = document.createElement('button')
    button.textContent = `Result ${i + 1} (${r.rowCount.toLocaleString()}${r.truncated ? '+' : ''})`
    button.title = `Batch ${r.batch}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(tab.view === i))
    button.onclick = () => {
      tab.view = i
      renderResults()
    }
    return button
  })
  const messagesTab = document.createElement('button')
  const errorCount = status.messages.filter((m) => m.kind === 'error').length
  messagesTab.textContent = `Messages (${status.messages.length})`
  messagesTab.setAttribute('role', 'tab')
  messagesTab.setAttribute('aria-selected', String(tab.view === 'messages'))
  messagesTab.classList.toggle('has-error', errorCount > 0)
  messagesTab.onclick = () => {
    tab.view = 'messages'
    renderResults()
  }
  ui.tabs.replaceChildren(...resultTabs, messagesTab)
  ui.empty.hidden = true

  const result = typeof tab.view === 'number' ? status.results[tab.view] : undefined
  if (!result) {
    ui.grid.hidden = true
    ui.resultBar.hidden = true
    ui.messages.hidden = false
    renderMessages(status)
    return
  }
  ui.messages.hidden = true
  ui.grid.hidden = false
  ui.resultBar.hidden = false
  const info = `${result.rowCount.toLocaleString()} rows${result.truncated ? ' (row limit reached; more rows not fetched)' : ''} · ${result.columns.length} columns`
  ui.resultInfo.textContent = info
  const runId = status.runId
  const index = tab.view as number
  const widths = (tab.widths ??= new Map())
  grid = new Grid(ui.grid, {
    columns: result.columns,
    rowCount: result.rowCount,
    fetchRows: async (offset, limit) => {
      const page = await request('query.rows', { runId, result: index, offset, limit })
      return { rows: page.rows as Cell[][], cut: page.cut ?? [] }
    },
    onCopy: (kind) => void copySelection(kind),
    onSelectionChange: (range) => {
      ui.resultInfo.textContent = range ? `${info} · ${describeRange(range)}` : info
      syncCopyButton(!!range)
      resetExport() // a pending "Ready to copy" holds the old selection
    },
    headers: () => ui.includeHeaders.checked,
    widths: widths.get(index),
    onResize: (column, width) => {
      if (!widths.has(index)) widths.set(index, new Map())
      widths.get(index)!.set(column, width)
    }
  })
  syncCopyButton(false)
  void grid.mount().catch((err) => setStatus(errorText(err), true, tab))
}

function renderMessages(status: RunStatus): void {
  const items = status.messages.map((m) => {
    const li = document.createElement('li')
    li.className = m.kind
    if (m.line) {
      const link = document.createElement('a')
      link.textContent = `Line ${m.line}`
      link.title = 'Select this line in the editor'
      link.onclick = () => selectLine(active().editor, m.line!)
      li.append(link, `: ${m.text}`)
    } else li.textContent = m.text
    return li
  })
  ui.messages.replaceChildren(...items)
}

// --- Copying the grid selection ---------------------------------------------------------------

function describeRange({ r0, r1, c0, c1 }: Range): string {
  const rows = r1 - r0 + 1
  const columns = c1 - c0 + 1
  return rows === 1 && columns === 1 ? '1 cell selected' : `${rows.toLocaleString()} × ${columns} selected`
}

/** ⌘C, ⇧⌘C or the grid menu. ⌘C/⇧⌘C copy TSV, which pastes into spreadsheets as cells, with
 *  headers as the "Headers" box says (⇧ the other way); a single cell copies as its raw text. */
async function copySelection(kind: CopyKind): Promise<void> {
  const viaKeys = kind === 'default' || kind === 'inverse'
  const headers = ui.includeHeaders.checked !== (kind === 'inverse')
  try {
    await copyFromGrid(viaKeys ? 'tsv' : kind, headers, viaKeys)
  } catch (err) {
    setStatus(isBusy(err) ? errorText(err) : `Copy failed: ${errorText(err)}`, !isBusy(err))
  }
  // The "Ready to copy" dialog keeps the focus when the copy needs one more click.
  if (!pending) grid?.focus()
}

/** Copies the grid selection in a format; false when nothing is selected. Formatted here from the
 *  loaded rows, or in the worker when some of the selected values arrived cut short. */
async function copyFromGrid(format: ExportFormat, headers: boolean, rawSingleCell: boolean): Promise<boolean> {
  const source = grid
  const { status, view } = active()
  const selected = await source?.selectedData()
  if (source && source !== grid) return true // the result changed while rows loaded: copy nothing
  if (!selected) return false
  const { columns, rows, range, cut } = selected
  const raw = rawSingleCell && rows.length === 1 && columns.length === 1
  const tableName = ui.tableName.value.trim()
  let text: string
  if (cut && status && typeof view === 'number') {
    const input = { runId: status.runId, result: view, format, headers, selection: range, ...(raw ? { raw } : {}), ...(tableName ? { tableName } : {}) }
    let progressed = false
    text = (await fetchExport(input, (p) => ((progressed = true), setStatus(`Copying… ${p}`)))).text
    if (progressed) setStatus('')
    if (source !== grid) return true
  } else text = raw ? cellText(rows[0][0]) : exportResult(format, { columns, rows, headers, ...(tableName ? { tableName } : {}) })
  const delimited = format === 'csv' || format === 'tsv'
  const what = `${describeRange(range).replace(' selected', '')}${!raw && delimited ? (headers ? ' with headers' : ' without headers') : ''} as ${raw ? 'text' : formatLabel(format)}`
  await deliver('copy', { key: '', fileName: '', mimeType: 'text/plain', text, rows: rows.length, what })
  return true
}

/** The Copy button copies the selection when there is one, else the whole result. */
function syncCopyButton(hasSelection: boolean): void {
  ui.copyResult.querySelector('span')!.textContent = hasSelection ? 'Copy selection' : 'Copy'
  ui.copyResult.title = hasSelection
    ? `Copy the selected cells in this format.\n${keys.copy} copies them as TSV; Escape clears the selection.`
    : 'Copy the whole result in this format'
}

// --- Copy and save: format in the worker, fetch in chunks, then copy or show the save dialog ------
// Both need a click or key press in the last few seconds (Chromium's transient activation). A
// large result can take longer to fetch; then a dialog asks for one more click.

/** `saved`: the status once saved, when not "Saved <file name>". */
type Prepared = { key: string; fileName: string; mimeType: string; text: string; rows: number; what: string; saved?: string }
let prepared: Prepared | null = null
let pending: { action: 'copy' | 'save'; data: Prepared } | null = null

ui.format.replaceChildren(...EXPORT_FORMATS.map((f) => option(f.format, f.label)))
ui.format.value = storageGet(FORMAT_KEY) ?? 'csv'
ui.includeHeaders.checked = storageGet(HEADERS_KEY) !== '0'
ui.includeHeaders.addEventListener('change', () => {
  storageSet(HEADERS_KEY, ui.includeHeaders.checked ? '1' : '0')
  resetExport()
  returnFocusToGrid()
})
/** After a result-bar setting changes, keyboard copies should go on working on the selection. */
const returnFocusToGrid = () => {
  if (grid?.selection()) grid.focus()
}
ui.copyResult.innerHTML = `${icon('copy')}<span>Copy</span>`
ui.saveResult.innerHTML = `${icon('download')}<span>Save…</span>`
/** SQL INSERT's target table, just before the format. (Headers stays shown for every format: ⌘C in
 *  the grid copies TSV and follows it, whatever the format.) */
const syncTableField = () => (ui.tableName.hidden = ui.format.value !== 'sql')
syncTableField()
ui.format.addEventListener('change', () => {
  storageSet(FORMAT_KEY, ui.format.value)
  syncTableField()
  resetExport()
  if (ui.format.value !== 'sql') returnFocusToGrid() // SQL INSERT shows the table-name field to fill in
})
ui.tableName.addEventListener('input', () => resetExport())

/** A copy or export is being fetched from the worker. One at a time: each export.prepare replaces
 *  the run's previous export, which would leave the other one unfinished. */
let exporting = false
/** The Copy or Save button's action is under way. */
let buttonBusy = false
const syncExportButtons = () => (ui.copyResult.disabled = ui.saveResult.disabled = exporting || buttonBusy)
const isBusy = (err: unknown) => (err as { busy?: boolean } | null)?.busy === true

function resetExport(): void {
  prepared = null
  pending = null
  if (ui.readyDialog.open) ui.readyDialog.close()
  syncExportButtons()
}

/** The current result in the chosen format; reused while nothing changes. */
async function prepare(progress: (text: string) => void): Promise<Prepared> {
  const { status, view } = active()
  if (!status || typeof view !== 'number') throw new Error('No result selected')
  // Request inputs must be plain JSON: Orca refuses `undefined`, so leave tableName out when empty.
  const tableName = ui.tableName.value.trim()
  const input = {
    runId: status.runId,
    result: view,
    format: ui.format.value as ExportFormat,
    headers: ui.includeHeaders.checked,
    ...(tableName ? { tableName } : {})
  }
  const key = JSON.stringify(input)
  if (prepared?.key === key) return prepared
  const { fileName, mimeType, text } = await fetchExport(input, progress)
  const rows = status.results[view].rowCount
  const bare = !input.headers && (input.format === 'csv' || input.format === 'tsv')
  const what = `${rows.toLocaleString()} rows${bare ? ' without headers' : ''} as ${formatLabel(input.format)}`
  prepared = { key, fileName, mimeType, text, rows, what }
  return prepared
}

/** Formats in the worker and fetches the text in chunks of up to about 900 KB. */
type ExportRequest = { runId: string; result: number; format: ExportFormat; headers: boolean; tableName?: string; selection?: CellRange; raw?: boolean }

async function fetchExport(input: ExportRequest, progress: (text: string) => void) {
  if (exporting) throw Object.assign(new Error('Still getting the last copy or export ready: try again when it is done.'), { busy: true })
  exporting = true
  syncExportButtons()
  try {
    const info = await request('export.prepare', input)
    let text = ''
    for (let offset: number | null = 0; offset !== null; ) {
      if (offset > 0) progress(`${Math.round((offset / info.length) * 100)}%`)
      const chunk: { text: string; next: number | null } = await request('export.chunk', { exportId: info.exportId, offset })
      text += chunk.text
      offset = chunk.next
    }
    return { fileName: info.fileName, mimeType: info.mimeType, text }
  } finally {
    exporting = false
    syncExportButtons()
  }
}

/** Writes the clipboard (plugin frames may write it, never read it, right after a click or key press). */
function writeClipboard(text: string): boolean {
  // The copy event's clipboardData keeps the text exactly (a textarea would turn CRLF into LF).
  let written = false
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', text)
    event.preventDefault()
    written = !!event.clipboardData
  }
  document.addEventListener('copy', onCopy, { capture: true })
  try {
    return document.execCommand('copy') && written
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true })
  }
}

const formatLabel = (format = ui.format.value) => EXPORT_FORMATS.find((f) => f.format === format)?.label ?? format
const stillActive = () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive !== false

/** `again`: it needs another click or key press (the last one expired); `failed`: it went wrong,
 *  and the fetched text is kept for another try. */
type Outcome = 'done' | 'again' | 'failed'

function copyPrepared(data: Prepared): Outcome {
  if (!writeClipboard(data.text)) return 'again'
  setStatus(`Copied ${data.what} (${formatBytes(new Blob([data.text]).size)})`)
  return 'done'
}

async function savePrepared(data: Prepared): Promise<Outcome> {
  if (!orca.files) {
    setStatus('Saving files needs the Orca desktop app.', true)
    return 'failed'
  }
  try {
    const { status: saved } = await orca.files.saveAs({ suggestedName: data.fileName, mimeType: data.mimeType, data: data.text })
    setStatus(saved === 'saved' ? (data.saved ?? `Saved ${data.fileName}`) : 'Save cancelled')
    return 'done'
  } catch (err) {
    if ((err as { code?: string }).code === 'not_permitted') return 'again'
    setStatus(`Save failed: ${errorText(err)}`, true)
    return 'failed'
  }
}

/** Copies or saves `data`, or, when the click or key press that asked for it has expired, asks for another. */
async function deliver(action: 'copy' | 'save', data: Prepared): Promise<void> {
  const outcome = !stillActive() ? 'again' : action === 'copy' ? copyPrepared(data) : await savePrepared(data)
  if (outcome === 'done') resetExport()
  else if (outcome === 'again') askToFinish(action, data)
}

ui.readyWhy.innerHTML = icon('info')
const READY_WHY =
  'Large results are loaded in parts of about 1 MB, which can take a few seconds.\n' +
  'For security, copying and saving only work within a few seconds of a click. If loading takes longer, one more click is needed.'
ui.readyWhy.title = READY_WHY
ui.readyWhy.setAttribute('role', 'img')
ui.readyWhy.setAttribute('aria-label', READY_WHY)

/** A dialog whose button finishes the copy or save with a click of its own; it stays open until that works. */
function askToFinish(action: 'copy' | 'save', data: Prepared): void {
  pending = { action, data }
  const copy = action === 'copy'
  ui.readyTitle.textContent = copy ? 'Ready to copy' : 'Ready to save'
  ui.readySize.textContent = `${formatBytes(new Blob([data.text]).size)} · ${data.what}`
  ui.readyText.textContent = copy ? 'Click Copy to put it on the clipboard.' : `Click Save… to choose where to save ${data.fileName}.`
  ui.readyOk.textContent = copy ? 'Copy' : 'Save…'
  if (!ui.readyDialog.open) ui.readyDialog.showModal()
  ui.readyOk.focus()
}

ui.readyOk.addEventListener('click', async () => {
  if (!pending) return
  const { action, data } = pending
  const outcome = action === 'copy' ? copyPrepared(data) : await savePrepared(data)
  if (pending?.data !== data) return
  if (outcome === 'again') {
    ui.readyText.textContent = action === 'copy' ? "Couldn't copy. Click Copy again." : "Couldn't save. Click Save… again."
    return
  }
  if (outcome === 'failed') ui.readyDialog.close()
  else resetExport()
  grid?.focus()
})
ui.readyCancel.addEventListener('click', () => ui.readyDialog.close())
ui.readyDialog.addEventListener('close', () => (pending = null))

async function runExport(action: 'copy' | 'save', button: HTMLButtonElement): Promise<void> {
  const { status, view } = active()
  if (!status || typeof view !== 'number' || buttonBusy) return
  const label = button.querySelector('span')!
  buttonBusy = true
  syncExportButtons()
  try {
    if (action === 'copy' && (await copyFromGrid(ui.format.value as ExportFormat, ui.includeHeaders.checked, false))) return
    await deliver(action, await prepare((p) => (label.textContent = p)))
  } catch (err) {
    setStatus(isBusy(err) ? errorText(err) : `${action === 'copy' ? 'Copy' : 'Export'} failed: ${errorText(err)}`, !isBusy(err))
  } finally {
    buttonBusy = false
    syncExportButtons()
    // Labels from the current state (the selection may have changed meanwhile), not the old text.
    ui.saveResult.querySelector('span')!.textContent = 'Save…'
    syncCopyButton(!!grid?.selection())
  }
}

ui.copyResult.addEventListener('click', () => void runExport('copy', ui.copyResult))
ui.saveResult.addEventListener('click', () => void runExport('save', ui.saveResult))

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

// --- Keyboard ---------------------------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  // A modal dialog (connection, confirm, ready to copy) owns the keyboard: no running or copying behind it.
  if (document.querySelector('dialog[open]')) return
  const mod = event.metaKey || event.ctrlKey
  if (mod && event.key === 'Enter') {
    // In the editor's find/replace panel (⌘F) the key is the panel's: find next, replace.
    if ((event.target as Element).closest?.('.cm-panels')) return
    event.preventDefault()
    void run()
  } else if (mod && event.key === '.') {
    event.preventDefault()
    void cancel()
  } else if (event.altKey && !mod && !event.shiftKey && event.key === 'F1') {
    // ⌥F1: show the name at the cursor in the explorer.
    event.preventDefault()
    void locate()
  } else if (mod && event.key.toLowerCase() === 'c' && !event.defaultPrevented && copiesGridSelection(event.target)) {
    // ⌘C on the result bar's controls (after ticking a box, say) copies the grid selection too.
    event.preventDefault()
    void copySelection(event.shiftKey ? 'inverse' : 'default')
  }
})

/** Whether ⌘C on this element means the grid selection: anywhere in the results area except text
 *  fields, which copy their own text (the grid itself handles the keys first). The SQL editor is
 *  outside the results area (and editable content counts as a text field anyway). */
function copiesGridSelection(target: EventTarget | null): boolean {
  if (!grid?.selection() || !(target instanceof HTMLElement) || !target.closest('#results')) return false
  const textField =
    target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
  return !textField
}

// --- Explorer ---------------------------------------------------------------------------------

/** Inserts text at the cursor of the active tab (undoable); `ownLine` puts it on a line of its
 *  own. False when the file is read-only. */
function insertText(text: string, ownLine = false): boolean {
  const editor = active().editor
  if (editor.state.readOnly) {
    setStatus('This file is read-only.', true)
    return false
  }
  insertAtCursor(editor, text, ownLine)
  return true
}

function copyText(text: string): void {
  const copied = writeClipboard(text)
  setStatus(copied ? `Copied ${text}` : 'Could not copy to the clipboard.', !copied)
}

let refreshing: Promise<void> | null = null
let refreshAgain = false

/** Reloads connections and the tree; calls while one runs collapse into one more afterwards (a
 *  save here triggers both the dialog callback and the storage change event). */
function connectionsChanged(): Promise<void> {
  if (refreshing) {
    refreshAgain = true
    return refreshing
  }
  refreshing = (async () => {
    do {
      refreshAgain = false
      forgetNames() // a connection may point elsewhere now; the toolbar's Refresh lands here too
      await loadConnections()
      await explorer.reload()
    } while (refreshAgain)
  })().finally(() => (refreshing = null))
  return refreshing
}

async function editConnection(connectionId?: string, folder?: string): Promise<void> {
  // Fresh from the worker: a sign-in may have saved a user since the list was loaded.
  const latest = connectionId ? await listConnections().catch(() => connections) : connections
  const existing = latest.find((c) => c.id === connectionId)
  if (connectionId && !existing) return void connectionsChanged()
  const folders = folderPaths(latest.map((c) => c.folder))
  openConnectionDialog(existing, async (saved) => {
    // A renamed connection: tabs that used the old name follow it.
    if (existing && existing.name !== saved.name) {
      for (const tab of tabs) {
        if (tab.connectionName !== existing.name) continue
        tab.connectionName = saved.name
        if (workbookMode && !tab.named) tab.name = nextTabName(tabs.filter((t) => t !== tab), saved.name)
        writeHeader(tab)
      }
      saveWorkbook()
    }
    await connectionsChanged()
    // A new connection becomes the active tab's when it has none yet (never on an edit: the tab may
    // use a connection this machine does not have, which an unrelated edit must not replace).
    if (!existing && !active().connectionName) await setTarget(active(), saved.id, '')
  }, { folder, folders })
}

async function renameFolder(folder: string): Promise<void> {
  const others = folderPaths(connections.map((c) => c.folder)).filter((f) => f !== folder && !f.startsWith(`${folder}/`))
  const to = await promptDialog(`Rename ${folder}`, 'Folder', folder, 'Rename', {
    suggestions: others,
    note: 'Use / or \\ for subfolders. An existing folder\'s name moves these connections into it.'
  })
  if (to === null || normalizeFolder(to) === folder) return
  try {
    await request('connections.renameFolder', { from: folder, to })
    explorer.folderRenamed(folder, normalizeFolder(to))
  } catch (err) {
    setStatus(errorText(err), true)
  }
  await connectionsChanged()
}

async function deleteConnection(connectionId: string): Promise<void> {
  const connection = connections.find((c) => c.id === connectionId)
  if (!connection) return
  if (!(await confirmDialog(`Delete the connection "${connection.name}"? Its saved password is deleted too. Tabs that use it keep their SQL.`, 'Delete'))) return
  try {
    await request('connections.delete', { id: connectionId })
  } catch (err) {
    setStatus(errorText(err), true)
  }
  await connectionsChanged()
}

// A connection without a saved login: one prompt, however many requests need it.
const remembering = new Set<string>()
/** Connections whose sign-in was cancelled, kept across page reloads (Orca reloads a console's
 *  page when its tab is shown again) for a while: until then only a user action asks again. */
const DECLINED_KEY = 'seaqull.signInDeclined'
const DECLINED_MS = 12 * 60 * 60_000
const declinedAt = (): Record<string, number> => {
  try {
    const all = JSON.parse(storageGet(DECLINED_KEY) ?? '{}') as Record<string, number>
    return Object.fromEntries(Object.entries(all).filter(([, at]) => typeof at === 'number' && Date.now() - at < DECLINED_MS))
  } catch {
    return {}
  }
}
const declined = {
  has: (id: string) => id in declinedAt(),
  add: (id: string) => storageSet(DECLINED_KEY, JSON.stringify({ ...declinedAt(), [id]: Date.now() })),
  delete: (id: string) => {
    const all = declinedAt()
    if (!(id in all)) return
    delete all[id]
    storageSet(DECLINED_KEY, JSON.stringify(all))
  }
}
/** The Remember box as last left, by connection: asked again after a refused login, it stays. */
const rememberChoice = new Map<string, boolean>()
installSignIn(
  new SignInGate(
    (id) => request('connections.signInState', { id }),
    async (id, state) => {
      for (let failure = state.failure; ; ) {
        const login = await signInDialog({ ...state, ...(failure ? { failure } : {}) }, rememberChoice.get(id))
        if (!login) return false
        rememberChoice.set(id, login.remember)
        try {
          await request('connections.signIn', { id, ...login })
        } catch (err) {
          failure = errorText(err)
          continue
        }
        if (login.remember) remembering.add(id)
        else remembering.delete(id)
        return true
      }
    },
    // A login to remember is saved once the server accepts it (a run connects after its request
    // returns): reload the connections once it has been.
    (id) => {
      if (!remembering.delete(id)) return
      void (async () => {
        for (let i = 0; i < 60; i++) {
          const state = await request('connections.signInState', { id }).catch(() => null)
          if (!state?.saving) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        await connectionsChanged()
      })()
    },
    declined
  )
)

const explorer = new Explorer(ui.tree, {
  load: (key, byUser) => request('tree.children', { key }, { timeoutMs: 60_000 }, byUser),
  use: (connectionId, database) => void setTarget(active(), connectionId, database),
  insert: insertText,
  copy: copyText,
  refreshed: (connectionId, database) => forgetNames(connectionId, database),
  selectTop: (path: TreePath) => {
    // Workbooks: always a new tab, so it never replaces what you were working on.
    if (workbookMode) {
      const tab = newTab(path.connection!, path.database ?? '', selectTopSql(path))
      void startRun(tab, path.connection!, path.database ?? '', text(tab), 1)
      return
    }
    // A .sql console has one session: running on another connection or database would replace it
    // (rolling back an open transaction, dropping temp tables). On its own connection, run in its
    // own database with a three-part name; anything else is inserted for the person to run.
    const tab = active()
    void (async () => {
      // No connection yet: this table's connection and database become the console's.
      if (!connectionOf(tab)) await setTarget(tab, path.connection!, path.database ?? '')
      const query = `SELECT TOP (100) * FROM ${sqlName(path, tab.database)};`
      if (connectionOf(tab)?.id !== path.connection) {
        if (insertText(query, true)) setStatus('Inserted, not run: this console uses another connection, and running it here would replace its session.')
        return
      }
      if (tab.running) return setStatus('A query is already running in this console.', true)
      writeHeader(tab) // so the id is saved and the results come back after Orca reloads the page
      // firstLine 0: this SQL is not in the editor, so messages get no line links.
      await startRun(tab, path.connection!, tab.database, query, 0)
    })()
  },
  ...(workbookMode ? { newTab: (connectionId: string, database: string) => void newTab(connectionId, database) } : {}),
  colorOf,
  newConnection: (folder) => void editConnection(undefined, folder),
  editConnection: (id) => void editConnection(id),
  deleteConnection: (id) => void deleteConnection(id),
  renameFolder: (folder) => void renameFolder(folder),
  exportConnections: (folder) => void exportConnections(folder),
  importConnections: () => importConnections(),
  folderOf: (connectionId) => connections.find((c) => c.id === connectionId)?.folder
})

ui.explorerToggle.innerHTML = icon('sidebar')
ui.explorerAdd.innerHTML = icon('add')
ui.explorerLocate.innerHTML = icon('locate')
ui.explorerRefresh.innerHTML = icon('refresh')
ui.explorerCollapse.innerHTML = icon('collapse')
ui.explorerMore.innerHTML = icon('dots')
ui.explorerMore.addEventListener('click', () => {
  const box = ui.explorerMore.getBoundingClientRect()
  showMenu(
    [
      { label: 'Export connections…', run: () => void exportConnections() },
      { label: 'Import connections…', run: importConnections }
    ],
    box.left,
    box.bottom + 2,
    () => ui.explorerMore.focus()
  )
})

const importConnections = () => openImportDialog((outcome) => void connectionsChanged().then(() => setStatus(importedText(outcome))))

/** Saves the connections (of a folder and its subfolders) to a file: no ids, no passwords. */
async function exportConnections(folder?: string): Promise<void> {
  try {
    let text = ''
    let length = -1
    let count = 0
    for (let offset: number | null = 0; offset !== null; ) {
      const chunk: { text: string; next: number | null; length: number; count: number } = await request('connections.export', { ...(folder ? { folder } : {}), offset })
      if (length !== -1 && chunk.length !== length) throw new Error('The connections changed while exporting: try again.')
      ;({ length, count } = chunk)
      text += chunk.text
      offset = chunk.next
    }
    if (count === 0) return setStatus(folder ? `No connections in ${folder}.` : 'No connections to export.')
    const fileName = folder ? `seaqull-${folder.replace(/[\\/]+/g, '-').replace(/[^\w.-]+/g, '_')}.json` : 'seaqull-connections.json'
    const what = `${count.toLocaleString()} connection${count === 1 ? '' : 's'}`
    await deliver('save', { key: '', fileName, mimeType: 'application/json', text, rows: count, what, saved: `Exported ${what} (passwords are not included)` })
  } catch (err) {
    setStatus(`Export failed: ${errorText(err)}`, true)
  }
}
ui.explorerSide.innerHTML = icon('swap')
ui.explorerAdd.addEventListener('click', () => void editConnection(undefined, explorer.selectedFolder()))
ui.explorerLocate.addEventListener('click', () => void locate())
ui.explorerLocate.title = `Show the object at the cursor, or the tab's database (${keys.locate})`

/** How long locate waits for the tab's names (loaded once per database) before falling back. */
const LOCATE_NAMES_WAIT_MS = 1000

/** The explorer's locate (its button, ⌥F1): the object, column or schema named at the active
 *  editor's cursor, opened in the tree; otherwise the tab's connection and database. */
async function locate(): Promise<void> {
  if (ui.app.classList.contains('explorer-hidden')) setExplorerHidden(false)
  const tab = active()
  const connection = connectionOf(tab)
  try {
    const source = connection && (await Promise.race([tabNames(tab), new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATE_NAMES_WAIT_MS))]))
    const database = tab.database || source?.index.database || connection?.database
    if (connection && source && database) {
      const { state } = tab.editor
      const pos = state.selection.main.head
      const start = Math.max(0, pos - WINDOW)
      const target = await locateAt(state.sliceDoc(start, pos + WINDOW), pos - start, { index: source.index, columns: source.columns })
      if (target) return await explorer.reveal(targetPath(target, connection.id, database), source.index.fold)
    }
  } catch {
    // Anything unexpected: show the database.
  }
  await explorer.locate()
}
ui.explorerRefresh.addEventListener('click', () => void connectionsChanged())
ui.explorerCollapse.addEventListener('click', () => explorer.collapseAll())

const setExplorerHidden = (hidden: boolean) => {
  ui.app.classList.toggle('explorer-hidden', hidden)
  ui.explorerToggle.setAttribute('aria-pressed', String(!hidden))
  storageSet(EXPLORER_HIDDEN_KEY, hidden ? '1' : '')
}
setExplorerHidden(storageGet(EXPLORER_HIDDEN_KEY) === '1')
ui.explorerToggle.addEventListener('click', () => setExplorerHidden(!ui.app.classList.contains('explorer-hidden')))

// Left or right: a plugin setting (Orca Settings, or the explorer's swap button), shared by all consoles.
const explorerOnRight = () => ui.app.classList.contains('explorer-right')
const applyExplorerSide = (side: unknown) => ui.app.classList.toggle('explorer-right', side === 'right')
applyExplorerSide(await orca.settings.get('explorerSide').catch(() => 'left'))
orca.settings.onDidChange(({ key }) => {
  if (key === 'explorerSide') void orca.settings.get('explorerSide').then(applyExplorerSide)
})
ui.explorerSide.addEventListener('click', () => {
  const side = explorerOnRight() ? 'left' : 'right'
  applyExplorerSide(side)
  void orca.settings.set('explorerSide', side).catch((err) => setStatus(errorText(err), true))
})

const savedWidth = Number(storageGet(EXPLORER_WIDTH_KEY))
if (savedWidth > 0) ui.explorer.style.width = `${savedWidth}px`
onDrag(ui.explorerSplitter, (event) => {
  const startX = event.clientX
  const startWidth = ui.explorer.offsetWidth
  return {
    move: (e) => {
      const delta = (e.clientX - startX) * (explorerOnRight() ? -1 : 1)
      ui.explorer.style.width = `${Math.max(160, Math.min(window.innerWidth - 320, startWidth + delta))}px`
    },
    end: () => storageSet(EXPLORER_WIDTH_KEY, String(ui.explorer.offsetWidth))
  }
})

// --- Editor layout ----------------------------------------------------------------------------

const savedHeight = Number(storageGet(EDITOR_HEIGHT_KEY))
if (savedHeight > 0) ui.editors.style.height = `${savedHeight}px`
onDrag(ui.splitter, (event) => {
  const startY = event.clientY
  const startHeight = ui.editors.offsetHeight
  return {
    move: (e) => {
      const height = Math.max(60, Math.min(window.innerHeight - 160, startHeight + e.clientY - startY))
      ui.editors.style.height = `${height}px`
    },
    end: () => storageSet(EDITOR_HEIGHT_KEY, String(ui.editors.offsetHeight))
  }
})

// --- Start ------------------------------------------------------------------------------------

if (workbookMode) {
  loadWorkbook(doc.value)
  const remembered = storageGet(activeTabKey(workbookId))
  activeId = tabs.some((t) => t.id === remembered) ? remembered! : tabs[0].id
} else {
  const header = parseHeader(doc.value)
  const target = header ?? lastTarget()
  const tab = createTab({
    id: header?.id ?? newId(),
    name: '',
    named: false,
    connectionName: target.connection,
    database: target.database,
    sql: doc.value
  })
  tabs = [tab]
  activeId = tab.id
  headerText = firstLineOf(text(tab))
}
showTab(activeId)

// Orca reloads this page whenever its tab is shown again; the worker still has each tab's last run
// (or is still running it). Ask before anything slow (listing databases can take a while). A .sql
// file without an id in its header has nothing to restore.
const restorable = workbookMode ? tabs : parseHeader(doc.value)?.id ? tabs : []
for (const tab of restorable) {
  void orca.plugin
    .request('query.latest', { consoleId: tab.id })
    .then(({ status }) => {
      if (!status || tab.status || tab.running || tab.runId || !tabs.includes(tab)) return // a run started meanwhile
      tab.runId = status.runId
      tab.status = status
      setRunning(status.state === 'running', tab)
      void follow(tab, status.runId, status)
    })
    .catch(() => undefined)
}
await connectionsChanged().catch((err) => setStatus(errorText(err), true))
// Another console added, edited or removed a connection.
orca.storage.onDidChange(({ key }) => {
  if (key === 'connections') void connectionsChanged()
})
