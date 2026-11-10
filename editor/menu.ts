// A context menu drawn in the page (plugin frames get no native menus or dialogs).
// ↑/↓ move, Enter runs, Escape or a click elsewhere closes.

export type MenuItem = { label: string; run: () => void; danger?: boolean } | { separator: true }

let close: (() => void) | null = null

export function showMenu(items: MenuItem[], x: number, y: number, onClose?: () => void): void {
  close?.()
  if (items.length === 0) return
  const menu = document.createElement('div')
  menu.className = 'menu'
  menu.setAttribute('role', 'menu')
  const buttons: HTMLButtonElement[] = []
  for (const item of items) {
    if ('separator' in item) {
      menu.append(Object.assign(document.createElement('div'), { className: 'menu-separator' }))
      continue
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = item.label
    if (item.danger) button.classList.add('danger')
    // Run inside the click: copying to the clipboard needs the user gesture.
    button.onclick = () => {
      dismiss(false)
      item.run()
      if (document.activeElement === document.body) onClose?.()
    }
    buttons.push(button)
    menu.append(button)
  }

  const onKey = (event: KeyboardEvent) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') dismiss(true)
    else if (event.key === 'ArrowDown') buttons[(at + 1) % buttons.length].focus()
    else if (event.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length].focus()
    else if (event.key === 'Tab') dismiss(true)
    else return
    event.preventDefault()
    event.stopPropagation()
  }
  const onPointer = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) dismiss(false)
  }
  const dismiss = (restoreFocus: boolean) => {
    if (close !== dismissThis) return
    close = null
    menu.remove()
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onPointer, true)
    window.removeEventListener('blur', dismissThis)
    if (restoreFocus) onClose?.()
  }
  const dismissThis = () => dismiss(false)
  close = dismissThis

  document.body.append(menu)
  // Keep it on screen.
  const { width, height } = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('blur', dismissThis)
  buttons[0]?.focus()
}
