// The contract between the console page (a sandboxed frame showing a .seaqull workbook or a .sql
// file) and the plugin's worker, declared once.
// Requests are JSON: input ≤ 64 KiB, answer ≤ 1 MiB, timeout ≤ 120 s, which is why queries run in
// the background (query.run → query.status polling), rows/exports are fetched in pages/chunks, and
// large scripts are sent in parts (query.append).

export type AuthConfig =
  /** SQL Server login; the password lives in Orca's encrypted secrets (OS keychain). */
  | { kind: 'sql'; user: string }
  /** Microsoft Entra ID token from the Azure CLI (`az login`); no stored secret. */
  | { kind: 'entra' }

export type ConnectionConfig = {
  id: string
  name: string
  server: string
  port: number
  /** Initial database; empty means the login's default. */
  database: string
  auth: AuthConfig
  encrypt: boolean
  trustServerCertificate: boolean
  /** `#rrggbb`, shown on its tabs and in the explorer (production in red, say). */
  color?: string
}

/** Create/update/test payload. `password` (SQL auth) blank means "keep the stored one". */
export type ConnectionInput = Omit<ConnectionConfig, 'id'> & { id?: string; password?: string }

export type ConnectionTestResult =
  | { ok: true; ms: number; serverVersion: string; login: string }
  | { ok: false; error: string }

export type TreeNodeKind =
  | 'connection'
  | 'database'
  | 'schema'
  | 'folder'
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'column'
  | 'more'
  | 'error'

export type TreeNode = {
  /** Unique across the tree; encodes the path (see worker/metadata.ts). */
  key: string
  label: string
  description?: string
  kind: TreeNodeKind
  hasChildren: boolean
}

export type ColumnInfo = {
  name: string
  /** SQL Server type as declared, e.g. `nvarchar(50)`, `decimal(19,4)`. */
  type: string
  /** Base type name, lower case, e.g. `nvarchar`, `decimal`, `varbinary`. */
  baseType: string
}

/** A display/export-safe value: dates and binary are pre-formatted strings, big integers stay strings. */
export type Cell = string | number | boolean | null

export type ResultSummary = {
  index: number
  /** 1-based batch (GO-separated) that produced it. */
  batch: number
  columns: ColumnInfo[]
  rowCount: number
  /** More rows existed than the row limit; only the first `rowCount` were kept. */
  truncated: boolean
}

export type RunMessage = {
  kind: 'info' | 'error'
  text: string
  /** Line in the editor document, when SQL Server reported one. */
  line?: number
}

export type RunState = 'running' | 'done' | 'error' | 'cancelled'

export type RunStatus = {
  runId: string
  state: RunState
  elapsedMs: number
  results: ResultSummary[]
  messages: RunMessage[]
  /** Index of `messages[0]` in the run's messages: query.status sends only those after the ones
   *  the caller has (`messagesFrom`). 0 or absent: all of them. */
  messagesFrom?: number
}

/** Rows r0…r1 and columns c0…c1 of a result, inclusive. */
export type CellRange = { r0: number; r1: number; c0: number; c1: number }

/** A value query.rows sent cut short: [index in `rows`, column, whole length in characters, and
 *  when the worker itself keeps only the start of it (values over 20,000,000 characters, or rows
 *  too large to keep whole), how many characters it kept: copies and exports have only those]. */
export type ValueCut = [row: number, column: number, length: number, kept?: number]

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'markdown' | 'sql'

/** `t` table, `v` view, `p` procedure, `f` function (scalar or table-valued), `s` synonym. */
export type NameKind = 't' | 'v' | 'p' | 'f' | 's'

/** The names the editor completes, for one connection and database. Compact (`[name, kind]`
 *  pairs grouped by schema) because a database can have many thousands of objects and the answer
 *  is capped at 1 MiB. */
export type CompletionNames = {
  /** The database these names are in (DB_NAME()), where the request named none. */
  database?: string
  /** The login's default schema (SCHEMA_NAME()): its objects complete unqualified. */
  defaultSchema: string
  /** The database's collation tells `Sales` from `sales`. */
  caseSensitive: boolean
  /** Schemas owning a listed object, the default one and `sys` and `INFORMATION_SCHEMA` included,
   *  with their objects by name. User objects first, then the system views and functions. */
  schemas: { name: string; objects: [name: string, kind: NameKind][] }[]
  /** More objects existed than were sent. */
  truncated: boolean
}

/** An object to complete the columns of, by its catalog names. */
export type ObjectName = { schema: string; name: string }

/** A column for completion: name, declared type (`nvarchar(50)`, `Name` for an alias type), and
 *  whether it is in the primary key. */
