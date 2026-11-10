// Azure CLI lookup and access tokens, with a fake `az` (this machine may have no real one).
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { clearTokenCache, findAz, getSqlAccessToken, parseTokenOutput } from '../worker/az.ts'

const unix = process.platform !== 'win32'
let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seaqull-az-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A fake az that prints a token and counts its calls. */
async function fakeAz(token: string, expiresOn: number): Promise<string> {
  const path = join(dir, 'az')
  const counter = join(dir, 'calls')
  await writeFile(counter, '')
  await writeFile(path, `#!/bin/sh\necho x >> '${counter}'\necho '{"accessToken":"${token}","expires_on":${expiresOn}}'\n`)
  await chmod(path, 0o755)
  return path
}
const calls = async () => (await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(Boolean).length

test('token output: epoch seconds, older date strings, fallback, errors', () => {
  assert.deepEqual(parseTokenOutput('{"accessToken":"t","expires_on":1700000000}', 0), { token: 't', expiresAt: 1_700_000_000_000 })
  assert.equal(parseTokenOutput('{"accessToken":"t","expiresOn":"2030-01-01 10:00:00.000000"}', 0).expiresAt, Date.parse('2030-01-01 10:00:00.000000'))
  assert.equal(parseTokenOutput('{"accessToken":"t"}', 1000).expiresAt, 1000 + 30 * 60_000)
  assert.throws(() => parseTokenOutput('{"expires_on":1}', 0), /no access token/)
  assert.throws(() => parseTokenOutput('WARNING: not json', 0), /not JSON/)
})

test('a configured az path must exist', async () => {
  await assert.rejects(findAz(join(dir, 'missing-az')), /Azure CLI not found at/)
})

test('az is found on PATH', { skip: !unix }, async () => {
  const path = await fakeAz('t', 0)
  const saved = process.env.PATH
  process.env.PATH = `${dir}:${saved}`
  try {
    assert.equal(await findAz(undefined), path)
  } finally {
    process.env.PATH = saved
  }
})

test('tokens are cached until near expiry, and the cache can be cleared', { skip: !unix }, async () => {
  clearTokenCache()
  const az = await fakeAz('first', Math.floor(Date.now() / 1000) + 3600)
  assert.equal(await getSqlAccessToken(az), 'first')
  assert.equal(await getSqlAccessToken(az), 'first')
  assert.equal(await calls(), 1, 'second call should come from the cache')
  clearTokenCache()
  await getSqlAccessToken(az)
  assert.equal(await calls(), 2)
  // Expiring within five minutes: fetched again every time.
  clearTokenCache()
  await fakeAz('soon', Math.floor(Date.now() / 1000) + 60)
  await getSqlAccessToken(az)
  await getSqlAccessToken(az)
  assert.equal(await calls(), 2)
})

test('a clear invalidates a token request already in flight', { skip: !unix }, async () => {
  clearTokenCache()
  const az = await fakeAz('unused', 0) // only needs to exist and be executable
  const requests: { token: string; resolve: () => void }[] = []
  const fetch = (_az: string) =>
    new Promise<{ token: string; expiresAt: number }>((resolve) => {
      const token = `token${requests.length + 1}`
      requests.push({ token, resolve: () => resolve({ token, expiresAt: Date.now() + 3_600_000 }) })
    })
  const first = getSqlAccessToken(az, fetch)
  const second = getSqlAccessToken(az, fetch) // shares the request in flight
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(requests.length, 1)
  clearTokenCache() // e.g. a login failed with the token being fetched
  requests[0].resolve()
  await new Promise((r) => setTimeout(r, 10))
  // Both callers asked again rather than take the token from before the clear.
  assert.equal(requests.length, 2)
  requests[1].resolve()
  assert.deepEqual(await Promise.all([first, second]), ['token2', 'token2'])
  // And the cache holds the new one, not the old.
  assert.equal(await getSqlAccessToken(az, fetch), 'token2')
  assert.equal(requests.length, 2)
  clearTokenCache()
})
