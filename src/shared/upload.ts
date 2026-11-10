// Sending a script to run. Orca caps a request's input at 64 KiB of JSON, measured after encoding:
// a quote or a newline takes two bytes there, `é` two, `€` three, a control character six. A script
// that does not fit in one query.run goes in parts (query.append), each measured the same way, then
// runs by its upload id. Shared by the console page and the integration tests.
import type { PluginRequestInput, PluginRequestOutput } from 'orca'

/** Well under Orca's 64 KiB input cap, for each request as a whole. */
export const MAX_REQUEST_BYTES = 48 * 1024
/** Room in a query.append request for everything but the part (ids, offset, field names). */
const APPEND_OVERHEAD = 1024
/** The worker refuses larger scripts (worker/runs.ts checks it too). */
export const MAX_SCRIPT_BYTES = 10 * 1024 * 1024

/** Bytes the code unit at `i` (with the next, for a surrogate pair) takes in a JSON string, UTF-8
 *  encoded, and how many code units that is. */
function unitAt(text: string, i: number): [bytes: number, units: number] {
  const c = text.charCodeAt(i)
  if (c === 0x22 || c === 0x5c) return [2, 1] // \" \\
  if (c < 0x20) return [c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6, 1] // \n or \u0001
  if (c < 0x80) return [1, 1]
  if (c < 0x800) return [2, 1]
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return [4, 2] // a pair: one 4-byte character
  }
  if (c >= 0xd800 && c <= 0xdfff) return [6, 1] // a lone surrogate: \udxxx
  return [3, 1]
}

/** UTF-8 bytes of `text` as the inside of a JSON string. */
export function jsonStringBytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; ) {
    const [b, units] = unitAt(text, i)
    bytes += b
    i += units
  }
  return bytes
}

/** Splits `text` into parts of at most `maxBytes` each as JSON strings, never inside a
 *  surrogate pair. Joined, they are `text` again. */
export function splitForJson(text: string, maxBytes: number): string[] {
  const parts: string[] = []
  let start = 0
  let bytes = 0
  for (let i = 0; i < text.length; ) {
    const [b, units] = unitAt(text, i)
    if (bytes + b > maxBytes && i > start) {
      parts.push(text.slice(start, i))
      start = i
      bytes = 0
    }
    bytes += b
    i += units
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start))
  return parts
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

type Request = <K extends 'query.run' | 'query.append'>(name: K, input: PluginRequestInput<K>) => Promise<PluginRequestOutput<K>>

/** Starts a run of `input.sql`: one query.run when it fits, otherwise query.append parts and then
 *  query.run with the upload id. Too large a script is refused here, before anything is sent. */
export async function sendRun(request: Request, input: PluginRequestInput<'query.run'>): Promise<{ runId: string }> {
  if (utf8Bytes(JSON.stringify(input)) <= MAX_REQUEST_BYTES) return request('query.run', input)
  if (utf8Bytes(input.sql) > MAX_SCRIPT_BYTES) {
    throw new Error(`Script too large: SeaQull runs at most ${MAX_SCRIPT_BYTES / 1024 / 1024} MB at once. Run it in parts (select one, then ⌘↵).`)
  }
  let uploadId: string | undefined
  let offset = 0
  for (const part of splitForJson(input.sql, MAX_REQUEST_BYTES - APPEND_OVERHEAD)) {
    ;({ uploadId } = await request('query.append', { consoleId: input.consoleId, ...(uploadId ? { uploadId } : {}), offset, part }))
    offset += part.length
  }
  return request('query.run', { ...input, sql: '', uploadId })
}
