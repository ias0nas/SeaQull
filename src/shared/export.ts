// Result-set exporters. Pure functions shared by the worker (whole results) and the editor.
import type { Cell, ColumnInfo, ExportFormat } from '../protocol.ts'
import { bracket } from './tree-keys.ts'

export type ExportInput = {
  columns: ColumnInfo[]
  rows: Cell[][]
  /** Target table for `sql` INSERT statements. */
  tableName?: string
  /** CSV/TSV/Markdown: include the header row (default true). */
  headers?: boolean
}

export const EXPORT_FORMATS: { format: ExportFormat; label: string; extension: string; mimeType: string }[] = [
  { format: 'csv', label: 'CSV', extension: 'csv', mimeType: 'text/csv' },
  { format: 'tsv', label: 'TSV', extension: 'tsv', mimeType: 'text/tab-separated-values' },
  { format: 'json', label: 'JSON', extension: 'json', mimeType: 'application/json' },
  { format: 'jsonl', label: 'JSON Lines', extension: 'jsonl', mimeType: 'application/jsonl' },
  { format: 'markdown', label: 'Markdown', extension: 'md', mimeType: 'text/markdown' },
  { format: 'sql', label: 'SQL INSERT', extension: 'sql', mimeType: 'application/sql' }
]

export function formatInfo(format: ExportFormat) {
  const info = EXPORT_FORMATS.find((f) => f.format === format)
  if (!info) throw new Error(`Unknown export format: ${format}`)
  return info
}

/** An export in pieces: `head`, then `row(cells, index)` for each row in order, then `tail`.
 *  Concatenated, they are the whole text, so the worker can format any stretch of it on demand
 *  instead of holding it all. */
export type ExportParts = { head: string; row: (cells: Cell[], index: number) => string; tail: string }

export function exportParts(format: ExportFormat, input: ExportInput): ExportParts {
  switch (format) {
    case 'csv':
      return delimited(input, ',')
    case 'tsv':
      return delimited(input, '\t')
    case 'json':
      return toJson(input)
    case 'jsonl':
      return toJsonLines(input)
    case 'markdown':
      return toMarkdown(input)
    case 'sql':
      return toSqlInserts(input)
  }
}

/** The whole export as one string. */
export function exportResult(format: ExportFormat, input: ExportInput): string {
  const { head, row, tail } = exportParts(format, input)
  return head + input.rows.map(row).join('') + tail
}

/** A cell as plain text: NULL is empty, bits are 0/1. */
export const cellText = (cell: Cell): string => (cell === null ? '' : typeof cell === 'boolean' ? (cell ? '1' : '0') : String(cell))
const text = cellText

/** RFC 4180 for CSV (CRLF, quotes doubled). TSV uses the same quoting so tabs/newlines survive. */
function delimited({ columns, headers = true }: ExportInput, sep: string): ExportParts {
  const needsQuotes = new RegExp(`[${sep === '\t' ? '\\t' : sep}"\\r\\n]|^\\s|\\s$`)
  const field = (value: string) => (needsQuotes.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  return {
    head: headers ? `${columns.map((c) => field(c.name)).join(sep)}\r\n` : '',
    row: (cells) => `${cells.map((cell) => field(text(cell))).join(sep)}\r\n`,
    tail: ''
  }
}

/** Unique object keys: a repeated column name gets `_2`, `_3`… (e.g. `SELECT a.id, b.id`). */
export function uniqueKeys(columns: ColumnInfo[]): string[] {
  const taken = new Set<string>()
  return columns.map((c) => {
    const base = c.name || 'column'
    let key = base
    // `id, id, id_2` must not give two `id_2`s: skip any name already used.
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`
    taken.add(key)
    return key
  })
}

const toObject = (keys: string[], row: Cell[]) => Object.fromEntries(keys.map((k, i) => [k, row[i] ?? null]))

function toJson({ columns, rows }: ExportInput): ExportParts {
  const keys = uniqueKeys(columns)
  if (rows.length === 0) return { head: '[]\n', row: () => '', tail: '' }
  return { head: '[\n', row: (cells, i) => `${i > 0 ? ',\n' : ''}  ${JSON.stringify(toObject(keys, cells))}`, tail: '\n]\n' }
}

function toJsonLines({ columns }: ExportInput): ExportParts {
  const keys = uniqueKeys(columns)
  return { head: '', row: (cells) => `${JSON.stringify(toObject(keys, cells))}\n`, tail: '' }
}

function toMarkdown({ columns }: ExportInput): ExportParts {
  // A Markdown table needs its header row, so `headers` does not apply.
  const cell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const numeric = columns.map((c) => NUMERIC_TYPES.has(c.baseType))
  return {
    head: `| ${columns.map((c) => cell(c.name)).join(' | ')} |\n| ${numeric.map((n) => (n ? '---:' : '---')).join(' | ')} |\n`,
    row: (cells) => `| ${cells.map((v) => cell(v === null ? 'NULL' : text(v))).join(' | ')} |\n`,
    tail: ''
  }
}

/** Numeric SQL Server types: right-aligned in the grid and Markdown, bare in INSERTs. */
export const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real', 'bit'
])
const BINARY_TYPES = new Set(['binary', 'varbinary', 'image', 'timestamp', 'rowversion'])

/** One INSERT per row. Binary values (already `0x…`) and numbers go in bare; text is N'…'. Unnamed
 *  and repeated columns (`SELECT a.id, b.id, 1`) get names as in JSON, so the SQL is valid. */
function toSqlInserts({ columns, tableName }: ExportInput): ExportParts {
  const target = tableName?.trim() || '[dbo].[ExportedRows]'
  const columnList = uniqueKeys(columns).map(bracket).join(', ')
  const literal = (cell: Cell, column: ColumnInfo): string => {
    if (cell === null) return 'NULL'
    if (typeof cell === 'boolean') return cell ? '1' : '0'
    if (typeof cell === 'number') return String(cell)
    if (BINARY_TYPES.has(column.baseType) && /^0x[0-9a-f]*$/i.test(cell)) return cell
    if (NUMERIC_TYPES.has(column.baseType) && /^-?\d+(\.\d+)?$/.test(cell)) return cell
    return `N'${cell.replace(/'/g, "''")}'`
  }
  return {
    head: '',
    row: (cells) => `INSERT INTO ${target} (${columnList}) VALUES (${cells.map((cell, i) => literal(cell, columns[i])).join(', ')});\n`,
    tail: ''
  }
}
