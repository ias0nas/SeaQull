// Completion of object and column names in the SQL editor, without DOM or CodeMirror (unit-tested):
// the worker's `completion.names` and `completion.columns` answers as completion options (JOIN
// conditions from foreign keys too), and what the text before the cursor asks for (`Cust`,
// `Sales.Cust`, `c.Na`, `[Sales].[Order D`).
import type { CompletionColumn, CompletionNames, NameKind, ObjectColumns, ObjectName } from '../protocol.ts'
import type { JoinPlace, StatementScan, TableRef } from './sql-statement.ts'

/** A completion option (CodeMirror's Completion, structurally). */
export type NameOption = { label: string; type: string; detail: string; apply?: string; boost?: number }

/** What a kind shows: `type` picks the icon, `detail` is the text beside the name. */
export const KIND_INFO: Record<NameKind, { type: string; detail: string }> = {
  t: { type: 'table', detail: 'table' },
  v: { type: 'view', detail: 'view' },
  p: { type: 'procedure', detail: 'procedure' },
  f: { type: 'function', detail: 'function' },
  s: { type: 'synonym', detail: 'synonym' }
}

/** Schemas whose objects complete only qualified (`sys.objects`), never on their own. */
const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema'])

// T-SQL's reserved keywords: a name that is one of them needs brackets.
export const RESERVED_WORDS = new Set(
  (
    'add all alter and any as asc authorization backup begin between break browse bulk by cascade case check checkpoint close ' +
    'clustered coalesce collate column commit compute constraint contains containstable continue convert create cross current ' +
    'current_date current_time current_timestamp current_user cursor database dbcc deallocate declare default delete deny desc ' +
    'disk distinct distributed double drop dump else end errlvl escape except exec execute exists exit external fetch file ' +
    'fillfactor for foreign freetext freetexttable from full function goto grant group having holdlock identity identity_insert ' +
    'identitycol if in index inner insert intersect into is join key kill left like lineno load merge national nocheck ' +
    'nonclustered not null nullif of off offsets on open opendatasource openquery openrowset openxml option or order outer over ' +
    'percent pivot plan precision primary print proc procedure public raiserror read readtext reconfigure references replication ' +
    'restore restrict return revert revoke right rollback rowcount rowguidcol rule save schema securityaudit select ' +
    'semantickeyphrasetable semanticsimilaritydetailstable semanticsimilaritytable session_user set setuser shutdown some ' +
    'statistics system_user table tablesample textsize then to top tran transaction trigger truncate try_convert tsequal union ' +
    'unique unpivot update updatetext use user values varying view waitfor when where while with within writetext'
  ).split(' ')
)

