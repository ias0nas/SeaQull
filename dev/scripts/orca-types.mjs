// Writes Orca's plugin typings into .orca/types (what `orca plugin types .` does).
//
// Orca 1.4.251 ships without its typings files, so `orca plugin types` fails with ENOENT. When it
// does, fetch the same files from Orca's source at the installed version's tag and write the same
// layout. Mirrors src/cli/plugin-authoring/plugin-type-files.ts in stablyai/orca.
//
// Usage: node dev/scripts/orca-types.mjs [--force]
// Without Orca installed (CI), set ORCA_VERSION to the version whose typings to fetch.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const typesDir = join(root, '.orca', 'types')
const versionFile = join(typesDir, '.orca-version')
const force = process.argv.includes('--force')

const MODULE_TYPINGS = ['orca.d.ts', 'orca-components.d.ts', 'orca-components-layout.d.ts', 'orca-components-data.d.ts']
const SURFACE_TYPINGS = ['orca-host', 'orca-frame', 'orca-worker', 'orca-services', 'orca-testing']
const TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    allowImportingTsExtensions: true,
    isolatedModules: true,
    jsx: 'react-jsx',
    jsxImportSource: 'orca',
    lib: ['ES2022', 'DOM'],
    preserveSymlinks: true,
    typeRoots: ['.'],
    types: ['orca', ...SURFACE_TYPINGS]
  }
}
const NOTE = '// Written by dev/scripts/orca-types.mjs from Orca source (orca plugin types fallback). Do not edit.\n'

function installedOrcaVersion() {
  if (process.env.ORCA_VERSION) return process.env.ORCA_VERSION.trim()
  try {
    return execFileSync('orca', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return execFileSync('defaults', ['read', '/Applications/Orca.app/Contents/Info.plist', 'CFBundleShortVersionString'], {
      encoding: 'utf8'
    }).trim()
  }
}

const version = installedOrcaVersion()
const current = await readFile(versionFile, 'utf8').catch(() => '')
if (!force && current.trim() === version) {
  console.log(`.orca/types already match Orca ${version}`)
  process.exit(0)
}

try {
  execFileSync('orca', ['plugin', 'types', root], { stdio: 'pipe' })
  await writeFile(versionFile, `${version}\n`)
  console.log(`.orca/types written by orca plugin types (Orca ${version})`)
  process.exit(0)
} catch (err) {
  console.log(`orca plugin types failed (${String(err.stderr ?? err.message).trim().split('\n')[0]}); fetching v${version} typings from GitHub`)
}

const raw = (path) => `https://raw.githubusercontent.com/stablyai/orca/v${version}/resources/plugins/${path}`
async function fetchText(path) {
  const res = await fetch(raw(path))
  if (!res.ok) throw new Error(`GET ${raw(path)} -> ${res.status}`)
  return res.text()
}

const files = { '.gitignore': '*\n' }
files['types/orca/index.d.ts'] = NOTE + (await Promise.all(MODULE_TYPINGS.map((f) => fetchText(`declarative/${f}`)))).join('\n')
for (const dir of SURFACE_TYPINGS) {
  files[`types/${dir}/index.d.ts`] = NOTE + (await fetchText(`types/${dir}.d.ts`))
}
files['types/tsconfig.json'] = `${JSON.stringify(TSCONFIG, null, 2)}\n`
files['types/.orca-version'] = `${version}\n`

for (const [file, content] of Object.entries(files)) {
  const path = join(root, '.orca', file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
console.log(`.orca/types written from stablyai/orca v${version}`)
