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
