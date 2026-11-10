// Runs the SQL console page in an ordinary browser, outside Orca, for quick UI work:
//   npm run preview  →  http://127.0.0.1:5178/
// The page gets a stand-in `orca` object whose plugin.request calls the real worker code in this
// process (worker/main.ts), against the dev SQL Server, with in-memory storage and secrets and a
// "Local" connection already saved. Documents live in memory until the server stops: ?doc=workbook
// opens a .seaqull workbook, otherwise a .sql file.
// TypeScript is served with types stripped (Node's own stripper), as Orca does with sucrase.
// Not in the plugin: dev only. Listens on 127.0.0.1 only, and refuses requests that could come from
// another website: the Host must be this server (no DNS rebinding) and API calls must carry a
// random token that only the page this server serves knows (no cross-site requests). The worker
// behind it holds the SA password and runs SQL, so both matter.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import activate from '../../worker/main.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORT = Number(process.env.PREVIEW_PORT ?? 5178)
const TOKEN = randomBytes(24).toString('hex')
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const SERVED = ['editor', 'src', 'templates']
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/javascript', '.sql': 'text/plain' }

// --- The worker, on a fake host --------------------------------------------------------------
const handlers = new Map()
const storage = new Map()
const secrets = new Map()
const host = {
  // The status-bar item (Orca's status bar is not here): print its changes.
  host: { call: async (method, params) => (console.log(`[${method}]`, JSON.stringify(params)), { ok: true }) },
  log: (message) => console.log(message),
  panels: { handle: (name, handler) => (handlers.set(name, handler), { dispose() {} }), post() {} },
  storage: {
    get: async (key) => storage.get(key) ?? null,
    set: async (key, value) => void storage.set(key, structuredClone(value)),
    delete: async (key) => void storage.delete(key),
    keys: async () => [...storage.keys()],
    onDidChange: () => ({ dispose() {} })
  },
  secrets: {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => void secrets.set(key, value),
    delete: async (key) => void secrets.delete(key)
  },
  settings: { get: async (key) => (key === 'maxRows' ? 10_000 : ''), set: async () => {}, onDidChange: () => ({ dispose() {} }) }
}
await activate(host)
const context = { panel: { id: 'preview-editor', surface: 'editor', contributionId: 'console' }, signal: new AbortController().signal }
if (process.env.MSSQL_SA_PASSWORD) {
  await handlers.get('connections.save')(
    {
      name: 'Local',
      server: 'localhost',
      port: Number(process.env.MSSQL_PORT ?? 1433),
      database: '',
      auth: { kind: 'sql', user: 'sa' },
      password: process.env.MSSQL_SA_PASSWORD,
      encrypt: true,
      trustServerCertificate: true
    },
    context
  )
} else console.warn('MSSQL_SA_PASSWORD is not set (dev/.env): starting with no connections.')

// One in-memory document per kind: ?doc=workbook opens a .seaqull workbook, otherwise a .sql file.
const documents = {
  sql: '',
  workbook: await readFile(join(ROOT, 'templates/workbook.seaqull'), 'utf8')
}

// --- The page's stand-in for Orca's frame API -------------------------------------------------
const THEMES = {
  dark: {
    background: '#1f1f1f', foreground: '#e4e4e4', card: '#252526', 'card-foreground': '#e4e4e4', border: '#3c3c3c',
    input: '#2a2a2a', muted: '#2c2c2c', 'muted-foreground': '#9d9d9d', accent: '#37373d', 'accent-foreground': '#ffffff',
    primary: '#3b82f6', 'primary-foreground': '#ffffff', secondary: '#2d2d2d', 'secondary-foreground': '#e4e4e4',
    destructive: '#f14c4c', 'destructive-foreground': '#ffffff', popover: '#252526', 'popover-foreground': '#e4e4e4', ring: '#3b82f6', radius: '6px'
  },
  light: {
    background: '#ffffff', foreground: '#1f1f1f', card: '#f7f7f8', 'card-foreground': '#1f1f1f', border: '#e2e2e5',
    input: '#ffffff', muted: '#f1f1f3', 'muted-foreground': '#6b6b74', accent: '#e8e8ec', 'accent-foreground': '#111111',
    primary: '#2563eb', 'primary-foreground': '#ffffff', secondary: '#f1f1f3', 'secondary-foreground': '#1f1f1f',
    destructive: '#dc2626', 'destructive-foreground': '#ffffff', popover: '#ffffff', 'popover-foreground': '#1f1f1f', ring: '#2563eb', radius: '6px'
  }
}

