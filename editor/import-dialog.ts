// Import connections: a file chosen, dropped or pasted is checked here, sent to the worker in parts,
// previewed (what is new, renamed, already there or invalid), then imported in one go.
import type { ImportItem, ImportOutcome } from '../src/protocol.ts'
import { importBatches, MAX_CONNECTIONS, MAX_FILE_BYTES, parseConnectionsFile } from '../src/shared/connection-file.ts'
import { request } from './request.ts'
import { errorText } from './util.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  dialog: $<HTMLDialogElement>('import-dialog'),
  choose: $<HTMLDivElement>('im-choose'),
  file: $<HTMLButtonElement>('im-file'),
  input: $<HTMLInputElement>('im-input'),
  text: $<HTMLTextAreaElement>('im-text'),
  preview: $<HTMLDivElement>('im-preview'),
  summary: $<HTMLParagraphElement>('im-summary'),
  list: $<HTMLUListElement>('im-list'),
  status: $<HTMLParagraphElement>('im-status'),
  back: $<HTMLButtonElement>('im-back'),
  cancel: $<HTMLButtonElement>('im-cancel'),
  ok: $<HTMLButtonElement>('im-ok')
}

let importId: string | undefined
let onImported: ((outcome: ImportOutcome) => void) | undefined
let busy = false

const count = (items: ImportItem[], status: ImportItem['status']) => items.filter((i) => i.status === status).length
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const tooLarge = (bytes: number) => `This is ${(bytes / 1024 / 1024).toFixed(1)} MB; SeaQull reads connection files up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`

