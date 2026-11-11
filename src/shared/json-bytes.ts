// The size of text inside a JSON string, UTF-8 encoded, as Orca measures requests and answers: a
// quote or a newline takes two bytes there, `é` two, `€` three, a control character six.

/** Bytes the code unit at `i` (with the next, for a surrogate pair) takes, and how many code units
 *  that is. */
export function jsonUnitAt(text: string, i: number): [bytes: number, units: number] {
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

export function jsonStringBytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; ) {
    const [b, units] = jsonUnitAt(text, i)
    bytes += b
    i += units
  }
  return bytes
}

/** How far from `from` the text fits in `maxBytes`, never inside a surrogate pair: the end index
 *  and the bytes up to it. */
export function jsonFit(text: string, from: number, maxBytes: number): [end: number, bytes: number] {
  let bytes = 0
  let i = from
  while (i < text.length) {
    const [b, units] = jsonUnitAt(text, i)
    if (bytes + b > maxBytes) break
    bytes += b
    i += units
  }
  return [i, bytes]
}
