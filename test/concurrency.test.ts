import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ConcurrencyGovernor,
  isLoadFailure,
  runWithConcurrency,
  describeLimitChange,
  resolveConcurrency,
  FAILURE_THRESHOLD,
  RECOVERY_STREAK,
  DEFAULT_QUERY_CONCURRENCY,
  MAX_QUERY_CONCURRENCY,
} from "../src/context/db/concurrency";
import { AppError } from "../src/core/errors";

const timeout = () => new Error("Timeout: Request failed to complete in 30000ms");

test("only LOAD failures count — the rest would collapse the limit for nothing", () => {
  // These mean "we are pushing too hard".
  for (const e of [
    new Error("Timeout: Request failed to complete in 30000ms"),
    new Error("read ECONNRESET"),
    new Error("ER_CON_COUNT_ERROR: Too many connections"),
    new Error("429 Too Many Requests"),
    new Error("503 Service Unavailable"),
    new Error("Transaction was deadlocked on lock resources"),
    new Error("net::ERR_HTTP2_PROTOCOL_ERROR"),
    new AppError("slow down", "graph.throttled"),
  ]) {
    assert.equal(isLoadFailure(e), true, e instanceof Error ? e.message : String(e));
  }
  // These are about THIS request and do not improve with less parallelism.
  // Reacting to them would drop the limit on a schema whose only problem is
  // that some tables aren't readable.
  for (const e of [
    new Error("Invalid object name 'dbo.Missing'."),
    new Error("Unknown column 'x' in 'field list'"),
    new Error("permission denied for relation orders"),
    new Error("Incorrect syntax near ')'"),
    new AppError("login failed", "auth.failed"),
    new AppError("cancelled", "auth.cancelled"),
    new AppError("not authorized for this Copilot feature", "copilot.entitlement"),
  ]) {
    assert.equal(isLoadFailure(e), false, e instanceof Error ? e.message : String(e));
  }
  // Unrecognized failures do NOT count: a limit that drops for unknown reasons
  // is worse than one that never drops.
  assert.equal(isLoadFailure(new Error("something odd happened")), false);
  assert.equal(isLoadFailure(undefined), false);
});

test("a permission error that mentions a pool is still not overload", () => {
  // Order matters in the classifier: the not-load signatures win, or any
  // message containing "pool" would read as pool exhaustion.
  assert.equal(isLoadFailure(new Error("permission denied on resource pool default")), false);
});

test("one failure does not reduce the limit — two do", () => {
  const g = new ConcurrencyGovernor(8);
  assert.equal(g.limit, 8);
  // A single timeout is normal on any busy database; collapsing on it would
  // make the feature feel broken.
  assert.equal(g.recordFailure(timeout()), undefined);
  assert.equal(g.limit, 8);
  const change = g.recordFailure(timeout());
  assert.equal(change?.direction, "down");
  assert.equal(change?.from, 8);
  // MULTIPLICATIVE decrease: backing off must outrun the overload.
  assert.equal(change?.to, 4);
  assert.equal(g.limit, 4);
  assert.equal(FAILURE_THRESHOLD, 2);
});

test("ignored failures never move the limit, however many there are", () => {
  const g = new ConcurrencyGovernor(4);
  for (let i = 0; i < 20; i++) {
    assert.equal(g.recordFailure(new Error("Invalid object name 'x'")), undefined);
  }
  assert.equal(g.limit, 4, "a schema full of unreadable tables must not throttle itself");
  assert.equal(g.snapshot().ignoredFailures, 20);
  assert.equal(g.snapshot().loadFailures, 0);
  assert.equal(g.snapshot().reduced, false);
});

test("a reduction resets the window, so one burst can't cascade", () => {
  const g = new ConcurrencyGovernor(8);
  g.recordFailure(timeout());
  assert.equal(g.recordFailure(timeout())?.to, 4);
  // The next single failure must not immediately halve again off the same
  // window — the new limit deserves a fresh observation.
  assert.equal(g.recordFailure(timeout()), undefined);
  assert.equal(g.limit, 4);
  assert.equal(g.recordFailure(timeout())?.to, 2);
});

