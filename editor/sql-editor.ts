// The SQL editor: CodeMirror 6, bundled into vendor/codemirror.js by `npm run build:editor` (the
// page's sandboxed frame cannot load bare imports). T-SQL highlighting, line numbers, undo history,
// search (⌘F), bracket matching, completion of keywords, object and column names; colours from Orca's
// --orca-* variables and console.css. The console makes one editor per query tab, so each keeps its
// own undo history, selection and scroll position.
import {
  acceptCompletion,
  autocompletion,
  bracketMatching,
  closeCompletion,
  defaultKeymap,
  drawSelection,
  dropCursor,
  EditorSelection,
  EditorState,
  EditorView,
  HighlightStyle,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentOnInput,
  indentUnit,
  isolateHistory,
  keymap,
  lineNumbers,
  MSSQL,
  placeholder,
  search,
  searchKeymap,
  syntaxHighlighting,
  tags,
  Transaction,
  keywordCompletionSource,
  pickedCompletion,
  startCompletion,
  Prec,
  syntaxTree,
  type Completion,
  type CompletionContext,
  type CompletionSource,
  type Extension
} from './vendor/codemirror.js'
import type { ObjectColumns, ObjectName } from '../src/protocol.ts'
import { nameContext, planCompletion, wordRest, type NameIndex } from '../src/shared/sql-names.ts'
import { scanStatement, WINDOW } from '../src/shared/sql-statement.ts'
import { icon } from './icons.ts'
import { keys } from './tooltip.ts'

export type { EditorView }

/** What the editor completes names from: the tab's database's names, and a way to get the columns
 *  and foreign keys of some of its objects (by `objectKey`; those it cannot get are left out). */
export type NameSource = { index: NameIndex; columns(objects: ObjectName[]): Promise<Map<string, ObjectColumns>> }

/** How long a completion waits for columns before showing what it has (the request goes on, and
 *  the next keystroke has them). */
const COLUMNS_WAIT_MS = 1500

const INDENT = '    '

/** Tab inserts four spaces at the cursor, or indents the selected lines; Shift+Tab outdents them.
 *  Escape then Tab (or Shift+Tab) moves focus out of the editor instead: CodeMirror's tab-focus
 *  mode, also toggled by Ctrl+M (⇧⌥M on a Mac). With text selected, the first Escape only clears
 *  the selection. In a read-only file Tab always moves focus. The README lists the keys. */
const tabKeys = keymap.of([
  {
    key: 'Tab',
    run: (view) => {
      if (view.state.readOnly) return false
      if (view.state.selection.ranges.some((r) => !r.empty)) return indentMore(view)
      view.dispatch(view.state.replaceSelection(INDENT), { scrollIntoView: true, userEvent: 'input.type' })
      return true
    },
    shift: indentLess
  }
])

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--sql-keyword)' },
  { tag: [tags.bool, tags.null], color: 'var(--sql-keyword)' },
  { tag: tags.typeName, color: 'var(--sql-type)' },
  { tag: tags.standard(tags.name), color: 'var(--sql-function)' },
  { tag: tags.special(tags.name), color: 'var(--sql-variable)' },
  { tag: tags.string, color: 'var(--sql-string)' },
  // "Quoted identifiers" are names, not strings.
  { tag: tags.special(tags.string), color: 'inherit' },
  { tag: tags.number, color: 'var(--sql-number)' },
  { tag: tags.comment, color: 'var(--sql-comment)', fontStyle: 'italic' }
])

/** The page's colours: CodeMirror's own defaults assume a light or dark theme, so every colour it
 *  shows is set here from the --orca-* variables (the --sql-* ones are in console.css). */
