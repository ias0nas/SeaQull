// RunManager without a database: script uploads (order, owner, size cap, expiry).
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { MAX_SCRIPT_BYTES, RunManager } from '../worker/runs.ts'

const runs = new RunManager(async () => 100)
after(() => runs.dispose())

test('parts are joined in order, once, for the console that sent them', () => {
  const { uploadId } = runs.append('console:a', undefined, 0, 'SELECT ')
  runs.append('console:a', uploadId, 7, "'x'")
  assert.throws(() => runs.takeUpload('console:b', uploadId), /expired/, 'another console cannot run it')
  assert.equal(runs.takeUpload('console:a', uploadId), "SELECT 'x'")
  assert.throws(() => runs.takeUpload('console:a', uploadId), /expired/, 'taken once')
})

test('a part out of order fails the upload', () => {
  const { uploadId } = runs.append('console:a', undefined, 0, 'abc')
  assert.throws(() => runs.append('console:a', uploadId, 2, 'd'), /out of order/)
  assert.throws(() => runs.append('console:a', uploadId, 3, 'd'), /expired/)
})

test('a new upload replaces the console’s unfinished one', () => {
  const first = runs.append('console:a', undefined, 0, 'old').uploadId
  const second = runs.append('console:a', undefined, 0, 'new').uploadId
  assert.throws(() => runs.takeUpload('console:a', first), /expired/)
  assert.equal(runs.takeUpload('console:a', second), 'new')
})

test('scripts over 10 MB (UTF-8) are refused with a clear message', () => {
  const part = '€'.repeat(1024 * 1024) // 3 MB in UTF-8
  const { uploadId } = runs.append('console:big', undefined, 0, part)
  runs.append('console:big', uploadId, part.length, part)
  runs.append('console:big', uploadId, part.length * 2, part)
  assert.ok(part.length * 4 * 3 > MAX_SCRIPT_BYTES)
  assert.throws(() => runs.append('console:big', uploadId, part.length * 3, part), /Script too large: SeaQull runs at most 10 MB/)
})

test('an abandoned upload is dropped after 5 minutes', () => {
  const { uploadId } = runs.append('console:a', undefined, 0, 'x')
  runs.sweep(Date.now() + 4 * 60_000)
  runs.append('console:a', uploadId, 1, 'y')
  runs.sweep(Date.now() + 6 * 60_000)
  assert.throws(() => runs.takeUpload('console:a', uploadId), /expired/)
})

test('status of an unknown run says the result is gone', () => {
  assert.throws(() => runs.status('nope', 3), /gone/)
})

test('the @@TRANCOUNT check gives up on a connection that never answers, and says it is lost', async () => {
  const { probeTransaction } = await import('../worker/runs.ts')
  const connection = { closed: false } as never
  const stalled = () => new Promise<never>(() => undefined)
  const started = Date.now()
  assert.equal(await probeTransaction(connection, stalled, 50), 'lost')
  assert.ok(Date.now() - started < 1000)
  assert.equal(await probeTransaction(connection, async () => [{ n: 1 }], 50), 'open')
  assert.equal(await probeTransaction(connection, async () => [{ n: 0 }], 50), 'none')
  // A failed check on a live connection plays safe (kept, never swept); on a closed one, nothing is open.
  assert.equal(await probeTransaction(connection, async () => Promise.reject(new Error('x')), 50), 'unknown')
  assert.equal(await probeTransaction({ closed: true } as never, async () => Promise.reject(new Error('x')), 50), 'none')
})
