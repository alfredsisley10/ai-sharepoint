import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  emptyLedger,
  migrateLedger,
  recordInto,
  monthRequests,
  monthFailures,
  todayRequests,
  monthByModel,
  monthByLabel,
  dailySeries,
  RECENT_CAP,
  UsageRecord,
} from "../src/copilot/ledgerMath";

const NOW = "2026-06-11T12:00:00.000Z";

function rec(partial: Partial<UsageRecord>): UsageRecord {
  return {
    at: NOW,
    modelId: "gpt-test",
    inputTokens: 100,
    outputTokens: 50,
    ok: true,
    ...partial,
  };
}

test("records aggregate into month/day/model/label slices", () => {
  const l = emptyLedger();
  recordInto(l, rec({ label: "chat" }));
  recordInto(l, rec({ label: "chat" }));
  recordInto(l, rec({ label: "chat", modelId: "opus" }));
  recordInto(l, rec({ at: "2026-05-30T00:00:00Z", label: "old" }));

  assert.equal(monthRequests(l, NOW), 3);
  assert.equal(todayRequests(l, NOW), 3);
  const byModel = monthByModel(l, NOW);
  assert.equal(byModel[0].key, "gpt-test"); // sorted by request count desc
  assert.equal(byModel[0].requests, 2);
  assert.equal(byModel[0].inputTokens, 200);
  const byLabel = monthByLabel(l, NOW);
  assert.equal(byLabel.length, 1);
  assert.equal(byLabel[0].key, "chat");
});

test("failures count separately and still count as requests", () => {
  const l = emptyLedger();
  recordInto(l, rec({ ok: false }));
  assert.equal(monthFailures(l, NOW), 1);
  assert.equal(monthRequests(l, NOW), 1);
});

test("recent tail is capped", () => {
  const l = emptyLedger();
  for (let i = 0; i < RECENT_CAP + 50; i++) {
    recordInto(l, rec({}));
  }
  assert.equal(l.recent.length, RECENT_CAP);
});

test("v1 ledgers migrate into aggregates", () => {
  const v1 = {
    records: [
      { at: NOW, modelId: "m", inputTokens: 1, outputTokens: 2 },
      { at: NOW, modelId: "m", inputTokens: 1, outputTokens: 2, label: "x" },
    ],
  };
  const l = migrateLedger(v1);
  assert.equal(l.version, 3);
  assert.equal(monthRequests(l, NOW), 2);
});

test("v2 ledgers migrate: counts/tokens survive, premium-unit estimates are dropped", () => {
  const v2 = {
    version: 2,
    days: [
      {
        day: "2026-06-11",
        requests: 4,
        failures: 1,
        inputTokens: 40,
        outputTokens: 80,
        premiumUnits: 12.5,
        byModel: { "gpt-test": { requests: 4, failures: 1, inputTokens: 40, outputTokens: 80, premiumUnits: 12.5 } },
        byLabel: { chat: { requests: 4, failures: 1, inputTokens: 40, outputTokens: 80, premiumUnits: 12.5 } },
      },
    ],
    recent: [
      { at: NOW, modelId: "gpt-test", inputTokens: 10, outputTokens: 20, premiumUnits: 1, ok: true },
    ],
  };
  const l = migrateLedger(v2);
  assert.equal(l.version, 3);
  assert.equal(monthRequests(l, NOW), 4);
  assert.equal(monthFailures(l, NOW), 1);
  const byModel = monthByModel(l, NOW);
  assert.equal(byModel[0].inputTokens, 40);
  assert.ok(!("premiumUnits" in byModel[0]), "premium-unit estimates must not survive migration");
  assert.equal(l.recent.length, 1);
  assert.ok(!("premiumUnits" in l.recent[0]));
});

test("migrate tolerates garbage", () => {
  assert.equal(migrateLedger(undefined).days.length, 0);
  assert.equal(migrateLedger("junk").days.length, 0);
  assert.equal(migrateLedger({ records: "nope" }).days.length, 0);
});

test("dailySeries returns exactly n days ending today", () => {
  const l = emptyLedger();
  recordInto(l, rec({}));
  recordInto(l, rec({ at: "2026-06-10T01:00:00Z" }));
  recordInto(l, rec({ at: "2026-06-10T02:00:00Z", ok: false }));
  const series = dailySeries(l, NOW, 7);
  assert.equal(series.length, 7);
  assert.equal(series[6].day, "2026-06-11");
  assert.equal(series[6].requests, 1);
  assert.equal(series[5].requests, 2);
  assert.equal(series[5].failures, 1);
  assert.equal(series[0].requests, 0);
});
