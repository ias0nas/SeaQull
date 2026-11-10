// Checks the plugin as Orca would get it: the repository's files only, no node_modules.
//   npm run check:package
// Copies the tracked files plus new, not ignored ones (what the next commit would hold, with
// node_modules/, dev/.env and the rest of .gitignore left out) into an empty temporary folder,
// checks Orca's size limits, then imports the manifest's `main` from there in a separate Node
// process and checks its default export is a function. With dev/.env (the local SQL Server), that
// process also starts the worker on a stand-in host and runs a query through it, checking exact
// decimals and datetimeoffset come back. Runs on your Node, and on Orca's own when Orca is
// installed in /Applications.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './bundles.mjs'

const MAX_FILES = 2000
const MAX_BYTES = 50 * 1024 * 1024
const ORCA = '/Applications/Orca.app/Contents/MacOS/Orca'

// Runs in the child process: argv[2] is the worker entry's file URL.
const PROBE = `
const fail = (message) => { console.log(message); process.exit(1) }
const worker = await import(process.argv[2])
if (typeof worker.default !== 'function') fail('main has no default export function')
const report = ['imports, default export is a function (Node ' + process.version + ')']
const password = process.env.MSSQL_SA_PASSWORD
if (password) {
  const handlers = new Map(), storage = new Map(), secrets = new Map()
  await worker.default({
    host: { call: async () => ({ ok: true }) },
    panels: { handle: (name, handler) => (handlers.set(name, handler), { dispose() {} }), post() {} },
    storage: { get: async (k) => storage.get(k) ?? null, set: async (k, v) => void storage.set(k, structuredClone(v)), delete: async (k) => void storage.delete(k), keys: async () => [...storage.keys()], onDidChange: () => ({ dispose() {} }) },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    settings: { get: async (k) => (k === 'maxRows' ? 10000 : ''), set: async () => {}, onDidChange: () => ({ dispose() {} }) },
    grantedCapabilities: [], log() {}
  })
  const context = { panel: { id: 'probe', surface: 'editor', contributionId: 'console' }, signal: new AbortController().signal }
  const call = (name, input) => handlers.get(name)(input, context)
  const connection = await call('connections.save', {
    name: 'Probe', server: '127.0.0.1', // an IP: TLS without SNI (worker/tls-ip.ts)
    port: Number(process.env.MSSQL_PORT ?? 1433), database: '',
    auth: { kind: 'sql', user: 'sa' }, password, encrypt: true, trustServerCertificate: true
  })
  const sql = "SELECT CAST('12345678901234567890.123456789' AS decimal(38,9)), CAST(1.10 AS decimal(10,2)), CAST('922337203685477.5807' AS money), CAST('2026-01-02 03:04:05.1234567 +05:30' AS datetimeoffset)"
  const { runId } = await call('query.run', { consoleId: 'probe', connectionId: connection.id, database: '', sql, firstLine: 1 })
  let status
  for (let i = 0; i < 200; i++) {
    status = await call('query.status', { runId })
    if (status.state !== 'running') break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (status.state !== 'done') fail('query ' + status.state + ': ' + JSON.stringify(status.messages))
  const { rows } = await call('query.rows', { runId, result: 0, offset: 0, limit: 10 })
  const expected = ['12345678901234567890.123456789', '1.10', '922337203685477.5807', '2026-01-02 03:04:05.1234567 +05:30']
  if (JSON.stringify(rows[0]) !== JSON.stringify(expected)) fail('wrong values: ' + JSON.stringify(rows[0]))
  await call('query.close', { consoleId: 'probe' })
  report.push('ran a query on the local SQL Server at 127.0.0.1, values exact')
  if (worker.deactivate) await worker.deactivate()
}
console.log(report.join('; '))
process.exit(0)
`

const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
const files = listed.split('\0').filter((f) => f && existsSync(join(ROOT, f)))
const folder = await mkdtemp(join(tmpdir(), 'seaqull-package-'))
const probeFolder = await mkdtemp(join(tmpdir(), 'seaqull-probe-'))
let failed = false
try {
  let bytes = 0
  for (const file of files) {
    await cp(join(ROOT, file), join(folder, file))
    bytes += (await stat(join(ROOT, file))).size
  }
  const size = `${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB`
  if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error(`Over Orca's limits (${MAX_FILES} files, 50 MiB): ${size}`)
  console.log(`Package: ${size} (limits ${MAX_FILES} files, 50 MiB)`)

  const manifest = JSON.parse(await readFile(join(folder, 'orca-plugin.json'), 'utf8'))
  const main = pathToFileURL(join(folder, manifest.main)).href
  // Its own folder, away from the repo, so nothing resolves from the repo's node_modules.
  const probe = join(probeFolder, 'probe.mjs')
  await writeFile(probe, PROBE)
  const runtimes = [['your Node', process.execPath, {}]]
  if (existsSync(ORCA)) runtimes.push(["Orca's Node", ORCA, { ELECTRON_RUN_AS_NODE: '1' }])
  for (const [label, exe, env] of runtimes) {
    try {
      const out = execFileSync(exe, [probe, main], { cwd: probeFolder, env: { ...process.env, ...env }, encoding: 'utf8' })
      console.log(`${label}: ${out.trim()}`)
    } catch (err) {
      failed = true
      console.error(`${label}: FAILED\n${err.stdout ?? ''}${err.stderr ?? err.message}`)
    }
  }
} finally {
  await rm(folder, { recursive: true, force: true })
  await rm(probeFolder, { recursive: true, force: true })
}
if (failed) process.exit(1)
