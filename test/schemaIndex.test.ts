import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  catalogFromRows,
  catalogFromMongoSamples,
  chunkTables,
  buildIndexPrompt,
  parseSemanticResponse,
  mergeSemantic,
  searchSchema,
  renderSchemaForModel,
  qualifiedName,
  SchemaCatalog,
  SourceSchema,
  TableDef,
  SCHEMA_MAX_TABLES,
  SCHEMA_MAX_COLUMNS_PER_TABLE,
} from "../src/context/db/schemaIndex";

const T0 = "2026-06-11T12:00:00.000Z";

function cmdbCatalog(): SchemaCatalog {
  return {
    fetchedAt: T0,
    engine: "mssql",
    database: "CMDB",
    tables: [
      {
        schema: "dbo",
        name: "Applications",
        kind: "table",
        columns: [
          { name: "appl_id", dataType: "int" },
          { name: "appl_name", dataType: "nvarchar" },
          { name: "group_cio", dataType: "nvarchar" },
          { name: "lst_upd_dt", dataType: "datetime" },
        ],
      },
      {
        schema: "dbo",
        name: "Servers",
        kind: "table",
        columns: [
          { name: "server_id", dataType: "int" },
          { name: "hostname", dataType: "nvarchar" },
          { name: "owned_by_team", dataType: "nvarchar" },
        ],
      },
    ],
  };
}

function indexedSchema(): SourceSchema {
  return {
    catalog: cmdbCatalog(),
    semanticState: "indexed",
    semantic: {
      indexedAt: T0,
      modelId: "test-model",
      tables: [
        {
          table: "dbo.Applications",
          purpose: "Application inventory",
          columns: [
            {
              name: "group_cio",
              tags: ["ownership", "organization"],
              synonyms: ["owner", "owning group", "CIO"],
              note: "CIO/exec owner of the record",
            },
            { name: "appl_id", tags: ["identifier", "application"], synonyms: ["application id"] },
            { name: "lst_upd_dt", tags: ["date", "audit"], synonyms: ["last updated", "modified"] },
          ],
        },
        {
          table: "dbo.Servers",
          columns: [
            { name: "owned_by_team", tags: ["ownership"], synonyms: ["team owner"] },
            { name: "hostname", tags: ["host"], synonyms: ["server name"] },
          ],
        },
      ],
    },
  };
}

test("catalogFromRows groups ordered INFORMATION_SCHEMA rows, any key casing", () => {
  const rows = [
    // mssql-style uppercase aliases on one row, pg-style lowercase on others
    { TABLE_SCHEMA: "dbo", TABLE_NAME: "A", TABLE_TYPE: "BASE TABLE", COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO" },
    { table_schema: "dbo", table_name: "A", table_type: "BASE TABLE", column_name: "name", data_type: "nvarchar", is_nullable: "YES" },
    { table_schema: "dbo", table_name: "V", table_type: "VIEW", column_name: "x", data_type: "int", is_nullable: "YES" },
  ];
  const cat = catalogFromRows("mssql", "db", rows, T0);
  assert.equal(cat.tables.length, 2);
  assert.equal(cat.tables[0].columns.length, 2);
  assert.equal(cat.tables[0].columns[0].nullable, false);
  assert.equal(cat.tables[1].kind, "view");
  assert.equal(qualifiedName(cat.tables[0]), "dbo.A");
  assert.equal(cat.truncated, undefined);
});

test("catalogFromRows enforces table and column caps with a truncation flag", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let t = 0; t < SCHEMA_MAX_TABLES + 5; t++) {
    rows.push({ table_schema: "s", table_name: `t${String(t).padStart(4, "0")}`, column_name: "c", data_type: "int" });
  }
  const cat = catalogFromRows("postgres", "db", rows, T0);
  assert.equal(cat.tables.length, SCHEMA_MAX_TABLES);
  assert.equal(cat.truncated, true);

  const wide: Array<Record<string, unknown>> = [];
  for (let c = 0; c < SCHEMA_MAX_COLUMNS_PER_TABLE + 3; c++) {
    wide.push({ table_schema: "s", table_name: "w", column_name: `c${c}`, data_type: "int" });
  }
  const wideCat = catalogFromRows("postgres", "db", wide, T0);
  assert.equal(wideCat.tables[0].columns.length, SCHEMA_MAX_COLUMNS_PER_TABLE);
  assert.equal(wideCat.truncated, true);
});

