// A text input with a list of suggestions drawn under it (a native <datalist> pops up in the wrong
// place in Orca's frames, unstyled). Any text is accepted; the suggestions only help.
// Focus shows every suggestion, typing filters them. ↓/↑ move, Enter or Tab picks, Escape closes
// the list (a second one closes the dialog).

import { icon } from './icons.ts'

let next = 0

export class Combobox {
  private readonly input: HTMLInputElement
  private readonly list: HTMLElement
  private options: string[] = []
  private shown: string[] = []
  private active = -1

  constructor(input: HTMLInputElement) {
    this.input = input
    this.list = document.createElement('div')
    this.list.id = `combo-${++next}`
    this.list.className = 'combo-list'
    this.list.setAttribute('role', 'listbox')
    this.list.hidden = true
    // In the dialog (the top layer), placed with fixed coordinates so its overflow cannot clip it.
    ;(input.closest('dialog') ?? document.body).append(this.list)
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-controls', this.list.id)
    input.setAttribute('aria-expanded', 'false')
    input.autocomplete = 'off'
    input.addEventListener('focus', () => this.update(false))
    input.addEventListener('click', () => this.list.hidden && this.update(false))
    input.addEventListener('input', () => this.update(true))
    input.addEventListener('blur', () => this.close())
    input.addEventListener('keydown', (event) => this.onKeyDown(event))
    this.list.addEventListener('mousedown', (event) => {
      event.preventDefault() // keep the focus in the input
      const row = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]')
      if (row) this.pick(Number(row.dataset.index))
    })
    window.addEventListener('resize', () => this.close())
  }

  setOptions(options: string[]): void {
    this.options = options
    this.close()
  }

  /** Shows every option (the current one active), or, once something is typed, those matching it. */
  private update(filter: boolean): void {
    const value = this.input.value
    const query = filter ? value.trim().toLowerCase() : ''
    const shown = this.options.filter((o) => o.toLowerCase().includes(query))
    if (shown.length === 0) return this.close()
    this.shown = shown
    this.active = -1
    this.list.replaceChildren(
      ...shown.map((option, i) => {
        const row = document.createElement('div')
        row.id = `${this.list.id}-${i}`
        row.className = 'combo-option'
        row.dataset.index = String(i)
        row.title = option
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', 'false')
        const glyph = document.createElement('span')
        glyph.className = 'combo-icon'
        glyph.innerHTML = icon('group')
        const label = document.createElement('span')
        label.className = 'combo-label'
        if (!filter) {
          // A tree: each folder's last segment, indented under its parent (options come in tree order).
          const segments = option.split('/')
          row.style.paddingLeft = `${10 + (segments.length - 1) * 14}px`
          label.textContent = segments[segments.length - 1]
        } else {
          const at = query ? option.toLowerCase().indexOf(query) : -1
          if (at === -1) label.textContent = option
          else {
            const mark = document.createElement('mark')
            mark.textContent = option.slice(at, at + query.length)
            label.append(option.slice(0, at), mark, option.slice(at + query.length))
          }
        }
        row.append(glyph, label)
        if (option === value.trim()) {
          row.setAttribute('aria-current', 'true')
          const check = document.createElement('span')
          check.className = 'combo-check'
          check.innerHTML = icon('check')
          row.append(check)
        }
        return row
      })
    )
    const box = this.input.getBoundingClientRect()
    this.list.style.left = `${box.left}px`
    this.list.style.top = `${box.bottom + 2}px`
    this.list.style.width = `${box.width}px`
    this.list.hidden = false
    this.input.setAttribute('aria-expanded', 'true')
    this.input.removeAttribute('aria-activedescendant')
    const current = filter ? -1 : shown.indexOf(value.trim())
    if (current !== -1) this.setActive(current)
  }

  private close(): void {
    this.list.hidden = true
    this.shown = []
    this.active = -1
    this.input.setAttribute('aria-expanded', 'false')
    this.input.removeAttribute('aria-activedescendant')
  }

  private setActive(index: number): void {
    this.active = index
    this.list.querySelectorAll<HTMLElement>('.combo-option').forEach((row, i) => {
      row.classList.toggle('active', i === index)
      row.setAttribute('aria-selected', String(i === index))
      if (i === index) row.scrollIntoView({ block: 'nearest' })
    })
    this.input.setAttribute('aria-activedescendant', `${this.list.id}-${index}`)
  }

  private pick(index: number): void {
    this.input.value = this.shown[index]
    this.input.setSelectionRange(this.input.value.length, this.input.value.length)
    this.close()
  }

  private onKeyDown(event: KeyboardEvent): void {
    const open = !this.list.hidden
    switch (event.key) {
      case 'ArrowDown':
        if (!open) this.update(false)
        if (this.shown.length) this.setActive(Math.min(this.active + 1, this.shown.length - 1))
        break
      case 'ArrowUp':
        if (!open) return
        this.setActive(Math.max(this.active - 1, 0))
        break
      case 'Enter':
      case 'Tab':
        if (!open || this.active === -1) return
        // Picking the value already there changes nothing: let the key submit or move on.
        if (this.shown[this.active] === this.input.value) return this.close()
        this.pick(this.active)
        break
      case 'Escape':
        // Not the dialog's Escape: that closes it.
        if (!open) return
        this.close()
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }
}
