import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  proposeJoinCandidates,
  buildJoinProbeSql,
  buildJoinProbeMongo,
  parseProbeCounts,
  classifyJoin,
  renderErMermaid,
  renderErForModel,
  fkStem,
  joinFamily,
  ER_SAMPLE_SIZE,
  ER_MAX_CANDIDATES,
} from "../src/context/db/erDiagram";
import { SourceSchema, ErModel } from "../src/context/db/schemaIndex";

const T0 = "2026-06-12T12:00:00.000Z";

function schemaWith(over: Partial<SourceSchema> = {}): SourceSchema {
  return {
    catalog: {
      fetchedAt: T0,
      engine: "mssql",
      database: "cmdb",
      tables: [
        {
          schema: "dbo",
          name: "Customers",
          kind: "table",
          columns: [
            { name: "id", dataType: "int" },
            { name: "name", dataType: "nvarchar" },
            { name: "region_code", dataType: "nvarchar" },
          ],
        },
        {
          schema: "dbo",
          name: "Orders",
          kind: "table",
          columns: [
            { name: "id", dataType: "int" },
            { name: "customer_id", dataType: "int" },
            { name: "region_code", dataType: "nvarchar" },
            { name: "placed_on", dataType: "datetime" },
          ],
        },
        {
          schema: "dbo",
          name: "Invoices",
          kind: "table",
          columns: [
            { name: "id", dataType: "int" },
            { name: "customer_id", dataType: "nvarchar" }, // type-incompatible with Customers.id
          ],
        },
      ],
    },
    semanticState: "none",
    ...over,
  };
}

test("fkStem and joinFamily ground the candidate heuristics", () => {
  assert.equal(fkStem("customer_id"), "customer");
  assert.equal(fkStem("applid"), "appl");
  assert.equal(fkStem("region_code"), "region");
  assert.equal(fkStem("name"), undefined);
  assert.equal(joinFamily("bigint"), "num");
  assert.equal(joinFamily("uniqueidentifier"), "text");
  assert.equal(joinFamily("datetime"), undefined, "dates never define relationships");
});

test("candidates: FK-shaped names rank first; type families must match; generic names are skipped", () => {
  const candidates = proposeJoinCandidates(schemaWith());
  // Orders.customer_id → Customers.id (int↔int) is the top candidate.
  assert.equal(candidates[0].fromTable, "dbo.Orders");
  assert.equal(candidates[0].fromColumn, "customer_id");
  assert.equal(candidates[0].toTable, "dbo.Customers");
  assert.equal(candidates[0].toColumn, "id");
  assert.match(candidates[0].reason, /name pattern/);
  // Invoices.customer_id (nvarchar) must NOT pair with Customers.id (int).
  assert.ok(
    !candidates.some((c) => c.fromTable === "dbo.Invoices" && c.toColumn === "id"),
    "type-family mismatch must be excluded",
  );
  // region_code appears in two tables with matching types → same-name pair.
  assert.ok(
    candidates.some(
      (c) =>
        c.reason === "same column name: region_code" &&
        [c.fromTable, c.toTable].sort().join() === ["dbo.Customers", "dbo.Orders"].sort().join(),
    ),
  );
  // Bare "id" = generic: never proposed as a same-name pair.
  assert.ok(!candidates.some((c) => c.reason === "same column name: id"));
  assert.ok(candidates.length <= ER_MAX_CANDIDATES);
});

test("candidates: semantic identifier tags propose pairs the names alone would miss", () => {
  const schema = schemaWith({
    semantic: {
      indexedAt: T0,
      modelId: "m",
      tables: [
        {
          table: "dbo.Customers",
          columns: [{ name: "id", tags: ["identifier", "customer"], synonyms: [] }],
        },
        {
          table: "dbo.Invoices",
          columns: [{ name: "id", tags: ["identifier", "customer"], synonyms: [] }],
        },
      ],
    },
    semanticState: "indexed",
  });
  const candidates = proposeJoinCandidates(schema);
  assert.ok(
    candidates.some((c) => c.reason === "shared tags: identifier+customer"),
    JSON.stringify(candidates),
  );
});

