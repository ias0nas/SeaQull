import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scanStatement, tokenize, type TableRef } from '../src/shared/sql-statement.ts'

/** Scans `sql`, whose `|` marks the cursor. */
function scan(sql: string) {
  const cursor = sql.indexOf('|')
  return scanStatement(sql.slice(0, cursor) + sql.slice(cursor + 1), cursor)
}
const tables = (sql: string) => scan(sql).tables
const place = (sql: string) => scan(sql).place
/** The qualifier names and what each stands for (`?` when unresolved). */
const qualifiers = (sql: string) =>
  Object.fromEntries(scan(sql).qualifiers.map((q) => [q.name, q.table ? `${q.table.schema ? `${q.table.schema}.` : ''}${q.table.name}` : '?']))

const t = (name: string, alias?: string, schema?: string): TableRef => ({ ...(schema ? { schema } : {}), name, ...(alias ? { alias } : {}) })

test('tokens: strings, comments, bracketed and quoted names, GO', () => {
  const kinds = (sql: string) => tokenize(sql).map((t) => `${t.kind}:${t.text}`)
  assert.deepEqual(kinds("SELECT 'FROM x' -- FROM y\n/* FROM /* nested */ z */ [a]]b] \"c\"\"d\" N'it''s' @v #t 1.5e3"), [
    'word:SELECT', "string:'FROM x'", 'ident:[a]]b]', 'ident:"c""d"', "string:N'it''s'", 'variable:@v', 'temp:#t', 'number:1.5e3'
  ])
  assert.deepEqual(kinds('a\nGO\nb\n  go 5 -- twice\nc go'), ['word:a', 'go:GO', 'word:b', 'go:go 5 -- twice', 'word:c', 'word:go'])
  // An unclosed bracket (being typed) stops at the end of its line.
  assert.deepEqual(kinds('[Order D\nFROM t'), ['ident:[Order D', 'word:FROM', 'word:t'])
})

test('aliases with and without AS; the table name qualifies too', () => {
  assert.deepEqual(tables('SELECT | FROM Sales.Customer c JOIN Sales.SalesOrderHeader AS h ON h.CustomerID = c.CustomerID'), [
    t('Customer', 'c', 'Sales'),
    t('SalesOrderHeader', 'h', 'Sales')
  ])
  assert.deepEqual(qualifiers('SELECT | FROM Sales.Customer c JOIN Sales.SalesOrderHeader AS h ON 1 = 1'), {
    c: 'Sales.Customer', Customer: 'Sales.Customer', h: 'Sales.SalesOrderHeader', SalesOrderHeader: 'Sales.SalesOrderHeader'
  })
  assert.deepEqual(qualifiers('SELECT | FROM Customer'), { Customer: 'Customer' })
})

test('every kind of JOIN, APPLY, comma lists, table hints', () => {
  const sql = `SELECT | FROM a WITH (NOLOCK), b bb, [My Table] AS [m t]
    INNER JOIN c ON 1=1 LEFT JOIN d ON 1=1 LEFT OUTER JOIN e ON 1=1 RIGHT JOIN f ON 1=1 FULL OUTER JOIN g ON 1=1
    CROSS JOIN h LEFT HASH JOIN i ON 1=1 LEFT MERGE JOIN j ON 1=1 JOIN k x WITH (INDEX(ix)) ON 1=1
    CROSS APPLY dbo.fn(a.id) f OUTER APPLY (SELECT 1 AS one) sub OUTER APPLY dbo.fn2(b.id) AS g2`
  assert.deepEqual(tables(sql), [
    t('a'), t('b', 'bb'), t('My Table', 'm t'), t('c'), t('d'), t('e'), t('f'), t('g'), t('h'), t('i'), t('j'), t('k', 'x'), t('fn', 'f', 'dbo'), t('fn2', 'g2', 'dbo')
  ])
  assert.equal(qualifiers(sql).sub, '?', 'APPLY (subquery) gives nothing')
})

