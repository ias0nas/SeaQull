// Requests Orca refuses as too many (`rate_limited`) wait and try again.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_RATE_ATTEMPTS, retryRateLimited } from '../editor/request.ts'

const limited = (retryAfterMs?: number) => Object.assign(new Error('Too many requests.'), { code: 'rate_limited', retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })

/** A call that fails with `errors` in turn, then answers 'ok'; and the waits it was made to take. */
function script(...errors: Error[]) {
  const waits: number[] = []
  let calls = 0
  const call = async () => {
    calls++
    const err = errors.shift()
    if (err) throw err
    return 'ok'
  }
  const wait = async (ms: number) => void waits.push(ms)
  return { call, wait, waits, calls: () => calls }
}

test('waits as long as Orca says, then tries again', async () => {
  const s = script(limited(1200), limited(300))
  assert.equal(await retryRateLimited(s.call, s.wait), 'ok')
  assert.deepEqual(s.waits, [1200, 300])
  assert.equal(s.calls(), 3)
})

test('without retryAfterMs, backs off', async () => {
  const s = script(limited(), limited(), limited())
  assert.equal(await retryRateLimited(s.call, s.wait), 'ok')
  assert.deepEqual(s.waits, [250, 500, 1000])
})

test('other failures are passed on at once', async () => {
  const s = script(Object.assign(new Error('nope'), { code: 'invalid_params' }))
  await assert.rejects(retryRateLimited(s.call, s.wait), /nope/)
  assert.deepEqual(s.waits, [])
})

test('gives up once the waits would pass the limit', async () => {
  const s = script(limited(4000), limited(4000), limited(4000))
  await assert.rejects(retryRateLimited(s.call, s.wait, 10_000), /Too many requests/)
  assert.deepEqual(s.waits, [4000, 4000])
})

test('a retryAfterMs of 0 still waits a little, and the tries are capped', async () => {
  const s = script(...Array.from({ length: 100 }, () => limited(0)))
  await assert.rejects(retryRateLimited(s.call, s.wait), /Too many requests/)
  assert.equal(s.calls(), MAX_RATE_ATTEMPTS)
  assert.ok(s.waits.every((ms) => ms >= 50))
})
