import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  renderDashboardHtml,
  esc,
  DashboardData,
} from "../src/ui/dashboardHtml";

function data(over: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: "2026-06-11T12:00:00.000Z",
    todayRequests: 4,
    monthRequests: 80,
    monthFailures: 2,
    daily: Array.from({ length: 30 }, (_, i) => ({
      day: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
      requests: i % 3,
      failures: i % 7 === 0 ? 1 : 0,
    })),
    byModel: [
      { key: "gpt-test", requests: 60, inputTokens: 5000, outputTokens: 9000 },
    ],
    byLabel: [{ key: "chat", requests: 60 }],
    ...over,
  };
}

test("esc neutralizes html metacharacters", () => {
  assert.equal(esc(`<img src=x onerror="a&'b">`), "&lt;img src=x onerror=&quot;a&amp;&#39;b&quot;&gt;");
});

test("renders a strict CSP with the provided nonce only", () => {
  const html = renderDashboardHtml(data(), "NONCE123");
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("style-src 'nonce-NONCE123'"));
  assert.ok(html.includes("script-src 'nonce-NONCE123'"));
  assert.ok(!/src\s*=\s*["']https?:/i.test(html), "no external resources");
});

test("escapes injected model/task names", () => {
  const html = renderDashboardHtml(
    data({ byModel: [{ key: "<script>alert(1)</script>", requests: 1, inputTokens: 1, outputTokens: 1 }] }),
    "n",
  );
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renders 30 daily request bars and factual counts only", () => {
  const html = renderDashboardHtml(data(), "n");
  const bars = html.match(/class="bar/g) ?? [];
  assert.equal(bars.length, 30);
  // No allowance/budget/premium-unit language anywhere — the gauge is gone.
  assert.ok(!/allowance|premium unit|budget|soft cap|hard cap/i.test(html));
  assert.ok(html.includes("requests this month"));
  assert.ok(html.includes("billing lives in GitHub"));
});

test("failed requests surface as a card only when present", () => {
  const withFailures = renderDashboardHtml(data({ monthFailures: 3 }), "n");
  assert.ok(withFailures.includes("failed / cancelled"));
  const clean = renderDashboardHtml(data({ monthFailures: 0 }), "n");
  assert.ok(!clean.includes("failed / cancelled"));
});

test("empty activity renders friendly empty states", () => {
  const html = renderDashboardHtml(data({ byModel: [], byLabel: [] }), "n");
  assert.ok(html.includes("No requests yet"));
});

test("failed filter switches the chart + tables to failures and offers a way back", () => {
  const all = renderDashboardHtml(data(), "n");
  assert.ok(!all.includes("Showing"), "no filter banner in the default view");
  assert.ok(all.includes('data-filter="failed"'), "failed card is clickable");

  const failed = renderDashboardHtml(
    data({
      filter: "failed",
      byModel: [
        { key: "gpt-a", requests: 60, failures: 3, inputTokens: 5000, outputTokens: 9000 },
        { key: "gpt-b", requests: 40, failures: 0, inputTokens: 1000, outputTokens: 1000 },
      ],
      byLabel: [
        { key: "chat", requests: 60, failures: 2 },
        { key: "tool:x", requests: 20, failures: 0 },
      ],
    }),
    "n",
  );
  assert.ok(failed.includes("Showing"), "shows the failed-only banner");
  assert.ok(failed.includes("failures per day"), "chart heading reflects failures");
  assert.ok(failed.includes("<th>Failed</th>"), "tables switch to a Failed column");
  assert.ok(failed.includes("btn-clear-filter"), "offers a show-all control");
  // Only rows with failures survive the filter.
  assert.ok(failed.includes("gpt-a"));
  assert.ok(!failed.includes("gpt-b"), "zero-failure model row is dropped");
  assert.ok(!failed.includes("tool:x"), "zero-failure task row is dropped");
});

test("cost is hidden by default and shown only when a rate produces monthCost", () => {
  const noCost = renderDashboardHtml(data(), "n");
  assert.ok(!noCost.includes("est. cost this month"));
  assert.ok(!noCost.includes("Est. cost"));

  const withCost = renderDashboardHtml(
    data({
      monthCost: "$3.00",
      byModel: [{ key: "gpt-test", requests: 60, inputTokens: 5000, outputTokens: 9000, cost: "$1.20" }],
    }),
    "n",
  );
  assert.ok(withCost.includes("$3.00"));
  assert.ok(withCost.includes("est. cost this month"));
  assert.ok(withCost.includes("<th>Est. cost</th>"));
  assert.ok(withCost.includes("$1.20"));
  // Framed as the user's own estimate, never as a GitHub bill.
  assert.ok(/estimate from a rate you set|rate you set/i.test(withCost));
});