test("the limit never falls below one", () => {
  const g = new ConcurrencyGovernor(2);
  g.recordFailure(timeout());
  assert.equal(g.recordFailure(timeout())?.to, 1);
  for (let i = 0; i < 10; i++) g.recordFailure(timeout());
  assert.equal(g.limit, 1, "zero would stall every database function");
});

test("recovery is additive and never exceeds the user's ceiling", () => {
  const g = new ConcurrencyGovernor(4);
  g.recordFailure(timeout());
  g.recordFailure(timeout());
  assert.equal(g.limit, 2);
  // Recovering fast just re-triggers the overload, so it takes a real streak.
  for (let i = 0; i < RECOVERY_STREAK - 1; i++) assert.equal(g.recordSuccess(), undefined);
  const up = g.recordSuccess();
  assert.equal(up?.direction, "up");
  assert.equal(up?.to, 3, "one step at a time");
  for (let i = 0; i < RECOVERY_STREAK; i++) g.recordSuccess();
  assert.equal(g.limit, 4);
  // The ceiling is the user's decision; automatic control does not get to
  // decide it knows better.
  for (let i = 0; i < RECOVERY_STREAK * 3; i++) assert.equal(g.recordSuccess(), undefined);
  assert.equal(g.limit, 4);
});

test("a failure breaks the success streak", () => {
  const g = new ConcurrencyGovernor(4);
  g.recordFailure(timeout());
  g.recordFailure(timeout());
  for (let i = 0; i < RECOVERY_STREAK - 1; i++) g.recordSuccess();
  g.recordFailure(timeout()); // load failure: resets the streak
  for (let i = 0; i < RECOVERY_STREAK - 1; i++) assert.equal(g.recordSuccess(), undefined);
  assert.equal(g.limit, 2, "the streak restarted, so no step up yet");
});

test("lowering the ceiling mid-run pulls the running limit down with it", () => {
  const g = new ConcurrencyGovernor(8);
  g.setCeiling(2);
  assert.equal(g.limit, 2);
  assert.equal(g.ceiling, 2);
  // Raising it does NOT jump the running value up — that has to be earned.
  g.setCeiling(8);
  assert.equal(g.limit, 2);
  assert.equal(g.ceiling, 8);
});

test("the run summary reports what happened, or says nothing", () => {
  const clean = new ConcurrencyGovernor(4);
  for (let i = 0; i < 5; i++) clean.recordSuccess();
  assert.equal(clean.summary(), undefined, "a clean run has nothing to report");

  const rough = new ConcurrencyGovernor(4);
  rough.recordFailure(timeout());
  rough.recordFailure(timeout());
  rough.recordFailure(new Error("Invalid object name 'x'"));
  const s = rough.summary()!;
  assert.match(s, /2 load-related failure/);
  assert.match(s, /reduced to 2/);
  assert.match(s, /1 other error\(s\) were not treated as overload/);
});

test("describeLimitChange explains a slowdown rather than just announcing it", () => {
  const down = describeLimitChange({ from: 8, to: 4, direction: "down", reason: "2 timeouts" }, "Database");
  assert.match(down, /reduced 8 → 4/);
  assert.match(down, /2 timeouts/);
  // An adaptive limit that never says it recovers reads as permanent damage.
  assert.match(down, /recover automatically/);
  assert.match(describeLimitChange({ from: 2, to: 3, direction: "up", reason: "ok" }), /raised 2 → 3/);
});

test("runWithConcurrency honors the limit and keeps INPUT order", async () => {
  const items = [40, 5, 30, 10, 20, 1];
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency(
    items,
    async (ms, i) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return `${i}:${ms}`;
    },
    { limit: () => 3 },
  );
  assert.equal(peak, 3, "never more than the limit at once");
  // Completion order is 5,1,10,20,30,40 — results must still be by INPUT
  // index, or a caller indexing into the input silently mis-associates.
  assert.deepEqual(results, ["0:40", "1:5", "2:30", "3:10", "4:20", "5:1"]);
});

