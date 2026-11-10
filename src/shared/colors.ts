// Connection colours: a fixed palette that reads in light and dark themes, or any #rrggbb.

export const PALETTE: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#e5534b' },
  { name: 'Orange', hex: '#e0823d' },
  { name: 'Yellow', hex: '#d4a72c' },
  { name: 'Green', hex: '#3fb950' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Purple', hex: '#a371f7' }
]

const HEX_RE = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i

/** `#rrggbb` in lower case, or undefined for anything else (empty means no colour). */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = HEX_RE.exec(value.trim())
  if (!match) return undefined
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1]
  return `#${hex.toLowerCase()}`
}
