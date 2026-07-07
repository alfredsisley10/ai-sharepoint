import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  DEFAULT_PRICE_PER_REQUEST,
  PremiumPricing,
  premiumCostEnabled,
  premiumRequests,
  estimatePremiumCost,
  estimateProbeCost,
} from "../src/copilot/premiumCost";

const pricing = (price = DEFAULT_PRICE_PER_REQUEST, currency = "$"): PremiumPricing => ({
  pricePerRequest: price,
  currency,
});

// A simple multiplier table for the tests.
const mult = (key: string): number => (key === "o1" ? 10 : key === "free" ? 0 : 1);

test("the default per-request price is GitHub's published $0.04 overage rate", () => {
  assert.equal(DEFAULT_PRICE_PER_REQUEST, 0.04);
});

test("premiumCostEnabled tracks a non-zero price", () => {
  assert.equal(premiumCostEnabled(pricing(0.04)), true);
  assert.equal(premiumCostEnabled(pricing(0)), false);
});

test("premiumRequests = requests × multiplier, summed", () => {
  const rows = [
    { key: "gpt-4o", requests: 10 }, // ×1 = 10
    { key: "o1", requests: 2 }, // ×10 = 20
    { key: "free", requests: 100 }, // ×0 = 0
  ];
  assert.equal(premiumRequests(rows, mult), 30);
});

test("estimatePremiumCost multiplies premium requests by the price", () => {
  const rows = [
    { key: "gpt-4o", requests: 10 },
    { key: "o1", requests: 2 },
  ]; // 30 premium requests
  assert.equal(estimatePremiumCost(rows, mult, pricing(0.04)), 30 * 0.04);
  assert.equal(estimatePremiumCost(rows, mult, pricing(0)), 0);
});

test("estimatePremiumCost floors negative/NaN inputs to zero", () => {
  assert.equal(estimatePremiumCost([{ key: "gpt-4o", requests: -5 }], mult, pricing(0.04)), 0);
  assert.equal(estimatePremiumCost([{ key: "gpt-4o", requests: NaN }], mult, pricing(0.04)), 0);
  assert.equal(estimatePremiumCost([{ key: "gpt-4o", requests: 10 }], mult, pricing(-1)), 0);
});

test("estimateProbeCost = steps × multiplier × price (upper bound)", () => {
  const e = estimateProbeCost(10, 8, 0.04); // 80 premium requests
  assert.equal(e.premiumRequests, 80);
  assert.equal(e.cost, 80 * 0.04);
  // A 0× (included) model probes for free.
  assert.equal(estimateProbeCost(0, 8, 0.04).cost, 0);
  assert.equal(estimateProbeCost(1, 8, 0).cost, 0);
});