test("probe SQL: per-dialect sampling, COUNTS only, null-filtered DISTINCT", () => {
  const from = { schema: "dbo", table: "Orders", column: "customer_id" };
  const to = { schema: "dbo", table: "Customers", column: "id" };
  const mssql = buildJoinProbeSql("mssql", from, to);
  assert.match(mssql, /SELECT DISTINCT TOP 100 \[customer_id\] AS v FROM \[dbo\]\.\[Orders\] WHERE \[customer_id\] IS NOT NULL/);
  assert.match(mssql, /COUNT\(\*\) AS sampled/);
  assert.match(mssql, /EXISTS \(SELECT 1 FROM \[dbo\]\.\[Customers\] t WHERE t\.\[id\] = s\.v\)/);
  const pg = buildJoinProbeSql("postgres", { table: "orders", column: "customer_id" }, { table: "customers", column: "id" });
  assert.match(pg, /SELECT DISTINCT "customer_id" AS v FROM "orders" WHERE "customer_id" IS NOT NULL LIMIT 100/);
  const my = buildJoinProbeSql("mysql", { table: "orders", column: "customer_id" }, { table: "customers", column: "id" });
  assert.match(my, /`orders`/);
  const mongo = buildJoinProbeMongo({ table: "orders", column: "customer_id" }, { table: "customers", column: "_id" }, 50);
  assert.equal(mongo.collection, "orders");
  assert.deepEqual(mongo.pipeline[2], { $limit: 50 });
});

test("parseProbeCounts tolerates engine casing, strings, and NULL SUM over zero rows", () => {
  assert.deepEqual(parseProbeCounts([{ sampled: 100, matched: 98 }]), { sampled: 100, matched: 98 });
  assert.deepEqual(parseProbeCounts([{ SAMPLED: "100", MATCHED: "98" }]), { sampled: 100, matched: 98 });
  assert.deepEqual(parseProbeCounts([{ sampled: 0, matched: null }]), { sampled: 0, matched: 0 });
  assert.deepEqual(parseProbeCounts([]), { sampled: 0, matched: 0 });
});

test("classifyJoin: 100% = strong; high = likely; low both ways = discarded; subsets read as outer-join advice", () => {
  const strong = classifyJoin({ sampled: 100, matched: 100 }, { sampled: 100, matched: 100 });
  assert.equal(strong.verdict, "strong");
  assert.match(strong.note ?? "", /bidirectional/);

  // The user's exact scenario: 100 rows each side, full join rate one way,
  // partial the other — an intentional subset, inner-vs-outer captured.
  const subset = classifyJoin({ sampled: 100, matched: 100 }, { sampled: 100, matched: 30 });
  assert.equal(subset.verdict, "strong");
  assert.match(subset.note ?? "", /subset/);
  assert.match(subset.note ?? "", /LEFT JOIN/);

  const likely = classifyJoin({ sampled: 100, matched: 80 }, { sampled: 100, matched: 10 });
  assert.equal(likely.verdict, "likely");

  const noise = classifyJoin({ sampled: 100, matched: 20 }, { sampled: 100, matched: 12 });
  assert.equal(noise.verdict, undefined);

  const empty = classifyJoin({ sampled: 0, matched: 0 }, { sampled: 0, matched: 0 });
  assert.equal(empty.verdict, undefined, "empty tables prove nothing");
});

test("mermaid + tool rendering carry rates, cardinality, and join guidance", () => {
  const model: ErModel = {
    builtAt: T0,
    sampleSize: ER_SAMPLE_SIZE,
    candidatesTested: 5,
    relationships: [
      {
        fromTable: "dbo.Orders",
        fromColumn: "customer_id",
        toTable: "dbo.Customers",
        toColumn: "id",
        forwardRate: 0.98,
        backwardRate: 0.45,
        sampledForward: 100,
        sampledBackward: 100,
        verdict: "strong",
        note: "from-side is a subset: every sampled value resolves in the target; LEFT JOIN from the target side to keep its unmatched rows",
        reason: "name pattern: customer_id → dbo.Customers.id",
      },
    ],
  };
  const mermaid = renderErMermaid(model);
  assert.match(mermaid, /^erDiagram/);
  assert.match(mermaid, /"dbo\.Orders" \}o--\|\| "dbo\.Customers" : "customer_id -> id \(98%\/45%\)"/);

  const toolLines = renderErForModel(model).join("\n");
  assert.match(toolLines, /JOIN dbo\.Orders\.customer_id = dbo\.Customers\.id \(98%\/45%, strong/);
  assert.match(toolLines, /INNER vs LEFT JOIN/);

  const emptyModel: ErModel = { builtAt: T0, sampleSize: 100, candidatesTested: 0, relationships: [] };
  assert.match(renderErMermaid(emptyModel), /no relationships/);
  assert.deepEqual(renderErForModel(emptyModel), []);
});

