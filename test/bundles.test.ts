// The committed bundles (worker/dist/main.mjs, the manifest's `main`, and editor/vendor/codemirror.js)
// must be what the source builds to: rebuilt in memory and compared. Fails after a change to worker/,
// src/ or CodeMirror until `npm run build` is run (and before `orca plugin dev load`, which loads
// the worker bundle, not the source).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const bundles = '../dev/scripts/bundles.mjs'
const { staleFiles } = (await import(bundles)) as { staleFiles: (name: string) => Promise<string[]> }

for (const name of ['worker', 'editor']) {
  test(`the committed ${name} bundle matches its source`, async () => {
    assert.deepEqual(await staleFiles(name), [], 'run `npm run build`')
  })
}
