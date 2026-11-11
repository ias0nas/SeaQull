// Virtual-scrolling result grid: draws only the rows in view and fetches rows from the worker in
// pages as they scroll in. Plain DOM, no framework.
//
// Selection works like a spreadsheet: click a cell, shift-click or drag for a range, click a column
// header or row number for whole columns or rows (drag or shift-click to extend), the corner for
// everything. Arrows move, Shift+arrows extend, ⌘/Ctrl+arrows jump to the edge, ⌘/Ctrl+A selects
// all, Escape collapses the range (and clears a single cell). ⌘/Ctrl+C copies the selection with
// or without headers as the console's "Headers" box says, ⇧⌘/Ctrl+Shift+C the other way;
// right-click for more formats.
import type { Cell, CellRange, ColumnInfo, ExportFormat, ValueCut } from '../src/protocol.ts'
import { NUMERIC_TYPES } from '../src/shared/export.ts'
import { showMenu, type MenuItem } from './menu.ts'
import { keys } from './tooltip.ts'

const ROW_HEIGHT = 24
const HEADER_HEIGHT = ROW_HEIGHT + 1
const PAGE = 200
/** The worker answers at most this many rows per request. */
const MAX_FETCH = 2000
const OVERSCAN = 20

/** Rows from `offset`, and which values arrived cut short. */
export type FetchRows = (offset: number, limit: number) => Promise<{ rows: Cell[][]; cut: ValueCut[] }>
/** `default`: TSV, headers as the "Headers" box says (a single cell as its raw text); `inverse`:
 *  the same with headers the other way; a format: that format, headers as the setting says. */
export type CopyKind = 'default' | 'inverse' | ExportFormat
export type Range = CellRange
type Point = { r: number; c: number }
type DragMode = 'cells' | 'rows' | 'columns'

export type GridOptions = {
  columns: ColumnInfo[]
  rowCount: number
  fetchRows: FetchRows
  /** Asked from a key press or menu click, so the clipboard is still writable for a moment. */
  onCopy: (kind: CopyKind) => void
  onSelectionChange?: (range: Range | null) => void
  /** Whether copies include headers unless inverted (the "Headers" box). */
  headers: () => boolean
}

export class Grid {
  private readonly root: HTMLElement
  private readonly columns: ColumnInfo[]
  private readonly rowCount: number
  private readonly fetchRows: FetchRows
  private readonly options: GridOptions
  private readonly rows = new Map<number, Cell[]>()
  /** By row, then column: each value that arrived cut short, its whole length and what the worker kept. */
  private readonly cut = new Map<number, Map<number, { length: number; kept?: number }>>()
  private readonly pending = new Set<number>()
  private widths: number[] = []
  /** Left edge of each column in content coordinates (after the row-number column). */
  private lefts: number[] = []
  private body!: HTMLElement
  private headerCells: HTMLElement[] = []
  private frame = 0
  private disposed = false
  private anchor: Point | null = null
  private focusPoint: Point | null = null
  private drag: { mode: DragMode; x: number; y: number; timer: number } | null = null
  private readonly listeners: [EventTarget, string, EventListener][] = []

