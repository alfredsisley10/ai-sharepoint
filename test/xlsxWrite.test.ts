import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildXlsx, columnLetters, sanitizeSheetName } from "../src/context/files/xlsxWrite";
import { readXlsxSheets } from "../src/context/files/xlsx";
import { oversightSheets, workItemRows, historyRows } from "../src/context/oversightReport";
import { createWorkItem, applyEvent, workItemEvent } from "../src/context/workItems";

test("columnLetters: 0→A, 25→Z, 26→AA", () => {
  assert.equal(columnLetters(0), "A");
  assert.equal(columnLetters(25), "Z");
  assert.equal(columnLetters(26), "AA");
  assert.equal(columnLetters(27), "AB");
});

test("sanitizeSheetName: strips illegal chars, caps at 31, falls back when blank", () => {
  assert.equal(sanitizeSheetName("Work/Items:2025", "x"), "Work Items 2025");
  assert.equal(sanitizeSheetName("   ", "Sheet1"), "Sheet1");
  assert.equal(sanitizeSheetName("x".repeat(40), "y").length, 31);
});

test("buildXlsx round-trips through our own reader (values + special chars + multi-sheet)", () => {
  const bytes = buildXlsx(
    [
      { name: "Alpha", rows: [["Name", "Note"], ["R&D <team>", 'say "hi"'], ["", "empty-A"]] },
      { name: "Beta", rows: [["only"]] },
    ],
    { headerRow: true },
  );
  const sheets = readXlsxSheets(Buffer.from(bytes));
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, "Alpha");
  assert.deepEqual(sheets[0].rows[0], ["Name", "Note"]);
  assert.equal(sheets[0].rows[1][0], "R&D <team>"); // xml-escaped then decoded back
  assert.equal(sheets[0].rows[1][1], 'say "hi"');
  assert.equal(sheets[1].name, "Beta");
  assert.equal(sheets[1].rows[0][0], "only");
});

test("buildXlsx de-duplicates colliding sanitized sheet names", () => {
  const bytes = buildXlsx([{ name: "A:B", rows: [["1"]] }, { name: "A/B", rows: [["2"]] }]);
  const sheets = readXlsxSheets(Buffer.from(bytes));
  assert.equal(sheets.length, 2);
  assert.notEqual(sheets[0].name, sheets[1].name);
});

test("oversightSheets: Summary + Work Items + History reflect the backlog and its events", () => {
  const T = (n: number) => new Date(Date.UTC(2026, 6, 1, 0, n)).toISOString();
  let item = createWorkItem(
    { title: "Stale page", finding: "old gateway", target: { source: "Wiki", kind: "confluence", ref: "9" }, owner: { sam: "jdoe", displayName: "J Doe", contact: "j@x.com", basis: "page-contributor" } },
    "wi1",
    "e0",
    T(0),
  );
  item = applyEvent(item, workItemEvent("e1", T(1), "communication", "ai", { channel: "outlook", recipient: "j@x.com", draftId: "d1", toStatus: "notified" }));
  item = applyEvent(item, workItemEvent("e2", T(2), "resolved", "user", { toStatus: "resolved" }));

  const sheets = oversightSheets([item], T(9));
  const [summary, work, history] = sheets;
  assert.equal(summary.name, "Summary");
  assert.ok(summary.rows.some((r) => r[0] === "resolved" && r[1] === "1"));
  // Work Items: header row + one data row; owner + contact populated.
  const rows = workItemRows([item]);
  const ownerCol = rows[0].indexOf("Owner contact");
  assert.equal(rows[1][ownerCol], "j@x.com");
  assert.equal(rows[1][rows[0].indexOf("Status")], "resolved");
  // History: header + created + owner_resolved + communication + resolved = 5 rows.
  const hist = historyRows([item]);
  assert.equal(hist.length, 1 + item.events.length);
  assert.ok(hist.some((r) => r.includes("communication")));
  assert.equal(work.name, "Work Items");
  assert.equal(history.name, "History");
});
