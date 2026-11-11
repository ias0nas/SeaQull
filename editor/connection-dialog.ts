// Add/edit a saved connection, confirm deleting one, ask for a folder's new name, and sign in to a
// connection without a saved login, in page-drawn <dialog>s (plugin frames get no alert, confirm
// or prompt). Saving goes to the worker: the config to plugin storage, a SQL login password to
// Orca's encrypted secrets.
import type { ConnectionConfig, ConnectionInput, SavedConnection, SignInState } from '../src/protocol.ts'
import { normalizeColor, PALETTE } from '../src/shared/colors.ts'
import { normalizeFolder } from '../src/shared/folders.ts'
import { Combobox } from './combobox.ts'
import { request } from './request.ts'
import { errorText } from './util.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  dialog: $<HTMLDialogElement>('connection-dialog'),
  title: $<HTMLHeadingElement>('cd-title'),
  name: $<HTMLInputElement>('cd-name'),
  folder: $<HTMLInputElement>('cd-folder'),
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
  forgetRow: $<HTMLLabelElement>('cd-forget-row'),
  forget: $<HTMLInputElement>('cd-forget'),
  encrypt: $<HTMLInputElement>('cd-encrypt'),
  trust: $<HTMLInputElement>('cd-trust'),
  status: $<HTMLParagraphElement>('cd-status'),
  test: $<HTMLButtonElement>('cd-test'),
  save: $<HTMLButtonElement>('cd-save'),
  cancel: $<HTMLButtonElement>('cd-cancel'),
  confirm: $<HTMLDialogElement>('confirm-dialog'),
  confirmText: $<HTMLParagraphElement>('confirm-text'),
  confirmOk: $<HTMLButtonElement>('confirm-ok'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel'),
  prompt: $<HTMLDialogElement>('prompt-dialog'),
  promptTitle: $<HTMLHeadingElement>('prompt-title'),
  promptLabel: $<HTMLSpanElement>('prompt-label'),
  promptInput: $<HTMLInputElement>('prompt-input'),
  promptNote: $<HTMLParagraphElement>('prompt-note'),
  promptOk: $<HTMLButtonElement>('prompt-ok'),
  promptCancel: $<HTMLButtonElement>('prompt-cancel'),
  signIn: $<HTMLDialogElement>('signin-dialog'),
  signInTitle: $<HTMLHeadingElement>('si-title'),
  signInStatus: $<HTMLParagraphElement>('si-status'),
  signInUser: $<HTMLInputElement>('si-user'),
  signInPassword: $<HTMLInputElement>('si-password'),
  signInRemember: $<HTMLInputElement>('si-remember'),
  signInCancel: $<HTMLButtonElement>('si-cancel')
}


const folderBox = new Combobox(ui.folder)
const promptBox = new Combobox(ui.promptInput)

let editingId: string | undefined
let passwordSaved = false
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
  ui.forgetRow.hidden = entra || !passwordSaved
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
  const folder = normalizeFolder(ui.folder.value)
  return {
    ...(color ? { color } : {}),
    ...(folder ? { folder } : {}),
    ...(editingId ? { id: editingId } : {}),
    name: ui.name.value,
    server: ui.server.value,
    port: Number(ui.port.value),
    database: ui.database.value,
    auth: sql ? { kind: 'sql', user: ui.user.value } : { kind: 'entra' },
    ...(sql && ui.forget.checked ? { forgetPassword: true } : sql && ui.password.value ? { password: ui.password.value } : {}),
    encrypt: ui.encrypt.checked,
    trustServerCertificate: ui.trust.checked
  }
}