test('UPDATE, UPDATE … FROM, DELETE, INSERT INTO t (…), MERGE', () => {
  assert.deepEqual(tables('UPDATE Sales.Customer SET | = 1'), [t('Customer', undefined, 'Sales')])
  assert.deepEqual(tables('UPDATE c SET | = h.x FROM Sales.Customer c JOIN h ON 1=1'), [t('Customer', 'c', 'Sales'), t('h')])
  assert.deepEqual(tables('UPDATE TOP (10) t SET |'), [t('t')])
  assert.deepEqual(tables('DELETE FROM dbo.ErrorLog WHERE |'), [t('ErrorLog', undefined, 'dbo')])
  assert.deepEqual(tables('DELETE e FROM dbo.ErrorLog e WHERE |'), [t('ErrorLog', 'e', 'dbo')])
  assert.deepEqual(tables('DELETE dbo.ErrorLog WHERE |'), [t('ErrorLog', undefined, 'dbo')])
  assert.deepEqual(tables('INSERT INTO dbo.t (|) SELECT x FROM s'), [t('t', undefined, 'dbo'), t('s')])
  assert.deepEqual(tables('INSERT dbo.t (|) VALUES (1)'), [t('t', undefined, 'dbo')])
  const merge = 'MERGE INTO dbo.Target AS tgt USING Sales.Source AS src ON tgt.id = src.id WHEN MATCHED THEN UPDATE SET |'
  assert.deepEqual(tables(merge), [t('Target', 'tgt', 'dbo'), t('Source', 'src', 'Sales')])
  assert.deepEqual(tables('MERGE dbo.Target WITH (HOLDLOCK) t USING (SELECT 1 AS id) s ON |'), [t('Target', 't', 'dbo')])
})

test('subqueries count for the statement; strings and comments do not', () => {
  assert.deepEqual(tables('SELECT | FROM a WHERE x IN (SELECT y FROM b) AND EXISTS (SELECT 1 FROM c)'), [t('a'), t('b'), t('c')])
  assert.deepEqual(tables("SELECT 'FROM x', | /* JOIN y */ FROM a -- JOIN z\nWHERE b = 'JOIN w'"), [t('a')])
  assert.deepEqual(tables('SELECT | FROM [Order Details] od JOIN [a]]b] ON 1=1'), [t('Order Details', 'od'), t('a]b')])
  assert.deepEqual(tables('SELECT a FROM t WHERE a IS DISTINCT FROM b AND |'), [t('t')])
})

test('statements: semicolons, GO, and new statements without semicolons', () => {
  assert.deepEqual(tables('SELECT * FROM a; SELECT | FROM b'), [t('b')])
  assert.deepEqual(tables('SELECT * FROM a\nGO\nSELECT | FROM b\nGO\nSELECT * FROM c'), [t('b')])
  assert.deepEqual(tables('SELECT * FROM a\nSELECT | FROM b\nUPDATE c SET x = 1'), [t('b')])
  assert.deepEqual(tables('DECLARE @x int\nSET @x = 1\nSELECT | FROM b\nIF @x = 1 PRINT 1'), [t('b')])
  assert.deepEqual(tables('SELECT | FROM a UNION ALL SELECT x FROM b EXCEPT SELECT x FROM c'), [t('a'), t('b'), t('c')])
  assert.deepEqual(tables('SELECT CASE WHEN x = 1 THEN 2 ELSE 3 END, | FROM a'), [t('a')], 'CASE … END is not a statement end')
  assert.deepEqual(tables('BEGIN\nSELECT | FROM a\nEND\nSELECT * FROM b'), [t('a')])
  assert.deepEqual(tables('INSERT INTO t (a) SELECT | FROM s'), [t('t'), t('s')])
  assert.deepEqual(tables('INSERT INTO t (a) EXEC dbo.p\nSELECT | FROM s'), [t('s')])
  assert.deepEqual(tables('SELECT 1 FROM a ORDER BY 1 OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY\nSELECT | FROM b'), [t('b')])
})

test('CTEs, derived tables, temp tables, table variables and three-part names give nothing', () => {
  const cte = 'WITH recent AS (SELECT * FROM Sales.SalesOrderHeader), totals (id, n) AS (SELECT 1, 2)\nSELECT | FROM recent r JOIN totals ON 1=1 JOIN Sales.Customer c ON 1=1'
  assert.deepEqual(tables(cte), [t('SalesOrderHeader', undefined, 'Sales'), t('Customer', 'c', 'Sales')])
  assert.deepEqual(qualifiers(cte), { SalesOrderHeader: 'Sales.SalesOrderHeader', r: '?', totals: '?', c: 'Sales.Customer', Customer: 'Sales.Customer' })
  const others = 'SELECT | FROM (SELECT 1 AS a) AS d JOIN #tmp t ON 1=1 JOIN @tv v ON 1=1 JOIN AdventureWorks2022.Sales.Customer x ON 1=1'
  assert.deepEqual(tables(others), [])
  assert.deepEqual(qualifiers(others), { d: '?', t: '?', v: '?', x: '?' })
  assert.deepEqual(tables('WITH c AS (SELECT 1 AS a) UPDATE c SET |'), [])
})