const shim = `
window.orca = (() => {
  const headers = { 'x-preview-token': '__TOKEN__' }
  const call = async (name, input) => {
    const response = await fetch('/__preview/request', { method: 'POST', headers, body: JSON.stringify({ name, input }) })
    const answer = await response.json()
    if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code })
    return answer.value
  }
  const storageListeners = []
  return {
    api: { major: 1, minor: 4 },
    locale: 'en',
    plugin: {
      request: async (name, input) => {
        const value = await call(name, input)
        // The real host notifies other frames of storage writes; mimic it for connection edits.
        if (name === 'connections.save' || name === 'connections.delete') storageListeners.forEach((h) => h({ key: 'connections' }))
        return value
      }
    },
    storage: { onDidChange: (handler) => (storageListeners.push(handler), { dispose() {} }) },
    settings: (() => {
      const values = { explorerSide: 'left', maxRows: 10000, azPath: '' }
      const listeners = []
      return {
        get: async (key) => (key === undefined ? { ...values } : values[key]),
        set: async (key, value) => { values[key] = value; listeners.forEach((h) => h({ key })) },
        onDidChange: (handler) => (listeners.push(handler), { dispose() {} })
      }
    })(),
    document: {
      session: async () => {
        const kind = new URLSearchParams(location.search).get('doc') === 'workbook' ? 'workbook' : 'sql'
        const url = '/__preview/document?kind=' + kind
        const value = await (await fetch(url, { headers })).text()
        let timer = 0
        return {
          value, readOnly: false,
          change(next) { this.value = next; clearTimeout(timer); timer = setTimeout(() => fetch(url, { method: 'POST', headers, body: next }), 300) },
          flush: async () => {}, onReplace: () => ({ dispose() {} }), dispose() {}
        }
      }
    },
    files: {
      saveAs: async ({ suggestedName, mimeType, data }) => {
        const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: mimeType })), download: suggestedName })
        link.click()
        return { status: 'saved' }
      }
    },
    on: () => ({ dispose() {} })
  }
})()
`

function page(html, theme) {
  const tokens = Object.entries(THEMES[theme]).map(([k, v]) => `--orca-${k}: ${v};`).join(' ')
  const head = `<style>:root { ${tokens} color-scheme: ${theme}; }</style><script>${shim.replace('__TOKEN__', TOKEN)}</script>`
  return html.replace('<html>', `<html class="${theme}">`).replace('</head>', `${head}</head>`)
}

// --- Server -----------------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const send = (status, type, body) => {
    // No framing by other sites (the page holds the token and a live connection: clickjacking).
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'"
    })
    res.end(body)
  }
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(403, 'text/plain', 'Forbidden host')
  // API calls need the page's token (a custom header also forces a CORS preflight, which this
  // server never answers, so other origins cannot even send one).
  if (url.pathname.startsWith('/__preview/') && req.headers['x-preview-token'] !== TOKEN) return send(403, 'text/plain', 'Forbidden')
  try {
    if (url.pathname === '/') {
      res.setHeader('location', `/editor/console.html${url.search}`) // keep ?theme= and ?doc=
      return send(302, 'text/plain', '')
    }
    if (url.pathname === '/__preview/request' && req.method === 'POST') {
      const { name, input } = JSON.parse(await body(req))
      const handler = handlers.get(name)
      if (!handler) return send(200, 'application/json', JSON.stringify({ error: { message: `unknown_method ${name}`, code: 'unknown_method' } }))
      try {
        const value = await handler(input, context)
        return send(200, 'application/json', JSON.stringify({ value: value ?? null }))
      } catch (err) {
        return send(200, 'application/json', JSON.stringify({ error: { message: err?.message ?? String(err), code: err?.code } }))
      }
    }
    if (url.pathname === '/__preview/document') {
      const kind = url.searchParams.get('kind') === 'workbook' ? 'workbook' : 'sql'
      if (req.method === 'POST') documents[kind] = await body(req)
      return send(200, 'text/plain; charset=utf-8', documents[kind])
    }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)))
    if (!SERVED.some((dir) => file.startsWith(join(ROOT, dir) + sep))) return send(404, 'text/plain', 'not found')
    const ext = extname(file)
    let content = await readFile(file, 'utf8')
    if (ext === '.ts') content = stripTypeScriptTypes(content, { mode: 'strip' })
    if (ext === '.html') content = page(content, url.searchParams.get('theme') === 'light' ? 'light' : 'dark')
    return send(200, `${TYPES[ext] ?? 'application/octet-stream'}; charset=utf-8`, content)
  } catch (err) {
    return send(err?.code === 'ENOENT' ? 404 : 500, 'text/plain', String(err?.message ?? err))
  }
})

function body(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

server.listen(PORT, '127.0.0.1', () => console.log(`SeaQull console preview: http://127.0.0.1:${PORT}/  (?theme=light for light)`))
