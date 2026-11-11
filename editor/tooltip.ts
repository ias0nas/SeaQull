// Tooltips drawn in the page: Orca's plugin pages run in Electron web views, which do not reliably
// show native `title` tooltips. Any element with a `title` gets this one instead (the attribute moves
// to `data-tip` on hover, so the two never show together; code may keep setting `title`).

const DELAY_MS = 450

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Shortcut labels for this platform. */
export const keys = isMac
  ? { run: '⌘↵', cancel: '⌘.', copy: '⌘C', copyOther: '⇧⌘C', selectAll: '⌘A', complete: '⌘I', locate: '⌥F1' }
  : { run: 'Ctrl+Enter', cancel: 'Ctrl+.', copy: 'Ctrl+C', copyOther: 'Ctrl+Shift+C', selectAll: 'Ctrl+A', complete: 'Ctrl+I', locate: 'Alt+F1' }

export function installTooltips(): void {
  const tip = document.createElement('div')
  tip.className = 'tooltip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  document.body.append(tip)
  let target: HTMLElement | null = null
  let timer = 0

  const hide = () => {
    clearTimeout(timer)
    target = null
    tip.hidden = true
  }

  const show = (el: HTMLElement) => {
    const text = el.dataset.tip
    if (!text || !el.isConnected) return
    tip.textContent = text
    // Modal dialogs sit in the top layer, above anything in <body>: show inside the dialog then.
    const layer = el.closest('dialog[open]') ?? document.body
    if (tip.parentElement !== layer) layer.append(tip)
    tip.hidden = false
    const box = el.getBoundingClientRect()
    const { width, height } = tip.getBoundingClientRect()
    const below = box.bottom + 6 + height <= window.innerHeight
    tip.style.top = `${below ? box.bottom + 6 : Math.max(4, box.top - 6 - height)}px`
    tip.style.left = `${Math.max(4, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 4))}px`
  }

  document.addEventListener('mouseover', (event) => {
    if (event.buttons) return hide() // mid-drag
    const el = (event.target as HTMLElement).closest<HTMLElement>('[title], [data-tip]')
    if (el?.hasAttribute('title')) {
      // Latest text wins: code may have set `title` again since the last hover.
      const title = el.getAttribute('title')!
      el.removeAttribute('title')
      if (title) el.dataset.tip = title
      else delete el.dataset.tip
    }
    if (el === target) return
    hide()
    if (!el?.dataset.tip) return
    target = el
    timer = window.setTimeout(() => show(el), DELAY_MS)
  })
  document.addEventListener('mouseout', (event) => {
    if (target && !target.contains(event.relatedTarget as Node | null)) hide()
  })
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'wheel']) document.addEventListener(type, hide, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
}
