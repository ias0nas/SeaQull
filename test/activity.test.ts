// The status-bar item: shown after 3 s of activity, hidden at once, updated only on change.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityIndicator, describe, SHOW_AFTER_MS, type ActivityItem, type StatusBarPatch } from '../worker/activity.ts'

/** Timers that only move when told. */
function fakeTimers() {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn: () => void, ms: number) => (pending.set(next, { at: now + ms, fn }), next++),
    clearTimeout: (id: unknown) => void pending.delete(id as number),
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...pending]) if (t.at <= now) (pending.delete(id), t.fn())
    },
    get pending() {
      return pending.size
    }
  }
}

function setup(fail = false) {
  const timers = fakeTimers()
  const sent: StatusBarPatch[] = []
  const logs: string[] = []
  const indicator = new ActivityIndicator(
    async (patch) => {
      sent.push(patch)
      if (fail) throw new Error('no status bar')
    },
    (m) => logs.push(m),
    timers
  )
  return { timers, sent, logs, indicator }
}

const running = (label = 'Local · AW'): ActivityItem => ({ label, running: true, openTransaction: false })
const inTransaction = (label = 'Local · AW'): ActivityItem => ({ label, running: false, openTransaction: true })
const idle = (label = 'Local · AW'): ActivityItem => ({ label, running: false, openTransaction: false })

test('a quick query never shows the item', () => {
  const { timers, sent, indicator } = setup()
  indicator.set([running()])
  timers.advance(SHOW_AFTER_MS - 1)
  indicator.set([idle()])
  timers.advance(10_000)
  assert.deepEqual(sent, [])
  assert.equal(timers.pending, 0, 'no timer left while nothing is going on')
})

test('shown after 3 s, updated only when the text changes, hidden as soon as it clears', () => {
  const { timers, sent, indicator } = setup()
  indicator.set([running()])
  timers.advance(SHOW_AFTER_MS)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { text: 'SeaQull: 1 query running', icon: 'database', tone: 'accent', tooltip: 'Running: Local · AW', visible: true })
  indicator.set([running()]) // same thing again: nothing sent
  assert.equal(sent.length, 1)
  indicator.set([running(), running('Prod · Sales')])
  assert.equal(sent[1].text, 'SeaQull: 2 queries running')
  assert.equal(sent[1].tooltip, 'Running: Local · AW, Prod · Sales')
  // The query ends but its transaction stays open: still going, shown at once with the new text.
  indicator.set([inTransaction()])
  assert.deepEqual(sent[2], {
    text: 'SeaQull: open transaction',
    icon: 'database',
    tone: 'warning',
    tooltip: 'Open transaction: Local · AW (commit or roll back when done)',
    visible: true
  })
  indicator.set([idle()])
  assert.deepEqual(sent[3], { visible: false })
  indicator.set([])
  assert.equal(sent.length, 4, 'already hidden')
})

test('activity coming back after it cleared waits 3 s again', () => {
  const { timers, sent, indicator } = setup()
  indicator.set([running()])
  timers.advance(SHOW_AFTER_MS)
  indicator.set([])
  indicator.set([running()])
  timers.advance(SHOW_AFTER_MS - 1)
  assert.equal(sent.length, 2) // shown, hidden
  timers.advance(1)
  assert.equal(sent.length, 3)
  assert.equal(sent[2].visible, true)
})

test('the wait starts with the first activity, and shows what is going on when it ends', () => {
  const { timers, sent, indicator } = setup()
  indicator.set([running()])
  timers.advance(2000)
  indicator.set([running(), inTransaction('Other · db')])
  timers.advance(1000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, 'SeaQull: 1 query running · open transaction')
  assert.equal(sent[0].tone, 'warning')
})

test('a failed update is logged, not thrown, and sent again on the next change', async () => {
  const { timers, sent, logs, indicator } = setup(true)
  indicator.set([running()])
  timers.advance(SHOW_AFTER_MS)
  await new Promise((r) => setImmediate(r))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /no status bar/)
  indicator.set([running()])
  assert.equal(sent.length, 2, 'retried, since the first did not get through')
})

test('reset hides an item a previous worker left showing', () => {
  const { sent, indicator } = setup()
  indicator.reset()
  assert.deepEqual(sent, [{ visible: false }])
})

test('long tooltips and texts fit Orca limits', () => {
  const many = Array.from({ length: 40 }, (_, i) => running(`Connection number ${i} · database`))
  const patch = describe(many)
  assert.ok(patch.tooltip!.length <= 256)
  assert.ok(patch.text!.length <= 64)
})

test('an update that throws at once is only logged', async () => {
  const logs: string[] = []
  const indicator = new ActivityIndicator(
    () => {
      throw new Error('host.call is missing')
    },
    (m) => logs.push(m),
    fakeTimers()
  )
  assert.doesNotThrow(() => indicator.reset())
  await new Promise((r) => setImmediate(r))
  assert.match(logs[0], /host.call is missing/)
})
