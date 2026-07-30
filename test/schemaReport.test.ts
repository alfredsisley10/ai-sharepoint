import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ageInDays,
  classifyAge,
  summarizeAging,
  buildInventory,
  inventoryMarkdown,
  agingMarkdown,
  buildCapacityProbeSql,
  parseCapacity,
  recommendLimits,
  schemaReportSheets,
} from "../src/context/db/schemaReport";
import { SourceSchema, TableDef } from "../src/context/db/schemaIndex";

const NOW = "2026-07-30T00:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const tbl = (name: string, cols = 3, kind: TableDef["kind"] = "table"): TableDef => ({
  schema: "dbo",
  name,
  kind,
  columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, dataType: "int" })),
});

function schemaWith(
  tables: TableDef[],
  stats?: Record<string, { rows?: number; bytes?: number; lastUpdated?: string; columns?: number; recencyNote?: string }>,
): SourceSchema {
  return {
    catalog: { fetchedAt: NOW, engine: "mssql", database: "DW", tables },
    semanticState: "none",
    ...(stats ? { stats: { measuredAt: NOW, tables: stats } } : {}),
  };
}

test("ageInDays clamps a future timestamp instead of reporting negative age", () => {
  assert.equal(ageInDays(daysAgo(10), NOW), 10);
  assert.equal(ageInDays(daysAgo(0), NOW), 0);
  // Clock skew, or a business date that slipped past the column filter — either
  // way "-40 days old" is not a thing to show anyone.
  assert.equal(ageInDays("2030-01-01T00:00:00Z", NOW), 0);
  assert.equal(ageInDays(undefined, NOW), undefined);
  assert.equal(ageInDays("not a date", NOW), undefined);
});

test("age bands split at the boundaries people actually reason in", () => {
  assert.equal(classifyAge(daysAgo(1), NOW), "current");
  assert.equal(classifyAge(daysAgo(30), NOW), "current");
  assert.equal(classifyAge(daysAgo(31), NOW), "recent");
  assert.equal(classifyAge(daysAgo(90), NOW), "recent");
  assert.equal(classifyAge(daysAgo(91), NOW), "aging");
  assert.equal(classifyAge(daysAgo(365), NOW), "aging");
  assert.equal(classifyAge(daysAgo(366), NOW), "stale");
  assert.equal(classifyAge(daysAgo(365 * 3 + 1), NOW), "dormant");
  // Never measured is its own answer, not "old".
  assert.equal(classifyAge(undefined, NOW), "unknown");
});

test("aging is weighted by rows, because that is where the finding is", () => {
  // Three small live tables and one huge dead one: counting tables says the
  // database is healthy, counting rows says most of it is a dead migration.
  const schema = schemaWith(
    [tbl("Live1"), tbl("Live2"), tbl("Live3"), tbl("OldWarehouse")],
    {
      "dbo.live1": { rows: 100, bytes: 1024, lastUpdated: daysAgo(2) },
      "dbo.live2": { rows: 200, bytes: 2048, lastUpdated: daysAgo(10) },
      "dbo.live3": { rows: 300, bytes: 4096, lastUpdated: daysAgo(45) },
      "dbo.oldwarehouse": { rows: 9_000_000, bytes: 1024 ** 3, lastUpdated: daysAgo(1500) },
    },
  );
  const aging = summarizeAging(schema.catalog, schema.stats, NOW);
  assert.equal(aging.measured, 4);
  assert.equal(aging.unmeasured, 0);
  const dormant = aging.bands.find((b) => b.band === "dormant")!;
  assert.equal(dormant.tables, 1);
  assert.equal(dormant.rows, 9_000_000);
  // The headline must carry the row share — "1 table is dormant" is not the
  // same finding as "the dormant table holds most of the rows". And 9,000,000
  // of 9,000,600 must not round up to a flat "100%": three other tables still
  // hold rows, so claiming all of them would be false.
  assert.match(aging.headline, />99% of the rows/);
  assert.match(aging.headline, /1 has not changed/, "singular");
  assert.match(aging.headline, /3 of 4 measured/);
});

test("aging says plainly when nothing has been measured", () => {
  const schema = schemaWith([tbl("A"), tbl("B")]);
  const aging = summarizeAging(schema.catalog, schema.stats, NOW);
  assert.equal(aging.measured, 0);
  assert.equal(aging.unmeasured, 2);
  assert.match(aging.headline, /Refresh Database Table Statistics/);
  // Unmeasured tables are still accounted for, in their own band.
  assert.equal(aging.bands.find((b) => b.band === "unknown")?.tables, 2);
  // A partially-measured database says how many it couldn't do.
  const partial = summarizeAging(
    schemaWith([tbl("A"), tbl("B")], { "dbo.a": { lastUpdated: daysAgo(5) } }).catalog,
    { measuredAt: NOW, tables: { "dbo.a": { lastUpdated: daysAgo(5) } } },
    NOW,
  );
  assert.match(partial.headline, /1 could not be measured/);
});

