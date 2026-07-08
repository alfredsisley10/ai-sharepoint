import { test } from "node:test";
import * as assert from "node:assert/strict";
import { progressMessage, formatDuration } from "../src/core/progress";

test("formatDuration renders seconds, minutes, hours", () => {
  assert.equal(formatDuration(500), "1s");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(90_000), "2m"); // rounded
  assert.equal(formatDuration(3_600_000), "1h 0m");
  assert.equal(formatDuration(5_400_000), "1h 30m");
});

test("progressMessage shows count, percent, and a rate-based ETA", () => {
  // 10 of 40 in 10s → 30 left at 1s/item → ~30s remaining.
  assert.equal(progressMessage(10, 40, 10_000, "page"), "10 of 40 pages (25%) · ~30s remaining");
  // Singular noun handling.
  assert.equal(progressMessage(1, 1, 5_000, "page"), "1 of 1 page (100%)"); // done == total → no ETA
  // No ETA before any item completes.
  assert.equal(progressMessage(0, 40, 0, "page"), "0 of 40 pages (0%)");
  // Unknown total → bare count.
  assert.equal(progressMessage(7, 0, 1000, "record"), "7 records…");
});
