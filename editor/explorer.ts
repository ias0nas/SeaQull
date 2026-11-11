// The console's object explorer: connection folders → saved connections → databases → schemas
// → objects → columns, loaded lazily from the worker (tree.children). Plain DOM, keyboard driven
// like a native tree: ↑/↓ move, →/← expand/collapse, Enter inserts the name (or toggles a
// container), Shift+F10 or right-click opens the node's menu.
import type { TreeNode, TreeNodeKind } from '../src/protocol.ts'
import { folderSegments } from '../src/shared/folders.ts'
import { decodeKey, encodeKey, isTableLike, sqlName, type TreePath } from '../src/shared/tree-keys.ts'
import { icon } from './icons.ts'
import { showMenu, type MenuItem } from './menu.ts'

export type ExplorerActions = {
  /** Children of a node; '' lists the top-level folders and connections. `byUser`: the person
   *  opened or refreshed it (a reload or an automatic expand is not). */
  load(key: string, byUser: boolean): Promise<TreeNode[]>
  use(connectionId: string, database: string): void
  insert(text: string, ownLine?: boolean): void
  copy(text: string): void
  selectTop(path: TreePath): void
  /** Workbooks: a new tab on this connection and database (absent for a plain .sql console). */
  newTab?(connectionId: string, database: string): void
  /** The connection's colour, if it has one. */
  colorOf(connectionId: string): string | undefined
  /** A node was refreshed: what is cached about its connection (or database) is out of date. */
  refreshed?(connectionId: string, database?: string): void
  /** `folder`: the folder to put it in. */
  newConnection(folder?: string): void
  editConnection(connectionId: string): void
  deleteConnection(connectionId: string): void
  renameFolder(folder: string): void
  /** The connection's folder, if it has one. */
  folderOf(connectionId: string): string | undefined
}

type Row = { node: TreeNode; depth: number; parent: string }

const NAMED: ReadonlySet<TreeNodeKind> = new Set(['database', 'schema', 'table', 'view', 'procedure', 'function', 'column'])

export class Explorer {
  private readonly root: HTMLElement
  private readonly actions: ExplorerActions
  private readonly children = new Map<string, TreeNode[]>()
  private readonly expanded = new Set<string>()
  private readonly loading = new Set<string>()
  private readonly autoExpanded = new Set<string>()
  private rows: Row[] = []
  private focused = ''
  private current = { connectionId: '', database: '' }

  constructor(root: HTMLElement, actions: ExplorerActions) {
    this.root = root
    this.actions = actions
    root.setAttribute('role', 'tree')
    root.tabIndex = 0
    root.addEventListener('click', (event) => this.onClick(event))
    root.addEventListener('dblclick', (event) => this.onDoubleClick(event))
    root.addEventListener('contextmenu', (event) => this.onContextMenu(event))
    root.addEventListener('keydown', (event) => this.onKeyDown(event))
    root.addEventListener('focus', () => {
      if (!this.focused && this.rows[0]) this.focus(this.rows[0].node.key)
    })
  }

  /** Highlights the console's connection and database; expands the connection (and opens its
   *  folders) the first time. */
  setCurrent(connectionId: string, database: string): void {
    this.current = { connectionId, database }
    const key = connectionId && this.children.has('') ? this.connectionKey(connectionId) : ''
    if (key && !this.autoExpanded.has(key)) {
      // Once per connection: collapsing it afterwards sticks.
      this.autoExpanded.add(key)
      if (!this.expanded.has(key)) {
        void this.openFolders(key).then((found) => {
          if (found) void this.toggle(key, true, false)
        })
        return
      }
    }
    this.render()
  }

  /** The folder of the selected folder or connection, if any. */
  selectedFolder(): string | undefined {
    return decodeKey(this.focused).group?.join('/')
  }

