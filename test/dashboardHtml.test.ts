import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  renderDashboardHtml,
  esc,
  DashboardData,
} from "../src/ui/dashboardHtml";

function data(over: Partial<DashboardData> = {}): DashboardData {
  return {
    configured: true,
    generatedAt: "2026-06-11T12:00:00.000Z",
    usedUnits: 190,
    allowance: 300,
    usedPct: 63.3,
    softPct: 80,
    hardPct: 100,
    mode: "block",
    todayRequests: 4,
    todayUnits: 3,
    monthRequests: 80,
    monthFailures: 2,
    daily: Array.from({ length: 30 }, (_, i) => ({
      day: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
      premiumUnits: i % 5,
      requests: i % 3,
    })),
    byModel: [
      { key: "gpt-test", requests: 60, premiumUnits: 100, inputTokens: 5000, outputTokens: 9000 },
    ],
    byLabel: [{ key: "chat", requests: 60, premiumUnits: 100 }],
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
    data({ byModel: [{ key: "<script>alert(1)</script>", requests: 1, premiumUnits: 1, inputTokens: 1, outputTokens: 1 }] }),
    "n",
  );
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renders 30 daily bars and budget markers", () => {
  const html = renderDashboardHtml(data(), "n");
  const bars = html.match(/class="bar/g) ?? [];
  assert.equal(bars.length, 30);
  assert.ok(html.includes("soft cap 80%"));
  assert.ok(html.includes("hard cap 100%"));
});

test("hard-cap state shows danger styling, ok state does not", () => {
  const danger = renderDashboardHtml(data({ usedPct: 120 }), "n");
  assert.ok(danger.includes("hard cap reached"));
  const ok = renderDashboardHtml(data({ usedPct: 10 }), "n");
  assert.ok(ok.includes("within budget"));
});

test("empty usage renders friendly empty states", () => {
  const html = renderDashboardHtml(data({ byModel: [], byLabel: [] }), "n");
  assert.ok(html.includes("No metered requests yet"));
});
