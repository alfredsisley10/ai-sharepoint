import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  BudgetGuard,
  BudgetBlockedError,
  BudgetConfig,
} from "../src/copilot/budget";

const NOW = "2026-06-11T12:00:00.000Z";

function guard(usedUnits: number, cfg: Partial<BudgetConfig> = {}) {
  const config: BudgetConfig = {
    allowance: 100,
    mode: "block",
    softPct: 80,
    hardPct: 100,
    ...cfg,
  };
  return new BudgetGuard({ premiumUnitsThisMonth: () => usedUnits }, () => config);
}

test("ok below the soft cap", () => {
  const v = guard(50).evaluate(1, NOW);
  assert.equal(v.state, "ok");
  assert.equal(v.usedPct, 50);
  assert.equal(v.projectedPct, 51);
});

test("soft state when the *projected* spend crosses the soft cap", () => {
  const v = guard(80).evaluate(1, NOW); // 81% projected > 80%
  assert.equal(v.state, "soft");
});

test("hard state past the hard cap; enforce throws in block mode", () => {
  const g = guard(100);
  assert.equal(g.evaluate(1, NOW).state, "hard");
  assert.throws(() => g.enforce(1, NOW), BudgetBlockedError);
});

test("enforce with override returns instead of throwing", () => {
  const v = guard(100).enforce(1, NOW, true);
  assert.equal(v.state, "hard");
});

test("warn mode never throws, still reports hard state", () => {
  const v = guard(150, { mode: "warn" }).enforce(10, NOW);
  assert.equal(v.state, "hard");
});

test("off mode reports ok regardless of usage", () => {
  const v = guard(500, { mode: "off" }).evaluate(10, NOW);
  assert.equal(v.state, "ok");
});

test("free (0-unit) requests are never blocked, even at the hard cap", () => {
  // 100% used, next request costs 0 → projected stays 100, not > 100:
  // warns (soft territory) but does not throw — base-model usage stays free.
  const v = guard(100).enforce(0, NOW);
  assert.equal(v.state, "soft");
});

test("config is sanitized: hard >= soft, allowance >= 1", () => {
  const v = guard(5, { allowance: -10, softPct: 90, hardPct: 50 }).evaluate(0, NOW);
  assert.equal(v.allowance, 1);
  assert.ok(v.hardPct >= v.softPct);
});

test("BudgetBlockedError carries the verdict and a user summary", () => {
  try {
    guard(200).enforce(1, NOW);
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof BudgetBlockedError);
    assert.equal(err.code, "budget.blocked");
    assert.ok(err.verdict.usedPct >= 200);
    assert.ok(err.userSummary);
  }
});
