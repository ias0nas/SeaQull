// Small helpers shared by the console's modules.

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Drag-to-resize for a splitter: primary button only, and always cleans up (a lost pointer
 *  capture or a cancelled pointer would otherwise leave the pane resizing on hover). */
export function onDrag(handle: HTMLElement, start: (event: PointerEvent) => { move: (e: PointerEvent) => void; end: () => void }): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const { move, end } = start(event)
    handle.setPointerCapture(event.pointerId)
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      handle.removeEventListener('lostpointercapture', stop)
      end()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
    handle.addEventListener('lostpointercapture', stop)
  })
}