// --- adaptive strategy (ADR-0030 amendment) ----------------------------------

test("candidateBudget scales with the catalog and never drops below the old fixed cap", async () => {
  const { candidateBudget } = await import("../src/context/db/erDiagram");
  const tables = (n: number, cols: number) => ({
    tables: Array.from({ length: n }, (_, i) => ({
      name: `t${i}`,
      kind: "table" as const,
      columns: Array.from({ length: cols }, (_, j) => ({ name: `c${j}`, dataType: "int" })),
    })),
  });
  assert.equal(candidateBudget(tables(3, 4)), 40, "small DB keeps the floor");
  assert.equal(candidateBudget(tables(50, 20)), 200, "mid-size scales up (50×3 + 1000/20)");
  assert.equal(candidateBudget(tables(300, 80)), 300, "bounded on warehouses");
});

test("initialSampleSize: complete joins for small pairs, shrinking samples as the target grows", async () => {
  const { initialSampleSize, ER_FULL_JOIN_MAX_ROWS } = await import("../src/context/db/erDiagram");
  assert.equal(initialSampleSize(10_000, 40_000), "full", "both small → full join test");
  assert.equal(initialSampleSize(10_000, ER_FULL_JOIN_MAX_ROWS + 1), 500, "target just over → sampled");
  assert.equal(initialSampleSize(200_000, 5_000_000), 250);
  assert.equal(initialSampleSize(200_000, 50_000_000), 100, "huge target → smallest sample");
  assert.equal(initialSampleSize(0, 0), 100, "unknown sizes → conservative classic");
});

test("nextSampleSize escalates ×5 while fast, reaches full on small tables, and stops when slow or capped", async () => {
  const { nextSampleSize, ER_MAX_SAMPLE, ER_FAST_PROBE_MS } = await import("../src/context/db/erDiagram");
  assert.equal(nextSampleSize(100, 200, 10_000_000), 500, "fast → ×5");
  assert.equal(nextSampleSize(2_000, 100, 80_000), 10_000, "fast keeps escalating toward the cap");
  assert.equal(nextSampleSize(ER_MAX_SAMPLE, 100, 10_000_000), undefined, "cap reached");
  assert.equal(nextSampleSize(100, ER_FAST_PROBE_MS, 1_000_000), undefined, "not fast → stop");
  assert.equal(nextSampleSize(500, 100, 2_000), "full", "small from-side upgrades to a complete pass");
  assert.equal(nextSampleSize(5_000, 100, 2_000), undefined, "already covered the from-side");
});

test("'full' probes drop TOP/LIMIT ($limit) — the complete join test", async () => {
  const { buildJoinProbeSql, buildJoinProbeMongo } = await import("../src/context/db/erDiagram");
  const from = { schema: "dbo", table: "Orders", column: "customer_id" };
  const to = { schema: "dbo", table: "Customers", column: "id" };
  const mssql = buildJoinProbeSql("mssql", from, to, "full");
  assert.ok(!/TOP /.test(mssql), mssql);
  const pg = buildJoinProbeSql("postgres", { table: "a", column: "x" }, { table: "b", column: "y" }, "full");
  assert.ok(!/LIMIT/.test(pg), pg);
  const mongo = buildJoinProbeMongo({ table: "a", column: "x" }, { table: "b", column: "y" }, "full");
  assert.ok(!mongo.pipeline.some((s) => "$limit" in (s as Record<string, unknown>)), JSON.stringify(mongo.pipeline));
});

