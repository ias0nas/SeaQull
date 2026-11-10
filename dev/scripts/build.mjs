// Builds the committed bundles (see bundles.mjs), or checks them.
//   npm run build            both: worker/dist/main.mjs and editor/vendor/codemirror.js
//   npm run build:worker     the worker only (after changing worker/ or src/, before `orca plugin dev load`)
//   npm run build:editor     CodeMirror only (after changing CodeMirror packages or dev/codemirror.entry.ts)
//   npm run build:watch      rebuild the worker whenever worker/ or src/ changes (Node's --watch-path)
//   npm run check:bundles    rebuild in memory and fail if the committed files differ (npm test does too)
//   npm run dev:load         build, then `orca plugin dev load .`
// Files whose contents did not change are not written, so a watch on worker/ does not loop.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BUNDLES, buildBundle, ROOT, staleFiles } from './bundles.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const names = args.filter((a) => !a.startsWith('--'))
for (const name of names) if (!(name in BUNDLES)) throw new Error(`Unknown bundle ${name}: ${Object.keys(BUNDLES).join(', ')}`)
const chosen = names.length ? names : Object.keys(BUNDLES)

if (check) {
  const stale = (await Promise.all(chosen.map(staleFiles))).flat()
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run \`npm run build\` and commit the result.`)
    process.exit(1)
  }
  console.log(`Bundles up to date: ${chosen.join(', ')}`)
} else {
  for (const name of chosen) {
    const { files, summary } = await buildBundle(name)
    for (const [path, contents] of files) {
      if ((await readFile(join(ROOT, path), 'utf8').catch(() => null)) === contents) continue
      await mkdir(dirname(join(ROOT, path)), { recursive: true })
      await writeFile(join(ROOT, path), contents)
    }
    console.log(summary)
  }
}
