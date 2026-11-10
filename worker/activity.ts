// The SeaQull status-bar item: shown while something is going on that the worker must not lose, a
// query running or a session holding an open transaction. Contributing a status-bar item also
// makes Orca keep this worker running while the plugin is enabled (orca-host `statusBar.update`),
// instead of stopping it after a few idle minutes, which would end those sessions.
//
// It appears only after the condition has held for 3 seconds, so quick queries never make the
// status bar jump, and goes as soon as it clears. statusBar.update is called only when what shows
// changes, and a failure is logged, never passed on. No timers run while nothing is going on.

/** What the worker is doing, by console session. */
export type ActivityItem = { label: string; running: boolean; openTransaction: boolean }

export type StatusBarPatch = {
  text?: string
  icon?: 'database'
  tone?: 'accent' | 'warning'
  tooltip?: string
  visible: boolean
}

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const SHOW_AFTER_MS = 3000
const TEXT_MAX = 64
const TOOLTIP_MAX = 256

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)

/** The item for what is going on; hidden when nothing is. */
export function describe(items: ActivityItem[]): StatusBarPatch {
  const running = items.filter((i) => i.running)
  const open = items.filter((i) => i.openTransaction)
  if (running.length === 0 && open.length === 0) return { visible: false }
  const parts = []
  if (running.length) parts.push(plural(running.length, '1 query running', 'queries running'))
  if (open.length) parts.push(plural(open.length, 'open transaction', 'open transactions'))
  const lines = []
  if (running.length) lines.push(`Running: ${running.map((i) => i.label).join(', ')}`)
  if (open.length) lines.push(`Open transaction: ${open.map((i) => i.label).join(', ')} (commit or roll back when done)`)
  const tooltip = lines.join('\n')
  return {
    text: `SeaQull: ${parts.join(' · ')}`.slice(0, TEXT_MAX),
    icon: 'database',
    tone: open.length ? 'warning' : 'accent',
    tooltip: tooltip.length > TOOLTIP_MAX ? `${tooltip.slice(0, TOOLTIP_MAX - 1)}…` : tooltip,
    visible: true
  }
}

export class ActivityIndicator {
  private readonly update: (patch: StatusBarPatch) => Promise<unknown>
  private readonly log: (message: string) => void
  private readonly timers: Timers
  private items: ActivityItem[] = []
  /** Pending 3-second wait before showing. */
  private timer: unknown
  private shown = false
  /** The last patch sent, as JSON, so an unchanged one is not sent again. */
  private sent = ''

  constructor(update: (patch: StatusBarPatch) => Promise<unknown>, log: (message: string) => void, timers: Timers = globalThis) {
    this.update = update
    this.log = log
    this.timers = timers
  }

  /** Hides an item a previous worker may have left showing (Orca keeps it until it restarts). */
  reset(): void {
    this.sent = ''
    this.send({ visible: false })
  }

  /** The worker's activity changed. */
  set(items: ActivityItem[]): void {
    this.items = items
    const active = describe(items).visible
    if (!active) {
      if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
      this.timer = undefined
      if (this.shown) {
        this.shown = false
        this.send({ visible: false })
      }
      return
    }
    if (this.shown) this.send(describe(items))
    else if (this.timer === undefined) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined
        this.shown = true
        this.send(describe(this.items))
      }, SHOW_AFTER_MS)
    }
  }

  private send(patch: StatusBarPatch): void {
    const json = JSON.stringify(patch)
    if (json === this.sent) return
    this.sent = json
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(this.update(patch))
    } catch (err) {
      pending = Promise.reject(err) // an update that throws at once is only logged too
    }
    pending.catch((err) => {
      // Not sent: let the next change send it again.
      if (this.sent === json) this.sent = ''
      this.log(`SeaQull: could not update the status bar item: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}
