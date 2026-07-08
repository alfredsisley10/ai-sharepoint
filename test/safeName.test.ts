import { test } from "node:test";
import * as assert from "node:assert/strict";
import { avoidReservedName } from "../src/context/files/safeName";

test("avoidReservedName escapes Windows reserved device names (case-insensitive, with extension)", () => {
  for (const n of ["con", "CON", "Nul", "aux", "prn", "com1", "com9", "lpt1", "lpt9"]) {
    assert.equal(avoidReservedName(n), `_${n}`, n);
  }
  assert.equal(avoidReservedName("con.md"), "_con.md"); // reserved even with an extension
  assert.equal(avoidReservedName("nul.txt"), "_nul.txt");
});

test("avoidReservedName leaves ordinary names untouched", () => {
  assert.equal(avoidReservedName("project"), "project");
  assert.equal(avoidReservedName("console"), "console"); // not a device name
  assert.equal(avoidReservedName("com10"), "com10"); // COM10 is not reserved (only COM0–9)
  assert.equal(avoidReservedName("readme.md"), "readme.md");
});

test("avoidReservedName escapes trailing dots/spaces (Windows trims them)", () => {
  assert.equal(avoidReservedName("report."), "report_");
  assert.equal(avoidReservedName("report  "), "report__");
  assert.equal(avoidReservedName("a.b."), "a.b_"); // only the trailing dot
});

test("avoidReservedName never returns empty", () => {
  assert.equal(avoidReservedName(""), "_");
});
