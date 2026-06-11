import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  emptyLedger,
  migrateLedger,
  recordInto,
  monthUnits,
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
    premiumUnits: 1,
    ok: true,
    ...partial,
  };
}

test("records aggregate into month/day/model/label slices", () => {
  const l = emptyLedger();
  recordInto(l, rec({ label: "chat" }));
  recordInto(l, rec({ label: "chat", premiumUnits: 10, modelId: "opus" }));
  recordInto(l, rec({ at: "2026-05-30T00:00:00Z", label: "old" }));

  assert.equal(monthUnits(l, NOW), 11);
  assert.equal(monthRequests(l, NOW), 2);
  assert.equal(todayRequests(l, NOW), 2);
  const byModel = monthByModel(l, NOW);
  assert.equal(byModel[0].key, "opus"); // sorted by spend desc
  assert.equal(byModel[0].premiumUnits, 10);
  const byLabel = monthByLabel(l, NOW);
  assert.equal(byLabel.length, 1);
  assert.equal(byLabel[0].key, "chat");
});

test("failures count separately and still cost units", () => {
  const l = emptyLedger();
  recordInto(l, rec({ ok: false, premiumUnits: 1 }));
  assert.equal(monthFailures(l, NOW), 1);
  assert.equal(monthUnits(l, NOW), 1);
});

test("recent tail is capped", () => {
  const l = emptyLedger();
  for (let i = 0; i < RECENT_CAP + 50; i++) {
    recordInto(l, rec({}));
  }
  assert.equal(l.recent.length, RECENT_CAP);
});

test("v1 ledgers migrate losslessly into aggregates", () => {
  const v1 = {
    records: [
      { at: NOW, modelId: "m", inputTokens: 1, outputTokens: 2, premiumUnits: 3 },
      { at: NOW, modelId: "m", inputTokens: 1, outputTokens: 2, premiumUnits: 3, label: "x" },
    ],
  };
  const l = migrateLedger(v1);
  assert.equal(l.version, 2);
  assert.equal(monthUnits(l, NOW), 6);
  assert.equal(monthRequests(l, NOW), 2);
});

test("migrate tolerates garbage", () => {
  assert.equal(migrateLedger(undefined).days.length, 0);
  assert.equal(migrateLedger("junk").days.length, 0);
  assert.equal(migrateLedger({ records: "nope" }).days.length, 0);
});

test("dailySeries returns exactly n days ending today", () => {
  const l = emptyLedger();
  recordInto(l, rec({}));
  recordInto(l, rec({ at: "2026-06-10T01:00:00Z", premiumUnits: 5 }));
  const series = dailySeries(l, NOW, 7);
  assert.equal(series.length, 7);
  assert.equal(series[6].day, "2026-06-11");
  assert.equal(series[6].premiumUnits, 1);
  assert.equal(series[5].premiumUnits, 5);
  assert.equal(series[0].premiumUnits, 0);
});
