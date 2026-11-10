# Contributing to SeaQull

Bug reports and pull requests are welcome. For anything larger than a fix, please open an issue
first so we can agree on the approach.

## Setup

You need Node.js 22.18 or newer (the tests run TypeScript directly), the Orca desktop app, and
Docker for the integration tests.

```sh
npm install
npm run typecheck   # fetches Orca's plugin typings into .orca/types, then runs tsc
npm test            # unit tests
```

## Project layout

| Path | Contents |
|---|---|
| `orca-plugin.json` | Plugin manifest: the console editor for `.seaqull` and `.sql` files, *New SeaQull workbook*, settings, status bar item |
| `worker/` | The Node worker: database connections and queries (tedious), saved connections, sessions, exports |
| `worker/dist/` | `main.mjs`, the worker bundled with its dependencies (built and committed; this is what Orca runs), and its licence notices |
| `editor/` | The console page (a sandboxed frame): explorer, query tabs, SQL editor (CodeMirror 6), result grid |
| `editor/vendor/` | `codemirror.js`, the CodeMirror bundle the console imports (built and committed), its types and licence notices |
| `src/protocol.ts` | The typed request contract between console and worker |
| `src/shared/` | Code used by both sides: workbook format, SQL parsing helpers, export formats |
| `test/` | `*.test.ts` unit tests; `*.itest.ts` integration tests against a local SQL Server |
| `dev/` | Build, preview and check scripts, the CodeMirror bundle's entry point, the local SQL Server |

## Scripts

```sh
npm run typecheck        # tsc for the worker, shared code and tests (with Node types) and the console (without)
npm test                 # unit tests, including a check that the committed bundles are up to date
npm run test:integration # integration tests against the local SQL Server (below)
npm run validate         # orca plugin validate + orca plugin check
npm run preview          # the console in your browser at http://127.0.0.1:5178, without Orca

npm run build            # rebuild both bundles
npm run build:worker     # just the worker, after changing worker/ or src/
npm run build:watch      # rebuild the worker whenever worker/ or src/ changes
npm run build:editor     # just CodeMirror, after changing @codemirror/* or dev/codemirror.entry.ts
npm run check:bundles    # fail if a committed bundle differs from a fresh build
npm run check:package    # load the plugin as Orca gets it, without node_modules, on your Node and Orca's
```

## Running in Orca

```sh
npm run dev:load                     # build, then load this folder as a development plugin
orca plugin dev watch .              # reload on change and stream logs (pair with npm run build:watch)
orca plugin restart local.seaqull    # restart the worker (a reload alone keeps a running worker)
orca plugin logs local.seaqull       # worker output
orca plugin dev request . connections.list --data '{}'   # call a worker handler directly
```

## Bundles

Orca loads the plugin folder as it is, without running `npm install`. So everything the plugin
imports from `node_modules` is bundled with esbuild and committed:

- **Worker:** the manifest's `main` is `worker/dist/main.mjs`, which is `worker/main.ts` and `src/`
  plus tedious and its dependencies. Orca runs the bundle, not the source, so rebuild after
  changing `worker/` or `src/`. The tests and the preview run the source.
- **Editor:** the console's sandboxed frame can't resolve bare imports, so the CodeMirror parts it
  uses are bundled into `editor/vendor/codemirror.js`. Add new exports in
  `dev/codemirror.entry.ts`.

Neither bundle is minified, and each comes with a `.LICENSE.txt` listing the licence of every
package in it. Builds are reproducible: they depend only on the sources, `package-lock.json` and
the pinned esbuild version. `npm test` and `npm run check:bundles` fail if a committed bundle is out
of date.

tedious reads `decimal`, `numeric` and `money` as JavaScript numbers, and `datetimeoffset` as UTC.
`worker/exact-values.ts` wraps its value reader to return exact text instead. Because that relies
on tedious internals, tedious is pinned to an exact version. The worker refuses to start, and the
tests fail, if an update breaks it.

Plugin constraints to keep in mind:
- pure JavaScript only, with no native modules or binaries
- at most 2,000 files and 50 MiB
- no telemetry

## Local SQL Server

The integration tests and the preview use SQL Server in Docker, bound to `127.0.0.1` only.

```sh
npm run db:up        # creates dev/.env with a random SA password, starts SQL Server, waits until healthy
npm run db:seed      # restores AdventureWorks2022, AdventureWorksLT2022 and WideWorldImporters
dev/scripts/db.sh sql "SELECT 1"   # run a query (no argument: interactive sqlcmd)
npm run smoke        # connect and query with tedious on your Node
npm run smoke:orca   # the same on Orca's bundled Node, which workers run on (macOS)
npm run db:down      # stop (dev/scripts/db.sh nuke also deletes the data volume)
```

Set `MSSQL_TAG` or `MSSQL_PORT` in `dev/.env` to change the image or port.

On Apple Silicon, SQL Server runs as x86 under Rosetta. Use OrbStack with Rosetta on
(`orb config set rosetta true`), or Docker Desktop with *Use Rosetta for x86_64/amd64 emulation*.
SQL Server 2025 needs CU1 or later on recent macOS.

## Testing

| Layer | How |
|---|---|
| Parsing, formats, the connection store, `az` lookup and other pure logic | `npm test` |
| Driver, metadata queries, runs, cancel, exports; the worker through a fake Orca host | `npm run test:integration` |
| The console page | `npm run preview` in a browser, then `npm run dev:load` in Orca |

CI runs the typecheck and unit tests on Node 22.18 and 24 on every push and pull request. Please
run the integration tests and `npm run validate` locally before opening a pull request that
touches the worker or the manifest.