  /** Keeps a renamed folder's open levels and selection, and opens the folders it is in now. */
  folderRenamed(from: string, to: string): void {
    const before = encodeKey({ group: folderSegments(from) })
    const segments = folderSegments(to)
    const after = encodeKey({ group: segments })
    const move = (key: string) => (key === before || key.startsWith(`${before}/`) ? after + key.slice(before.length) : key)
    for (const set of [this.expanded, this.autoExpanded]) {
      const keys = [...set]
      set.clear()
      for (const key of keys) set.add(move(key))
    }
    this.focused = move(this.focused)
    for (let i = 1; i < segments.length; i++) this.expanded.add(encodeKey({ group: segments.slice(0, i) }))
  }

  /** Reloads the connections and every open level (connections were added, edited or removed). */
  async reload(): Promise<void> {
    this.children.clear()
    await this.fetch('')
    // Parents first, so each level is reachable when its children load.
    const open = [...this.expanded].sort((a, b) => a.split('/').length - b.split('/').length)
    for (const key of open) if (this.isReachable(key)) await this.fetch(key)
    this.setCurrent(this.current.connectionId, this.current.database)
  }

  /** Reloads one node's children and every open level under it. */
  async refresh(key: string): Promise<void> {
    const path = decodeKey(key)
    if (path.connection) this.actions.refreshed?.(path.connection, path.database)
    for (const k of [...this.children.keys()]) if (k === key || k.startsWith(`${key}/`)) this.children.delete(k)
    await this.fetch(key, true)
    const open = [...this.expanded].filter((k) => k.startsWith(`${key}/`)).sort((a, b) => a.split('/').length - b.split('/').length)
    for (const k of open) if (this.isReachable(k)) await this.fetch(k, true)
  }

  /** Shows the active tab's connection and database in the tree. */
  async locate(): Promise<void> {
    const { connectionId, database } = this.current
    if (!connectionId) return
    if (!this.children.has('')) await this.fetch('')
    const connectionKey = this.connectionKey(connectionId)
    if (!(await this.openFolders(connectionKey))) return
    if (!this.expanded.has(connectionKey)) await this.toggle(connectionKey, true)
    const databaseKey = database ? this.children.get(connectionKey)?.find((n) => decodeKey(n.key).database === database)?.key : undefined
    this.focus(databaseKey ?? connectionKey)
    this.root.focus({ preventScroll: true })
  }

  /**
   * Opens the tree down to `path` and selects the deepest node of it that exists (loading levels
   * as needed; one that fails shows its error row, as when opened by hand), with keyboard focus in
   * the tree. Only ever opens nodes. A level cut short ("… more (not shown)") without the node
   * stops at its parent. `fold` compares names as the database does.
   */
  async reveal(path: TreePath, fold: (name: string) => string): Promise<void> {
    const order: (keyof TreePath)[] = ['connection', 'database', 'schema', 'folder', 'object', 'column']
    const levels: TreePath[] = []
    let so: TreePath = {}
    for (const field of order) {
      if (path[field] === undefined) break
      so = { ...so, [field]: path[field], ...(field === 'object' ? { objectKind: path.objectKind } : {}) }
      levels.push(so)
    }
    const lower = (name: string) => name.toLowerCase()
    const same = (node: TreePath, level: TreePath) =>
      node.connection === level.connection &&
      (level.database === undefined || (node.database !== undefined && lower(node.database) === lower(level.database))) &&
      (level.schema === undefined || (node.schema !== undefined && fold(node.schema) === fold(level.schema))) &&
      (level.folder === undefined || node.folder === level.folder) &&
      (level.object === undefined || (node.object !== undefined && node.objectKind === level.objectKind && fold(node.object) === fold(level.object))) &&
      (level.column === undefined || (node.column !== undefined && fold(node.column) === fold(level.column)))
    if (!this.children.has('')) await this.fetch('')
    let parent = ''
    let deepest = ''
    if (path.connection !== undefined) {
      const key = this.connectionKey(path.connection)
      if (await this.openFolders(key)) parent = key.slice(0, Math.max(0, key.lastIndexOf('/')))
    }
    for (const level of levels) {
      if (parent) {
        this.expanded.add(parent)
        if (!this.children.has(parent) && !this.loading.has(parent)) await this.fetch(parent, true)
      }
      const node = (this.children.get(parent) ?? []).find((n) => n.kind !== 'error' && n.kind !== 'more' && same(decodeKey(n.key), level))
      if (!node) break
      deepest = parent = node.key
    }
    if (!deepest) return this.locate()
    this.render()
    this.focus(deepest)
    this.root.focus({ preventScroll: true })
  }