const theme = EditorView.theme({
  '&': { flex: '1 1 auto', minWidth: '0', height: '100%', fontSize: '13px', backgroundColor: 'var(--orca-background, Canvas)', color: 'var(--orca-foreground, CanvasText)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--orca-foreground, CanvasText)' },
  '.cm-line': { padding: '0 10px 0 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--orca-foreground, CanvasText)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-gutters': { backgroundColor: 'var(--orca-background, Canvas)', color: 'var(--muted)', borderColor: 'var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  // The current line only while the editor has focus: the tint would hide a selection made there.
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--sql-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': { backgroundColor: 'var(--sql-active-line)', color: 'var(--orca-foreground, CanvasText)' },
  '.cm-selectionBackground': { background: 'var(--sql-selection-blur)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: 'var(--sql-selection)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--sql-bracket)', color: 'inherit' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--orca-destructive)' },
  '.cm-specialChar': { color: 'var(--orca-destructive)' },
  '.cm-searchMatch': { backgroundColor: 'var(--sql-search-match)', outline: '1px solid var(--sql-search-outline)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--sql-search-current)' },
  // The search panel (⌘F).
  '.cm-panels': { backgroundColor: 'var(--orca-card, Canvas)', color: 'var(--orca-foreground, CanvasText)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '4px 28px 4px 8px', fontSize: '12px', fontFamily: 'system-ui, -apple-system, sans-serif' },
  '.cm-panel.cm-search label': { fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '3px' },
  '.cm-panel.cm-search input[type=checkbox]': { minHeight: '0', margin: '0' },
  '.cm-textfield': {
    fontSize: '12px', padding: '2px 6px', minHeight: '24px', color: 'inherit',
    backgroundColor: 'var(--orca-input, transparent)', border: '1px solid var(--border)', borderRadius: 'var(--orca-radius, 6px)'
  },
  '.cm-textfield:focus-visible': { outline: '2px solid var(--orca-ring, Highlight)', outlineOffset: '-1px' },
  '.cm-button': {
    fontSize: '12px', padding: '2px 8px', minHeight: '24px', backgroundImage: 'none',
    backgroundColor: 'var(--orca-secondary, transparent)', color: 'var(--orca-secondary-foreground, inherit)',
    border: '1px solid var(--border)', borderRadius: 'var(--orca-radius, 6px)'
  },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--orca-accent)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', minHeight: '0', padding: '0 4px', border: '0', background: 'transparent' },
  // The completion pop-up and its info tooltip.
  '.cm-tooltip': {
    backgroundColor: 'var(--orca-popover, Canvas)', color: 'var(--orca-popover-foreground, CanvasText)',
    border: '1px solid var(--border)', borderRadius: 'var(--orca-radius, 6px)', boxShadow: '0 4px 16px rgb(0 0 0 / 0.2)'
  },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '3px 0' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '17em', minWidth: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { display: 'flex', alignItems: 'center', padding: '1px 8px 1px 6px', lineHeight: '1.6' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--orca-accent)', color: 'var(--orca-accent-foreground, inherit)' },
  '&.cm-focused .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--sql-selection)', color: 'var(--orca-foreground, CanvasText)'
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--orca-primary, LinkText)' },
  '.cm-completionDetail': { marginLeft: 'auto', paddingLeft: '2em', fontStyle: 'normal', fontSize: '11px', color: 'var(--muted)', fontFamily: 'system-ui, -apple-system, sans-serif' },
  // Colours as in the explorer (console.css).
  '.cm-sqlIcon': { display: 'inline-flex', flex: 'none', width: '14px', height: '14px', marginRight: '6px' },
  '.cm-tooltip.cm-completionInfo': { padding: '4px 8px', fontSize: '12px', maxWidth: '400px' }
})

/** The current line up to the cursor (at most 300 characters): what `nameContext` reads. */
const textBefore = (context: CompletionContext) => {
  const line = context.state.doc.lineAt(context.pos)
  return context.state.sliceDoc(Math.max(line.from, context.pos - 300), context.pos)
}

