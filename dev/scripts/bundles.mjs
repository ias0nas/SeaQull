// The two committed bundles, built with esbuild. Orca loads the plugin folder as it is, without
// `npm install`, so whatever the plugin imports from node_modules must be bundled and committed:
//   worker   worker/main.ts and tedious (with its dependencies) → worker/dist/main.mjs, the
//            manifest's `main`, for Orca's Node
//   editor   the CodeMirror 6 parts the console uses (dev/codemirror.entry.ts) →
//            editor/vendor/codemirror.js, which the page imports by relative path: its sandboxed
//            frame cannot load bare imports
// Each comes with a .LICENSE.txt holding the licence of every package in it. Neither is minified
// (Orca's plugin listing policy: no minified code; bundling is fine with the source in the repo).
// The output depends only on the sources, the installed packages (package-lock.json) and esbuild's
// exact version, so `npm run check:bundles` (and a unit test) can rebuild it in memory and compare.
// Used by build.mjs (npm run build, build:worker, build:editor, check:bundles) and the tests.
import { build } from 'esbuild'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Licences the bundles may contain (SPDX ids); anything else fails the build until checked. */
const ALLOWED_LICENCES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD'])

export const BUNDLES = {
  worker: {
    entry: 'worker/main.ts',
    out: 'worker/dist/main.mjs',
    notices: 'worker/dist/main.LICENSE.txt',
    title: 'The SeaQull worker (worker/main.ts and what it imports) with tedious and its dependencies',
    options: {
      platform: 'node',
      target: 'node22',
      // tedious and its dependencies are CommonJS and require() Node's modules; an ES module has no
      // `require`, so give the bundle one.
      banner: { js: "import { createRequire as __seaqullCreateRequire } from 'node:module';\nconst require = __seaqullCreateRequire(import.meta.url);" }
    }
  },
  editor: {
    entry: 'dev/codemirror.entry.ts',
    out: 'editor/vendor/codemirror.js',
    notices: 'editor/vendor/codemirror.LICENSE.txt',
    title: 'CodeMirror 6 (MIT) and its dependencies, for the SeaQull console (from dev/codemirror.entry.ts)',
    options: { platform: 'browser', target: 'es2022' }
  }
}

/**
 * Builds one bundle in memory: resolves to its files (repo-relative path → contents) and a
 * one-line summary. Nothing is written.
 */
export async function buildBundle(name) {
  const spec = BUNDLES[name]
  if (!spec) throw new Error(`Unknown bundle ${name}: ${Object.keys(BUNDLES).join(', ')}`)
  const notices = spec.notices.split('/').pop()
  const header = `/* ${spec.title}. Built by \`npm run build\`; do not edit, rebuild. Licences: ${notices}. */`
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [spec.entry],
    outfile: spec.out,
    bundle: true,
    format: 'esm',
    minify: false,
    legalComments: 'eof',
    charset: 'utf8',
    metafile: true,
    write: false,
    logLevel: 'warning',
    ...spec.options,
    banner: { js: [header, spec.options.banner?.js].filter(Boolean).join('\n') }
  })
  const [output] = result.outputFiles
  const code = output.text
  if (code.includes(ROOT)) throw new Error(`${spec.out} contains the absolute path ${ROOT}: it would not be reproducible`)

  // The packages that ended up in the bundle (tree shaking drops some that are imported), by the
  // folder each module came from, so a nested second version gets its own entry.
  const [meta] = Object.values(result.metafile.outputs)
  const packages = new Map()
  for (const [input, { bytesInOutput }] of Object.entries(meta.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
    if (match && bytesInOutput > 0) packages.set(match[1], (packages.get(match[1]) ?? 0) + bytesInOutput)
  }
  const sections = []
  const names = []
  for (const dir of [...packages.keys()].sort()) {
    const pkg = JSON.parse(await readFile(join(ROOT, dir, 'package.json'), 'utf8'))
    if (!ALLOWED_LICENCES.has(pkg.license)) throw new Error(`${pkg.name} ${pkg.version} (${dir}) is licensed ${JSON.stringify(pkg.license)}: check it may be bundled, then add it to ALLOWED_LICENCES`)
    names.push(pkg.name)
    const files = (await readdir(join(ROOT, dir))).filter((f) => /^(licen[cs]e|notice)/i.test(f)).sort()
    const texts = []
    for (const file of files) texts.push((await readFile(join(ROOT, dir, file), 'utf8')).trim())
    if (texts.length === 0) texts.push(missingLicenceText(pkg))
    sections.push(`${pkg.name} ${pkg.version} (${pkg.license})\n${'-'.repeat(60)}\n${texts.join('\n\n')}`)
  }
  const noticesText = `Third-party software in ${spec.out.split('/').pop()}, with the licence of each package.\n\n${sections.join('\n\n\n')}\n`

  const summary = `${spec.out}: ${(Buffer.byteLength(code) / 1024).toFixed(0)} KB, ${packages.size} packages: ${[...new Set(names)].sort().join(', ')}`
  return { files: new Map([[spec.out, code], [spec.notices, noticesText]]), summary }
}

/** A package that declares MIT in package.json but ships no licence file (proxy-agent-negotiate):
 *  the standard MIT text, with its author as the copyright holder. */
function missingLicenceText(pkg) {
  if (pkg.license !== 'MIT') throw new Error(`${pkg.name} ${pkg.version} has no licence file`)
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return `(The package ships no licence file; its package.json declares MIT${repo ? `, source ${repo}` : ''}. The MIT licence text:)

MIT License

Copyright (c) ${author ?? `the ${pkg.name} authors`}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`
}

/** The committed files that differ from a fresh build (missing ones included), repo-relative. */
export async function staleFiles(name) {
  const { files } = await buildBundle(name)
  const stale = []
  for (const [path, contents] of files) {
    const committed = await readFile(join(ROOT, path), 'utf8').catch(() => null)
    if (committed !== contents) stale.push(relative(ROOT, join(ROOT, path)))
  }
  return stale
}
