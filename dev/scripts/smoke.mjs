// Connects to the local dev SQL Server with tedious (the driver the worker bundles) and runs a query.
// npm run smoke        -> your Node
// npm run smoke:orca   -> Orca's bundled Node, the runtime plugin workers actually use
import { Connection, Request } from 'tedious'

const fail = (what, err) => {
  console.error(`${what} failed:`, err.message)
  process.exit(1)
}

const connection = new Connection({
  server: 'localhost',
  options: {
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'AdventureWorks2022',
    trustServerCertificate: true, // local container's self-signed cert only
    rowCollectionOnRequestCompletion: true
  },
  authentication: { type: 'default', options: { userName: 'sa', password: process.env.MSSQL_SA_PASSWORD } }
})
connection.on('error', (err) => fail('connection', err))

connection.on('connect', (err) => {
  if (err) fail('connect', err)
  const started = Date.now()
  const sql = `SELECT TOP 5 p.ProductID, p.Name, p.ListPrice, p.SellStartDate, p.rowguid,
                 CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(32)) AS ServerVersion
               FROM Production.Product p WHERE p.ListPrice > 0 ORDER BY p.ListPrice DESC`
  const request = new Request(sql, (err, rowCount, rows) => {
    if (err) fail('query', err)
    const records = rows.map((cols) => Object.fromEntries(cols.map((c) => [c.metadata.colName, c.value])))
    console.log(`tedious OK on Node ${process.version}: ${rowCount} rows in ${Date.now() - started} ms, SQL Server ${records[0]?.ServerVersion}`)
    console.table(records.map(({ ServerVersion, ...rest }) => rest))
    connection.close()
  })
  connection.execSql(request)
})
connection.connect()
