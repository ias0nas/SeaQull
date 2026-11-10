// Following a run from the console page: poll query.status until the run ends, without the DOM, so
// it can be tested on its own (test/run-watch.test.ts).
//
// A failed poll is not the end of the run: the query keeps going in the worker. So failures are
// retried with a short backoff; when they keep failing, query.latest says whether the worker still
// has the run (and how it is doing). Only when even that fails is the outcome unknown, and then
// the run may still be going: the page keeps Cancel usable.
import type { RunStatus } from '../src/protocol.ts'

export type WatchDeps = {
  /** query.status, with how many messages the page already has. */
  status(runId: string, messagesFrom: number): Promise<RunStatus>
  /** query.latest for the tab's console. */
  latest(): Promise<RunStatus | null>
  sleep(ms: number): Promise<void>
  /** False once the tab has moved on (a newer run, or it closed): stop without a word. */
  current(): boolean
  /** The run's status so far, while it runs (messages complete, not just the new ones). */
  progress(status: RunStatus): void
}

export type WatchEnd =
  /** It finished: done, error or cancelled. */
  | { kind: 'ended'; status: RunStatus }
  /** The tab moved on. */
  | { kind: 'stale' }
  /** The worker no longer has the run (it restarted, or a newer run replaced it): not running. */
  | { kind: 'gone'; error: unknown }
  /** The worker could not be reached: the run may still be going. */
  | { kind: 'unreachable'; error: unknown }

/** Waits between retries of a failed poll; after the last, query.latest decides. */
export const RETRY_DELAYS = [250, 500, 1000, 2000]
const FIRST_DELAY = 100
const MAX_DELAY = 500

const codeOf = (err: unknown) => (err as { code?: unknown } | null)?.code

export async function watchRun(runId: string, deps: WatchDeps, initial?: RunStatus): Promise<WatchEnd> {
  let messages = initial?.messages ?? []
  /** The answer with its messages joined to the ones the page has. */
  const merge = (answer: RunStatus): RunStatus => {
    const from = Math.min(answer.messagesFrom ?? 0, messages.length)
    messages = from === 0 ? answer.messages : [...messages.slice(0, from), ...answer.messages]
    return { ...answer, messages, messagesFrom: 0 }
  }
  let delay = FIRST_DELAY
  let failures = 0
  for (;;) {
    if (!deps.current()) return { kind: 'stale' }
    let status: RunStatus
    try {
      status = merge(await deps.status(runId, messages.length))
      failures = 0
    } catch (err) {
      if (!deps.current()) return { kind: 'stale' }
      // invalid_params: the worker does not know the run; waiting will not change that.
      if (codeOf(err) !== 'invalid_params' && failures < RETRY_DELAYS.length) {
        await deps.sleep(RETRY_DELAYS[failures++])
        continue
      }
      let latest: RunStatus | null
      try {
        latest = await deps.latest()
      } catch {
        return deps.current() ? { kind: 'unreachable', error: err } : { kind: 'stale' }
      }
      if (!deps.current()) return { kind: 'stale' }
      if (latest?.runId !== runId) return { kind: 'gone', error: err }
      messages = []
      status = merge(latest)
      failures = 0
    }
    if (status.state !== 'running') return { kind: 'ended', status }
    deps.progress(status)
    await deps.sleep(delay)
    delay = Math.min(delay * 1.5, MAX_DELAY)
  }
}