/** A regular identifier: a letter or `_`, then letters, digits, `_ @ # $`; not a reserved word. */
const REGULAR = /^[\p{L}_][\p{L}\p{N}_@#$]*$/u

export const needsBrackets = (name: string) => !REGULAR.test(name) || RESERVED_WORDS.has(name.toLowerCase())

/** `name`, or `[name]` (`"name"` with `quote` `"`) when it must be delimited or `always` is set. */
export function quoteName(name: string, quote: '[' | '"' = '[', always = false): string {
  if (!always && !needsBrackets(name)) return name
  return quote === '"' ? `"${name.replace(/"/g, '""')}"` : `[${name.replace(/]/g, ']]')}]`
}

function option(name: string, type: string, detail: string): NameOption {
  const quoted = quoteName(name)
  return quoted === name ? { label: name, type, detail } : { label: name, type, detail, apply: quoted }
}

export type NameIndex = {
  /** Unqualified: the default schema's objects and every schema. */
  top: NameOption[]
  /** Each schema's objects, by `fold(schema name)`. */
  schemas: Map<string, NameOption[]>
  /** The catalog by `fold(name)`: each schema's own name and its objects' names and kinds. */
  catalog: Map<string, { name: string; objects: Map<string, [name: string, kind: NameKind]> }>
  defaultSchema: string
  /** The database's name, when the worker sent it. */
  database?: string
  /** How the database compares names: `sales.` finds `Sales` unless it is case-sensitive. */
  fold: (name: string) => string
  truncated: boolean
}

export function nameIndex(names: CompletionNames): NameIndex {
  const fold = names.caseSensitive ? (name: string) => name : (name: string) => name.toLowerCase()
  const schemas = new Map<string, NameOption[]>()
  const catalog: NameIndex['catalog'] = new Map()
  const top: NameOption[] = []
  for (const schema of names.schemas) {
    const objects = schema.objects.map(([name, kind]) => option(name, KIND_INFO[kind].type, KIND_INFO[kind].detail))
    schemas.set(fold(schema.name), objects)
    catalog.set(fold(schema.name), { name: schema.name, objects: new Map(schema.objects.map(([name, kind]) => [fold(name), [name, kind]])) })
    top.push(option(schema.name, 'schema', 'schema'))
    if (schema.name === names.defaultSchema && !SYSTEM_SCHEMAS.has(schema.name.toLowerCase())) top.unshift(...objects)
  }
  return { top, schemas, catalog, defaultSchema: names.defaultSchema, ...(names.database ? { database: names.database } : {}), fold, truncated: names.truncated }
}

/** Kinds of object that have columns: tables, views, functions (the table-valued ones), synonyms. */
const HAS_COLUMNS = new Set<NameKind>(['t', 'v', 'f', 's'])

/** The catalog names of an object that may have columns: `schema.name`, or `name` in the default
 *  schema; null when the index does not know it. */
export function findObject(index: NameIndex, schema: string | undefined, name: string): ObjectName | null {
  const owner = index.catalog.get(index.fold(schema ?? index.defaultSchema))
  const found = owner?.objects.get(index.fold(name))
  return owner && found && HAS_COLUMNS.has(found[1]) ? { schema: owner.name, name: found[0] } : null
}

/** What a completion.columns answer says about each object asked for, by `objectKey`: its
 *  columns and foreign keys, or null when it has no columns. Objects the worker did not send
 *  (`unsent`) are not in it: nothing is known about them yet. */
export function settledColumns(requested: ObjectName[], answer: { objects: ObjectColumns[]; unsent: ObjectName[] }): Map<string, ObjectColumns | null> {
  const unsent = new Set(answer.unsent.map(objectKey))
  const settled = new Map<string, ObjectColumns | null>()
  for (const o of requested) if (!unsent.has(objectKey(o))) settled.set(objectKey(o), null)
  for (const o of answer.objects) settled.set(objectKey(o), o)
  return settled
}

/** A key for an object's columns in a cache. */
export const objectKey = (o: ObjectName) => `${o.schema}\u0000${o.name}`

/** Column options of one or more tables. `source` (an alias or table name) is added to the
 *  detail of a column that more than one of them has, so each keeps its own option. */
export function columnOptions(tables: { columns: CompletionColumn[]; source?: string }[], fold: (name: string) => string, boost?: number): NameOption[] {
  const count = new Map<string, number>()
  for (const { columns } of tables) for (const name of new Set(columns.map(([n]) => fold(n)))) count.set(name, (count.get(name) ?? 0) + 1)
  const options: NameOption[] = []
  for (const { columns, source } of tables) {
    for (const [name, type, pk] of columns) {
      const shared = (count.get(fold(name)) ?? 0) > 1 && source
      const o = option(name, pk ? 'key' : 'column', `${type}${pk ? ' PK' : ''}${shared ? ` · ${source}` : ''}`)
      options.push(boost === undefined ? o : { ...o, boost })
    }
  }
  return options
}

/** JOIN conditions rank above columns (`COLUMN_BOOST`), most recently joined table first. */
const JOIN_BOOST = 2

/** Conditions for the JOIN at `join` from the foreign keys, either way, between the table joined
 *  there and each table before it (the most recent first): `o.CustomerID = c.CustomerID`, with
 *  `AND` between the pairs of a key of several columns. Each table is written as its alias, else
 *  its name as the statement has it. `columns`: what completion.columns gave, by `objectKey`. */
export function joinConditions(index: NameIndex, join: JoinPlace, columns: Map<string, ObjectColumns>): NameOption[] {
  const lookup = (ref: TableRef) => {
    const object = findObject(index, ref.schema, ref.name)
    const entry = object && columns.get(objectKey(object))
    // A synonym's foreign keys name its base table.
    return object && { base: entry?.base ?? object, keys: entry?.foreignKeys ?? [], qualifier: ref.alias ?? ref.name }
  }
  const same = (a: ObjectName, b: ObjectName) => index.fold(a.schema) === index.fold(b.schema) && index.fold(a.name) === index.fold(b.name)
  const joined = lookup(join.table)
  if (!joined) return []
  const texts = new Set<string>()
  for (const ref of [...join.earlier].reverse()) {
    const other = lookup(ref)
    if (!other || index.fold(other.qualifier) === index.fold(joined.qualifier)) continue
    const condition = (pairs: [string, string][]) =>
      pairs.map(([mine, theirs]) => `${quoteName(joined.qualifier)}.${quoteName(mine)} = ${quoteName(other.qualifier)}.${quoteName(theirs)}`).join(' AND ')
    for (const key of [...joined.keys, ...other.keys]) {
      if (same(key.from, joined.base) && same(key.to, other.base)) texts.add(condition(key.columns))
      if (same(key.to, joined.base) && same(key.from, other.base)) texts.add(condition(key.columns.map(([from, to]) => [to, from])))
    }
  }
  return [...texts].map((label, i, all) => ({ label, type: 'join', detail: 'fk', boost: JOIN_BOOST + 1 - i / all.length }))
}

// One part of a name: [bracketed], "quoted" or regular.
const PART = String.raw`(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_@#$]*)`
// The name being typed: a delimited one not closed yet, or a regular one (maybe empty).
const WORD = String.raw`(\[(?:[^\]]|\]\])*|"(?:[^"]|"")*|[\p{L}\p{N}_@#$]*)`
const AT_END = new RegExp(String.raw`(?:(${PART})\s*\.\s*)?(?:(${PART})\s*\.\s*)?${WORD}$`, 'u')

export type NameContext = {
  /** The text typed so far (from where the completion replaces), an opening `[` or `"` included. */
  word: string
  /** The names before the dots, unquoted: none, a schema, object or alias (`x.`), or a schema and
   *  object (`Sales.Customer.`). */
  path: string[]
  quote: '[' | '"' | null
}

const unquote = (part: string) =>
  part.startsWith('[') ? part.slice(1, -1).replace(/]]/g, ']') : part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part

