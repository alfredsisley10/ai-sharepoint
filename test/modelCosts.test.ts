import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ModelCostTable } from "../src/copilot/modelCosts";

const table = new ModelCostTable();

test("longest substring match wins (gpt-4o-mini vs gpt-4o)", () => {
  assert.equal(table.multiplierFor("gpt-4o-mini"), 0);
  assert.equal(table.multiplierFor("gpt-4o"), 0);
});

test("known premium models are multiplied", () => {
  assert.ok(table.multiplierFor("claude-opus-4.1") > 1);
});

test("unknown models fall back to the default multiplier", () => {
  assert.equal(table.multiplierFor("totally-unknown-model"), 1);
});

test("tiers map from multipliers", () => {
  assert.equal(table.tierFor("gpt-4o"), "Economy");
  assert.equal(table.tierFor("claude-sonnet-4.5"), "Standard");
  assert.equal(table.tierFor("claude-opus-4.1"), "Premium");
});

test("badge renders the multiplier", () => {
  assert.equal(table.badgeFor("claude-opus-4"), "10×");
});