  /** Where a connection is in the tree, from its folder. */
  private connectionKey(connectionId: string): string {
    return encodeKey({ group: folderSegments(this.actions.folderOf(connectionId)), connection: connectionId })
  }

  /** Opens (loading as needed) the folders holding `key`; false when one of them is not there. */
  private async openFolders(key: string): Promise<boolean> {
    const parts = key.split('/')
    let parent = ''
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/')
      if (!(this.children.get(parent) ?? []).some((n) => n.key === folder)) return false
      this.expanded.add(folder)
      if (!this.children.has(folder) && !this.loading.has(folder)) await this.fetch(folder)
      parent = folder
    }
    this.render()
    return (this.children.get(parent) ?? []).some((n) => n.key === key)
  }

  collapseAll(): void {
    this.expanded.clear()
    this.render()
  }

  // --- Loading and rendering --------------------------------------------------------------------

  private async fetch(key: string, byUser = false): Promise<void> {
    this.loading.add(key)
    this.render()
    try {
      this.children.set(key, await this.actions.load(key, byUser))
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      this.children.set(key, [{ key: `${key}/error:`, label: text, kind: 'error', hasChildren: false }])
    } finally {
      this.loading.delete(key)
      this.render()
    }
  }

  /** Whether every ancestor of `key` is loaded and open, so it is shown. */
  private isReachable(key: string): boolean {
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (!this.expanded.has(ancestor) || !this.children.has(ancestor)) return false
    }
    return this.children.has('') && (this.children.get('') ?? []).some((n) => n.key === parts[0])
  }

  private async toggle(key: string, open = !this.expanded.has(key), byUser = true): Promise<void> {
    const row = this.rows.find((r) => r.node.key === key)
    if (row && !row.node.hasChildren) return
    if (open) this.expanded.add(key)
    else this.expanded.delete(key)
    if (open && !this.children.has(key) && !this.loading.has(key)) await this.fetch(key, byUser)
    else this.render()
  }

  private flatten(): Row[] {
    const rows: Row[] = []
    const walk = (parent: string, depth: number) => {
      for (const node of this.children.get(parent) ?? []) {
        rows.push({ node, depth, parent })
        if (node.hasChildren && this.expanded.has(node.key)) {
          if (this.children.has(node.key)) walk(node.key, depth + 1)
          else rows.push({ node: { key: `${node.key}/loading:`, label: 'Loading…', kind: 'more', hasChildren: false }, depth: depth + 1, parent: node.key })
        }
      }
    }
    walk('', 0)
    return rows
  }

  private render(): void {
    this.rows = this.flatten()
    if (this.focused && !this.rows.some((r) => r.node.key === this.focused)) this.focused = ''
    const hadFocus = document.activeElement === this.root
    const fragment = document.createDocumentFragment()
    this.rows.forEach(({ node, depth }, index) => {
      const row = document.createElement('div')
      row.id = `tree-row-${index}`
      row.className = `tree-row kind-${node.kind}`
      row.dataset.key = node.key
      row.setAttribute('role', 'treeitem')
      row.setAttribute('aria-level', String(depth + 1))
      row.setAttribute('aria-selected', String(node.key === this.focused))
      row.style.paddingLeft = `${4 + depth * 14}px`
      if (node.hasChildren) row.setAttribute('aria-expanded', String(this.expanded.has(node.key)))
      if (this.isCurrent(node)) row.classList.add('current')
      const color = this.actions.colorOf(this.connectionOf(node.key) ?? '')
      if (color) {
        row.style.setProperty('--conn', color)
        if (node.kind === 'connection') row.classList.add('colored')
      }

      const twisty = document.createElement('span')
      twisty.className = 'twisty'
      if (node.hasChildren) {
        const busy = this.loading.has(node.key)
        twisty.innerHTML = icon(busy ? 'spinner' : 'chevron')
        twisty.classList.toggle('busy', busy)
      }
      const primaryKey = node.kind === 'column' && /\bPK\b/.test(node.description ?? '')
      if (primaryKey) row.classList.add('pk')
      const glyph = document.createElement('span')
      glyph.className = 'glyph'
      glyph.innerHTML = icon(primaryKey ? 'key' : node.kind)
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = node.label
      row.append(twisty, glyph, label)
      if (node.description) {
        const description = document.createElement('span')
        description.className = 'description'
        description.textContent = node.description
        row.append(description)
      }

      row.title = node.description ? `${node.label}  ${node.description}` : node.label
      fragment.append(row)
    })
    if (this.children.get('')?.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tree-empty'
      empty.textContent = 'No connections yet.'
      const add = document.createElement('button')
      add.textContent = 'Add a connection'
      add.onclick = () => this.actions.newConnection()
      empty.append(document.createElement('br'), add)
      fragment.append(empty)
    }
    this.root.replaceChildren(fragment)
    const index = this.rows.findIndex((r) => r.node.key === this.focused)
    if (index === -1) this.root.removeAttribute('aria-activedescendant')
    else this.root.setAttribute('aria-activedescendant', `tree-row-${index}`)
    if (hadFocus) this.root.focus({ preventScroll: true })
  }

  private isCurrent(node: TreeNode): boolean {
    if (!this.current.connectionId || this.connectionOf(node.key) !== this.current.connectionId) return false
    if (node.kind === 'connection') return true
    return node.kind === 'database' && decodeKey(node.key).database === this.current.database
  }

  private connectionOf(key: string): string | undefined {
    return decodeKey(key).connection
  }

  /** Moves the focus without rebuilding the rows (a rebuild between two clicks loses the double-click). */
  private focus(key: string): void {
    this.focused = key
    let active: HTMLElement | undefined
    this.root.querySelectorAll<HTMLElement>('.tree-row').forEach((row) => {
      const on = row.dataset.key === key
      row.setAttribute('aria-selected', String(on))
      if (on) active = row
    })
    if (active) {
      this.root.setAttribute('aria-activedescendant', active.id)
      active.scrollIntoView({ block: 'nearest' })
    } else this.root.removeAttribute('aria-activedescendant')
  }

  // --- Interaction ------------------------------------------------------------------------------

  private rowAt(event: Event): Row | undefined {
    const key = (event.target as HTMLElement).closest<HTMLElement>('.tree-row')?.dataset.key
    return this.rows.find((r) => r.node.key === key)
  }

  private onClick(event: MouseEvent): void {
    const row = this.rowAt(event)
    if (!row) return
    this.focus(row.node.key)
    this.root.focus({ preventScroll: true })
    if ((event.target as HTMLElement).closest('.twisty')) void this.toggle(row.node.key)
  }

  private onDoubleClick(event: MouseEvent): void {
    const row = this.rowAt(event)
    if (row && !(event.target as HTMLElement).closest('.twisty')) this.activate(row.node)
  }

  /** Enter or double-click: insert a named object's name; open or close anything else. */
  private activate(node: TreeNode): void {
    if (node.kind === 'error') return void this.refresh(this.parentOf(node.key))
    const insertable = NAMED.has(node.kind) && node.kind !== 'database' && node.kind !== 'schema'
    if (insertable) return this.insertName(node)
    if (node.hasChildren) void this.toggle(node.key)
  }

  private insertName(node: TreeNode): void {
    const name = sqlName(decodeKey(node.key), this.current.connectionId === this.connectionOf(node.key) ? this.current.database : undefined)
    if (name) this.actions.insert(name)
  }

  private parentOf(key: string): string {
    return this.rows.find((r) => r.node.key === key)?.parent ?? ''
  }

  private onContextMenu(event: MouseEvent): void {
    const row = this.rowAt(event)
    event.preventDefault()
    if (row) this.focus(row.node.key)
    this.openMenu(row?.node, event.clientX, event.clientY)
  }

  private openMenu(node: TreeNode | undefined, x: number, y: number): void {
    const items = node ? this.menuFor(node) : [{ label: 'New connection…', run: () => this.actions.newConnection() }]
    showMenu(items, x, y, () => this.root.focus({ preventScroll: true }))
  }

  private menuFor(node: TreeNode): MenuItem[] {
    const path = decodeKey(node.key)
    const connectionId = path.connection ?? ''
    const items: MenuItem[] = []
    const folder = path.group?.join('/')
    if (node.kind === 'group' && folder) {
      items.push(
        { label: 'New connection in this folder…', run: () => this.actions.newConnection(folder) },
        { label: 'Rename folder…', run: () => this.actions.renameFolder(folder) }
      )
    }
    const name = sqlName(path, this.current.connectionId === connectionId ? this.current.database : undefined)
    if (node.kind === 'connection' || node.kind === 'database') {
      const database = path.database ?? ''
      if (this.actions.newTab) items.push({ label: 'New query tab', run: () => this.actions.newTab!(connectionId, database) })
      items.push({ label: this.actions.newTab ? 'Use in this tab' : 'Use in this console', run: () => this.actions.use(connectionId, database) })
    }
    if (isTableLike(path)) {
      items.push(
        { label: 'Select top 100 rows', run: () => this.actions.selectTop(path) },
        { label: 'Insert SELECT statement', run: () => this.actions.insert(`SELECT TOP (100) *\nFROM ${name};`, true) }
      )
    }
    if (path.objectKind === 'p' && path.column === undefined) items.push({ label: 'Insert EXEC statement', run: () => this.actions.insert(`EXEC ${name};`, true) })
    if (name && node.kind !== 'connection' && node.kind !== 'database') items.push({ label: 'Insert name', run: () => this.actions.insert(name) })
    if (name && NAMED.has(node.kind)) items.push({ label: 'Copy name', run: () => this.actions.copy(name) })
    if (node.hasChildren) items.push({ separator: true }, { label: 'Refresh', run: () => void this.refresh(node.key) })
    if (node.kind === 'error') items.push({ label: 'Retry', run: () => void this.refresh(this.parentOf(node.key)) })
    if (node.kind === 'connection') {
      items.push(
        { separator: true },
        { label: 'Edit connection…', run: () => this.actions.editConnection(connectionId) },
        { label: 'Delete connection…', danger: true, run: () => this.actions.deleteConnection(connectionId) },
        { separator: true },
        { label: folder ? 'New connection in this folder…' : 'New connection…', run: () => this.actions.newConnection(folder) }
      )
    }
    return items.filter((item, i, all) => !('separator' in item) || (i > 0 && i < all.length - 1 && !('separator' in all[i - 1])))
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const index = this.rows.findIndex((r) => r.node.key === this.focused)
    const row = this.rows[index]
    const go = (i: number) => this.rows[i] && this.focus(this.rows[i].node.key)
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown':
          return go(index + 1), true
        case 'ArrowUp':
          return go(Math.max(0, index - 1)), true
        case 'Home':
          return go(0), true
        case 'End':
          return go(this.rows.length - 1), true
        case 'ArrowRight':
          if (!row?.node.hasChildren) return true
          if (!this.expanded.has(row.node.key)) void this.toggle(row.node.key, true)
          else go(index + 1)
          return true
        case 'ArrowLeft':
          if (!row) return true
          if (row.node.hasChildren && this.expanded.has(row.node.key)) void this.toggle(row.node.key, false)
          else if (row.parent) this.focus(row.parent)
          return true
        case 'Enter':
          if (row) this.activate(row.node)
          return true
        case 'F10':
        case 'ContextMenu': {
          if (event.key === 'F10' && !event.shiftKey) return false
          const box = this.root.querySelector<HTMLElement>('[aria-selected="true"]')?.getBoundingClientRect()
          this.openMenu(row?.node, box ? box.left + 24 : 24, box ? box.bottom : 24)
          return true
        }
        default:
          return false
      }
    })()
    if (handled) event.preventDefault()
  }
}
