// Renders docs/ux/dashboard-sample.html from the real dashboard renderer with
// representative data, so the design can be reviewed in any browser without
// launching VS Code. Run via `npm run build:samples` (compiles first).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const { renderDashboardHtml } = require("../out-test/src/ui/dashboardHtml.js");

const daily = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 4, 13 + i)); // 2026-05-13 … 2026-06-11
  const wave = Math.max(0, Math.round(6 + 5 * Math.sin(i / 3) - (i % 7 === 5 ? 6 : 0)));
  return {
    day: d.toISOString().slice(0, 10),
    premiumUnits: i === 22 ? 0 : wave,
    requests: wave * 2,
  };
});

const html = renderDashboardHtml(
  {
    generatedAt: "2026-06-11T12:00:00.000Z",
    usedUnits: 189.5,
    allowance: 300,
    usedPct: 63.2,
    softPct: 80,
    hardPct: 100,
    mode: "block",
    todayRequests: 7,
    todayUnits: 4.5,
    monthRequests: 164,
    monthFailures: 3,
    daily,
    byModel: [
      { key: "gpt-4.1", requests: 96, premiumUnits: 0, inputTokens: 182_400, outputTokens: 96_100 },
      { key: "claude-sonnet-4.5", requests: 52, premiumUnits: 52, inputTokens: 96_800, outputTokens: 88_200 },
      { key: "o4-mini", requests: 12, premiumUnits: 3.96, inputTokens: 9_100, outputTokens: 14_800 },
      { key: "claude-opus-4.1", requests: 4, premiumUnits: 40, inputTokens: 18_900, outputTokens: 22_000 },
    ],
    byLabel: [
      { key: "chat", requests: 121, premiumUnits: 61.4 },
      { key: "askCopilot", requests: 31, premiumUnits: 24.6 },
      { key: "tool:site_overview", requests: 12, premiumUnits: 9.9 },
    ],
  },
  "SAMPLENONCE",
);

// The sample runs outside a webview: VS Code theme variables resolve to the
// CSS fallbacks already present in the renderer, so the page previews in the
// dark-theme palette by default.
const target = path.join(__dirname, "..", "docs", "ux", "dashboard-sample.html");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(
  target,
  html.replace(
    "<script nonce=\"SAMPLENONCE\">",
    "<script nonce=\"SAMPLENONCE\">\n  // Sample preview: stub the VS Code webview bridge.\n  function acquireVsCodeApi(){return{postMessage:()=>{}}}\n",
  ),
);
console.log(`wrote ${target}`);