test("a mid-run reduction applies to work still queued", async () => {
  // The whole reason the limit is a function rather than a number: a reduction
  // that only took effect next run would be useless for the run that is
  // currently overloading the server.
  let limit = 4;
  let active = 0;
  const peaks: number[] = [];
  await runWithConcurrency(
    Array.from({ length: 24 }, (_, i) => i),
    async (i) => {
      active += 1;
      peaks.push(active);
      if (i === 3) limit = 1;
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    },
    { limit: () => limit },
  );
  assert.ok(Math.max(...peaks) <= 4, `peak ${Math.max(...peaks)}`);
  // Once dropped to 1, the tail must be strictly sequential.
  assert.deepEqual(peaks.slice(-8), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test("one failing item never voids the rest", async () => {
  // The sequential loops this replaces already had this property, and it is
  // the difference between "one unreadable table" and "a lost run".
  const results = await runWithConcurrency(
    [1, 2, 3, 4],
    async (n) => {
      if (n % 2 === 0) throw new Error(`boom ${n}`);
      return n * 10;
    },
    { limit: () => 2 },
  );
  assert.deepEqual(results, [10, undefined, 30, undefined]);
});

test("cancellation stops dispatching without hanging", async () => {
  let cancelled = false;
  let started = 0;
  const results = await runWithConcurrency(
    Array.from({ length: 50 }, (_, i) => i),
    async () => {
      started += 1;
      if (started >= 4) cancelled = true;
      await new Promise((r) => setTimeout(r, 1));
      return 1;
    },
    { limit: () => 2, isCancelled: () => cancelled },
  );
  assert.ok(started < 50, `started ${started}`);
  assert.equal(results.length, 50, "the result array still matches the input");
});

test("an empty list resolves rather than hanging", async () => {
  assert.deepEqual(await runWithConcurrency([], async () => 1, { limit: () => 4 }), []);
});

test("a nonsense limit never stalls the pool", async () => {
  // A setting of 0 must mean "one", not "none" — otherwise every database
  // function would hang on a typo in the settings box.
  const out = await runWithConcurrency([1, 2, 3], async (n) => n, { limit: () => 0 });
  assert.deepEqual(out, [1, 2, 3]);
  assert.deepEqual(await runWithConcurrency([1], async (n) => n, { limit: () => NaN }), [1]);
});

test("resolveConcurrency clamps a hand-typed setting", () => {
  assert.equal(resolveConcurrency(undefined, DEFAULT_QUERY_CONCURRENCY, MAX_QUERY_CONCURRENCY), DEFAULT_QUERY_CONCURRENCY);
  assert.equal(resolveConcurrency(0, 4, 16), 4, "0 means unset, not 'run nothing'");
  assert.equal(resolveConcurrency(-3, 4, 16), 4);
  assert.equal(resolveConcurrency(NaN, 4, 16), 4);
  assert.equal(resolveConcurrency(999, 4, 16), 16);
  assert.equal(resolveConcurrency(6, 4, 16), 6);
  assert.equal(resolveConcurrency(6.9, 4, 16), 6, "no fractional parallelism");
});

test("a ceiling of 1 reproduces the original strictly-sequential behavior", async () => {
  // The documented escape hatch: someone whose server is unhappy must be able
  // to get exactly the old behavior back, not merely something close to it.
  const g = new ConcurrencyGovernor(1);
  let active = 0;
  let peak = 0;
  await runWithConcurrency(
    Array.from({ length: 10 }, (_, i) => i),
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
    },
    { limit: () => g.limit },
  );
  assert.equal(peak, 1);
  // And it can't be reduced below itself, so no notices are produced either.
  assert.equal(g.recordFailure(timeout()), undefined);
  assert.equal(g.recordFailure(timeout()), undefined);
  assert.equal(g.limit, 1);
});
