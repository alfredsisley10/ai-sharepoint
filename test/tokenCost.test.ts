import { test } from "node:test";
import * as assert from "node:assert/strict";
import { TokenRates, costEnabled, estimateCost, formatCost } from "../src/copilot/tokenCost";

const rates = (i: number, o: number, currency = "$"): TokenRates => ({
  inputPerMillion: i,
  outputPerMillion: o,
  currency,
});

test("costEnabled is true only once a non-zero rate is set", () => {
  assert.equal(costEnabled(rates(0, 0)), false);
  assert.equal(costEnabled(rates(3, 0)), true);
  assert.equal(costEnabled(rates(0, 15)), true);
});

test("estimateCost multiplies tokens by per-million rates", () => {
  // 500k input @ $3/M + 100k output @ $15/M = 1.5 + 1.5 = 3.00
  assert.equal(estimateCost(500_000, 100_000, rates(3, 15)), 3);
  assert.equal(estimateCost(1_000_000, 0, rates(2.5, 10)), 2.5);
});

test("estimateCost floors bad inputs to zero (never negative)", () => {
  assert.equal(estimateCost(-5, -5, rates(3, 3)), 0);
  assert.equal(estimateCost(NaN, 100_000, rates(3, 3)), estimateCost(0, 100_000, rates(3, 3)));
  assert.equal(estimateCost(100_000, 100_000, rates(-1, -1)), 0);
});

test("formatCost is locale-independent with grouping and a tiny-amount floor", () => {
  assert.equal(formatCost(0, "$"), "$0.00");
  assert.equal(formatCost(3, "$"), "$3.00");
  assert.equal(formatCost(1234.5, "$"), "$1,234.50");
  assert.equal(formatCost(0.004, "$"), "<$0.01"); // real activity never reads as free
  assert.equal(formatCost(12.5, "£"), "£12.50");
});