  constructor(root: HTMLElement, options: GridOptions) {
    this.root = root
    this.options = options
    this.columns = options.columns
    this.rowCount = options.rowCount
    this.fetchRows = options.fetchRows
    this.root.replaceChildren()
    this.root.scrollTop = 0
    this.root.scrollLeft = 0
    this.root.tabIndex = 0
    this.listen(root, 'scroll', () => this.schedule())
    this.listen(root, 'mousedown', (e) => this.onMouseDown(e as MouseEvent))
    this.listen(root, 'contextmenu', (e) => this.onContextMenu(e as MouseEvent))
    this.listen(root, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent))
    this.listen(document, 'mousemove', (e) => this.onMouseMove(e as MouseEvent))
    this.listen(document, 'mouseup', () => this.endDrag())
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler)
    this.listeners.push([target, type, handler])
  }

  async mount(): Promise<void> {
    await this.ensure(0)
    if (this.disposed) return
    this.widths = this.measure()
    let left = this.rowNumWidth()
    this.lefts = this.widths.map((w) => {
      const start = left
      left += w
      return start
    })
    const header = el('div', 'grid-header')
    const corner = cell('#', 'hcell rownum corner', this.rowNumWidth())
    corner.title = `Select all (${keys.selectAll})`
    header.append(corner)
    this.headerCells = this.columns.map((c, i) => {
      const h = cell(c.name || '(no name)', 'hcell', this.widths[i])
      h.dataset.c = String(i)
      const type = document.createElement('small')
      type.textContent = c.type
      h.append(type)
      h.title = `${c.name} ${c.type}\nClick to select the column; drag, or shift-click another column, to select several`
      header.append(h)
      return h
    })
    this.body = el('div', 'grid-body')
    this.body.style.height = `${this.rowCount * ROW_HEIGHT}px`
    this.root.append(header, this.body)
    this.render()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.endDrag()
    for (const [target, type, handler] of this.listeners) target.removeEventListener(type, handler)
  }

  focus(): void {
    this.root.focus({ preventScroll: true })
  }

  // --- Selection --------------------------------------------------------------------------------

  selection(): Range | null {
    if (!this.anchor || !this.focusPoint) return null
    return {
      r0: Math.min(this.anchor.r, this.focusPoint.r),
      r1: Math.max(this.anchor.r, this.focusPoint.r),
      c0: Math.min(this.anchor.c, this.focusPoint.c),
      c1: Math.max(this.anchor.c, this.focusPoint.c)
    }
  }

  clearSelection(): void {
    this.anchor = this.focusPoint = null
    this.render()
    this.options.onSelectionChange?.(null)
  }

  selectAll(): void {
    if (this.rowCount === 0 || this.columns.length === 0) return
    this.select({ r: 0, c: 0 }, { r: this.rowCount - 1, c: this.columns.length - 1 }, false)
  }

  /** The selected columns and rows, fetching any rows not loaded yet. `cut`: some of their values
   *  arrived cut short, so the rows hold only the start of them. */
  async selectedData(): Promise<{ columns: ColumnInfo[]; rows: Cell[][]; range: Range; cut: boolean } | null> {
    const range = this.selection()
    if (!range) return null
    await this.load(range.r0, range.r1)
    if (this.disposed) return null // switched away mid-load: the rows would be incomplete
    const rows: Cell[][] = []
    let cut = false
    for (let r = range.r0; r <= range.r1; r++) {
      rows.push((this.rows.get(r) ?? []).slice(range.c0, range.c1 + 1))
      cut ||= [...(this.cut.get(r)?.keys() ?? [])].some((c) => c >= range.c0 && c <= range.c1)
    }
    return { columns: this.columns.slice(range.c0, range.c1 + 1), rows, range, cut }
  }

  private select(anchor: Point, focus: Point, reveal = true): void {
    const clamp = (p: Point): Point => ({
      r: Math.max(0, Math.min(this.rowCount - 1, p.r)),
      c: Math.max(0, Math.min(this.columns.length - 1, p.c))
    })
    this.anchor = clamp(anchor)
    this.focusPoint = clamp(focus)
    if (reveal) this.reveal(this.focusPoint)
    this.render()
    this.options.onSelectionChange?.(this.selection())
  }

  /** Scrolls so a cell is in view (below the sticky header, right of the row numbers). */
  private reveal({ r, c }: Point): void {
    const top = r * ROW_HEIGHT
    const viewHeight = this.root.clientHeight - HEADER_HEIGHT
    if (top < this.root.scrollTop) this.root.scrollTop = top
    else if (top + ROW_HEIGHT > this.root.scrollTop + viewHeight) this.root.scrollTop = top + ROW_HEIGHT - viewHeight
    const left = this.lefts[c] - this.rowNumWidth()
    const right = this.lefts[c] + this.widths[c]
    if (left < this.root.scrollLeft) this.root.scrollLeft = left
    else if (right > this.root.scrollLeft + this.root.clientWidth) this.root.scrollLeft = right - this.root.clientWidth
  }

  // --- Mouse ------------------------------------------------------------------------------------

  /** The cell under a point; `c: -1` is the row-number column. Clamped to the grid. */
  private pointAt(clientX: number, clientY: number): Point {
    const box = this.root.getBoundingClientRect()
    const r = Math.floor((clientY - box.top - HEADER_HEIGHT + this.root.scrollTop) / ROW_HEIGHT)
    const viewX = clientX - box.left
    let c = -1
    if (viewX >= this.rowNumWidth()) {
      const x = viewX + this.root.scrollLeft
      c = this.lefts.findIndex((left, i) => x >= left && x < left + this.widths[i])
      if (c === -1) c = x < (this.lefts[0] ?? 0) ? 0 : this.columns.length - 1
    }
    return { r: Math.max(0, Math.min(this.rowCount - 1, r)), c }
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button !== 0 || this.rowCount === 0) return
    const target = event.target as HTMLElement
    // The scrollbars and the empty area below the rows belong to the grid element itself.
    if (target === this.root || target === this.body) return
    const last = this.rowCount - 1
    const lastColumn = this.columns.length - 1
    event.preventDefault() // no text selection; the grid has its own
    this.focus()
    const shift = event.shiftKey && this.anchor
    if (target.closest('.corner')) return this.selectAll()
    const headerCell = target.closest<HTMLElement>('.hcell[data-c]')
    if (headerCell) {
      const c = Number(headerCell.dataset.c)
      this.select({ r: 0, c: shift ? this.anchor!.c : c }, { r: last, c }, false)
      return this.startDrag('columns', event)
    }
    if (target.closest('.grid-header') || !target.closest('.grid-body')) return
    const point = this.pointAt(event.clientX, event.clientY)
    if (point.c === -1) {
      this.select({ r: shift ? this.anchor!.r : point.r, c: 0 }, { r: point.r, c: lastColumn }, false)
      return this.startDrag('rows', event)
    }
    this.select(shift ? this.anchor! : point, point)
    this.startDrag('cells', event)
  }

  private startDrag(mode: DragMode, event: MouseEvent): void {
    this.drag = { mode, x: event.clientX, y: event.clientY, timer: 0 }
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.drag || !this.anchor) return
    this.drag.x = event.clientX
    this.drag.y = event.clientY
    this.dragTo()
    // Keep scrolling while the pointer is held past an edge.
    const box = this.root.getBoundingClientRect()
    // Over the sticky row numbers counts as past the left edge (unless selecting whole rows).
    const left = box.left + (this.drag.mode === 'rows' ? 0 : this.rowNumWidth())
    const outside = event.clientY < box.top + HEADER_HEIGHT || event.clientY > box.bottom || event.clientX < left || event.clientX > box.right
    if (outside && !this.drag.timer) this.drag.timer = window.setInterval(() => this.autoScroll(), 50)
    if (!outside && this.drag.timer) {
      clearInterval(this.drag.timer)
      this.drag.timer = 0
    }
  }

  private autoScroll(): void {
    if (!this.drag) return
    const box = this.root.getBoundingClientRect()
    const step = (distance: number) => Math.sign(distance) * Math.min(60, Math.ceil(Math.abs(distance) / 2) + 4)
    if (this.drag.mode !== 'columns') {
      if (this.drag.y > box.bottom) this.root.scrollTop += step(this.drag.y - box.bottom)
      else if (this.drag.y < box.top + HEADER_HEIGHT) this.root.scrollTop += step(this.drag.y - box.top - HEADER_HEIGHT)
    }
    if (this.drag.mode !== 'rows') {
      const left = box.left + this.rowNumWidth()
      if (this.drag.x > box.right) this.root.scrollLeft += step(this.drag.x - box.right)
      else if (this.drag.x < left) this.root.scrollLeft += step(this.drag.x - left)
    }
    this.dragTo()
  }

  private dragTo(): void {
    if (!this.drag || !this.anchor || !this.focusPoint) return
    const point = this.pointAt(this.drag.x, this.drag.y)
    // Over the row numbers: the leftmost column in view (auto-scroll brings in the rest).
    const column = point.c === -1 ? this.firstVisibleColumn() : point.c
    const next =
      this.drag.mode === 'rows'
        ? { r: point.r, c: this.columns.length - 1 }
        : this.drag.mode === 'columns'
          ? { r: this.rowCount - 1, c: column }
          : { r: point.r, c: column }
    if (next.r !== this.focusPoint.r || next.c !== this.focusPoint.c) this.select(this.anchor, next, false)
  }

  private firstVisibleColumn(): number {
    const edge = this.root.scrollLeft + this.rowNumWidth()
    const index = this.lefts.findIndex((left, i) => left + this.widths[i] > edge)
    return index === -1 ? 0 : index
  }

  private endDrag(): void {
    if (this.drag?.timer) clearInterval(this.drag.timer)
    this.drag = null
  }

  private onContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement
    if (!target.closest('.grid-body') && !target.closest('.grid-header')) return
    event.preventDefault()
    if (target.closest('.grid-body')) {
      const point = this.pointAt(event.clientX, event.clientY)
      const range = this.selection()
      const inside = range && point.r >= range.r0 && point.r <= range.r1 && (point.c === -1 || (point.c >= range.c0 && point.c <= range.c1))
      if (!inside) {
        if (point.c === -1) this.select({ r: point.r, c: 0 }, { r: point.r, c: this.columns.length - 1 }, false)
        else this.select(point, point, false)
      }
    }
    if (!this.selection()) return
    const copy = (kind: CopyKind) => () => this.options.onCopy(kind)
    const items: MenuItem[] = [
      { label: 'Copy', run: copy('default') },
      { label: this.options.headers() ? 'Copy without headers' : 'Copy with headers', run: copy('inverse') },
      { separator: true },
      { label: 'Copy as CSV', run: copy('csv') },
      { label: 'Copy as JSON', run: copy('json') },
      { label: 'Copy as Markdown', run: copy('markdown') },
      { label: 'Copy as SQL INSERT', run: copy('sql') },
      { separator: true },
      { label: 'Select all', run: () => this.selectAll() }
    ]
    showMenu(items, event.clientX, event.clientY, () => this.focus())
  }

  // --- Keyboard ---------------------------------------------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key
    if (mod && key.toLowerCase() === 'a') {
      event.preventDefault()
      return this.selectAll()
    }
    if (mod && key.toLowerCase() === 'c') {
      event.preventDefault()
      if (this.selection()) this.options.onCopy(event.shiftKey ? 'inverse' : 'default')
      return
    }
    if (!this.focusPoint || !this.anchor || event.altKey) return
    // As in a spreadsheet: Shift moves the far end of the range, plain keys move the active cell.
    const { r, c } = event.shiftKey ? this.focusPoint : this.anchor
    const page = Math.max(1, Math.floor((this.root.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT) - 1)
    const lastRow = this.rowCount - 1
    const lastColumn = this.columns.length - 1
    const moves: Record<string, Point> = {
      ArrowUp: { r: mod ? 0 : r - 1, c },
      ArrowDown: { r: mod ? lastRow : r + 1, c },
      ArrowLeft: { r, c: mod ? 0 : c - 1 },
      ArrowRight: { r, c: mod ? lastColumn : c + 1 },
      PageUp: { r: r - page, c },
      PageDown: { r: r + page, c },
      Home: mod ? { r: 0, c: 0 } : { r, c: 0 },
      End: mod ? { r: lastRow, c: lastColumn } : { r, c: lastColumn }
    }
    const next = moves[key]
    if (!next) {
      if (key === 'Escape') {
        const range = this.selection()!
        if (range.r0 === range.r1 && range.c0 === range.c1) this.clearSelection()
        else this.select(this.anchor, this.anchor)
      }
      return
    }
    event.preventDefault()
    this.select(event.shiftKey ? this.anchor : next, next)
  }

  // --- Rendering --------------------------------------------------------------------------------

  private rowNumWidth(): number {
    return Math.max(44, String(this.rowCount).length * 8 + 20)
  }

  /** Column widths from the header and the first page of values. */
  private measure(): number[] {
    const sample = [...this.rows.values()].slice(0, PAGE)
    return this.columns.map((c, i) => {
      let chars = Math.max(c.name.length, Math.ceil(c.type.length * 0.8) + 2)
      for (const row of sample) chars = Math.max(chars, Math.min(60, display(row[i]).length))
      return Math.round(Math.min(480, Math.max(64, chars * 7.4 + 18)))
    })
  }

  private schedule(): void {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.render())
  }

  private render(): void {
    if (this.disposed || !this.body) return
    const range = this.selection()
    const inRows = (r: number) => !!range && r >= range.r0 && r <= range.r1
    const inColumns = (c: number) => !!range && c >= range.c0 && c <= range.c1
    const wholeRows = !!range && range.c0 === 0 && range.c1 === this.columns.length - 1
    const wholeColumns = !!range && range.r0 === 0 && range.r1 === this.rowCount - 1
    // Headers and row numbers mark the selection's columns and rows; skip the side that is
    // selected end to end because of a whole-row or whole-column selection.
    const markColumns = !(wholeRows && !wholeColumns)
    const markRows = !(wholeColumns && !wholeRows)
    this.headerCells.forEach((h, c) => {
      h.classList.toggle('selected', markColumns && inColumns(c))
      h.classList.toggle('whole', wholeColumns && inColumns(c))
    })

    const top = this.root.scrollTop
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(this.rowCount, Math.ceil((top + this.root.clientHeight) / ROW_HEIGHT) + OVERSCAN)
    const fragment = document.createDocumentFragment()
    let missing = -1
    for (let r = first; r < last; r++) {
      const values = this.rows.get(r)
      if (!values && missing === -1) missing = r
      // Stripes by row number, not DOM position, so they do not flip while scrolling.
      const row = el('div', r % 2 ? 'grid-row odd' : 'grid-row')
      row.style.top = `${r * ROW_HEIGHT}px`
      const number = cell(String(r + 1), 'cell rownum', this.rowNumWidth())
      if (markRows && inRows(r)) number.classList.add(wholeRows ? 'whole' : 'selected')
      row.append(number)
      this.columns.forEach((c, i) => {
        if (!values) {
          row.append(cell(i === 0 ? '…' : '', 'cell loading', this.widths[i]))
          return
        }
        const value = values[i]
        const node = cell(display(value), `cell${value === null ? ' null' : NUMERIC_TYPES.has(c.baseType) ? ' num' : ''}`, this.widths[i])
        if (inRows(r) && inColumns(i)) node.classList.add('sel')
        if (this.anchor?.r === r && this.anchor.c === i) node.classList.add('active')
        const cut = this.cut.get(r)?.get(i)
        if (cut) node.title = `${value}\n\n${cutNote(cut.length, cut.kept)}`
        else if (typeof value === 'string' && (value.length > 40 || value.includes('\n'))) node.title = value
        row.append(node)
      })
      fragment.append(row)
    }
    this.body.replaceChildren(fragment)
    if (missing !== -1) void this.ensure(missing).then(() => this.schedule())
  }

  // --- Loading ----------------------------------------------------------------------------------

  /** Loads the page holding `index` (the worker may return fewer rows to stay under its size cap). */
  private async ensure(index: number): Promise<void> {
    const offset = index - (index % PAGE)
    if (this.rows.has(index) || this.pending.has(offset) || index >= this.rowCount) return
    this.pending.add(offset)
    try {
      await this.fill(offset, Math.min(offset + PAGE, this.rowCount))
    } finally {
      this.pending.delete(offset)
    }
  }

  /** Loads every missing row in [from, to] (inclusive), in large requests. */
  private async load(from: number, to: number): Promise<void> {
    let r = from
    while (r <= to && !this.disposed) {
      if (this.rows.has(r)) {
        r++
        continue
      }
      let end = r
      while (end < to && !this.rows.has(end + 1) && end - r + 1 < MAX_FETCH) end++
      await this.fill(r, end + 1)
      r = end + 1
    }
  }

  private async fill(from: number, to: number): Promise<void> {
    let at = from
    while (at < to && !this.disposed) {
      const { rows, cut } = await this.fetchRows(at, to - at)
      if (rows.length === 0) break
      for (const [i, c, length, kept] of cut) {
        if (!this.cut.has(at + i)) this.cut.set(at + i, new Map())
        this.cut.get(at + i)!.set(c, { length, kept })
      }
      rows.forEach((values, i) => this.rows.set(at + i, values))
      at += rows.length
    }
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function cell(text: string, className: string, width: number): HTMLElement {
  const node = el('div', className)
  node.style.width = `${width}px`
  node.textContent = text
  return node
}

const cutNote = (length: number, kept?: number) =>
  kept === undefined
    ? `${length.toLocaleString()} characters: copy or save to get all of them.`
    : `${length.toLocaleString()} characters, too many to keep: copies and saves have the first ${kept.toLocaleString()}.`

/** One line per cell: up to its first line break; the tooltip shows more. */
function display(value: Cell | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = String(value)
  const newline = text.search(/[\r\n]/)
  return newline === -1 ? text : `${text.slice(0, newline)} ⏎…`
}