/** The text before the cursor ends with the keyword ON (and maybe spaces). */
const AFTER_ON = /(?:^|[^\p{L}\p{N}_@#$\].])on\s*$/iu

/** Where completion does not go: strings and comments. */
const NOT_CODE = new Set(['String', 'LineComment', 'BlockComment'])

/** Object and column names from the tab's database (`names`, looked up when asked: a tab's target
 *  can change). Until they arrive, or when they cannot (no connection, a failed login), only
 *  keywords complete; until columns arrive, only names. */
function nameSource(names: () => Promise<NameSource | null>): CompletionSource {
  return async (context) => {
    if (NOT_CODE.has(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null
    const wanted = nameContext(textBefore(context))
    // With nothing typed, only right after ON (JOIN conditions), or when asked for.
    if (!wanted || (wanted.path.length === 0 && !wanted.word && !context.explicit && !AFTER_ON.test(context.state.sliceDoc(Math.max(0, context.pos - 40), context.pos)))) return null
    const source = await names()
    if (!source || context.aborted) return null
    // The statement around the cursor: its tables and aliases, and whether a column goes here.
    const start = Math.max(0, context.pos - WINDOW)
    const scan = wanted.path.length < 2 ? scanStatement(context.state.sliceDoc(start, context.pos + WINDOW), context.pos - start) : null
    const plan = planCompletion(source.index, wanted, scan, context.explicit)
    if (!plan) return null
    let columns = new Map<string, ObjectColumns>()
    if (plan.objects.length > 0) {
      const timeout = new Promise<Map<string, ObjectColumns>>((resolve) => setTimeout(() => resolve(new Map()), COLUMNS_WAIT_MS))
      columns = await Promise.race([source.columns(plan.objects), timeout])
      if (context.aborted) return null
    }
    const result = plan.complete(columns)
    if (!result) return null
    const from = context.pos - wanted.word.length
    return { from, options: result.options, validFor: result.validFor }
  }
}

const keywords = keywordCompletionSource(MSSQL, true, (label, type) => ({ label, type: type === 'variable' ? 'builtin' : type, boost: -1 }))

/** Keywords, types and built-in functions, in upper case, below names that match as well; not
 *  after `schema.` (lang-sql leaves them out only right after the dot). */
const keywordSource: CompletionSource = (context) => ((nameContext(textBefore(context))?.path.length ?? 0) > 0 ? null : keywords(context))

/** Accepting a completion in the middle of a word (`Cust|omer`) replaces the rest of the word too,
 *  and of a `[…]` or `"…"` name up to its closing delimiter. Not by extending the completion's
 *  range past the cursor: CodeMirror filters the options by the text in that range, and they
 *  should match what was typed before the cursor. */
const replaceWordRest = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(pickedCompletion) === undefined) return tr
  const removals: { from: number; to: number }[] = []
  tr.changes.iterChanges((_fromA, toA, _fromB, toB, inserted) => {
    const text = inserted.toString()
    const rest = wordRest(tr.startState.sliceDoc(toA, tr.startState.doc.lineAt(toA).to), text.startsWith('[') ? '[' : text.startsWith('"') ? '"' : null)
    if (rest > 0) removals.push({ from: toB, to: toB + rest })
  })
  return removals.length > 0 ? [tr, { changes: removals, sequential: true }] : tr
})

const ICONS: Record<string, string> = {
  table: 'table', view: 'view', procedure: 'procedure', function: 'function', builtin: 'function', synonym: 'synonym', schema: 'schema', column: 'column', key: 'key',
  join: 'join'
}

/** The explorer's icon for each kind of name (keywords get none). */
function renderIcon(completion: Completion): Node {
  const span = document.createElement('span')
  span.className = `cm-sqlIcon kind-${completion.type ?? ''}`
  const name = ICONS[completion.type ?? '']
  if (name) span.innerHTML = icon(name)
  return span
}

/** The completion pop-up: as you type, or ⌘I / Ctrl+I (also Ctrl+Space, and ⌥` on a Mac: macOS
 *  often takes Ctrl+Space for switching input sources). Enter or Tab accepts, Escape closes; Tab
 *  indents when the pop-up is not open. */
function completion(names: () => Promise<NameSource | null>): Extension {
  return [
    autocompletion({ override: [keywordSource, nameSource(names)], icons: false, addToOptions: [{ render: renderIcon, position: 20 }] }),
    replaceWordRest,
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }, { key: 'Mod-i', run: startCompletion, preventDefault: true }]))
  ]
}

/** Closes the completion pop-up, if open (a run started: ⌘↵ there runs, it does not accept). */
export function closeCompletionPopup(view: EditorView): void {
  closeCompletion(view)
}

/** ⌘↵ / Ctrl+Enter runs the query (the page's own keydown handler), so CodeMirror's binding for it
 *  (insert a blank line) is left out; so is Mod-i (select the parent syntax node), which opens
 *  completion here. */
const editorKeymap = defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter' && binding.key !== 'Mod-i')