test("row estimates: one statistics query per engine; parser tolerates casing and missing schema", async () => {
  const { buildRowEstimateSql, parseRowEstimates } = await import("../src/context/db/erDiagram");
  assert.match(buildRowEstimateSql("mssql"), /sys\.partitions/);
  assert.match(buildRowEstimateSql("postgres"), /reltuples/);
  assert.match(buildRowEstimateSql("mysql"), /information_schema\.tables/);
  // Statistics, never COUNT(*): sizing a warehouse must be cheap.
  for (const engine of ["mssql", "postgres", "mysql"] as const) {
    assert.ok(!/COUNT\(\*\)/i.test(buildRowEstimateSql(engine)));
  }
  const est = parseRowEstimates([
    { TABLE_SCHEMA: "dbo", TABLE_NAME: "Orders", ROW_ESTIMATE: "1200000" },
    { table_schema: null, table_name: "events", row_estimate: 42 },
  ]);
  assert.equal(est["dbo.orders"], 1_200_000);
  assert.equal(est["events"], 42);
});

test("thorough mode: exhaustive pairs only across small tables, deduped against heuristics, capped", async () => {
  const { proposeExhaustivePairs, proposeJoinCandidates, pairKey } = await import(
    "../src/context/db/erDiagram"
  );
  const schema = schemaWith();
  const heuristic = proposeJoinCandidates(schema);
  const tried = new Set(heuristic.map((c) => pairKey(c)));
  const est = {
    "dbo.customers": 1_000,
    "dbo.orders": 2_000,
    "dbo.invoices": 9_000_000, // too big — excluded from exhaustive testing
  };
  const pairs = proposeExhaustivePairs(schema, est, tried);
  assert.ok(pairs.length > 0);
  assert.ok(pairs.every((p) => p.reason === "exhaustive (small tables)"));
  assert.ok(
    !pairs.some((p) => p.fromTable === "dbo.Invoices" || p.toTable === "dbo.Invoices"),
    "large tables stay out of the exhaustive pass",
  );
  // The heuristic customer_id↔id pair is not re-proposed.
  assert.ok(
    !pairs.some((p) => pairKey(p) === pairKey({ fromTable: "dbo.Orders", fromColumn: "customer_id", toTable: "dbo.Customers", toColumn: "id" })),
  );
  // Type families still gate: int columns never pair with nvarchar ones.
  const cols = (t: string) => schema.catalog.tables.find((x) => `dbo.${x.name}` === t)!.columns;
  for (const p of pairs) {
    const a = cols(p.fromTable).find((c) => c.name === p.fromColumn)!.dataType;
    const b = cols(p.toTable).find((c) => c.name === p.toColumn)!.dataType;
    assert.equal(/int/.test(a), /int/.test(b), `${p.fromColumn}↔${p.toColumn}`);
  }
});

test("probe status is compact with the vitals leftmost: X/Y, ETA, found count, short detail", async () => {
  const { renderProbeStatus, formatEta } = await import("../src/context/db/erDiagram");
  // Early in the run: no pace yet → "estimating", never a silly ETA.
  assert.equal(
    renderProbeStatus({ done: 1, total: 220, found: 0, elapsedMs: 2_000 }),
    "2/220 · estimating… · 0 found",
  );
  // 20 pairs in 60s → 3s/pair → 180s remaining over 60 pairs → ~3 min.
  // The toast truncates from the RIGHT, so counts and ETA must lead.
  const mid = renderProbeStatus({
    done: 20,
    total: 80,
    found: 12,
    elapsedMs: 60_000,
    current: "dbo.Orders.customer_id ↔ dbo.Customers.id (500-value sample)",
  });
  assert.match(mid, /^21\/80 · ~3 min left · 12 found · dbo\.Orders/);
  // The trailing detail is capped hard so the vitals always survive.
  const long = renderProbeStatus({ done: 5, total: 10, found: 1, elapsedMs: 30_000, current: "x".repeat(200) });
  assert.ok(long.length < 90, long);
  assert.match(long, /…$/);
  // ETA formatting: seconds round to 5s steps; minutes stay coarse.
  assert.equal(formatEta(12_000), "~10s");
  assert.equal(formatEta(49_000), "~50s");
  assert.equal(formatEta(60_000), "~1 min");
  assert.equal(formatEta(170_000), "~3 min");
});

