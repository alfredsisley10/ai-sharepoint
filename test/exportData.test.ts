import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  rowsToCsv,
  exportFileName,
  sanitizeExportFileName,
} from "../src/context/exportData";

test("rowsToCsv neutralizes formula-injection cells (= + - @) without losing the value", () => {
  const csv = rowsToCsv([{ a: "=SUM(A1:A2)", b: "+1", c: "-2", d: "@x", e: "normal" }]);
  const dataRow = csv.split("\n")[1];
  assert.ok(dataRow.includes("'=SUM(A1:A2)"));
  assert.ok(dataRow.includes("'+1"));
  assert.ok(dataRow.includes("'@x"));
  assert.ok(dataRow.includes("normal"));
});

test("rowsToCsv escapes RFC-4180 style and aligns ragged rows via a header union", () => {
  const csv = rowsToCsv([
    { id: 1, name: 'He said "hi", twice', note: "line1\nline2" },
    { id: 2, extra: "only-here" },
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "id,name,note,extra");
  assert.equal(lines[1], '1,"He said ""hi"", twice","line1\nline2",');
  assert.equal(lines[2], "2,,,only-here");
});

test("rowsToCsv stringifies dates/objects and blanks null/undefined", () => {
  const when = new Date("2026-06-12T10:00:00.000Z");
  const csv = rowsToCsv([{ at: when, obj: { a: 1 }, empty: null }]);
  assert.match(csv, /2026-06-12T10:00:00\.000Z/);
  assert.match(csv, /"{""a"":1}"/);
  const dataLine = csv.split("\r\n")[1];
  assert.ok(dataLine.endsWith(","));
});

test("exportFileName slugs the source and stamps UTC time; empty slugs degrade", () => {
  assert.equal(
    exportFileName("CMDB (Prod)", "csv", "2026-06-12T17:30:05.123Z"),
    "cmdb-prod-20260612-173005.csv",
  );
  assert.match(exportFileName("***", "json", "2026-06-12T17:30:05Z"), /^source-/);
});

test("sanitizeExportFileName keeps bare names, enforces the extension, rejects traversal", () => {
  assert.equal(sanitizeExportFileName("My Export", "csv"), "My Export.csv");
  assert.equal(sanitizeExportFileName("data.CSV", "csv"), "data.csv");
  assert.equal(sanitizeExportFileName("../evil", "csv"), undefined);
  assert.equal(sanitizeExportFileName("a/b", "csv"), undefined);
  assert.equal(sanitizeExportFileName("a\\b", "json"), undefined);
  assert.equal(sanitizeExportFileName("  ", "csv"), undefined);
});