test("the inventory is biggest-first, not alphabetical", () => {
  // On a thousand-table schema, alphabetical order buries the ten tables that
  // hold the data — which are exactly the ones being looked for.
  const schema = schemaWith([tbl("Aardvark"), tbl("Zebra"), tbl("Middle")], {
    "dbo.aardvark": { bytes: 1024 },
    "dbo.zebra": { bytes: 1024 ** 3 },
    "dbo.middle": { bytes: 1024 ** 2 },
  });
  assert.deepEqual(
    buildInventory(schema, NOW).map((r) => r.table),
    ["dbo.Zebra", "dbo.Middle", "dbo.Aardvark"],
  );
  // With no sizes at all it falls back to a stable alphabetical order rather
  // than an arbitrary one.
  const unmeasured = buildInventory(schemaWith([tbl("B"), tbl("A")]), NOW);
  assert.deepEqual(unmeasured.map((r) => r.table), ["dbo.A", "dbo.B"]);
});

test("the inventory carries index state and the column-cap gap", () => {
  const schema: SourceSchema = {
    ...schemaWith([tbl("Wide", 80)], { "dbo.wide": { columns: 240, rows: 5 } }),
    semanticState: "indexed",
    semantic: {
      indexedAt: NOW,
      modelId: "m",
      tables: [{ table: "dbo.Wide", columns: [], synopsis: "One row per fact.", contentIndexedAt: NOW }],
    },
  };
  const [row] = buildInventory(schema, NOW);
  assert.equal(row.columns, 240, "the database's count, not the catalog's 80");
  assert.equal(row.columnsTruncated, true);
  assert.equal(row.indexed, true);
  assert.equal(row.contentIndexed, true);
  assert.equal(row.synopsis, "One row per fact.");
});

test("a view reads as 'n/a', not as an unmeasured table", () => {
  // A view has no storage of its own. A blank cell would say "not measured",
  // which is a different and wrong claim.
  const schema = schemaWith([tbl("V", 3, "view")]);
  const md = inventoryMarkdown(buildInventory(schema, NOW)).join("\n");
  assert.match(md, /n\/a \(view\)/);
  assert.match(md, /_\(view\)_/);
});

test("the inventory markdown caps its length and says it did", () => {
  const many = Array.from({ length: 250 }, (_, i) => tbl(`T${i}`));
  const md = inventoryMarkdown(buildInventory(schemaWith(many), NOW), 200).join("\n");
  assert.match(md, /… 50 more/);
  assert.match(md, /export the XLSX report/);
  // No silent truncation: a cap the reader can't see reads as "that's all of them".
  assert.equal(inventoryMarkdown([]).length, 0);
  assert.ok(agingMarkdown(summarizeAging(schemaWith(many).catalog, undefined, NOW)).length > 0);
});

test("the capacity probe measures the database, not the capped catalog", () => {
  for (const engine of ["mssql", "postgres", "mysql"] as const) {
    const sql = buildCapacityProbeSql(engine);
    assert.match(sql, /column_count/i, engine);
    assert.match(sql, /group by/i, engine);
  }
  // SQL Server must count views too — 'U' and 'V'.
  assert.match(buildCapacityProbeSql("mssql"), /o\.type IN \('U','V'\)/);
});

test("parseCapacity finds the widest table and names it", () => {
  const cap = parseCapacity([
    { table_schema: "dbo", table_name: "Narrow", column_count: 4 },
    { TABLE_SCHEMA: "dbo", TABLE_NAME: "Wide", COLUMN_COUNT: "412" },
    { table_name: "NoSchema", column_count: 9 },
    { column_count: 3 }, // no name — not a table
  ]);
  assert.equal(cap.tables, 3);
  assert.equal(cap.maxColumns, 412);
  // The NAME is what makes the recommendation believable.
  assert.equal(cap.widestTable, "dbo.Wide");
  assert.equal(cap.totalColumns, 425);
});

test("recommendLimits states what the CURRENT caps would cost", () => {
  const cap = { tables: 1847, maxColumns: 412, totalColumns: 40_000, widestTable: "dbo.FactSales" };
  const rec = recommendLimits(
    cap,
    { maxTables: 1000, maxColumnsPerTable: 300 },
    { maxTables: 10_000, maxColumnsPerTable: 1_000 },
    [412, 350, 120, 40],
  );
  assert.equal(rec.tablesMissed, 847);
  assert.equal(rec.tablesTruncated, 2, "412 and 350 both exceed 300");
  assert.equal(rec.adequate, false);
  // Headroom, so a schema that grows a little doesn't silently re-truncate.
  assert.ok(rec.maxTables >= 1847 * 1.1, String(rec.maxTables));
  assert.ok(rec.maxColumnsPerTable >= 412, String(rec.maxColumnsPerTable));
  assert.match(rec.summary, /847 table\(s\) would be MISSING/);
  assert.match(rec.summary, /dbo\.FactSales/);
  assert.equal(rec.exceedsCeiling, false);
});

