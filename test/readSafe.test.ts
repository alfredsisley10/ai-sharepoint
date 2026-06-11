import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  assertReadOnlySql,
  stripSqlNoise,
  rowsToHits,
  parseMongoSpec,
} from "../src/context/db/readSafe";

test("plain SELECT and WITH…SELECT pass", () => {
  assert.ok(assertReadOnlySql("SELECT * FROM dbo.Orders WHERE id = 1").ok);
  assert.ok(assertReadOnlySql("  with x as (select 1 as n) select * from x;").ok);
});

test("DML/DDL/exec are rejected even when leading whitespace/case varies", () => {
  for (const sql of [
    "DELETE FROM users",
    "update t set a=1",
    "INSERT INTO t VALUES (1)",
    "DROP TABLE t",
    "exec sp_who",
    "EXECUTE xp_cmdshell 'dir'",
    "CREATE TABLE x (a int)",
    "truncate table t",
    "GRANT SELECT ON t TO public",
  ]) {
    assert.equal(assertReadOnlySql(sql).ok, false, sql);
  }
});

test("write keywords hidden inside a SELECT are rejected (SELECT INTO, subquery exec)", () => {
  assert.equal(assertReadOnlySql("SELECT * INTO backup_t FROM t").ok, false);
  assert.equal(assertReadOnlySql("SELECT 1; DROP TABLE t").ok, false); // multi-statement
  assert.equal(assertReadOnlySql("SELECT * FROM t WHERE id IN (EXEC bad())").ok, false);
  assert.equal(assertReadOnlySql("SELECT 1 WAITFOR DELAY '0:0:10'").ok, false);
});

test("keywords inside strings/comments/identifiers do NOT trip the guard", () => {
  assert.ok(assertReadOnlySql("SELECT 'please do not DELETE me' AS note FROM t").ok);
  assert.ok(assertReadOnlySql("SELECT a FROM t -- TODO: drop this column later").ok);
  assert.ok(assertReadOnlySql("SELECT a /* update docs */ FROM t").ok);
  assert.ok(assertReadOnlySql('SELECT "drop" FROM t').ok);
  assert.ok(assertReadOnlySql("SELECT [delete] FROM [t]").ok);
});

test("trailing semicolon ok; trailing content after it is not", () => {
  assert.ok(assertReadOnlySql("SELECT 1;").ok);
  assert.equal(assertReadOnlySql("SELECT 1; SELECT 2").ok, false);
});

test("stripSqlNoise neutralizes escaped quotes", () => {
  const out = stripSqlNoise("SELECT 'it''s a DELETE trap' FROM t");
  assert.ok(!/delete/i.test(out));
});

test("rowsToHits caps rows, truncates values, handles null/date/buffer/json", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    name: `row-${i}`,
    when: new Date("2026-06-11T00:00:00Z"),
    blob: Buffer.from("abc"),
    obj: { nested: true },
    none: null,
    long: "y".repeat(200),
  }));
  const hits = rowsToHits(rows, 3, "db:test");
  assert.equal(hits.length, 3);
  assert.equal(hits[0].meta?.none, "NULL");
  assert.equal(hits[0].meta?.when, "2026-06-11T00:00:00.000Z");
  assert.match(hits[0].meta?.blob ?? "", /binary 3B/);
  assert.equal(hits[0].meta?.obj, '{"nested":true}');
  assert.ok((hits[0].meta?.long ?? "").length <= 121);
  assert.equal(hits[0].title, "0 · row-0 · 2026-06-11T00:00:00.000Z");
});

test("parseMongoSpec validates shape and defaults", () => {
  const spec = parseMongoSpec('{"collection":"users","filter":{"dept":"R&D"},"limit":5}');
  assert.deepEqual(spec, { collection: "users", filter: { dept: "R&D" }, projection: undefined, limit: 5 });
  assert.throws(() => parseMongoSpec("find all users"), /must be JSON/);
  assert.throws(() => parseMongoSpec('{"filter":{}}'), /"collection"/);
});