/** What the text before the cursor (on its line) is asking for; null where no name goes: a
 *  variable (`@x`), a number, a name of more than three parts (`db.schema.table.x`). */
export function nameContext(before: string): NameContext | null {
  const match = AT_END.exec(before)
  if (!match) return null
  const [, first, second, word] = match
  const path = [first, second].filter((part) => part !== undefined).map(unquote)
  // A match that starts inside a word or after another dot is not the whole name.
  const previous = before.slice(0, match.index).trimEnd().slice(-1)
  if (/[\p{L}\p{N}_@#$\]".]/u.test(before.charAt(match.index - 1)) || (path.length > 0 && previous === '.')) return null
  if (/^[\d@#$]/u.test(word)) return null
  return { word, path, quote: word.startsWith('[') ? '[' : word.startsWith('"') ? '"' : null }
}

export type NameResult = {
  options: NameOption[]
  /** Matches what may be typed next while the same options still apply. */
  validFor: RegExp
}

const delimited = new WeakMap<NameOption[], Record<'[' | '"', NameOption[]>>()

/** The options as `[name]` (or `"name"`): the person typed the opening one. */
function delimitedOptions(options: NameOption[], quote: '[' | '"'): NameOption[] {
  let entry = delimited.get(options)
  if (!entry) delimited.set(options, (entry = {} as Record<'[' | '"', NameOption[]>))
  return (entry[quote] ??= options.map((o) => {
    const quoted = quoteName(o.apply ? unquote(o.apply) : o.label, quote, true)
    return { ...o, label: quoted, apply: quoted }
  }))
}

const REGULAR_REST = /^[\p{L}\p{N}_@#$]*/u
// The rest of a delimited name: to its closing delimiter on this line, not past another `[`.
const BRACKET_REST = /^(?:[^\]\[\n]|\]\])*\]/
const QUOTE_REST = /^(?:[^"\n]|"")*"/

/** How many characters of `after` (the text after the cursor) belong to the name being typed: the
 *  rest of a regular word; in a `[` or `"` name, up to and including its closing delimiter (or,
 *  when it has none on this line, the rest of a regular word). Accepting a completion in the middle
 *  of a word replaces these too. */
export function wordRest(after: string, quote: '[' | '"' | null): number {
  const delimited = quote === '[' ? BRACKET_REST.exec(after) : quote === '"' ? QUOTE_REST.exec(after) : null
  return (delimited ?? REGULAR_REST.exec(after)!)[0].length
}

function result(options: NameOption[], context: NameContext): NameResult | null {
  if (options.length === 0) return null
  if (context.quote) {
    return {
      options: delimitedOptions(options, context.quote),
      validFor: context.quote === '[' ? /^\[(?:[^\]]|\]\])*\]?$/ : /^"(?:[^"]|"")*"?$/
    }
  }
  return { options, validFor: /^[\p{L}\p{N}_@#$]*$/u }
}

/** What a completion needs and how to make it: `objects` whose columns to fetch first (maybe
 *  none), then `complete` with the columns found (by `objectKey`; any missing are left out). */
export type CompletionPlan = {
  objects: ObjectName[]
  complete(columns: Map<string, ObjectColumns>): NameResult | null
}

/** Columns rank above object names and keywords (boost 0 and -1) where a column goes. */
const COLUMN_BOOST = 1

function uniqueObjects(objects: (ObjectName | null)[]): ObjectName[] {
  const seen = new Map<string, ObjectName>()
  for (const o of objects) if (o && !seen.has(objectKey(o))) seen.set(objectKey(o), o)
  return [...seen.values()]
}

/** Completions for `context` (from `nameContext`) in the statement `scan` describes (null: not
 *  read), or null when there are none to offer. `explicit`: asked for (⌘I, Ctrl+Space), so an empty
 *  word at the top level lists everything.
 *  - `schema.object.`: the object's columns.
 *  - `x.`: an alias or table of the statement: its columns (none for a CTE or derived table);
 *    otherwise schema x's objects and the columns of x in the default schema.
 *  - Unqualified where a column goes: the statement's columns, then names and keywords; right
 *    after a JOIN's ON, conditions from foreign keys before them (with nothing typed and not asked
 *    for, only when there are some). */
export function planCompletion(index: NameIndex, context: NameContext, scan: StatementScan | null, explicit: boolean): CompletionPlan | null {
  const columnsOf = (columns: Map<string, ObjectColumns>, o: ObjectName): CompletionColumn[] => columns.get(objectKey(o))?.columns ?? []
  const { path } = context
  if (path.length === 2) {
    const object = findObject(index, path[0], path[1])
    if (!object) return null
    return { objects: [object], complete: (columns) => result(columnOptions([{ columns: columnsOf(columns, object) }], index.fold), context) }
  }
  if (path.length === 1) {
    const qualifier = index.fold(path[0])
    const matches = scan?.qualifiers.filter((q) => index.fold(q.name) === qualifier) ?? []
    if (matches.length > 0) {
      // An alias hides anything else of that name; one this cannot resolve gives nothing.
      const objects = uniqueObjects(matches.map((m) => m.table && findObject(index, m.table.schema, m.table.name)))
      const label = (o: ObjectName) => `${o.schema}.${o.name}`
      return {
        objects,
        complete: (columns) => result(columnOptions(objects.map((o) => ({ columns: columnsOf(columns, o), source: label(o) })), index.fold), context)
      }
    }
    const schemaObjects = index.schemas.get(qualifier) ?? []
    const object = findObject(index, undefined, path[0])
    if (schemaObjects.length === 0 && !object) return null
    return {
      objects: object ? [object] : [],
      complete: (columns) => result(object ? [...columnOptions([{ columns: columnsOf(columns, object) }], index.fold), ...schemaObjects] : schemaObjects, context)
    }
  }
  const join = scan?.place.kind === 'column' && !context.quote ? scan.place.join : undefined
  // Nothing typed and not asked for: only JOIN conditions show by themselves.
  const unasked = !context.word && !explicit
  if (unasked && !join) return null
  if (scan?.place.kind !== 'column') return { objects: [], complete: () => result(index.top, context) }
  const refs: TableRef[] = scan.place.only ? [scan.place.only] : scan.tables
  const tables = refs.flatMap((ref) => {
    const object = findObject(index, ref.schema, ref.name)
    return object ? [{ object, source: ref.alias ?? ref.name }] : []
  })
  const joinObjects = join ? [join.table, ...join.earlier].map((ref) => findObject(index, ref.schema, ref.name)) : []
  return {
    objects: uniqueObjects([...tables.map((t) => t.object), ...joinObjects]),
    complete: (columns) => {
      const conditions = join ? joinConditions(index, join, columns) : []
      if (unasked && conditions.length === 0) return null
      const options = columnOptions(tables.map((t) => ({ columns: columnsOf(columns, t.object), source: t.source })), index.fold, COLUMN_BOOST)
      return result([...conditions, ...options, ...index.top], context)
    }
  }
}

/** Completions without a statement or columns: names only (the plan, made at once). */
export function completeNames(index: NameIndex, context: NameContext, explicit: boolean): NameResult | null {
  return planCompletion(index, context, null, explicit)?.complete(new Map()) ?? null
}