export type CompletionColumn = [name: string, type: string, pk: boolean]

/** An enabled foreign key, for suggesting JOIN conditions: the referencing table, the referenced
 *  one (catalog names, a synonym's base table's), and the column pairs in key order. */
export type CompletionForeignKey = { from: ObjectName; to: ObjectName; columns: [from: string, to: string][] }

/** The columns of a table, view, table-valued function, or synonym of one in the same database. */
export type ObjectColumns = ObjectName & {
  columns: CompletionColumn[]
  /** More columns existed than were sent. */
  truncated: boolean
  /** A synonym's base object, which `foreignKeys` name it by. */
  base?: ObjectName
  /** The foreign keys the object (a synonym's base table) holds, and those referencing it; a
   *  self-referencing one once. At most a few hundred. */
  foreignKeys: CompletionForeignKey[]
}

declare module 'orca' {
  // Declaration merging needs an interface.
  interface PluginRequests {
    'connections.list': { input: Record<string, never>; output: ConnectionConfig[] }
    'connections.save': { input: ConnectionInput; output: ConnectionConfig }
    'connections.delete': { input: { id: string }; output: { ok: true } }
    'connections.test': { input: ConnectionInput; output: ConnectionTestResult }
    /** Children of a tree node; `key: ''` lists the connections. */
    'tree.children': { input: { key: string }; output: TreeNode[] }
    /** Databases the connection's login can open, for the editor's picker. */
    'databases.list': { input: { connectionId: string }; output: string[] }
    /** Object names for the editor's completion; `database: ''` is the connection's default. */
    'completion.names': { input: { connectionId: string; database: string }; output: CompletionNames }
    /** Columns and foreign keys of up to 50 objects of one database; objects without columns
     *  (unknown, procedures, scalar functions, synonyms of objects elsewhere) are left out. Whole
     *  objects only: those that did not fit in the answer are listed in `unsent`, to be asked for
     *  again. */
    'completion.columns': {
      input: { connectionId: string; database: string; objects: ObjectName[] }
      output: { objects: ObjectColumns[]; unsent: ObjectName[] }
    }
    /** Starts running `sql` (GO-separated batches) on the tab's own session. `consoleId` is the
     *  tab's id: a workbook tab's, or the one in a .sql file's header (every console page shares
     *  one Orca caller id, so the page names its tabs itself). With `uploadId`, the script is the
     *  one sent with query.append and `sql` is empty. */
    'query.run': {
      input: { consoleId: string; connectionId: string; database: string; sql: string; firstLine: number; uploadId?: string }
      output: { runId: string }
    }
    /** Part of a script too large for one request (src/shared/upload.ts sends it): `offset` is the
     *  length sent so far; no `uploadId` starts a new upload. Scripts are capped at 10 MB, and an
     *  upload not run within 5 minutes is dropped. */
    'query.append': {
      input: { consoleId: string; uploadId?: string; offset: number; part: string }
      output: { uploadId: string }
    }
    /** `messagesFrom`: how many of the run's messages the caller already has. */
    'query.status': { input: { runId: string; messagesFrom?: number }; output: RunStatus }
    /** The calling console's latest run, if the worker still has it (Orca reloads a console's page
     *  when its tab is shown again). */
    'query.latest': { input: { consoleId: string }; output: { status: RunStatus | null } }
    /** A workbook tab closed: cancel its query and end its SQL session. */
    'query.close': { input: { consoleId: string }; output: { ok: true } }
    'query.cancel': { input: { runId: string }; output: { ok: true } }
    /** Rows `[offset, offset + limit)` of a result, as many as fit under the answer size cap. Text
     *  longer than a short preview ends in `…`; `cut` lists those values. */
    'query.rows': {
      input: { runId: string; result: number; offset: number; limit: number }
      output: { offset: number; rows: Cell[][]; cut: ValueCut[] }
    }
    /** Formats a result in the worker, from its full values; fetch it with export.chunk. */
    'export.prepare': {
      /** `headers` (CSV/TSV, default true): include the header row. `selection`: only those rows
       *  and columns. `raw`: the text of the one selected cell, in no format. */
      input: { runId: string; result: number; format: ExportFormat; tableName?: string; headers?: boolean; selection?: CellRange; raw?: boolean }
      output: { exportId: string; length: number; fileName: string; mimeType: string }
    }
    /** The export's text from character `offset`, as much as fits in one answer; `next` is where the
     *  following chunk starts, null after the last. */
    'export.chunk': { input: { exportId: string; offset: number }; output: { text: string; next: number | null } }
  }
}
