import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  planProbeBudget,
  PROBE_CHEAP_ROWS,
  PROBE_MAX_TIMEOUT_MS,
  PROBE_SCAN_ROWS_PER_MS,
} from "../src/context/db/queryBudget";

const BASE = 30_000;

test("a small table keeps the base timeout (no scaling)", () => {
  const b = planProbeBudget({ scanRows: 10_000, baseTimeoutMs: BASE });
  assert.equal(b.timeoutMs, BASE);
  assert.match(b.rationale, /small/);
});

test("exactly at the cheap threshold is still base", () => {
  assert.equal(planProbeBudget({ scanRows: PROBE_CHEAP_ROWS, baseTimeoutMs: BASE }).timeoutMs, BASE);
});

test("an indexed join column stays at base even for a huge table (seek, not scan)", () => {
  const b = planProbeBudget({ scanRows: 50_000_000, indexed: true, baseTimeoutMs: BASE });
  assert.equal(b.timeoutMs, BASE);
  assert.match(b.rationale, /indexed/);
});

test("a large unindexed table scales the timeout above base", () => {
  // 10M rows / 200 rows-per-ms + 2000 setup = 52,000ms
  const b = planProbeBudget({ scanRows: 10_000_000, baseTimeoutMs: BASE });
  assert.equal(b.timeoutMs, Math.ceil(10_000_000 / PROBE_SCAN_ROWS_PER_MS) + 2_000);
  assert.ok(b.timeoutMs > BASE && b.timeoutMs <= PROBE_MAX_TIMEOUT_MS);
  assert.equal(b.estimatedScanRows, 10_000_000);
});

test("a runaway estimate is clamped to the ceiling", () => {
  const b = planProbeBudget({ scanRows: 5_000_000_000, baseTimeoutMs: BASE });
  assert.equal(b.timeoutMs, PROBE_MAX_TIMEOUT_MS);
});

test("the ceiling honours a base timeout raised above the default cap", () => {
  // User set a 300s base; the probe may use up to that, not the 120s default cap.
  const b = planProbeBudget({ scanRows: 5_000_000_000, baseTimeoutMs: 300_000 });
  assert.equal(b.timeoutMs, 300_000);
});

test("no size estimate falls open to the base timeout", () => {
  const b = planProbeBudget({ scanRows: 0, baseTimeoutMs: BASE });
  assert.equal(b.timeoutMs, BASE);
  assert.match(b.rationale, /no size estimate/);
});