/** `folder`: a new connection's folder; `folders`: those in use, suggested. */
export function openConnectionDialog(
  existing: SavedConnection | undefined,
  saved: (config: ConnectionConfig) => void | Promise<void>,
  { folder, folders = [] }: { folder?: string; folders?: string[] } = {}
): void {
  session++
  editingId = existing?.id
  onSaved = saved
  ui.title.textContent = existing ? `Edit ${existing.name}` : 'New connection'
  ui.name.value = existing?.name ?? ''
  ui.folder.value = existing ? (existing.folder ?? '') : (folder ?? '')
  folderBox.setOptions(folders)
  setColor(existing?.color ?? '')
  ui.server.value = existing?.server ?? ''
  ui.port.value = String(existing?.port ?? 1433)
  ui.database.value = existing?.database ?? ''
  ui.auth.value = existing?.auth.kind ?? 'sql'
  ui.user.value = existing?.auth.kind === 'sql' ? existing.auth.user : ''
  ui.password.value = ''
  passwordSaved = existing?.passwordSaved === true
  ui.user.placeholder = 'asked when connecting'
  ui.password.placeholder = passwordSaved ? 'unchanged' : 'asked when connecting'
  ui.forget.checked = false
  ui.password.disabled = false
  ui.encrypt.checked = existing?.encrypt ?? true
  ui.trust.checked = existing?.trustServerCertificate ?? false
  syncAuth()
  setStatus('')
  setBusy(false)
  ui.dialog.showModal()
  ui.name.focus()
}

ui.auth.addEventListener('change', syncAuth)
ui.forget.addEventListener('change', () => {
  ui.password.disabled = ui.forget.checked
  if (ui.forget.checked) ui.password.value = ''
})
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

/** A password is only kept with the user it is for. */
function loginIsValid(): boolean {
  if (ui.auth.value === 'entra' || !ui.password.value || ui.user.value.trim()) return true
  setStatus('Enter the user this password is for.', 'danger')
  ui.user.focus()
  return false
}

ui.test.addEventListener('click', async () => {
  if (busy || !colorIsValid() || !loginIsValid()) return
  const mine = session
  setBusy(true)
  setStatus('Connecting…')
  try {
    const result = await request('connections.test', toInput(), { timeoutMs: 90_000 })
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
  if (busy || !colorIsValid() || !loginIsValid()) return
  const mine = session
  const callback = onSaved
  setBusy(true)
  let saved: ConnectionConfig
  try {
    saved = await request('connections.save', toInput())
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

/** Asks for a line of text (suggesting `suggestions`); resolves null when cancelled. */
export function promptDialog(title: string, label: string, value: string, okLabel: string, { suggestions = [], note = '' }: { suggestions?: string[]; note?: string } = {}): Promise<string | null> {
  ui.promptTitle.textContent = title
  ui.promptLabel.textContent = label
  ui.promptInput.value = value
  ui.promptNote.textContent = note
  ui.promptOk.textContent = okLabel
  promptBox.setOptions(suggestions)
  ui.prompt.showModal()
  ui.promptInput.select()
  return new Promise((resolve) => {
    const form = ui.prompt.querySelector('form')!
    const finish = (result: string | null) => {
      form.onsubmit = ui.promptCancel.onclick = ui.prompt.onclose = null
      if (ui.prompt.open) ui.prompt.close()
      resolve(result)
    }
    form.onsubmit = (event) => {
      event.preventDefault()
      finish(ui.promptInput.value)
    }
    ui.promptCancel.onclick = () => finish(null)
    ui.prompt.onclose = () => finish(null)
  })
}

/** Asks for a connection's user and password; null when cancelled. `failure`: why the last ones
 *  were refused. The password is not kept here once handed over. */
export function signInDialog(state: SignInState, remember = false): Promise<{ user: string; password: string; remember: boolean } | null> {
  ui.signInTitle.textContent = `Sign in to ${state.name}`
  ui.signInStatus.textContent = state.failure ?? ''
  ui.signInStatus.hidden = !state.failure
  ui.signInUser.value = state.user
  ui.signInPassword.value = ''
  ui.signInRemember.checked = remember
  if (!ui.signIn.open) ui.signIn.showModal()
  ;(state.user ? ui.signInPassword : ui.signInUser).focus()
  return new Promise((resolve) => {
    const form = ui.signIn.querySelector('form')!
    const finish = (result: { user: string; password: string; remember: boolean } | null) => {
      form.onsubmit = ui.signInCancel.onclick = ui.signIn.onclose = null
      ui.signInPassword.value = ''
      if (ui.signIn.open) ui.signIn.close()
      resolve(result)
    }
    form.onsubmit = (event) => {
      event.preventDefault()
      finish({ user: ui.signInUser.value.trim(), password: ui.signInPassword.value, remember: ui.signInRemember.checked })
    }
    ui.signInCancel.onclick = () => finish(null)
    ui.signIn.onclose = () => finish(null)
  })
}

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
