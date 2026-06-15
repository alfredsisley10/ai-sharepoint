import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  extractMssqlTables,
  buildStatsProbeSql,
  parseTableStats,
  assessMssqlQueryCost,
  rewriteWithSubset,
  BIG_TABLE_ROWS,
  SUBSET_TOP_ROWS,
  TableStat,
} from "../src/context/db/queryCost";

const stat = (
  name: string,
  rowCount: number | undefined,
  leadColumns: string[] = [],
  schema = "dbo",
): TableStat => ({ schema, name, ...(rowCount !== undefined ? { rowCount } : {}), leadColumns });

test("extractMssqlTables reads FROM/JOIN targets with schemas, brackets, and aliases", () => {
  const refs = extractMssqlTables(
    "SELECT o.Id, c.Name FROM dbo.Orders o JOIN [Sales].[Customers] AS c ON o.CustomerId = c.Id WHERE c.Country = 'DE'",
  );
  assert.deepEqual(
    refs.map((r) => `${r.schema}.${r.name}:${r.alias}`),
    ["dbo.Orders:o", "Sales.Customers:c"],
  );
});

test("extractMssqlTables skips derived tables, dedupes, and ignores literals/comments", () => {
  assert.deepEqual(
    extractMssqlTables("SELECT * FROM (SELECT 1 AS x) AS d").map((r) => r.name),
    [],
  );
  assert.deepEqual(
    extractMssqlTables(
      "SELECT * FROM Orders WHERE note = 'copied from Invoices' -- from Payments",
    ).map((r) => r.name),
    ["Orders"],
  );
  assert.equal(extractMssqlTables("SELECT * FROM Orders o, Orders x").length, 1);
});

test("extractMssqlTables supports old-style comma lists; rewrite declines them for big tables", () => {
  const refs = extractMssqlTables("SELECT * FROM Orders o, Customers c WHERE o.CId = c.Id");
  assert.deepEqual(refs.map((r) => `${r.name}${r.viaCommaList ? ":comma" : ""}`), [
    "Orders",
    "Customers:comma",
  ]);
  assert.equal(
    rewriteWithSubset("SELECT COUNT(*) FROM Tiny t, Orders o WHERE t.Id = o.TId", [
      stat("Orders", 9_000_000, []),
    ]),
    undefined,
  );
});

test("buildStatsProbeSql validates identifiers (injection-safe) and probes sizes + index leads", () => {
  const sql = buildStatsProbeSql(extractMssqlTables("SELECT * FROM dbo.Orders"))!;
  assert.match(sql, /sys\.partitions/);
  assert.match(sql, /key_ordinal = 1/);
  assert.match(sql, /IN \(N'Orders'\)/);
  // A hostile "table name" never reaches the probe.
  assert.equal(buildStatsProbeSql([{ name: "x'; DROP TABLE y--", raw: "x" }]), undefined);
});

test("parseTableStats groups probe rows per table and honors query-side schema qualification", () => {
  const rows = [
    { schema_name: "dbo", table_name: "Orders", row_count: 12_400_000, lead_column: "OrderId" },
    { schema_name: "dbo", table_name: "Orders", row_count: 12_400_000, lead_column: "CustomerId" },
    { schema_name: "dbo", table_name: "Tiny", row_count: 12, lead_column: null },
  ];
  const stats = parseTableStats(rows, extractMssqlTables("SELECT * FROM dbo.Orders, Tiny"));
  assert.equal(stats.length, 2);
  assert.equal(stats[0].rowCount, 12_400_000);
  assert.deepEqual(stats[0].leadColumns, ["OrderId", "CustomerId"]);
  // Schema-qualified ref to another schema must NOT match dbo rows.
  assert.equal(
    parseTableStats(rows, extractMssqlTables("SELECT * FROM archive.Orders")).length,
    0,
  );
});

test("small tables are always cheap; the statsNote sizes every probed table", () => {
  const v = assessMssqlQueryCost("SELECT COUNT(*) FROM Tiny GROUP BY a", [
    stat("Tiny", 5_000, ["Id"]),
  ]);
  assert.equal(v.expensive, false);
  assert.match(v.statsNote, /Tiny ≈5,000 rows/);
});

test("aggregates/DISTINCT/GROUP BY over a big table without an indexed WHERE are expensive", () => {
  const big = [stat("Orders", BIG_TABLE_ROWS * 25, ["OrderId", "CustomerId"])];
  for (const sql of [
    "SELECT COUNT(*) FROM Orders",
    "SELECT DISTINCT Status FROM dbo.Orders",
    "SELECT CustomerName, SUM(Total) FROM Orders GROUP BY CustomerName",
    "SELECT * FROM Orders ORDER BY CreatedAt",
    "SELECT * FROM Orders WHERE CustomerName = 'ACME'", // unindexed predicate
  ]) {
    const v = assessMssqlQueryCost(sql, big);
    assert.equal(v.expensive, true, sql);
    assert.match(v.reasons.join(" "), /Orders/);
  }
});

test("an indexed WHERE or a bounded TOP keeps a big-table query cheap", () => {
  const big = [stat("Orders", 9_000_000, ["OrderId", "CustomerId"])];
  assert.equal(
    assessMssqlQueryCost("SELECT * FROM Orders WHERE CustomerId = 42", big).expensive,
    false,
  );
  assert.equal(
    assessMssqlQueryCost("SELECT o.* FROM Orders o WHERE o.[OrderId] IN (1,2,3)", big).expensive,
    false,
  );
  assert.equal(
    assessMssqlQueryCost(`SELECT TOP 100 * FROM Orders`, big).expensive,
    false,
  );
  // …but TOP + ORDER BY still sorts the whole table.
  assert.equal(
    assessMssqlQueryCost("SELECT TOP 100 * FROM Orders ORDER BY CreatedAt", big).expensive,
    true,
  );
});

test("rewriteWithSubset bounds ONLY the big tables and keeps aliases working", () => {
  const big = [stat("Orders", 9_000_000, [])];
  const out = rewriteWithSubset(
    "SELECT c.Name, COUNT(*) FROM dbo.Orders o JOIN Customers c ON o.CustomerId = c.Id GROUP BY c.Name",
    big,
  )!;
  assert.match(out, new RegExp(`FROM \\(SELECT TOP ${SUBSET_TOP_ROWS} \\* FROM dbo\\.Orders\\) AS o`));
  assert.match(out, /JOIN Customers c ON/); // small table untouched
});

test("rewriteWithSubset aliases unaliased big tables by their own name", () => {
  const out = rewriteWithSubset("SELECT COUNT(*) FROM Orders WHERE Status = 'open'", [
    stat("Orders", 9_000_000, []),
  ])!;
  assert.match(out, new RegExp(`FROM \\(SELECT TOP ${SUBSET_TOP_ROWS} \\* FROM Orders\\) AS \\[Orders\\] WHERE`));
});

test("rewriteWithSubset declines CTEs, derived tables, APPLY/PIVOT, and literal-only matches", () => {
  const big = [stat("Orders", 9_000_000, [])];
  assert.equal(
    rewriteWithSubset("WITH x AS (SELECT 1 AS a) SELECT * FROM Orders", big),
    undefined,
  );
  assert.equal(
    rewriteWithSubset("SELECT * FROM (SELECT * FROM Orders) q", big),
    undefined,
  );
  assert.equal(
    rewriteWithSubset("SELECT * FROM Customers CROSS APPLY fn(Customers.Id)", big),
    undefined,
  );
  assert.equal(
    rewriteWithSubset("SELECT * FROM Tiny WHERE note = 'from Orders'", big),
    undefined,
  );
});