// --- AI-assisted candidates + probe report (0.25.0) ---------------------------

test("AI join proposals validate against the catalog: hallucinations and type mismatches drop", async () => {
  const { buildJoinCandidatePrompt, parseJoinCandidateResponse } = await import(
    "../src/context/db/erDiagram"
  );
  const schema = schemaWith();
  const prompt = buildJoinCandidatePrompt(schema);
  assert.match(prompt, /no foreign keys/i);
  assert.match(prompt, /dbo\.Customers/);
  assert.match(prompt, /ONLY JSON/);
  const response = JSON.stringify({
    pairs: [
      { fromTable: "dbo.Orders", fromColumn: "customer_id", toTable: "dbo.Customers", toColumn: "id", why: "FK by content" },
      { fromTable: "dbo.Ghost", fromColumn: "x", toTable: "dbo.Customers", toColumn: "id", why: "hallucinated table" },
      { fromTable: "dbo.Orders", fromColumn: "nope", toTable: "dbo.Customers", toColumn: "id", why: "hallucinated column" },
      { fromTable: "dbo.Invoices", fromColumn: "customer_id", toTable: "dbo.Customers", toColumn: "id", why: "nvarchar↔int" },
      { fromTable: "dbo.Orders", fromColumn: "customer_id", toTable: "dbo.Customers", toColumn: "id", why: "duplicate" },
    ],
  });
  const pairs = parseJoinCandidateResponse(`Here you go:\n${response}`, schema);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].priority, 5, "AI proposals probe first");
  assert.match(pairs[0].reason, /^AI: FK by content/);
  assert.deepEqual(parseJoinCandidateResponse("no json here", schema), []);
});

test("the refinement prompt shows the model what was measured", async () => {
  const { buildJoinCandidatePrompt } = await import("../src/context/db/erDiagram");
  const prompt = buildJoinCandidatePrompt(schemaWith(), [
    {
      fromTable: "dbo.Orders", fromColumn: "region_code", toTable: "dbo.Customers", toColumn: "region_code",
      forwardRate: 0.64, backwardRate: 0.1, sampledForward: 100, sampledBackward: 100,
      outcome: "rejected", reason: "same column name: region_code",
    },
  ]);
  assert.match(prompt, /ALREADY probed/);
  assert.match(prompt, /region_code: 64%\/10%/);
  assert.match(prompt, /DIFFERENT hypotheses/);
});

test("98–99% joins classify as designed joins with a data-quality note", async () => {
  const dq = classifyJoin({ sampled: 1000, matched: 985 }, { sampled: 1000, matched: 400 });
  assert.equal(dq.verdict, "strong");
  assert.match(dq.note ?? "", /data-quality/);
  assert.match(dq.note ?? "", /orphaned keys/);
  // A clean 100% gets no data-quality caveat.
  const clean = classifyJoin({ sampled: 100, matched: 100 }, { sampled: 100, matched: 100 });
  assert.ok(!/data-quality/.test(clean.note ?? ""));
});

test("the probe report surfaces near-misses and flags systemic zero-sample runs", async () => {
  const { renderProbeReport } = await import("../src/context/db/erDiagram");
  const tested = (over: Partial<import("../src/context/db/schemaIndex").TestedPair>) => ({
    fromTable: "dbo.A", fromColumn: "x", toTable: "dbo.B", toColumn: "y",
    forwardRate: 0, backwardRate: 0, sampledForward: 0, sampledBackward: 0,
    outcome: "rejected" as const, reason: "same column name: x",
    ...over,
  });
  const model: ErModel = {
    builtAt: T0, sampleSize: 100, candidatesTested: 10, relationships: [], mode: "ai",
    report: {
      tested: [
        tested({ forwardRate: 0.64, backwardRate: 0.1, sampledForward: 100, sampledBackward: 100 }),
        tested({ outcome: "failed" }),
      ],
      zeroSampleCount: 8,
      aiProposed: 12,
      aiRefined: 5,
    },
  };
  const text = renderProbeReport(model).join("\n");
  assert.match(text, /Probe report/);
  assert.match(text, /1 below thresholds, 1 failed/);
  assert.match(text, /12 pair\(s\) proposed by Copilot \+ 5 in the refinement round/);
  assert.match(text, /8 probe\(s\) sampled zero values/);
  assert.match(text, /64% \| 10%/);
  assert.deepEqual(renderProbeReport({ builtAt: T0, sampleSize: 100, candidatesTested: 0, relationships: [] }), []);
});

