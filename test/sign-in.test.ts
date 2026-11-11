// The sign-in gate: requests that fail for want of a login share one prompt, then go again.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SignInState } from '../src/protocol.ts'
import { connectionOfRequest } from '../editor/request.ts'
import { isSignInCancelled, SignInGate } from '../editor/sign-in.ts'

/** A worker where `c1` needs a sign-in until `signedIn` is set. */
function world() {
  const w = { signedIn: false, asks: 0, answer: (_: SignInState) => Promise.resolve(true), stateCalls: 0 }
  const gate = new SignInGate(
    async () => (w.stateCalls++, { needed: !w.signedIn, name: 'Local', user: 'sa' }),
    async (_id, state) => {
      w.asks++
      const ok = await w.answer(state)
      if (ok) w.signedIn = true
      return ok
    }
  )
  const send = (value: string) => async () => {
    if (!w.signedIn) throw new Error('Sign in to Local to connect.')
    return value
  }
  return { w, gate, send }
}

test('requests failing at once share one prompt, and all go again after it', async () => {
  const { w, gate, send } = world()
  let release!: (ok: boolean) => void
  w.answer = () => new Promise((resolve) => (release = resolve))
  const results = Promise.all([gate.run('c1', send('tree')), gate.run('c1', send('databases')), gate.run('c1', send('names'), true), gate.run('c1', send('run'))])
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(w.asks, 1)
  release(true)
  assert.deepEqual(await results, ['tree', 'databases', 'names', 'run'])
  assert.equal(w.asks, 1)
})

test('before any cancel a background request may ask; after one, only what the user does asks again', async () => {
  const { w, gate, send } = world()
  w.answer = async () => false
  const results = await Promise.allSettled([gate.run('c1', send('picker on load')), gate.run('c1', send('auto-expand'))])
  for (const r of results) assert.ok(r.status === 'rejected' && isSignInCancelled(r.reason) && r.reason.message === 'Sign-in cancelled')
  assert.equal(w.asks, 1, 'background requests may ask before any cancel')
  for (const what of ['completion', 'reload', 'picker on load']) await assert.rejects(gate.run('c1', send(what)), isSignInCancelled)
  assert.equal(w.asks, 1, 'background requests do not bring the prompt back')
  w.answer = async () => true
  assert.equal(await gate.run('c1', send('expand'), true), 'expand')
  assert.equal(w.asks, 2)
  assert.equal(await gate.run('c1', send('completion')), 'completion')
})

test('one prompt at a time across connections: a second waits for the first, and each gets its own', async () => {
  const shown: string[] = []
  const answers = new Map<string, (ok: boolean) => void>()
  const signedIn = new Set<string>()
  const gate = new SignInGate(
    async (id) => ({ needed: !signedIn.has(id), name: id, user: '' }),
    (id, state) => (shown.push(state.name), new Promise<boolean>((resolve) => answers.set(id, (ok) => (ok && signedIn.add(id), resolve(ok)))))
  )
  const send = (id: string) => async () => {
    if (!signedIn.has(id)) throw new Error('Sign in')
    return id
  }
  const a = gate.run('A', send('A'), true)
  const b = gate.run('B', send('B'), true)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(shown, ['A'], 'B waits')
  answers.get('A')!(true)
  assert.equal(await a, 'A')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(shown, ['A', 'B'])
  answers.get('B')!(false)
  await assert.rejects(b, isSignInCancelled)
})

