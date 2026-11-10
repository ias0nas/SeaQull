// Add/edit a saved connection, and confirm deleting one, in page-drawn <dialog>s (plugin frames
// get no alert/confirm). Saving goes to the worker: the config to plugin storage, a SQL login
// password to Orca's encrypted secrets.
import type { ConnectionConfig, ConnectionInput } from '../src/protocol.ts'
import { normalizeColor, PALETTE } from '../src/shared/colors.ts'
import { errorText } from './util.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  dialog: $<HTMLDialogElement>('connection-dialog'),
  title: $<HTMLHeadingElement>('cd-title'),
  name: $<HTMLInputElement>('cd-name'),
  swatches: $<HTMLDivElement>('cd-swatches'),
  color: $<HTMLInputElement>('cd-color'),
  server: $<HTMLInputElement>('cd-server'),
  port: $<HTMLInputElement>('cd-port'),
  database: $<HTMLInputElement>('cd-database'),
  auth: $<HTMLSelectElement>('cd-auth'),
  sqlFields: $<HTMLDivElement>('cd-sql-fields'),
  entraNote: $<HTMLParagraphElement>('cd-entra-note'),
  user: $<HTMLInputElement>('cd-user'),
  password: $<HTMLInputElement>('cd-password'),
  encrypt: $<HTMLInputElement>('cd-encrypt'),
  trust: $<HTMLInputElement>('cd-trust'),
  status: $<HTMLParagraphElement>('cd-status'),
  test: $<HTMLButtonElement>('cd-test'),
  save: $<HTMLButtonElement>('cd-save'),
  cancel: $<HTMLButtonElement>('cd-cancel'),
  confirm: $<HTMLDialogElement>('confirm-dialog'),
  confirmText: $<HTMLParagraphElement>('confirm-text'),
  confirmOk: $<HTMLButtonElement>('confirm-ok'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel')
}


let editingId: string | undefined
let onSaved: ((saved: ConnectionConfig) => void | Promise<void>) | undefined
let busy = false
/** Bumped on every open: a Test still running for the previous dialog must not report into this one. */
let session = 0

function setStatus(text: string, tone: 'neutral' | 'success' | 'danger' = 'neutral'): void {
  ui.status.textContent = text
  ui.status.dataset.tone = tone
  ui.status.hidden = !text
}

function syncAuth(): void {
  const entra = ui.auth.value === 'entra'
  ui.sqlFields.hidden = entra
  ui.entraNote.hidden = !entra
  if (entra) ui.encrypt.checked = true
}

function setBusy(value: boolean): void {
  busy = value
  ui.test.disabled = value
  ui.save.disabled = value
  ui.cancel.disabled = value // stay open until a save finishes, so its outcome is seen
}

// --- Colour: a palette swatch, none, or any #rrggbb typed in the box ------------------------------

function swatch(hex: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = hex ? 'swatch' : 'swatch none'
  button.dataset.hex = hex
  button.title = label
  button.setAttribute('role', 'radio')
  button.setAttribute('aria-label', label)
  if (hex) button.style.setProperty('--swatch', hex)
  button.onclick = () => setColor(hex)
  return button
}
ui.swatches.append(swatch('', 'No colour'), ...PALETTE.map((c) => swatch(c.hex, c.name)))

function setColor(hex: string): void {
  ui.color.value = hex
  syncSwatches()
}

function syncSwatches(): void {
  const current = normalizeColor(ui.color.value) ?? ''
  ui.color.classList.toggle('invalid', ui.color.value.trim() !== '' && !current)
  ui.color.style.setProperty('--swatch', current || 'transparent')
  ui.swatches.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.hex === current)))
}
ui.color.addEventListener('input', syncSwatches)

