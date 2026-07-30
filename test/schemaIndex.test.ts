import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  catalogFromRows,
  catalogFromMongoSamples,
  chunkTables,
  buildIndexPrompt,
  parseSemanticResponse,
  mergeSemantic,
  mergeContentIntoSemantic,
  profileColumns,
  describeProfile,
  PROFILE_DISTINCT_CAP,
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

// --- 0.11.0: content-type indexing + export sharing ---------------------------

test("buildSampleQuery quotes per engine; distinctValues dedupes/truncates locally", async () => {
  const { buildSampleQuery, distinctValues, CONTENT_DISTINCT_PER_COLUMN } = await import(
    "../src/context/db/schemaIndex"
  );
  const t = cmdbCatalog().tables[0];
  assert.equal(
    buildSampleQuery("mssql", t, 100),
    "SELECT TOP 100 [appl_id], [appl_name], [group_cio], [lst_upd_dt] FROM [dbo].[Applications]",
  );
  assert.match(buildSampleQuery("postgres", t, 50), /^SELECT "appl_id".*FROM "dbo"\."Applications" LIMIT 50$/);
  assert.match(buildSampleQuery("mysql", t, 50), /FROM `dbo`\.`Applications` LIMIT 50$/);
  const d = distinctValues([
    { c: "Active", n: 1 },
    { c: "Active", n: 2 },
    { c: "Retired", n: null },
    { c: "x".repeat(200) },
  ]);
  assert.deepEqual(d.c.slice(0, 2), ["Active", "Retired"]);
  assert.ok(d.c[2].length <= 60);
  assert.ok(d.c.length <= CONTENT_DISTINCT_PER_COLUMN);
  assert.deepEqual(d.n, ["1", "2"]);
});

test("content prompt carries sampled values; parse keeps contentSummary; merge unions without losing tags", async () => {
  const { buildContentPrompt, mergeContentIntoSemantic } = await import(
    "../src/context/db/schemaIndex"
  );
  const catalog = cmdbCatalog();
  const prompt = buildContentPrompt(catalog, [
    { table: "dbo.Applications", values: { group_cio: ["J. Doe", "A. Smith"] } },
  ]);
  assert.match(prompt, /J\. Doe \| A\. Smith/);
  assert.match(prompt, /contentSummary/);
  const parsed = parseSemanticResponse(
    JSON.stringify({
      tables: [
        {
          table: "dbo.Applications",
          columns: [{ name: "group_cio", contentSummary: "owner names (CIO)", tags: ["person"], synonyms: [] }],
        },
      ],
    }),
    catalog,
  );
  assert.equal(parsed[0].columns[0].contentSummary, "owner names (CIO)");
  const merged = mergeContentIntoSemantic(indexedSchema().semantic!.tables, parsed);
  const col = merged
    .find((t) => t.table === "dbo.Applications")!
    .columns.find((c) => c.name === "group_cio")!;
  assert.ok(col.tags.includes("ownership") && col.tags.includes("person")); // union, nothing lost
  assert.equal(col.contentSummary, "owner names (CIO)");
});

test("content summaries are searchable and rendered for the model", async () => {
  const schema = indexedSchema();
  schema.semantic!.tables[0].columns[0].contentSummary = "owner names like J. Doe";
  const ranked = searchSchema(schema, "names");
  assert.ok([...ranked[0].matchedColumns].includes("group_cio"));
  assert.match(renderSchemaForModel(schema, "owned"), /values: owner names/);
});

test("profileColumns measures what the model must not be asked to guess", () => {
  const rows = [
    { status: "Active", notes: null, code: "US" },
    { status: "Retired", notes: "needs review", code: "DE" },
    { status: "Active", notes: null, code: "US" },
    { status: null, notes: null, code: "FR" },
  ];
  const p = profileColumns(rows);
  assert.equal(p.status.sampled, 4);
  assert.equal(p.status.nulls, 1);
  assert.equal(p.status.distinct, 2, "Active/Retired — a code list, not free text");
  assert.equal(p.notes.nulls, 3, "sparsely populated, as measured");
  assert.equal(p.code.minLength, 2);
  assert.equal(p.code.maxLength, 2);
  assert.equal(p.code.min, "DE");
  assert.equal(p.code.max, "US");
});

