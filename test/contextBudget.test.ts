import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  PromptSection,
  budgetSections,
  effectiveInputCap,
  looksLikeOverflow,
  resolveLimit,
  onSuccess,
  onOverflow,
} from "../src/core/contextBudget";

const sec = (label: string, priority: number, tokens: number, required = false): PromptSection & { tokens: number } =>
  ({ label, text: label, priority, required, tokens });

const counter = (s: PromptSection) => (s as PromptSection & { tokens: number }).tokens;

// --- budgetSections --------------------------------------------------------

test("keeps everything when under cap", () => {
  const ss = [sec("instr", 100, 10, true), sec("hist", 20, 30), sec("req", 100, 10, true)];
  const r = budgetSections(ss, counter, 100);
  assert.equal(r.dropped.length, 0);
  assert.equal(r.kept.length, 3);
});

test("drops lowest-priority sections first until it fits", () => {
  const ss = [
    sec("instr", 100, 10, true),
    sec("project", 30, 40),
    sec("context", 40, 40),
    sec("history", 20, 40),
    sec("req", 100, 10, true),
  ];
  // total 140, cap 100 -> must shed 40+. history (20) is lowest -> dropped.
  const r = budgetSections(ss, counter, 100);
  assert.deepEqual(r.dropped.map((d) => d.label), ["history"]);
  assert.ok(!r.kept.some((k) => k.label === "history"));
});

test("drops in ascending priority order across several sections", () => {
  const ss = [
    sec("instr", 100, 10, true),
    sec("project", 30, 40),
    sec("context", 40, 40),
    sec("history", 20, 40),
    sec("req", 100, 10, true),
  ];
  // cap 60: required=20, need to shed 90 of the 120 droppable -> drop history(20)
  // then project(30); context(40) kept (20+40=60 fits).
  const r = budgetSections(ss, counter, 60);
  assert.deepEqual(r.dropped.map((d) => d.label).sort(), ["history", "project"]);
  assert.deepEqual(r.kept.map((k) => k.label).sort(), ["context", "instr", "req"]);
});

test("never drops required sections, even if still over cap", () => {
  const ss = [sec("instr", 100, 80, true), sec("req", 100, 80, true), sec("hist", 20, 10)];
  const r = budgetSections(ss, counter, 50);
  assert.deepEqual(r.dropped.map((d) => d.label), ["hist"]);
  assert.equal(r.kept.length, 2); // required kept though 160 > 50
});

// --- effectiveInputCap -----------------------------------------------------

test("effectiveInputCap applies the safety margin and clamps to the learned cap", () => {
  assert.equal(effectiveInputCap(10000, undefined, 0.85), 8500);
  assert.equal(effectiveInputCap(10000, 4000, 0.85), 3400); // learned < advertised
  assert.equal(effectiveInputCap(10000, 20000, 0.85), 8500); // learned above advertised ignored
  assert.equal(effectiveInputCap(undefined, undefined, 0.85), Math.floor(8192 * 0.85)); // fallback
});

// --- looksLikeOverflow -----------------------------------------------------

test("looksLikeOverflow matches context-length errors, not connectivity", () => {
  assert.ok(looksLikeOverflow("This model's maximum context length is 8192 tokens"));
  assert.ok(looksLikeOverflow("prompt is too long"));
  assert.ok(looksLikeOverflow("Please reduce the length of the messages"));
  assert.ok(looksLikeOverflow("Request exceeds the token limit"));
  assert.ok(!looksLikeOverflow("ECONNRESET: socket hang up"));
  assert.ok(!looksLikeOverflow(undefined));
});

// --- per-model learned limits ---------------------------------------------

test("onSuccess raises known-good and remembers advertised", () => {
  const r1 = onSuccess(undefined, 128000, 5000, "t1");
  assert.equal(r1.knownGood, 5000);
  assert.equal(r1.advertised, 128000);
  const r2 = onSuccess(r1, 128000, 3000, "t2"); // smaller success doesn't lower it
  assert.equal(r2.knownGood, 5000);
});

test("onOverflow sets a cap just below the attempted size", () => {
  const r = onOverflow(undefined, 128000, 9000, "t1");
  assert.ok(r);
  assert.equal(r?.effectiveCap, 8999);
  assert.equal(r?.advertised, 128000);
});

test("onOverflow ignores contradictory or non-improving signals", () => {
  // attempted at/below a proven known-good => not really a size problem.
  assert.equal(onOverflow({ knownGood: 9000 }, 128000, 8000, "t"), undefined);
  // already have a tighter cap.
  assert.equal(onOverflow({ effectiveCap: 4000 }, 128000, 9000, "t"), undefined);
  // non-positive size.
  assert.equal(onOverflow(undefined, 128000, 0, "t"), undefined);
});

test("resolveLimit clamps advertised by the learned cap but floors at known-good", () => {
  assert.equal(resolveLimit(undefined, 128000), 128000);
  assert.equal(resolveLimit({ effectiveCap: 4000 }, 128000), 4000);
  // a known-good larger than a stale cap wins (never budget below proven-good).
  assert.equal(resolveLimit({ effectiveCap: 4000, knownGood: 6000 }, 128000), 6000);
  assert.equal(resolveLimit(undefined, undefined), undefined);
});