test('after a sign-in one request tries the login first; a refusal costs one attempt, a success releases the rest', async () => {
  let password = ''
  let attempts = 0
  let refusedOnce = false
  const passwords = ['wrong', 'right']
  const gate = new SignInGate(
    async () => ({ needed: password === '', name: 'Local', user: 'sa' }),
    async () => ((password = passwords.shift()!), true)
  )
  const send = (value: string) => async () => {
    if (!password) throw new Error('Sign in')
    attempts++
    await new Promise((r) => setTimeout(r, 5))
    if (password === 'wrong') {
      password = '' // the worker forgets a refused sign-in
      refusedOnce = true
      throw new Error('Login failed')
    }
    return value
  }
  const results = await Promise.all(['a', 'b', 'c', 'd'].map((v) => gate.run('c1', send(v), true)))
  assert.deepEqual(results, ['a', 'b', 'c', 'd'])
  assert.ok(refusedOnce)
  assert.equal(attempts, 1 + 4, 'one refused attempt, then one per request')
})

test('after a sign-in, each request that then goes through is reported (a login to remember is saved by then)', async () => {
  const signedIn: string[] = []
  let ok = false
  const gate = new SignInGate(async () => ({ needed: !ok, name: 'Local', user: '' }), async () => (ok = true), (id) => signedIn.push(id))
  const send = async () => {
    if (!ok) throw new Error('Sign in')
    return 1
  }
  await Promise.all([gate.run('c1', send), gate.run('c1', send)])
  assert.deepEqual(signedIn, ['c1', 'c1'])
  await gate.run('c1', send)
  assert.equal(signedIn.length, 2, 'not for requests that needed no sign-in')
})

test('failures that are not about signing in pass through untouched', async () => {
  const { w, gate } = world()
  w.signedIn = true
  const boom = new Error('Cannot open database')
  await assert.rejects(gate.run('c1', async () => Promise.reject(boom)), (err) => err === boom)
  assert.equal(w.asks, 0)
  // The state check failing too: the original error, not the check's.
  const broken = new SignInGate(async () => Promise.reject(new Error('worker gone')), async () => true)
  await assert.rejects(broken.run('c1', async () => Promise.reject(boom)), (err) => err === boom)
})

test('a refused login asks again, with the reason, until signed in or cancelled', async () => {
  const states: SignInState[] = []
  let attempts = 0
  const gate = new SignInGate(
    async () => ({ needed: true, name: 'Local', user: 'sa', ...(attempts > 1 ? { failure: "Login failed for user 'sa'." } : {}) }),
    async (_id, state) => (states.push(state), states.length < 3)
  )
  await assert.rejects(
    gate.run('c1', async () => {
      attempts++
      throw new Error('Login failed')
    }),
    isSignInCancelled
  )
  assert.equal(states.length, 3)
  assert.equal(states[0].failure, undefined)
  assert.equal(states[1].failure, "Login failed for user 'sa'.")
})

test('the requests that connect, and the connection they name', () => {
  assert.equal(connectionOfRequest('tree.children', { key: 'g:Team/c:abc/d:AW' }), 'abc')
  assert.equal(connectionOfRequest('tree.children', { key: '' }), undefined)
  assert.equal(connectionOfRequest('tree.children', { key: '%E0%A4%A' }), undefined)
  for (const name of ['databases.list', 'query.run', 'completion.names', 'completion.columns']) assert.equal(connectionOfRequest(name, { connectionId: 'abc' }), 'abc')
  assert.equal(connectionOfRequest('connections.signInState', { id: 'abc' }), undefined)
  assert.equal(connectionOfRequest('query.status', { runId: 'r' }), undefined)
})

test('a cancel kept by the console still holds for a new gate (the page reloaded)', async () => {
  const kept = new Set<string>()
  let asks = 0
  const make = () => new SignInGate(async () => ({ needed: true, name: 'Local', user: '' }), async () => (asks++, false), undefined, kept)
  const fail = async () => Promise.reject(new Error('Sign in'))
  await assert.rejects(make().run('c1', fail), isSignInCancelled)
  assert.equal(asks, 1)
  await assert.rejects(make().run('c1', fail), isSignInCancelled)
  assert.equal(asks, 1, 'the reload does not ask')
  await assert.rejects(make().run('c1', fail, true), isSignInCancelled)
  assert.equal(asks, 2, 'a user action does')
})
