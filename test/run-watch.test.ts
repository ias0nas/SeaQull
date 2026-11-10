// Following a run from the page: retries, the query.latest fallback, messages sent only once.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RETRY_DELAYS, watchRun, type WatchDeps } from '../editor/run-watch.ts'
import type { RunMessage, RunStatus } from '../src/protocol.ts'

const msg = (text: string): RunMessage => ({ kind: 'info', text })
const status = (state: RunStatus['state'], messages: RunMessage[], messagesFrom = 0): RunStatus => ({ runId: 'r1', state, elapsedMs: 0, results: [], messages, messagesFrom })
const fail = (code?: string) => Object.assign(new Error(code ?? 'timeout'), code ? { code } : {})

/** Deps answering from a script: each status call takes the next answer (a status or an error). */
function deps(answers: (RunStatus | Error)[], latest: () => Promise<RunStatus | null> = async () => null) {
  const calls: number[] = []
  const sleeps: number[] = []
  const progress: RunStatus[] = []
  const d: WatchDeps = {
    status: async (_runId, from) => {
      calls.push(from)
      const next = answers.shift()
      if (!next) throw new Error('script ran out')
      if (next instanceof Error) throw next
      return next
    },
    latest,
    sleep: async (ms) => void sleeps.push(ms),
    current: () => true,
    progress: (s) => void progress.push(s)
  }
  return { d, calls, sleeps, progress }
}

test('polls until the run ends, asking only for messages it does not have', async () => {
  const { d, calls, progress } = deps([status('running', [msg('a')]), status('running', [msg('b')], 1), status('done', [msg('c')], 2)])
  const end = await watchRun('r1', d)
  assert.equal(end.kind, 'ended')
  assert.deepEqual(calls, [0, 1, 2])
  assert.deepEqual(end.kind === 'ended' && end.status.messages.map((m) => m.text), ['a', 'b', 'c'])
  assert.deepEqual(progress.map((p) => p.messages.length), [1, 2])
})

test('a few failed polls are retried with a backoff; the run is still followed', async () => {
  const { d, sleeps } = deps([fail(), fail(), status('done', [])])
  const end = await watchRun('r1', d)
  assert.equal(end.kind, 'ended')
  assert.deepEqual(sleeps, RETRY_DELAYS.slice(0, 2))
})

test('when polls keep failing, query.latest says whether it still runs, and following goes on', async () => {
  let latestCalls = 0
  const { d } = deps([...RETRY_DELAYS.map(() => fail()), fail(), status('done', [msg('end')], 1)], async () => (latestCalls++, status('running', [msg('x')])))
  const end = await watchRun('r1', d)
  assert.equal(latestCalls, 1)
  assert.equal(end.kind, 'ended')
  assert.deepEqual(end.kind === 'ended' && end.status.messages.map((m) => m.text), ['x', 'end'])
})

test('the worker no longer has the run: gone (not running), without waiting through retries', async () => {
  const { d, sleeps } = deps([fail('invalid_params')], async () => null)
  const end = await watchRun('r1', d)
  assert.equal(end.kind, 'gone')
  assert.deepEqual(sleeps, [])
})

test('a newer run in the worker: gone too', async () => {
  const { d } = deps([fail('invalid_params')], async () => ({ ...status('running', []), runId: 'r2' }))
  assert.equal((await watchRun('r1', d)).kind, 'gone')
})

test('the worker cannot be reached at all: unreachable (it may still be running)', async () => {
  const { d } = deps(RETRY_DELAYS.map(() => fail()).concat(fail()), async () => {
    throw fail()
  })
  assert.equal((await watchRun('r1', d)).kind, 'unreachable')
})

test('a tab that moved on stops quietly', async () => {
  let current = true
  const { d } = deps([status('running', [])])
  d.current = () => current
  d.progress = () => void (current = false)
  assert.equal((await watchRun('r1', d)).kind, 'stale')
})

test('restoring: starts from the messages it already has', async () => {
  const { d, calls } = deps([status('done', [msg('c')], 2)])
  const end = await watchRun('r1', d, status('running', [msg('a'), msg('b')]))
  assert.deepEqual(calls, [2])
  assert.deepEqual(end.kind === 'ended' && end.status.messages.map((m) => m.text), ['a', 'b', 'c'])
})
