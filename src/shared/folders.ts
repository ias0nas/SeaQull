// Connection folders: an optional `/`-separated path on each saved connection (the stored list
// stays flat); the explorer and the toolbar picker group connections by it.

/** Trimmed segments without empty ones (split on `/` or `\`), joined with `/`; '' for none. */
export function normalizeFolder(path: unknown): string {
  return typeof path === 'string' ? folderSegments(path).join('/') : ''
}

export function folderSegments(path: string | undefined): string[] {
  return (path ?? '')
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Where `folder` goes when the folder `from` is renamed to `to` (both normalized); undefined when
 *  it is neither `from` nor inside it. */
export function movedFolder(folder: string | undefined, from: string, to: string): string | undefined {
  if (!folder) return undefined
  if (folder === from) return to
  return folder.startsWith(`${from}/`) ? `${to}${folder.slice(from.length)}` : undefined
}

/** Every folder in use, parents included, in tree order. */
export function folderPaths(folders: (string | undefined)[]): string[] {
  const paths = new Set<string>()
  for (const folder of folders) {
    const segments = folderSegments(folder)
    for (let i = 1; i <= segments.length; i++) paths.add(segments.slice(0, i).join('/'))
  }
  return [...paths].sort(compareNames)
}

/** Case-insensitive, then exact, so the order is stable. */
export const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)