const parts = (counts: [number, string][]) =>
  counts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n.toLocaleString()} ${what}`)
    .join(', ')

/** "5 new, 2 renamed, 3 already there, 1 invalid" (parts that are zero left out). */
export const importCounts = (items: ImportItem[]) =>
  parts([
    [count(items, 'new'), 'new'],
    [count(items, 'renamed'), 'renamed'],
    [count(items, 'existing'), 'already there'],
    [count(items, 'invalid'), 'invalid']
  ])

/** The status line after an import. */
export function importedText(outcome: ImportOutcome): string {
  const others = parts([
    [outcome.renamed, 'renamed'],
    [outcome.existing, 'already there'],
    [outcome.invalid, 'invalid']
  ])
  const details = others ? ` (${others})` : ''
  if (outcome.added === 0) return `Nothing imported${details}.`
  return `Imported ${plural(outcome.added, 'connection')}${details}.${outcome.sqlLogins > 0 ? ' Passwords are asked for when you connect.' : ''}`
}

function setStatus(text: string): void {
  ui.status.textContent = text
  ui.status.hidden = !text
}

function setBusy(value: boolean): void {
  busy = value
  for (const b of [ui.ok, ui.back, ui.file, ui.cancel]) b.disabled = value
}

/** The worker need not keep a preview nobody will import. */
function dropStaged(): void {
  if (importId) void request('connections.importDrop', { importId }).catch(() => undefined)
  importId = undefined
}

function showChoose(): void {
  dropStaged()
  ui.choose.hidden = false
  ui.preview.hidden = true
  ui.back.hidden = true
  ui.ok.textContent = 'Preview'
  ui.ok.disabled = false
  setStatus('')
}

export function openImportDialog(imported: (outcome: ImportOutcome) => void): void {
  onImported = imported
  ui.text.value = ''
  ui.input.value = ''
  showChoose()
  setBusy(false)
  ui.dialog.showModal()
  ui.file.focus()
}

async function preview(text: string): Promise<void> {
  if (busy) return
  setStatus('')
  let entries: unknown[]
  try {
    entries = parseConnectionsFile(text)
  } catch (err) {
    return setStatus(errorText(err))
  }
  if (entries.length === 0) return setStatus('This file has no connections.')
  setBusy(true)
  let plan: { items: ImportItem[]; room: number } | undefined
  try {
    dropStaged()
    let id: string | undefined
    for (const batch of importBatches(entries)) id = (await request('connections.importAppend', { ...(id ? { importId: id } : {}), entries: batch })).importId
    importId = id
    const items: ImportItem[] = []
    let room = 0
    for (let offset: number | null = 0; offset !== null; ) {
      const page: { items: ImportItem[]; next: number | null; room: number } = await request('connections.importPlan', { importId: id!, offset })
      items.push(...page.items)
      room = page.room
      offset = page.next
    }
    plan = { items, room }
  } catch (err) {
    setStatus(errorText(err))
  } finally {
    setBusy(false)
  }
  if (plan) renderPlan(plan.items, plan.room)
}

function renderPlan(items: ImportItem[], room: number): void {
  const adding = count(items, 'new') + count(items, 'renamed')
  ui.summary.textContent = `${plural(items.length, 'connection')} in the file: ${importCounts(items)}.`
  const labels = { new: 'new', renamed: 'renamed', existing: 'already there', invalid: 'invalid' }
  ui.list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li')
      li.className = item.status
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = labels[item.status]
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent =
        item.status === 'renamed' ? `${item.name} → ${item.newName}` : item.newName ? `${item.name} (as ${item.newName})` : item.name
      const warnings = (item.risky ?? []).map((text) => {
        const tag = document.createElement('span')
        tag.className = 'badge risky'
        tag.textContent = text
        return tag
      })
      const where = document.createElement('span')
      where.className = item.status === 'invalid' ? 'where reason' : 'where'
      where.textContent = item.status === 'invalid' ? (item.reason ?? '') : [item.server, item.folder].filter(Boolean).join(' · ')
      li.title = [name.textContent, ...(item.risky ?? []), where.textContent].filter(Boolean).join('\n')
      li.append(badge, name, ...warnings, where)
      return li
    })
  )
  ui.choose.hidden = true
  ui.preview.hidden = false
  ui.back.hidden = false
  const fits = adding <= room
  if (!fits) setStatus(`Only ${plural(room, 'more connection')} fit (SeaQull keeps at most ${MAX_CONNECTIONS.toLocaleString()}), and this file would add ${adding.toLocaleString()}.`)
  ui.ok.textContent = adding ? `Import ${plural(adding, 'connection')}` : 'Nothing to import'
  ui.ok.disabled = adding === 0 || !fits
  ;(ui.ok.disabled ? ui.back : ui.ok).focus()
}

async function readFile(file: File | undefined): Promise<void> {
  if (!file) return
  if (file.size > MAX_FILE_BYTES) return setStatus(tooLarge(file.size))
  try {
    await preview(await file.text())
  } catch (err) {
    setStatus(`Could not read the file: ${errorText(err)}`)
  }
}

ui.file.addEventListener('click', () => {
  ui.input.value = '' // choosing the same file again must still read it
  ui.input.click()
})
ui.input.addEventListener('change', () => void readFile(ui.input.files?.[0]))
ui.dialog.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  ui.dialog.classList.add('dragging')
})
ui.dialog.addEventListener('dragleave', (event) => {
  if (!ui.dialog.contains(event.relatedTarget as Node | null)) ui.dialog.classList.remove('dragging')
})
ui.dialog.addEventListener('drop', (event) => {
  event.preventDefault()
  ui.dialog.classList.remove('dragging')
  if (!ui.preview.hidden || busy) return
  void readFile(event.dataTransfer?.files[0])
})
ui.back.addEventListener('click', () => {
  showChoose()
  ui.file.focus()
})
ui.cancel.addEventListener('click', () => ui.dialog.close())
ui.dialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault()
})
ui.dialog.addEventListener('close', () => dropStaged())
ui.ok.addEventListener('click', async () => {
  if (busy) return
  if (ui.preview.hidden) {
    if (!ui.text.value.trim()) return setStatus('Choose or drop a file, or paste its contents.')
    const bytes = new Blob([ui.text.value]).size
    if (bytes > MAX_FILE_BYTES) return setStatus(tooLarge(bytes))
    return void preview(ui.text.value)
  }
  if (!importId) return
  setBusy(true)
  try {
    const outcome = await request('connections.importApply', { importId })
    importId = undefined
    ui.dialog.close()
    onImported?.(outcome)
  } catch (err) {
    setStatus(errorText(err))
  } finally {
    setBusy(false)
  }
})