// --- user-defined joins from chat (test_join) ----------------------------------

test("parseJoinSpec resolves SQL join syntax with aliases against the catalog", async () => {
  const { parseJoinSpec } = await import("../src/context/db/erDiagram");
  const schema = schemaWith();
  const parsed = parseJoinSpec(
    "SELECT * FROM dbo.Orders o INNER JOIN dbo.Customers AS c ON o.customer_id = c.id WHERE o.id > 5",
    schema,
  );
  assert.deepEqual(parsed, {
    fromTable: "dbo.Orders",
    fromColumn: "customer_id",
    toTable: "dbo.Customers",
    toColumn: "id",
  });
  // Bare equality, bracketed identifiers, unqualified-but-unique tables.
  assert.deepEqual(parseJoinSpec("[Orders].[customer_id] = Customers.id", schema), {
    fromTable: "dbo.Orders",
    fromColumn: "customer_id",
    toTable: "dbo.Customers",
    toColumn: "id",
  });
});

test("parseJoinSpec returns actionable issues and flags cross-family joins", async () => {
  const { parseJoinSpec } = await import("../src/context/db/erDiagram");
  const schema = schemaWith();
  assert.match((parseJoinSpec("just words", schema) as { issue: string }).issue, /Provide the join/);
  assert.match(
    (parseJoinSpec("dbo.Ghost.x = dbo.Customers.id", schema) as { issue: string }).issue,
    /not in the catalog/,
  );
  assert.match(
    (parseJoinSpec("dbo.Orders.nope = dbo.Customers.id", schema) as { issue: string }).issue,
    /Column "nope" is not in dbo\.Orders \(has: id, customer_id/,
  );
  assert.match(
    (parseJoinSpec("dbo.Orders.id = dbo.Orders.customer_id", schema) as { issue: string }).issue,
    /same table/,
  );
  // nvarchar ↔ int: allowed for user-defined joins, but flagged.
  const cross = parseJoinSpec("dbo.Invoices.customer_id = dbo.Customers.id", schema);
  assert.ok(!("issue" in cross));
  assert.match((cross as { warning?: string }).warning ?? "", /implicit casts/);
});

test("upsertRelationship creates a model when absent and replaces by pair, keeping rate order", async () => {
  const { upsertRelationship, pairKey } = await import("../src/context/db/erDiagram");
  const rel = (over: Partial<import("../src/context/db/schemaIndex").ProbedRelationship>) => ({
    fromTable: "dbo.Orders", fromColumn: "customer_id", toTable: "dbo.Customers", toColumn: "id",
    forwardRate: 0.5, backwardRate: 0.2, sampledForward: 100, sampledBackward: 100,
    verdict: "defined" as const, reason: "user-defined join (chat)",
    ...over,
  });
  const created = upsertRelationship(undefined, rel({}), T0);
  assert.equal(created.relationships.length, 1);
  assert.equal(created.builtAt, T0);
  // Replacing the same pair (re-probed) keeps one entry with the new rates;
  // an unrelated stronger pair sorts first.
  const other = rel({ fromTable: "dbo.Orders", fromColumn: "region_code", toTable: "dbo.Customers", toColumn: "region_code", forwardRate: 0.99, verdict: "strong" as const });
  const merged = upsertRelationship(upsertRelationship(created, other, T0), rel({ forwardRate: 0.97 }), T0);
  assert.equal(merged.relationships.length, 2);
  assert.equal(merged.relationships[0].forwardRate, 0.99);
  assert.equal(
    merged.relationships.filter((r) => pairKey(r) === pairKey(rel({}))).length,
    1,
    "same pair never duplicates",
  );
  assert.equal(merged.relationships[1].forwardRate, 0.97, "re-probe replaced the rates");
});