test("recommendLimits never lowers a limit, and never exceeds the ceiling", () => {
  const small = { tables: 12, maxColumns: 8, totalColumns: 80 };
  const rec = recommendLimits(small, { maxTables: 1000, maxColumnsPerTable: 300 }, { maxTables: 10_000, maxColumnsPerTable: 1_000 });
  assert.equal(rec.adequate, true);
  // A small database must not shrink someone's deliberately-raised setting.
  assert.equal(rec.maxTables, 1000);
  assert.equal(rec.maxColumnsPerTable, 300);
  assert.match(rec.summary, /already cover it/);

  // Beyond the ceiling the recommendation says so rather than promising a
  // complete catalog it cannot deliver.
  const huge = recommendLimits(
    { tables: 40_000, maxColumns: 5_000, totalColumns: 1e6 },
    { maxTables: 1000, maxColumnsPerTable: 300 },
    { maxTables: 10_000, maxColumnsPerTable: 1_000 },
  );
  assert.equal(huge.maxTables, 10_000);
  assert.equal(huge.maxColumnsPerTable, 1_000);
  assert.equal(huge.exceedsCeiling, true);
  assert.match(huge.summary, /exceeds the supported maximum/);
});

test("the XLSX report separates the grains it reports on", () => {
  const schema: SourceSchema = {
    catalog: {
      fetchedAt: NOW,
      engine: "mssql",
      database: "DW",
      tables: [tbl("Orders", 2), tbl("Customers", 1)],
      truncated: true,
      truncation: { columnCap: 2, columnCapped: ["dbo.Orders"] },
    },
    semanticState: "indexed",
    semantic: {
      indexedAt: NOW,
      modelId: "test-model",
      partial: true,
      tables: [
        {
          table: "dbo.Orders",
          synopsis: "One row per order.",
          columns: [
            {
              name: "c0",
              tags: ["identifier"],
              synonyms: ["order id"],
              effectiveType: "ISO date stored as text",
              contentSummary: "order timestamps",
              profile: { sampled: 100, nulls: 25, distinct: 60 },
            },
          ],
        },
      ],
    },
    stats: {
      measuredAt: NOW,
      tables: { "dbo.orders": { rows: 1000, bytes: 1024 ** 2, columns: 12, lastUpdated: daysAgo(400) } },
      recencyFailed: [{ table: "dbo.Customers", reason: "timeout — statement: SELECT MAX(x) FROM y" }],
    },
  };
  const sheets = schemaReportSheets(schema, { sourceName: "DW prod", generatedAt: NOW, version: "0.145.0" });
  assert.deepEqual(sheets.map((s) => s.name), ["Summary", "Tables", "Columns", "Aging", "Relationships", "Issues"]);

  const flat = (name: string) => sheets.find((s) => s.name === name)!.rows.map((r) => r.join("|")).join("\n");
  assert.match(flat("Summary"), /DW prod/);
  assert.match(flat("Summary"), /0\.145\.0/);

  // One row per TABLE here...
  const tables = sheets.find((s) => s.name === "Tables")!;
  assert.equal(tables.rows.length, 3, "header + 2 tables");
  assert.match(flat("Tables"), /One row per order\./);
  // Both a human size and the raw byte count, so the sheet is sortable.
  assert.match(flat("Tables"), /1\.0 MB\|1048576/);
  // The catalog held 2 of the table's 12 columns — the gap is the point.
  assert.match(flat("Tables"), /\|12\|2\|/);

  // ...and one row per COLUMN there. Mixing the grains makes both unfilterable.
  const columns = sheets.find((s) => s.name === "Columns")!;
  assert.equal(columns.rows.length, 4, "header + 2 Orders columns + 1 Customers column");
  assert.match(flat("Columns"), /ISO date stored as text/);
  assert.match(flat("Columns"), /order timestamps/);
  assert.match(flat("Columns"), /\|100\|25\|60\|/, "sampled, %NULL, distinct");

  // Everything that went wrong lands in one place rather than being scattered.
  const issues = flat("Issues");
  assert.match(issues, /Columns truncated\|dbo\.Orders/);
  assert.match(issues, /Last-updated probe failed\|dbo\.Customers/);
  assert.match(issues, /Semantic index partial/);
});

test("the report is exportable before anything has been measured", () => {
  // A user's first instinct is to export; producing a broken file, or throwing,
  // would be a poor answer to "I haven't run statistics yet".
  const sheets = schemaReportSheets(schemaWith([tbl("A")]), { sourceName: "S", generatedAt: NOW });
  assert.equal(sheets.length, 6);
  const summary = sheets[0].rows.map((r) => r.join("|")).join("\n");
  assert.match(summary, /not measured/);
  assert.match(sheets.find((s) => s.name === "Issues")!.rows.map((r) => r.join("|")).join("\n"), /No issues detected/);
});
