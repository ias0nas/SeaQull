// Servers given as an IP address (IPv4 or IPv6) over TLS.
//
// tedious negotiates TDS 7.x encryption with `tls.connect({ servername: <server> })`. An IP address
// is not a valid SNI name (RFC 6066): Node 24 warns, and Node 25 throws ("Setting the TLS
// ServerName to an IP address is not permitted"), so `server: '127.0.0.1'` cannot connect.
// For an IP, the right request is no SNI and the certificate checked against that IP, which is
// what tls.connect does when the IP comes as `host` instead of `servername`. This wraps
// tls.connect to move it there; every other call is passed through untouched.
//
// tedious copies the tls module's functions when it loads (Babel's interop), so this has to run
// first, and must not import tedious itself: mssql.ts imports it before tedious, then runs
// `ipServernameProblem`, which pushes an IP through tedious's own TLS start and logs a warning if
// the wrapper was not used (only IP servers would fail, on Node 25); the unit tests fail on it.
import { isIP } from 'node:net'
import { Duplex } from 'node:stream'
import tls from 'node:tls'

/** tls.connect's options with an IP `servername` moved to `host`; anything else unchanged. */
export function withoutIpServername<T>(options: T): T {
  if (!options || typeof options !== 'object') return options
  const { servername, ...rest } = options as { servername?: unknown; host?: unknown }
  if (typeof servername !== 'string' || !isIP(servername)) return options
  return { ...rest, host: rest.host ?? servername } as T
}

let probe: (() => void) | undefined
const connect = tls.connect
tls.connect = function (this: unknown, ...args: unknown[]) {
  probe?.()
  return (connect as (...a: unknown[]) => tls.TLSSocket).apply(this, [withoutIpServername(args[0]), ...args.slice(1)])
} as typeof tls.connect

type MessageIo = { startTls(details: object, hostname: string, trust: boolean): Promise<void>; securePair?: { cleartext: tls.TLSSocket } }
type MessageIoClass = new (socket: Duplex, packetSize: number, debug: object) => MessageIo

/**
 * Starts TLS towards an IP through tedious's MessageIO (its module namespace), on a socket that
 * goes nowhere, and says whether the wrapper above was used. Synchronous: startTls calls
 * tls.connect before it returns. Only servers given as IP addresses depend on it, so mssql.ts
 * logs a warning when it fails rather than stopping the worker; the unit tests fail on it.
 */
export function ipServernameProblem(messageIoModule: unknown): string | undefined {
  const exports = (messageIoModule as { default?: { default?: MessageIoClass } | MessageIoClass }).default
  const MessageIO = (typeof exports === 'function' ? exports : exports?.default) as MessageIoClass | undefined
  if (typeof MessageIO !== 'function') return 'cannot find tedious MessageIO (check the tedious version)'
  const nowhere = new Duplex({ read() {}, write(_chunk, _encoding, done) { done() } })
  // tedious's Debug, quiet: log, packet, data, payload, token… all do nothing.
  const quiet = new Proxy({}, { get: () => () => undefined })
  const io = new MessageIO(nowhere, 4096, quiet)
  let seen = false
  probe = () => (seen = true)
  try {
    io.startTls({}, '127.0.0.1', true).catch(() => undefined)
  } catch (err) {
    return `tedious's TLS start fails for IP servers (${(err as Error).message})`
  } finally {
    probe = undefined
    io.securePair?.cleartext.destroy()
    nowhere.destroy()
  }
  return seen ? undefined : 'tedious does not use the tls.connect that handles IP servers (check the tedious version, and that tls-ip.ts loads before tedious)'
}
