import { test } from "node:test";
import * as assert from "node:assert/strict";
import { sheetToCsv } from "../src/context/files/sheet";

test("sheetToCsv renders RFC-4180 CSV with quoting", () => {
  const csv = sheetToCsv({
    name: "Pages",
    rows: [
      ["Page", "Owner", "Note"],
      ["Simple", "jdoe", "ok"],
      ["Has, comma", "a\"b", "line1\nline2"],
    ],
  });
  assert.equal(
    csv,
    ['Page,Owner,Note', 'Simple,jdoe,ok', '"Has, comma","a""b","line1\nline2"'].join("\r\n"),
  );
});

test("sheetToCsv handles an empty sheet", () => {
  assert.equal(sheetToCsv({ name: "x", rows: [] }), "");
});
