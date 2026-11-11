// Sending scripts: sizes measured as Orca measures them (encoded JSON), large ones in parts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jsonStringBytes } from '../src/shared/json-bytes.ts'
import { MAX_REQUEST_BYTES, MAX_SCRIPT_BYTES, sendRun, splitForJson } from '../src/shared/upload.ts'

const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

test('JSON string sizes match JSON.stringify, for every kind of character', () => {
  for (const text of ['', 'abc', 'say "hi"\\', 'a\nb\r\n\t', '\u0001\u001f', 'é€', '😀 x', 'lone \ud800 high', 'lone \udc00 low', 'end \ud83d']) {
    assert.equal(jsonStringBytes(text), encoded(text) - 2, JSON.stringify(text))
  }
})

test('parts fit, join back to the text, and never split a surrogate pair', () => {
  const text = `${'it\'s "quoted"\n'.repeat(500)}${'😀'.repeat(300)}${'\u0001'.repeat(100)}é€`
  for (const max of [7, 64, 1000]) {
    const parts = splitForJson(text, max)
    assert.equal(parts.join(''), text)
    for (const part of parts) {
      assert.ok(encoded(part) - 2 <= max, `${encoded(part) - 2} > ${max}`)
      assert.ok(!/^[\udc00-\udfff]/.test(part) && !/[\ud800-\udbff]$/.test(part), 'split inside a pair')
    }
  }
  assert.deepEqual(splitForJson('', 10), [''])
})

/** A fake worker that enforces Orca's 64 KiB input cap and rebuilds uploads. */
function fakeWorker() {
  const sent: { name: string; bytes: number }[] = []
  let upload = ''
  const request = async (name: string, input: Record<string, unknown>): Promise<never> => {
    const bytes = encoded(input)
    sent.push({ name, bytes })
    if (bytes > 64 * 1024) throw new Error(`input ${bytes} bytes is over 64 KiB`)
    if (name === 'query.append') {
      assert.equal(input.offset, upload.length)
      upload += input.part as string
      return { uploadId: 'u1' } as never
    }
    return { runId: 'r1', sql: input.uploadId ? upload : input.sql } as never
  }
  return { request, sent }
}

const input = (sql: string) => ({ consoleId: 'c1', connectionId: 'x', database: '', sql, firstLine: 1 })

test('a script that fits goes in one query.run', async () => {
  const { request, sent } = fakeWorker()
  await sendRun(request as never, input('SELECT 1'))
  assert.deepEqual(sent.map((s) => s.name), ['query.run'])
})

test('a script heavy in quotes and newlines goes in parts, each under the cap', async () => {
  // 40 KB of text, but quotes and newlines double in JSON: about 70 KB encoded.
  const sql = `PRINT '${'"\n'.repeat(20_000)}'`
  assert.ok(encoded(sql) > 64 * 1024)
  const { request, sent } = fakeWorker()
  const answer = (await sendRun(request as never, input(sql))) as unknown as { sql: string }
  assert.equal(answer.sql, sql)
  assert.ok(sent.length >= 3)
  assert.deepEqual(new Set(sent.slice(0, -1).map((s) => s.name)), new Set(['query.append']))
  assert.ok(sent.every((s) => s.bytes <= MAX_REQUEST_BYTES), JSON.stringify(sent.map((s) => s.bytes)))
})

test('too large a script is refused before anything is sent', async () => {
  const { request, sent } = fakeWorker()
  await assert.rejects(sendRun(request as never, input('x'.repeat(MAX_SCRIPT_BYTES + 1))), /Script too large/)
  assert.equal(sent.length, 0)
})
