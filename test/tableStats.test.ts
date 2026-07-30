import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCatalogStatsSql,
  parseCatalogStats,
  pickRecencyColumn,
  recencyNoteFor,
  nameTokens,
  quoteIdent,
  buildMaxDateSql,
  parseMaxDate,
  isoDate,
  formatBytes,
  formatRows,
  formatDay,
  summarizeStats,
  describeTableStats,
} from "../src/context/db/tableStats";
import { SchemaCatalog, TableDef } from "../src/context/db/schemaIndex";

const tbl = (name: string, cols: Array<[string, string]>, schema = "dbo"): TableDef => ({
  schema,
  name,
  kind: "table",
  columns: cols.map(([n, dataType]) => ({ name: n, dataType })),
});

test("the statistics query never counts rows", () => {
  for (const engine of ["mssql", "postgres", "mysql"] as const) {
    const sql = buildCatalogStatsSql(engine);
    // COUNT(*) over the data is the thing this exists to avoid: it turns
    // "how big is this database" into a full scan of every table in it.
    assert.ok(!/count\(\s*\*\s*\)\s+from\s+(?!sys\.|pg_|information_schema)/i.test(sql), engine);
    assert.match(sql, /table_schema/i, engine);
    assert.match(sql, /table_name/i, engine);
    assert.match(sql, /row_estimate/i, engine);
    assert.match(sql, /bytes/i, engine);
    assert.match(sql, /column_count/i, engine);
  }
  // Rows and size need DIFFERENT partition filters on SQL Server: rows only
  // from the heap/clustered index, size from every allocation unit.
  const mssql = buildCatalogStatsSql("mssql");
  assert.match(mssql, /index_id IN \(0,1\)/);
  assert.match(mssql, /allocation_units/);
});

test("parseCatalogStats tolerates engine casing and missing figures", () => {
  const parsed = parseCatalogStats([
    { TABLE_SCHEMA: "dbo", TABLE_NAME: "Orders", row_estimate: "1200", bytes: 4096, column_count: 12 },
    { table_schema: "public", table_name: "audit", row_estimate: null, bytes: null, column_count: 3 },
    { table_name: "unqualified", row_estimate: 5 },
    { row_estimate: 9 }, // no name at all — skipped rather than keyed to ""
  ]);
  assert.deepEqual(parsed["dbo.orders"], { columns: 12, rows: 1200, bytes: 4096 });
  // A denied or NULL figure leaves the field off rather than reporting zero,
  // because "0 rows" and "not allowed to know" are very different answers.
  assert.deepEqual(parsed["public.audit"], { columns: 3 });
  assert.deepEqual(parsed["unqualified"], { rows: 5 });
  assert.equal(Object.keys(parsed).length, 3);
});

test("MySQL's own update time is used, and labelled as its own basis", () => {
  const parsed = parseCatalogStats([
    { table_schema: "app", table_name: "users", engine_updated: "2026-07-01T10:00:00Z" },
  ]);
  assert.equal(parsed["app.users"].lastUpdated, "2026-07-01T10:00:00.000Z");
  assert.match(parsed["app.users"].lastUpdatedBasis ?? "", /engine metadata/);
});

test("a table's DEFINITION date is never reported as its DATA date", () => {
  // sys.tables.modify_date says when the table was ALTERed. Showing it as
  // "last updated" would tell someone a dormant table is active.
  const parsed = parseCatalogStats([
    { table_schema: "dbo", table_name: "Orders", schema_modified: "2020-01-01T00:00:00Z" },
  ]);
  assert.equal(parsed["dbo.orders"].schemaModified, "2020-01-01T00:00:00.000Z");
  assert.equal(parsed["dbo.orders"].lastUpdated, undefined);
});