test("profileColumns counts a column that never appears in any row as all-null", () => {
  // The driver omits keys for columns that are NULL in every sampled row, so
  // seeding from the column list is what makes "essentially unpopulated"
  // reportable at all — without it the column is simply invisible.
  const p = profileColumns([{ a: 1 }, { a: 2 }], ["a", "b"]);
  assert.equal(p.b.sampled, 2);
  assert.equal(p.b.nulls, 2);
  assert.equal(p.b.distinct, 0);
  assert.equal(p.a.nulls, 0);
});

test("profileColumns caps the distinct set so a unique column can't grow it", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}` }));
  const p = profileColumns(rows);
  assert.equal(p.id.distinct, PROFILE_DISTINCT_CAP);
  assert.match(describeProfile(p.id), /50\+ distinct/, "reads as 'at least', which is the honest claim");
});

test("describeProfile states sparseness as measured fact", () => {
  assert.match(describeProfile({ sampled: 100, nulls: 98, distinct: 2 }), /98% NULL \(essentially unpopulated\)/);
  assert.match(describeProfile({ sampled: 100, nulls: 60, distinct: 5 }), /60% NULL \(sparsely populated\)/);
  assert.match(describeProfile({ sampled: 100, nulls: 3, distinct: 5 }), /^3% NULL/);
  assert.match(describeProfile({ sampled: 100, nulls: 0, distinct: 5 }), /never NULL/);
  // Fixed-width values read as one length, not a degenerate range.
  assert.match(
    describeProfile({ sampled: 10, nulls: 0, distinct: 3, minLength: 2, maxLength: 2 }),
    /length 2(?!-)/,
  );
  assert.match(
    describeProfile({ sampled: 10, nulls: 0, distinct: 3, minLength: 2, maxLength: 40 }),
    /length 2-40/,
  );
  // An empty sample says nothing rather than dividing by zero.
  assert.equal(describeProfile({ sampled: 0, nulls: 0, distinct: 0 }), "");
});

test("the content parser accepts BOTH levels of description plus a table synopsis", () => {
  const catalog = cmdbCatalog();
  const parsed = parseSemanticResponse(
    JSON.stringify({
      tables: [
        {
          table: "dbo.Applications",
          synopsis: "One row per deployed application, with its owning CIO org and last-touch audit date.",
          columns: [
            {
              name: "lst_upd_dt",
              tags: ["date"],
              synonyms: ["last updated"],
              // LEVEL 1: the declared type lies — it is stored as text.
              effectiveType: "ISO 8601 date (stored as text)",
              // LEVEL 2: what an analyst would say the values ARE.
              contentSummary: "Last-modified timestamps, mostly within the past two years",
            },
          ],
        },
      ],
    }),
    catalog,
  );
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].synopsis ?? "", /One row per deployed application/);
  assert.equal(parsed[0].columns[0].effectiveType, "ISO 8601 date (stored as text)");
  assert.match(parsed[0].columns[0].contentSummary ?? "", /Last-modified timestamps/);
});

test("a column carrying ONLY an effectiveType still survives the parser", () => {
  // The prompt tells the model to omit tags/synonyms it has nothing to add to,
  // so "effectiveType alone" is a legitimate answer — dropping it would lose
  // the single most useful correction the content pass makes.
  const parsed = parseSemanticResponse(
    JSON.stringify({
      tables: [{ table: "dbo.Servers", columns: [{ name: "hostname", effectiveType: "FQDN" }] }],
    }),
    cmdbCatalog(),
  );
  assert.deepEqual(parsed[0].columns.map((c) => c.effectiveType), ["FQDN"]);
  // A column with nothing at all is still dropped.
  const empty = parseSemanticResponse(
    JSON.stringify({ tables: [{ table: "dbo.Servers", columns: [{ name: "hostname" }] }] }),
    cmdbCatalog(),
  );
  assert.deepEqual(empty[0].columns, []);
});

test("mergeContentIntoSemantic is PURE and preserves the schema pass's work", () => {
  const existing = indexedSchema().semantic!.tables;
  const before = JSON.parse(JSON.stringify(existing));
  const merged = mergeContentIntoSemantic(existing, [
    {
      table: "dbo.Applications",
      synopsis: "One row per application.",
      contentIndexedAt: T0,
      fingerprint: "abc12345",
      columns: [
        {
          name: "group_cio",
          tags: ["org"],
          synonyms: ["CIO"],
          contentSummary: "CIO organization names",
          effectiveType: "org name",
          profile: { sampled: 50, nulls: 0, distinct: 7 },
        },
      ],
    },
  ]);
  // The input must be untouched: the caller checkpoints the ORIGINAL between
  // batches, and a mutated input would silently rewrite already-saved state.
  assert.deepEqual(existing, before, "no mutation of the caller's array");

  const apps = merged.find((t) => t.table === "dbo.Applications")!;
  // The schema pass's purpose and the other columns survive the content merge —
  // the regression that destroyed the whole index once already.
  assert.equal(apps.purpose, "Application inventory");
  assert.equal(apps.columns.length, 3);
  assert.equal(apps.synopsis, "One row per application.");
  assert.equal(apps.contentIndexedAt, T0);
  assert.equal(apps.fingerprint, "abc12345");
  const cio = apps.columns.find((c) => c.name === "group_cio")!;
  // Tags union rather than replace: both passes contribute vocabulary.
  assert.ok(cio.tags.includes("ownership") && cio.tags.includes("org"));
  assert.equal(cio.contentSummary, "CIO organization names");
  assert.equal(cio.effectiveType, "org name");
  assert.equal(cio.profile?.distinct, 7);
  assert.equal(cio.note, "CIO/exec owner of the record", "schema-pass note not clobbered");
  // A table the content pass saw but the schema pass didn't is added, not lost.
  const only = mergeContentIntoSemantic([], [{ table: "dbo.New", columns: [] }]);
  assert.deepEqual(only.map((t) => t.table), ["dbo.New"]);
});

test("renderSchemaForModel surfaces the effective type, synopsis and profile", () => {
  const schema = indexedSchema();
  const tables = mergeContentIntoSemantic(schema.semantic!.tables, [
    {
      table: "dbo.Applications",
      synopsis: "One row per deployed application.",
      columns: [
        {
          name: "lst_upd_dt",
          tags: [],
          synonyms: [],
          effectiveType: "ISO date stored as text",
          contentSummary: "audit timestamps",
          profile: { sampled: 100, nulls: 91, distinct: 9 },
        },
      ],
    },
  ]);
  const rendered = renderSchemaForModel(
    { ...schema, semantic: { ...schema.semantic!, tables } },
    undefined,
  );
  assert.match(rendered, /really ISO date stored as text/, "so the model doesn't write a date comparison against a string");
  assert.match(rendered, /values: audit timestamps/);
  assert.match(rendered, /One row per deployed application/);
  assert.match(rendered, /91% NULL/, "sparseness travels to the model as measured fact");
});

test("the content prompt gives the model the declared type and the measured profile", async () => {
  const { buildContentPrompt } = await import("../src/context/db/schemaIndex");
  const prompt = buildContentPrompt(cmdbCatalog(), [
    {
      table: "dbo.Applications",
      values: { lst_upd_dt: ["2026-01-04", "2025-11-30"] },
      profile: { lst_upd_dt: { sampled: 100, nulls: 62, distinct: 38, minLength: 10, maxLength: 10 } },
    },
  ]);
  // Without the DECLARED type the model cannot notice that a text column is
  // really holding dates — that is the whole point of level 1.
  assert.match(prompt, /datetime/);
  // Without the MEASURED profile "sparsely populated" would be the model
  // guessing from 10 sampled values rather than reporting a counted fact.
  assert.match(prompt, /62% NULL \(sparsely populated\)/);
  assert.match(prompt, /38 distinct/);
  // And both outputs are asked for by name.
  assert.match(prompt, /effectiveType/);
  assert.match(prompt, /synopsis/);
});

test("truncation says WHICH cap was hit and what it cost", async () => {
  const { catalogFromRows, describeTruncation, resolveCatalogLimits } = await import(
    "../src/context/db/schemaIndex"
  );
  const limits = resolveCatalogLimits({ maxTables: 2, maxColumnsPerTable: 2 });
  const rows: Array<Record<string, unknown>> = [];
  for (const t of ["A", "B", "C"]) {
    for (let c = 0; c < 4; c++) {
      rows.push({ table_schema: "dbo", table_name: t, column_name: `c${c}`, data_type: "int" });
    }
  }
  const cat = catalogFromRows("mssql", "DB", rows, T0, limits);
  assert.equal(cat.tables.length, 2, "table cap");
  assert.equal(cat.tables[0].columns.length, 2, "column cap");
  assert.equal(cat.truncated, true, "the legacy flag still travels for stored catalogs");
  assert.equal(cat.truncation?.tableCap, 2);
  assert.equal(cat.truncation?.columnCap, 2);
  assert.deepEqual(cat.truncation?.columnCapped, ["dbo.A", "dbo.B"], "named once each, not once per dropped column");

  const text = describeTruncation(cat.truncation);
  // The two caps have different consequences and must not read the same: one
  // means tables are MISSING, the other that a listed table is incomplete.
  assert.match(text, /MISSING/);
  assert.match(text, /not fully described/);
  assert.match(text, /dbo\.A/);
  assert.equal(describeTruncation(undefined), "", "an untruncated catalog says nothing");
});

test("an untruncated catalog carries no truncation record", async () => {
  const { catalogFromRows } = await import("../src/context/db/schemaIndex");
  const cat = catalogFromRows(
    "mssql",
    "DB",
    [{ table_schema: "dbo", table_name: "A", column_name: "id", data_type: "int" }],
    T0,
  );
  assert.equal(cat.truncated, undefined);
  assert.equal(cat.truncation, undefined);
});

test("catalog limits are configurable but never unbounded", async () => {
  const {
    resolveCatalogLimits,
    SCHEMA_MAX_TABLES,
    SCHEMA_MAX_COLUMNS_PER_TABLE,
    CATALOG_TABLE_CEILING,
    CATALOG_COLUMN_CEILING,
  } = await import("../src/context/db/schemaIndex");
  // Unset falls back to the defaults.
  assert.deepEqual(resolveCatalogLimits(), {
    maxTables: SCHEMA_MAX_TABLES,
    maxColumnsPerTable: SCHEMA_MAX_COLUMNS_PER_TABLE,
    maxCollections: 250,
  });
  assert.equal(resolveCatalogLimits({ maxTables: 4000 }).maxTables, 4000);
  // A number typed into a settings box can be nonsense; none of it may produce
  // a catalog read that returns nothing or never ends.
  assert.equal(resolveCatalogLimits({ maxTables: 0 }).maxTables, SCHEMA_MAX_TABLES);
  assert.equal(resolveCatalogLimits({ maxTables: -5 }).maxTables, SCHEMA_MAX_TABLES);
  assert.equal(resolveCatalogLimits({ maxColumnsPerTable: NaN }).maxColumnsPerTable, SCHEMA_MAX_COLUMNS_PER_TABLE);
  assert.equal(resolveCatalogLimits({ maxTables: 1e9 }).maxTables, CATALOG_TABLE_CEILING);
  assert.equal(resolveCatalogLimits({ maxColumnsPerTable: 1e9 }).maxColumnsPerTable, CATALOG_COLUMN_CEILING);
  assert.equal(resolveCatalogLimits({ maxTables: 12.7 }).maxTables, 12, "no fractional caps");
});

test("the model is told how big a table is and how fresh", async () => {
  const { renderSchemaForModel } = await import("../src/context/db/schemaIndex");
  const schema = indexedSchema();
  const rendered = renderSchemaForModel(
    {
      ...schema,
      stats: {
        measuredAt: T0,
        tables: {
          "dbo.applications": {
            rows: 2_400_000,
            lastUpdated: "2026-07-01T00:00:00Z",
            lastUpdatedBasis: "MAX(lst_upd_dt)",
          },
        },
      },
    },
    undefined,
  );
  // A billion-row table needs a bounded WHERE, not an exploratory scan, and a
  // table whose newest row is old shouldn't be used to answer "current".
  assert.match(rendered, /~2,400,000 rows/);
  assert.match(rendered, /newest MAX\(lst_upd_dt\): 2026-07-01/);
});
