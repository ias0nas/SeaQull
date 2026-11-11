// Requests to the worker. Orca limits how many messages a plugin frame may send (Orca 1.4: 120 in
// any 10 seconds) and refuses the rest with `rate_limited` and `retryAfterMs`; a long copy or a
// busy grid can reach that, so such requests wait and try again rather than fail. Requests that
// connect go through the sign-in gate (sign-in.ts) once the console installs one.
import type { PluginRequestInput, PluginRequestOutput, PluginRequestOptions, PluginRequests } from 'orca'
import { decodeKey } from '../src/shared/tree-keys.ts'
import type { SignInGate } from './sign-in.ts'

/** Waits when a refusal gives no `retryAfterMs`. */
const BACKOFF_MS = [250, 500, 1000, 2000]
const MIN_WAIT_MS = 50
/** A refusal is passed on after this long waiting in all, or this many tries. */
export const MAX_RATE_WAIT_MS = 60_000
export const MAX_RATE_ATTEMPTS = 30

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function retryRateLimited<T>(call: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep, maxWaitMs = MAX_RATE_WAIT_MS): Promise<T> {
  let waited = 0
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (err) {
      const { code, retryAfterMs } = (err ?? {}) as { code?: unknown; retryAfterMs?: unknown }
      if (code !== 'rate_limited') throw err
      const given = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
      const ms = Math.max(MIN_WAIT_MS, given)
      if (attempt >= MAX_RATE_ATTEMPTS || waited + ms > maxWaitMs) throw err
      await wait(ms)
      waited += ms
    }
  }
}

let gate: SignInGate | undefined
export const installSignIn = (signIn: SignInGate) => void (gate = signIn)

/** The saved connection a request connects to, if it does. */
export function connectionOfRequest(name: string, input: unknown): string | undefined {
  if (name === 'tree.children') {
    try {
      return decodeKey(String((input as { key?: unknown }).key ?? '')).connection
    } catch {
      return undefined
    }
  }
  if (!['databases.list', 'query.run', 'completion.names', 'completion.columns'].includes(name)) return undefined
  const id = (input as { connectionId?: unknown } | null)?.connectionId
  return typeof id === 'string' && id ? id : undefined
}

/** orca.plugin.request, retried while Orca says too many requests, and after signing in.
 *  `byUser`: the person asked for it (a run always is), so it may ask for a sign-in again after a
 *  cancel. */
export function request<K extends keyof PluginRequests>(
  name: K,
  input: PluginRequestInput<K>,
  options?: PluginRequestOptions,
  byUser = name === 'query.run'
): Promise<PluginRequestOutput<K>> {
  const send = orca.plugin.request as (name: K, input: PluginRequestInput<K>, options?: PluginRequestOptions) => Promise<PluginRequestOutput<K>>
  const attempt = () => retryRateLimited(() => send(name, input, options))
  const connectionId = gate && connectionOfRequest(name, input)
  return connectionId ? gate!.run(connectionId, attempt, byUser) : attempt()
}
