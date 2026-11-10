// What the console page (editor/sql-editor.ts) uses from CodeMirror 6, re-exported for one bundle.
// `npm run build:editor` bundles this into editor/vendor/codemirror.js: the page runs in a sandboxed
// frame where bare imports (`from '@codemirror/view'`) cannot load. editor/vendor/codemirror.d.ts
// re-exports this file's types for tsc. Add an export here, then rebuild, to use more of CodeMirror.
export { EditorSelection, EditorState, Prec, Transaction, type Extension } from '@codemirror/state'
export {
  EditorView,
  type ViewUpdate,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  placeholder
} from '@codemirror/view'
// undo and redo are for scripts that drive the page (headless Chrome cannot send ⌘Z to it); the
// history keymap includes them anyway, so they add nothing to the bundle.
export { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory, undo, redo } from '@codemirror/commands'
export { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language'
// closeCompletion, startCompletion, completionStatus and pickedCompletion are in the bundle anyway (the completion
// keymap, the pop-up).
export {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
export { keywordCompletionSource, MSSQL } from '@codemirror/lang-sql'
export { search, searchKeymap } from '@codemirror/search'
export { tags } from '@lezer/highlight'