/** Request inputs must be plain JSON: Orca refuses `undefined` values, so optional keys are left out. */
function toInput(): ConnectionInput {
  const sql = ui.auth.value !== 'entra'
  const color = normalizeColor(ui.color.value)
  return {
    ...(color ? { color } : {}),
    ...(editingId ? { id: editingId } : {}),
    name: ui.name.value,
    server: ui.server.value,
    port: Number(ui.port.value),
    database: ui.database.value,
    auth: sql ? { kind: 'sql', user: ui.user.value } : { kind: 'entra' },
    ...(sql && ui.password.value ? { password: ui.password.value } : {}),
    encrypt: ui.encrypt.checked,
    trustServerCertificate: ui.trust.checked
  }
}

export function openConnectionDialog(existing: ConnectionConfig | undefined, saved: (config: ConnectionConfig) => void | Promise<void>): void {
  session++
  editingId = existing?.id
  onSaved = saved
  ui.title.textContent = existing ? `Edit ${existing.name}` : 'New connection'
  ui.name.value = existing?.name ?? ''
  setColor(existing?.color ?? '')
  ui.server.value = existing?.server ?? ''
  ui.port.value = String(existing?.port ?? 1433)
  ui.database.value = existing?.database ?? ''
  ui.auth.value = existing?.auth.kind ?? 'sql'
  ui.user.value = existing?.auth.kind === 'sql' ? existing.auth.user : ''
  ui.password.value = ''
  ui.password.placeholder = existing ? 'unchanged' : ''
  ui.encrypt.checked = existing?.encrypt ?? true
  ui.trust.checked = existing?.trustServerCertificate ?? false
  syncAuth()
  setStatus('')
  setBusy(false)
  ui.dialog.showModal()
  ui.name.focus()
}

ui.auth.addEventListener('change', syncAuth)
// Esc closes a <dialog> by itself: not while saving, or a failure would never be seen.
ui.dialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault()
})
ui.cancel.addEventListener('click', () => ui.dialog.close())

/** A half-typed or invalid hex would silently drop the colour: say so instead. */
function colorIsValid(): boolean {
  if (ui.color.value.trim() === '' || normalizeColor(ui.color.value)) return true
  setStatus('Colour must be #rrggbb (or #rgb), or empty for none.', 'danger')
  ui.color.focus()
  return false
}

ui.test.addEventListener('click', async () => {
  if (busy || !colorIsValid()) return
  const mine = session
  setBusy(true)
  setStatus('Connecting…')
  try {
    const result = await orca.plugin.request('connections.test', toInput(), { timeoutMs: 90_000 })
    if (mine !== session) return
    if (result.ok) setStatus(`Connected as ${result.login} to SQL Server ${result.serverVersion} in ${result.ms} ms`, 'success')
    else setStatus(result.error, 'danger')
  } catch (err) {
    if (mine === session) setStatus(errorText(err), 'danger')
  } finally {
    if (mine === session) setBusy(false)
  }
})

ui.dialog.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy || !colorIsValid()) return
  const mine = session
  const callback = onSaved
  setBusy(true)
  let saved: ConnectionConfig
  try {
    saved = await orca.plugin.request('connections.save', toInput())
  } catch (err) {
    if (mine === session) setStatus(errorText(err), 'danger')
    return
  } finally {
    if (mine === session) setBusy(false)
  }
  if (mine === session) ui.dialog.close()
  try {
    await callback?.(saved)
  } catch (err) {
    console.error('SeaQull: after saving the connection:', err) // reaches Orca's plugin log
  }
})

/** Resolves true when the person confirms. */
export function confirmDialog(text: string, okLabel: string): Promise<boolean> {
  ui.confirmText.textContent = text
  ui.confirmOk.textContent = okLabel
  ui.confirm.showModal()
  ui.confirmCancel.focus()
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      ui.confirmOk.onclick = ui.confirmCancel.onclick = null
      ui.confirm.onclose = null
      if (ui.confirm.open) ui.confirm.close()
      resolve(value)
    }
    ui.confirmOk.onclick = () => finish(true)
    ui.confirmCancel.onclick = () => finish(false)
    ui.confirm.onclose = () => finish(false)
  })
}