test("nameTokens splits the shapes real column names come in", () => {
  assert.deepEqual(nameTokens("lst_upd_dt"), ["lst", "upd", "dt"]);
  assert.deepEqual(nameTokens("LastModifiedDate"), ["last", "modified", "date"]);
  assert.deepEqual(nameTokens("sys_updated_on"), ["sys", "updated", "on"]);
  assert.deepEqual(nameTokens("created-at"), ["created", "at"]);
});

test("pickRecencyColumn prefers a modification stamp over a creation stamp", () => {
  const t = tbl("Orders", [
    ["id", "int"],
    ["created_on", "datetime"],
    ["lst_upd_dt", "datetime"],
  ]);
  const pick = pickRecencyColumn(t);
  // A table can be heavily updated without gaining a single row, so the
  // modification stamp is the one that answers "is anyone still writing here".
  assert.equal(pick?.column, "lst_upd_dt");
  assert.equal(pick?.kind, "modified");
  // With only a creation stamp, that is still a real signal — just a weaker one.
  const created = pickRecencyColumn(tbl("Log", [["created_on", "datetime"]]));
  assert.equal(created?.column, "created_on");
  assert.equal(created?.kind, "created");
});

test("pickRecencyColumn refuses BUSINESS dates", () => {
  // MAX(due_date) is a fact about future obligations. Reporting it as "last
  // updated" is worse than reporting nothing, because it looks like an answer.
  const t = tbl("Invoices", [
    ["id", "int"],
    ["due_date", "date"],
    ["expiry_date", "datetime"],
    ["effective_date", "date"],
    ["ship_date", "date"],
  ]);
  assert.equal(pickRecencyColumn(t), undefined);
  assert.match(recencyNoteFor(t), /look like business dates/);
  assert.match(recencyNoteFor(t), /due_date/);
});

test("pickRecencyColumn ignores non-date columns and unnamed dates", () => {
  // A varchar called "updated_by" is a person, not a time.
  assert.equal(pickRecencyColumn(tbl("T", [["updated_by", "varchar"]])), undefined);
  // A time-of-day has no date, so its maximum says nothing about recency.
  assert.equal(pickRecencyColumn(tbl("T", [["updated_time", "time"]])), undefined);
  // A date column whose name carries no meaning at all is too weak to claim.
  assert.equal(pickRecencyColumn(tbl("T", [["x", "datetime"]])), undefined);
  // No date column at all gets the simpler note.
  assert.equal(recencyNoteFor(tbl("T", [["id", "int"]])), "no date column");
});

test("pickRecencyColumn is stable, and prefers precision", () => {
  // Two equally-named candidates: the first wins, so the reported basis
  // doesn't wander between runs.
  const t = tbl("T", [["updated_a", "datetime"], ["updated_b", "datetime"]]);
  assert.equal(pickRecencyColumn(t)?.column, "updated_a");
  // A datetime pins the moment; a bare date only the day.
  const mixed = tbl("T", [["modified_date", "date"], ["modified_at", "datetime2"]]);
  assert.equal(pickRecencyColumn(mixed)?.column, "modified_at");
  // Mongo reports type unions.
  assert.equal(pickRecencyColumn(tbl("T", [["updatedAt", "date|null"]]))?.column, "updatedAt");
});