test("catalogFromMongoSamples infers field names/types, one nesting level, values discarded", () => {
  const cat = catalogFromMongoSamples(
    "ops",
    {
      apps: [
        { _id: "x1", name: "Billing", owner: { team: "Payments", cio: "J. Doe" }, tags: ["a"] },
        { _id: "x2", name: "Auth", cost: 12.5, createdAt: new Date("2026-01-01") },
      ],
    },
    T0,
  );
  const cols = new Map(cat.tables[0].columns.map((c) => [c.name, c.dataType]));
  assert.equal(cat.tables[0].kind, "collection");
  assert.equal(cols.get("name"), "string");
  assert.equal(cols.get("owner"), "object");
  assert.equal(cols.get("owner.cio"), "string"); // nested one level
  assert.equal(cols.get("tags"), "array");
  assert.equal(cols.get("cost"), "number");
  assert.equal(cols.get("createdAt"), "date");
  // No sampled VALUES anywhere in the catalog.
  const json = JSON.stringify(cat);
  for (const value of ["Billing", "Payments", "J. Doe", "12.5"]) {
    assert.ok(!json.includes(value), `sampled value leaked: ${value}`);
  }
});

test("buildIndexPrompt teaches the group_cio→ownership inference and carries names only", () => {
  const catalog = cmdbCatalog();
  const prompt = buildIndexPrompt(catalog, catalog.tables);
  assert.match(prompt, /group_cio/);
  assert.match(prompt, /ownership/);
  assert.match(prompt, /records owned by X/);
  assert.match(prompt, /dbo\.Applications \(table\)/);
  assert.match(prompt, /- appl_id: int/);
  assert.match(prompt, /Return ONLY a JSON object/);
});

test("chunkTables splits into bounded batches", () => {
  const tables: TableDef[] = Array.from({ length: 95 }, (_, i) => ({
    name: `t${i}`,
    kind: "table" as const,
    columns: [],
  }));
  const batches = chunkTables(tables, 40);
  assert.deepEqual(batches.map((b) => b.length), [40, 40, 15]);
});

test("parseSemanticResponse: fenced JSON, hallucination dropping, tag clamping", () => {
  const catalog = cmdbCatalog();
  const reply = [
    "Here is the index you asked for:",
    "```json",
    JSON.stringify({
      tables: [
        {
          table: "dbo.Applications",
          purpose: "Application inventory",
          columns: [
            { name: "group_cio", tags: ["OWNERSHIP", "Organization"], synonyms: ["owner", "CIO"] },
            { name: "made_up_column", tags: ["x"], synonyms: [] },
          ],
        },
        { table: "dbo.NotReal", columns: [{ name: "x", tags: ["y"], synonyms: [] }] },
      ],
    }),
    "```",
    "Hope that helps!",
  ].join("\n");
  const parsed = parseSemanticResponse(reply, catalog);
  assert.equal(parsed.length, 1); // hallucinated table dropped
  assert.equal(parsed[0].columns.length, 1); // hallucinated column dropped
  assert.deepEqual(parsed[0].columns[0].tags, ["ownership", "organization"]); // lowercased
  assert.throws(() => parseSemanticResponse("no json here", catalog), /no JSON/);
});

test("mergeSemantic: later batches replace earlier entries for the same table", () => {
  const a = [{ table: "dbo.T", columns: [{ name: "c", tags: ["old"], synonyms: [] }] }];
  const b = [{ table: "DBO.t", columns: [{ name: "c", tags: ["new"], synonyms: [] }] }];
  const merged = mergeSemantic([a, b]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].columns[0].tags, ["new"]);
});

test("'records owned by X' finds group_cio via the semantic index — the pilot scenario", () => {
  const ranked = searchSchema(indexedSchema(), "records owned by jdoe");
  assert.ok(ranked.length >= 2);
  const names = ranked.flatMap((r) => [...r.matchedColumns]);
  assert.ok(names.includes("group_cio"), `expected group_cio in ${names.join(",")}`);
  assert.ok(names.includes("owned_by_team"));
  // And the rendering carries the synonyms so the model can write the WHERE clause.
  const rendered = renderSchemaForModel(indexedSchema(), "owned by");
  assert.match(rendered, /group_cio/);
  assert.match(rendered, /ownership/);
});

test("without a semantic index, plain name matching still works (raw catalog fallback)", () => {
  const raw: SourceSchema = { catalog: cmdbCatalog(), semanticState: "none" };
  const ranked = searchSchema(raw, "hostname");
  assert.equal(qualifiedName(ranked[0].table), "dbo.Servers");
  assert.ok(ranked[0].matchedColumns.has("hostname"));
  // "owned" still hits owned_by_team by substring even unindexed.
  const owned = searchSchema(raw, "owned");
  assert.ok([...owned[0].matchedColumns].includes("owned_by_team"));
});

test("renderSchemaForModel reports the semantic state and respects the char cap", () => {
  const out = renderSchemaForModel(indexedSchema(), undefined, 400);
  assert.ok(out.length <= 400);
  assert.match(out, /semantic index: indexed/);
  const none = renderSchemaForModel(
    { catalog: cmdbCatalog(), semanticState: "none" },
    "zzz-no-match",
  );
  assert.match(none, /No tables matched/);
});