test('the cursor: column places', () => {
  for (const sql of [
    'SELECT | FROM a',
    'SELECT |\nFROM a',
    'SELECT a, | FROM a',
    'SELECT DISTINCT TOP 10 | FROM a',
    'SELECT CASE WHEN | FROM a',
    'SELECT COUNT(| FROM a',
    'SELECT * FROM a WHERE |',
    'SELECT * FROM a WHERE x = 1 AND |',
    'SELECT * FROM a WHERE x IN (|',
    'SELECT * FROM a JOIN b ON |',
    'SELECT * FROM a GROUP BY |',
    'SELECT * FROM a ORDER BY x, |',
    'SELECT * FROM a GROUP BY x HAVING |',
    'SELECT ROW_NUMBER() OVER (PARTITION BY |',
    'UPDATE a SET |',
    'UPDATE a SET x = 1, |',
    'INSERT INTO a (x) SELECT | FROM b',
    'SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b WHERE |'
  ]) {
    assert.equal(place(sql).kind, 'column', sql)
    assert.equal('only' in place(sql), false, sql)
  }
})

test('the cursor: INSERT column lists take only the target', () => {
  assert.deepEqual(place('INSERT INTO dbo.t (|) SELECT x FROM s'), { kind: 'column', only: t('t', undefined, 'dbo') })
  assert.deepEqual(place('INSERT [My T] (a, |'), { kind: 'column', only: t('My T') })
  assert.deepEqual(place('MERGE dbo.t AS x USING s ON 1=1 WHEN NOT MATCHED THEN INSERT (|'), { kind: 'column', only: t('t', 'x', 'dbo') })
})

test('the cursor: table and other places', () => {
  for (const sql of ['SELECT * FROM |', 'SELECT * FROM a, |', 'SELECT * FROM a JOIN |', 'SELECT * FROM a x LEFT JOIN |', 'UPDATE |', 'DELETE FROM |', 'INSERT INTO |', 'EXEC |', 'SELECT * FROM a CROSS APPLY |', 'MERGE INTO |', 'TRUNCATE TABLE |', 'SELECT * FROM a x |']) {
    assert.equal(place(sql).kind, 'table', sql)
  }
  for (const sql of ['|', 'INSERT INTO a (x) VALUES (|', 'DECLARE @x int = |', 'PRINT |', 'SELECT * FROM a WITH (|', 'SELECT 1;\n|']) {
    assert.equal(place(sql).kind, 'other', sql)
  }
})

test('the word being typed does not decide the place', () => {
  assert.equal(place('SELECT * FROM a WHERE Cu|').kind, 'column')
  assert.equal(place('SELECT * FROM Cu|').kind, 'table')
  assert.equal(place('SELECT * FROM a WHER|').kind, 'table')
})

test('only text near the cursor is read', () => {
  const far = `SELECT * FROM early\n${'-- padding\n'.repeat(5000)}SELECT | FROM late`
  assert.deepEqual(tables(far), [t('late')])
})

test('the name being typed is not one of the statement\'s tables', () => {
  assert.deepEqual(tables('SELECT * FROM Sales.|'), [])
  assert.deepEqual(tables('SELECT * FROM Sales.Cust|'), [])
  assert.deepEqual(tables('SELECT * FROM Sales.Cust|omer WHERE 1 = 1'), [])
  assert.deepEqual(tables('SELECT * FROM a JOIN Sales.| ON 1=1'), [t('a')])
  assert.deepEqual(tables('SELECT c.| FROM Sales.Customer c'), [t('Customer', 'c', 'Sales')])
})

