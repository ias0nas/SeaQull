// Microsoft Entra ID access tokens for Azure SQL from the Azure CLI (`az login`).
//
// Orca starts with the minimal macOS GUI PATH (/usr/bin:/bin:/usr/sbin:/sbin) and workers inherit
// it, so a bare `az` is usually not found. Resolve it from the `azPath` setting, then PATH, then the
// usual install locations, and give the child a PATH that includes its own directory (az is a
// script whose interpreter may sit beside it).
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

const SQL_RESOURCE = 'https://database.windows.net/'
const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin']
const REFRESH_MARGIN_MS = 5 * 60_000

type CachedToken = { token: string; expiresAt: number }
/** By az executable: a different CLI (setting changed) may be signed in as someone else. */
const cache = new Map<string, CachedToken>()
/** Token requests in flight, so tabs connecting at once share one az run. */
const pending = new Map<string, Promise<CachedToken>>()

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findAz(configuredPath: string | undefined): Promise<string> {
  if (configuredPath?.trim()) {
    if (await isExecutable(configuredPath.trim())) return configuredPath.trim()
    throw new Error(`Azure CLI not found at "${configuredPath}" (SeaQull setting "Azure CLI path").`)
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...KNOWN_DIRS]
  for (const dir of dirs) {
    const candidate = join(dir, process.platform === 'win32' ? 'az.cmd' : 'az')
    if (await isExecutable(candidate)) return candidate
  }
  throw new Error(
    'Azure CLI (az) not found. Install it and run `az login`, or set its full path in Orca Settings → SeaQull → "Azure CLI path".'
  )
}

/** Bumped by clearTokenCache: a token whose request started before a clear is neither cached nor
 *  handed out (it may be the very token the clear was for). */
let generation = 0

/** A token for Azure SQL, cached until five minutes before it expires. `fetch` is for tests. */
export async function getSqlAccessToken(configuredAzPath: string | undefined, fetch = fetchToken): Promise<string> {
  const az = await findAz(configuredAzPath)
  for (;;) {
    const hit = cache.get(az)
    if (hit && hit.expiresAt - REFRESH_MARGIN_MS > Date.now()) return hit.token
    const started = generation
    let request = pending.get(az)
    if (!request) {
      const mine: Promise<CachedToken> = fetch(az).finally(() => {
        if (pending.get(az) === mine) pending.delete(az)
      })
      pending.set(az, (request = mine))
    }
    const token = await request
    // Cleared while az ran: ask again, for a token fetched after the clear.
    if (generation !== started) continue
    cache.set(az, token)
    return token.token
  }
}

async function fetchToken(az: string): Promise<CachedToken> {
  const env = { ...process.env, PATH: [dirname(az), process.env.PATH, ...KNOWN_DIRS].filter(Boolean).join(delimiter) }
  const args = ['account', 'get-access-token', '--resource', SQL_RESOURCE, '--output', 'json']
  // Windows: az is az.cmd, a batch file, which execFile can only start through cmd.exe.
  const [file, argv, extra] =
    process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${az}" ${args.join(' ')}"`], { windowsVerbatimArguments: true }]
      : [az, args, {}]
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      file,
      argv,
      { env, timeout: 60_000, maxBuffer: 1024 * 1024, ...extra },
      (err, out, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ')
          reject(new Error(/az login/i.test(detail) ? `Not signed in to Azure: run \`az login\`. (${detail})` : `az failed: ${detail}`))
        } else resolve(out)
      }
    )
  })
  return parseTokenOutput(stdout, Date.now())
}

/** Reads `az account get-access-token` JSON: `expires_on` (epoch seconds, newer CLIs) or
 *  `expiresOn` (local date-time, older ones); 30 minutes when neither parses. */
export function parseTokenOutput(stdout: string, now: number): CachedToken {
  let parsed: { accessToken?: unknown; expires_on?: unknown; expiresOn?: unknown }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('az printed something that is not JSON')
  }
  if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) throw new Error('az returned no access token')
  const seconds = Number(parsed.expires_on)
  const expiresAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(String(parsed.expiresOn ?? '')) || now + 30 * 60_000
  return { token: parsed.accessToken, expiresAt }
}

/** Forget cached tokens: after a login fails with one (say the user ran `az login` again as
 *  someone else), or before an explicit connection test. */
export function clearTokenCache(): void {
  generation++
  cache.clear()
  pending.clear()
}