test("identifiers are escaped, not merely wrapped", () => {
  assert.equal(quoteIdent("mssql", "Order Details"), "[Order Details]");
  assert.equal(quoteIdent("postgres", 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent("mysql", "ba`ck"), "`ba``ck`");
  // The escape is what stops a hostile identifier closing the delimiter and
  // continuing as SQL. These names come from the catalog, but "the source is
  // trusted" is exactly the assumption that ages badly.
  assert.equal(quoteIdent("mssql", "a]b"), "[a]]b]");
});

test("buildMaxDateSql targets the right table, qualified or not", () => {
  assert.equal(
    buildMaxDateSql("mssql", tbl("Orders", [["lst_upd", "datetime"]]), "lst_upd"),
    "SELECT MAX([lst_upd]) AS last_updated FROM [dbo].[Orders]",
  );
  assert.match(
    buildMaxDateSql("postgres", tbl("orders", [["updated", "timestamp"]], "public"), "updated"),
    /FROM "public"\."orders"$/,
  );
  const noSchema: TableDef = { name: "events", kind: "collection", columns: [] };
  assert.equal(
    buildMaxDateSql("mysql", noSchema, "ts"),
    "SELECT MAX(`ts`) AS last_updated FROM `events`",
  );
});

test("parseMaxDate reads Date objects and strings, and rejects junk", () => {
  assert.equal(parseMaxDate([{ last_updated: new Date("2026-07-30T00:00:00Z") }]), "2026-07-30T00:00:00.000Z");
  assert.equal(parseMaxDate([{ LAST_UPDATED: "2026-01-02" }]), "2026-01-02T00:00:00.000Z");
  assert.equal(parseMaxDate([{ last_updated: null }]), undefined, "an empty table has no maximum");
  assert.equal(parseMaxDate([]), undefined);
  assert.equal(isoDate("not a date"), undefined);
  assert.equal(isoDate(0), undefined);
});

test("formatBytes uses the unit a person would say", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(12_288), "12 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  assert.equal(formatBytes(3.5 * 1024 ** 3), "3.50 GB");
  assert.equal(formatBytes(2 * 1024 ** 4), "2.00 TB");
  // A 12 KB lookup table must not read as "0.0 MB".
  assert.ok(!formatBytes(12_288).includes("MB"));
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatRows(undefined), "—");
  assert.equal(formatRows(1234567), "1,234,567");
  assert.equal(formatDay("2026-07-30T11:22:33.000Z"), "2026-07-30");
});

test("summarizeStats prefers the DATABASE's column count over the capped catalog", () => {
  // The catalog caps columns per table, so counting its entries under-reports
  // a wide table — the exact case where a total that looks precise is wrong.
  const catalog: SchemaCatalog = {
    fetchedAt: "2026-07-30T00:00:00Z",
    engine: "mssql",
    database: "DW",
    tables: [tbl("Wide", [["a", "int"], ["b", "int"]]), tbl("Narrow", [["id", "int"]])],
  };
  const withStats = summarizeStats(catalog, {
    measuredAt: "2026-07-30T00:00:00Z",
    tables: {
      "dbo.wide": { columns: 240, rows: 1_000_000, bytes: 1024 ** 3 },
      "dbo.narrow": { columns: 1, rows: 12, bytes: 8192 },
    },
  });
  assert.equal(withStats.columns, 241, "the real count, not the 3 the catalog kept");
  assert.equal(withStats.columnsExact, true);
  assert.equal(withStats.rows, 1_000_012);
  assert.equal(withStats.bytes, 1024 ** 3 + 8192);
  assert.equal(withStats.partial, false);

  // With no stats at all it falls back to the catalog and SAYS the count is
  // not exact, rather than presenting a capped number as fact.
  const noStats = summarizeStats(catalog, undefined);
  assert.equal(noStats.columns, 3);
  assert.equal(noStats.columnsExact, false);
  assert.equal(noStats.rows, undefined, "no rows measured means no total, not zero");

  // Stats covering only some tables are reported as partial.
  const half = summarizeStats(catalog, {
    measuredAt: "2026-07-30T00:00:00Z",
    tables: { "dbo.wide": { rows: 5 } },
  });
  assert.equal(half.partial, true);
  assert.equal(half.rows, 5);
});

test("describeTableStats reads as a sentence and degrades gracefully", () => {
  assert.equal(
    describeTableStats({ columns: 12, rows: 4200, bytes: 1024 * 1024, lastUpdated: "2026-07-01T00:00:00Z" }, 3),
    "12 columns · ≈ 4,200 rows · 1.0 MB · last updated 2026-07-01",
  );
  // Nothing measured yet: the catalog's column count still gives a useful line.
  assert.equal(describeTableStats(undefined, 7), "7 columns");
});