test('the cursor right after a JOIN\'s ON: the joined table and those before it', () => {
  const join = (sql: string) => {
    const p = place(sql)
    return p.kind === 'column' ? p.join : undefined
  }
  // Aliases, with and without AS; the earlier tables in order.
  assert.deepEqual(join('SELECT * FROM Sales.Customer c JOIN Sales.SalesOrderHeader AS h ON |'), { table: t('SalesOrderHeader', 'h', 'Sales'), earlier: [t('Customer', 'c', 'Sales')] })
  assert.deepEqual(join('SELECT * FROM Customers JOIN Orders ON |'), { table: t('Orders'), earlier: [t('Customers')] })
  assert.deepEqual(join('SELECT * FROM [Sales].[Customer] JOIN [Order Details] od ON |'), { table: t('Order Details', 'od'), earlier: [t('Customer', undefined, 'Sales')] })
  // A partly typed word after ON; the cursor in the middle of it.
  assert.deepEqual(join('SELECT * FROM a JOIN b ON x|'), { table: t('b'), earlier: [t('a')] })
  assert.deepEqual(join('SELECT * FROM a JOIN b ON x|yz'), { table: t('b'), earlier: [t('a')] })
  assert.deepEqual(join('SELECT * FROM a JOIN b ON [x|'), { table: t('b'), earlier: [t('a')] })
  // Several earlier tables: comma joins, earlier JOINs and their conditions, kinds of JOIN, hints, APPLY.
  assert.deepEqual(join(`SELECT * FROM a, b x
    LEFT OUTER JOIN c ON c.id = (SELECT MAX(id) FROM z JOIN y ON 1 = 1) AND c.v IN (1, 2)
    CROSS APPLY dbo.f(a.id) fa
    INNER HASH JOIN d WITH (NOLOCK) ON d.id = c.id
    FULL JOIN e AS ee WITH (NOLOCK) ON |`), { table: t('e', 'ee'), earlier: [t('a'), t('b', 'x'), t('c'), t('f', 'fa', 'dbo'), t('d')] })
  // A nested join: from outside, its tables are earlier ones; inside it, only its own count.
  assert.deepEqual(join('SELECT * FROM a JOIN (b JOIN c ON b.id = c.id) ON |'), undefined, 'a nested join is not one table')
  assert.deepEqual(join('SELECT * FROM a JOIN (b JOIN c ON b.id = c.id) JOIN d ON |'), { table: t('d'), earlier: [t('a'), t('b'), t('c')] })
  assert.deepEqual(join('SELECT * FROM a JOIN (b JOIN c ON |'), { table: t('c'), earlier: [t('b')] })
  // A subquery's own FROM clause, not the outer one.
  assert.deepEqual(join('SELECT * FROM a WHERE a.id IN (SELECT 1 FROM b JOIN c ON |'), { table: t('c'), earlier: [t('b')] })
  assert.deepEqual(join('SELECT * FROM a JOIN (SELECT * FROM z) d ON d.id = a.id JOIN b ON |'), { table: t('b'), earlier: [t('a')] })
  // The same table twice, as two aliases.
  assert.deepEqual(join('SELECT * FROM Employee e JOIN Employee m ON |'), { table: t('Employee', 'm'), earlier: [t('Employee', 'e')] })
  // UPDATE … FROM, DELETE … FROM, after a UNION.
  assert.deepEqual(join('UPDATE o SET x = 1 FROM Orders o JOIN Customers c ON |'), { table: t('Customers', 'c'), earlier: [t('Orders', 'o')] })
  assert.deepEqual(join('SELECT * FROM q UNION SELECT * FROM a JOIN b ON |'), { table: t('b'), earlier: [t('a')] })
  // A condition already started: plain column completion.
  assert.deepEqual(place('SELECT * FROM a JOIN b ON a.x = |'), { kind: 'column' })
  assert.deepEqual(place('SELECT * FROM a JOIN b ON a.x = b.x AND |'), { kind: 'column' })
  assert.deepEqual(place('SELECT * FROM a JOIN b ON (|'), { kind: 'column' })
  // Not a table: a derived table, a CTE, a temp table; APPLY, MERGE, CREATE INDEX have no JOIN.
  assert.equal(join('SELECT * FROM a JOIN (SELECT 1 AS id) d ON |'), undefined)
  assert.equal(join('WITH x AS (SELECT 1 AS id) SELECT * FROM a JOIN x ON |'), undefined)
  assert.equal(join('SELECT * FROM a JOIN #t ON |'), undefined)
  assert.equal(join('SELECT * FROM a CROSS APPLY dbo.f(a.id) ON |'), undefined)
  assert.equal(join('MERGE INTO t USING s ON |'), undefined)
  assert.equal(join('MERGE t USING (SELECT * FROM a JOIN b ON 1 = 1) s ON |'), undefined)
  assert.equal(join('CREATE INDEX ix ON |'), undefined)
  assert.equal(join('SELECT * FROM a JOIN b ON a.x IS DISTINCT FROM b.x JOIN c ON |')?.earlier.length, 2, 'IS DISTINCT FROM is not a FROM clause')
  // Only tables earlier in the clause; one alone has nothing to join to.
  assert.equal(join('SELECT * FROM a ON |'), undefined)
})