function setup(readOnly: boolean, names: (() => Promise<NameSource | null>) | undefined): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    syntaxHighlighting(highlighting),
    bracketMatching(),
    highlightActiveLine(),
    search(),
    MSSQL.language,
    EditorState.tabSize.of(4),
    indentUnit.of(INDENT),
    EditorState.readOnly.of(readOnly),
    placeholder(`SELECT TOP 100 * FROM …   (${keys.run} to run)`),
    EditorView.contentAttributes.of({ 'aria-label': `SQL. ${keys.complete} shows completions; Escape then Tab moves focus out of the editor.` }),
    keymap.of([...editorKeymap, ...searchKeymap, ...historyKeymap]),
    tabKeys,
    readOnly || !names ? [] : completion(names),
    theme
  ]
}

/** An editor showing `text` in `parent` (hidden until shown). `onEdit` runs after each change that
 *  was not `replaceText` (typing, undo, the explorer's inserts, `replaceRange`). `names` gives the
 *  object names to complete (none in a read-only document). */
export function createEditor(
  parent: HTMLElement,
  text: string,
  readOnly: boolean,
  onEdit: () => void,
  names?: () => Promise<NameSource | null>
): EditorView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        setup(readOnly, names),
        EditorView.updateListener.of((update) => {
          if (update.transactions.some((tr) => tr.docChanged && !tr.annotation(Transaction.remote))) onEdit()
        })
      ]
    })
  })
  view.dom.hidden = true
  return view
}

/** The editor's text, with LF line endings (CodeMirror reads CRLF as line breaks and writes LF). */
export const editorText = (view: EditorView): string => view.state.doc.toString()

/** Takes a change made outside the editor (another program, git, a revert). Only the part that
 *  differs is replaced, so the selection and the undo history of the rest are kept. Not undoable,
 *  as a change on disk is not; does not call `onEdit`. */
export function replaceText(view: EditorView, text: string): void {
  const old = editorText(view)
  if (old === text) return
  let start = 0
  const max = Math.min(old.length, text.length)
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++
  let end = 0
  while (end < max - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++
  view.dispatch({
    changes: { from: start, to: old.length - end, insert: text.slice(start, text.length - end) },
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]
  })
}

/** Replaces [from, to) as its own undo step, keeping the selection (moved past the new text when it
 *  touches it), the scroll position and focus where they are. */
export function replaceRange(view: EditorView, from: number, to: number, insert: string): void {
  const { state } = view
  const changes = state.changes({ from, to, insert })
  // Lines added above the view push its content down: keep the same text in view, unless the
  // view is at the top, where the new text should show (the .sql header being written).
  const top = view.scrollDOM.scrollTop
  const atTop = top <= 0
  view.dispatch({
    changes,
    selection: state.selection.map(changes, 1),
    annotations: isolateHistory.of('full'),
    userEvent: 'input'
  })
  if (atTop) view.scrollDOM.scrollTop = 0
}

/** Inserts text at the cursor (replacing any selection) and focuses the editor; `ownLine` puts
 *  it on a line of its own. A name gets a space before it when it would run into the word before. */
export function insertAtCursor(view: EditorView, text: string, ownLine: boolean): void {
  const { state } = view
  const { from, to } = state.selection.main
  const before = state.doc.sliceString(from - 1, from)
  const after = state.doc.sliceString(to, to + 1)
  let insert = text
  if (!ownLine && /[\w\])'"]/.test(before)) insert = ` ${insert}`
  if (ownLine) {
    if (from > 0 && before !== '\n') insert = `\n${insert}`
    if (to < state.doc.length && after !== '\n') insert = `${insert}\n`
  }
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input.paste'
  })
  view.focus()
}

/** Selects a 1-based line (an error's line link), scrolls to it and focuses the editor. */
export function selectLine(view: EditorView, line: number): void {
  const { doc } = view.state
  const { from, to } = doc.line(Math.max(1, Math.min(line, doc.lines)))
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
  view.focus()
}

/** The text to run: the selection, else everything; `firstLine` is the 1-based line it starts on. */
export function runnableText(view: EditorView): { sql: string; firstLine: number } {
  const { doc, selection } = view.state
  const { from, to, empty } = selection.main
  return empty ? { sql: doc.toString(), firstLine: 1 } : { sql: doc.sliceString(from, to), firstLine: doc.lineAt(from).number }
}
