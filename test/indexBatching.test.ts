import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  takeBatch,
  batchUnits,
  unitsOf,
  nextColumnBudget,
  shrinkAfterFailure,
  estimateBatchCount,
  describeBudgetChange,
  START_COLUMN_BUDGET,
  MIN_COLUMN_BUDGET,
  MAX_COLUMN_BUDGET,
  MAX_TABLES_PER_BATCH,
  TARGET_BATCH_MS,
} from "../src/context/db/indexBatching";

/** A table with `n` columns. */
const t = (n: number) => ({ columns: Array.from({ length: n }, (_, i) => ({ name: `c${i}` })) });

test("units are counted in COLUMNS — the thing the model actually writes", () => {
  assert.equal(unitsOf(t(12)), 12);
  assert.equal(batchUnits([t(3), t(4)]), 7);
  // A column-less table still costs something, so it can't be batched infinitely.
  assert.equal(unitsOf(t(0)), 1);
});

test("takeBatch fills up to the column budget, not a table count", () => {
  const tables = [t(30), t(30), t(30), t(30)];
  const { batch, rest } = takeBatch(tables, 100);
  assert.equal(batch.length, 3, "three 30-column tables fit in 100; the fourth would exceed it");
  assert.equal(rest.length, 1);
  assert.ok(batchUnits(batch) <= 100);
});

test("a single table WIDER than the budget is still taken — indexing never stalls", () => {
  const { batch, rest } = takeBatch([t(500), t(10)], 100);
  assert.equal(batch.length, 1);
  assert.equal(batchUnits(batch), 500, "over budget, but progress is made");
  assert.equal(rest.length, 1);
});

test("the table cap bounds a batch of many tiny tables", () => {
  const many = Array.from({ length: 200 }, () => t(1));
  const { batch } = takeBatch(many, 10_000);
  assert.equal(batch.length, MAX_TABLES_PER_BATCH, "column budget alone would have taken all 200");
});

test("takeBatch handles the empty and single-item cases", () => {
  assert.deepEqual(takeBatch([], 100), { batch: [], rest: [] });
  const one = takeBatch([t(5)], 100);
  assert.equal(one.batch.length, 1);
  assert.equal(one.rest.length, 0);
});

test("the budget GROWS when the model is fast, damped and capped", () => {
  // 120 columns in 5s ⇒ 24 cols/s ⇒ ~1080 for a 45s target, but one step may
  // only double.
  const next = nextColumnBudget(120, 120, 5_000);
  assert.equal(next, 240, "growth is damped to at most 2x per observation");
  // Repeated fast batches keep growing, and stop at the ceiling.
  let b = 120;
  for (let i = 0; i < 10; i++) b = nextColumnBudget(b, b, 1_000);
  assert.equal(b, MAX_COLUMN_BUDGET);
});

test("the budget SHRINKS when a batch is slow — the reported 460s case", () => {
  // The old scheme could put ~3,200 columns in one request; at the observed
  // ~7 columns/second that is the 460s batch. From a ceiling-sized budget the
  // controller backs off, damped to at most half per observation.
  assert.equal(nextColumnBudget(800, 800, 460_000), 400);
  // Sustained slowness converges toward the measured throughput, not to zero.
  let b = 800;
  for (let i = 0; i < 8; i++) b = nextColumnBudget(b, b, (b / 7) * 1000);
  assert.ok(b >= MIN_COLUMN_BUDGET && b <= 400, `converged to ${b}`);
  // ~7 cols/s over a 45s target is ~315 columns — about a 45s batch instead of
  // 460s, which is the whole point.
  assert.ok(b <= 320, `expected roughly a target-sized batch, got ${b}`);
});

test("an out-of-range budget is clamped back into bounds", () => {
  // Defensive: the budget is always clamped, so a stored/hand-passed value
  // outside the bounds can never produce a giant request.
  assert.equal(nextColumnBudget(5000, 5000, 45_000), MAX_COLUMN_BUDGET);
  assert.equal(nextColumnBudget(1, 1, 45_000), MIN_COLUMN_BUDGET);
});

test("a batch that lands ON target leaves the budget alone", () => {
  const b = 300;
  assert.equal(nextColumnBudget(b, b, TARGET_BATCH_MS), b);
});

test("the budget stays inside its bounds, and bad measurements are ignored", () => {
  assert.equal(nextColumnBudget(MIN_COLUMN_BUDGET, 10, 10_000_000), MIN_COLUMN_BUDGET);
  assert.equal(nextColumnBudget(MAX_COLUMN_BUDGET, 10_000, 1), MAX_COLUMN_BUDGET);
  // A missing/zero/negative duration must not divide-by-zero the budget away.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(nextColumnBudget(200, 200, bad), 200, `duration ${bad}`);
  }
  assert.equal(nextColumnBudget(200, 0, 5_000), 200, "zero units measured");
});

test("a failed batch halves the budget immediately", () => {
  // Failure usually means the response was too long to finish or parse, and a
  // failed batch never yields a duration to learn from.
  assert.equal(shrinkAfterFailure(400), 200);
  assert.equal(shrinkAfterFailure(MIN_COLUMN_BUDGET), MIN_COLUMN_BUDGET, "never below the floor");
});

test("estimateBatchCount drives the consent prompt's request estimate", () => {
  assert.equal(estimateBatchCount([]), 0);
  // 10 tables x 60 columns = 600 columns; at the 120 default that's 5 batches.
  assert.equal(estimateBatchCount(Array.from({ length: 10 }, () => t(60)), 120), 5);
  // Wide tables can't share a batch, so each is its own request.
  assert.equal(estimateBatchCount([t(500), t(500)], 120), 2);
  // The default start budget is used when none is given.
  assert.ok(estimateBatchCount(Array.from({ length: 4 }, () => t(50))) >= 1);
  assert.equal(START_COLUMN_BUDGET >= MIN_COLUMN_BUDGET, true);
});

test("describeBudgetChange only speaks when the size actually moved", () => {
  assert.equal(describeBudgetChange(120, 120), "");
  assert.match(describeBudgetChange(120, 240), /↑/);
  assert.match(describeBudgetChange(240, 120), /↓/);
});
