/**
 * Pure HTML renderer for the Copilot Activity dashboard webview.
 *
 * Shows factual, locally measured request counts only — no premium-unit
 * estimates and no allowance gauge (GitHub billing is the authoritative
 * source for those; estimates misled users).
 *
 * Security posture (see SECURITY.md): strict CSP (`default-src 'none'`), all
 * inline style/script gated by a per-render nonce, zero external resources,
 * every dynamic value HTML-escaped, charts are server-built inline SVG (no JS
 * charting library). Pure module → unit-testable and used to generate the
 * design-review sample in docs/ux/.
 */

export interface DashboardData {
  generatedAt: string;
  todayRequests: number;
  monthRequests: number;
  monthFailures: number;
  daily: Array<{ day: string; requests: number; failures: number; cost?: number }>;
  byModel: Array<{
    key: string;
    requests: number;
    /** Failed/cancelled requests for this model (drives the "failed" filter). */
    failures?: number;
    inputTokens: number;
    outputTokens: number;
    /** Formatted estimated cost (e.g. "$1.20") — present only when the user has
     *  configured a token rate. */
    cost?: string;
  }>;
  byLabel: Array<{ key: string; requests: number; failures?: number }>;
  /** Formatted estimated token cost this month, present only when a token rate is set. */
  monthCost?: string;
  /** Formatted estimated premium-request cost this month (default $0.04/request). */
  premiumCost?: string;
  /** Formatted per-premium-request rate in force (from the configured setting),
   *  shown in the card label so it reflects an enterprise-specific price. */
  premiumRate?: string;
  /** Active view: "all" (default) or "failed" — clicking the failed/cancelled
   *  card filters the chart + tables to failures only. */
  filter?: "all" | "failed";
  /** Per-model reported (advertised) vs. tested (measured) context limits.
   *  `usable` is the margin-adjusted per-turn input budget a chat is actually
   *  held to (resolved ceiling minus the safety margin — see `effectiveInputCap`). */
  modelLimits?: Array<{ key: string; reported?: number; tested?: number; usable?: number; drifted: boolean }>;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function barChart(daily: DashboardData["daily"], failedView: boolean): string {
  const W = 660;
  const H = 170;
  const padL = 30;
  const padB = 24;
  const plotW = W - padL - 8;
  const plotH = H - padB - 14;
  const valueOf = (d: { requests: number; failures: number }) => (failedView ? d.failures : d.requests);
  const noun = failedView ? "failure(s)" : "request(s)";
  const max = Math.max(1, ...daily.map(valueOf));
  const n = Math.max(1, daily.length);
  const step = plotW / n;
  const barW = Math.max(4, step - 6);

  // Overlay an estimated-cost line (premium-request $/day) when cost is present
  // and we're not in the failures view (failed requests have no per-failure cost
  // split). Scaled to its own max so it reads against the request bars.
  const showCostLine = !failedView && daily.some((d) => (d.cost ?? 0) > 0);
  const maxCost = Math.max(1e-9, ...daily.map((d) => d.cost ?? 0));
  const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0");

  const bars = daily
    .map((d, i) => {
      const v = valueOf(d);
      const h = Math.max(v > 0 ? 3 : 1, (v / max) * plotH);
      const x = padL + i * step + (step - barW) / 2;
      const y = H - padB - h;
      const cls = v > 0 ? (failedView ? "bar fail" : "bar") : "bar empty";
      const costTip = showCostLine ? ` · ~${money(d.cost ?? 0)} est.` : "";
      return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${esc(d.day)}: ${v} ${noun}${costTip}</title></rect>`;
    })
    .join("");

  const costLine = showCostLine
    ? (() => {
        const pts = daily
          .map((d, i) => {
            const cx = padL + i * step + step / 2;
            const cy = H - padB - ((d.cost ?? 0) / maxCost) * plotH;
            return `${cx.toFixed(1)},${cy.toFixed(1)}`;
          })
          .join(" ");
        return `<polyline class="costline" points="${pts}" fill="none"></polyline><text class="axis costlabel" x="${W - 8}" y="16" text-anchor="end">max/day ~${money(maxCost)}</text>`;
      })()
    : "";

  const labels = daily
    .map((d, i) =>
      i % 7 === 0
        ? `<text class="axis" x="${(padL + i * step + step / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.day.slice(5))}</text>`
        : "",
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily ${failedView ? "failures" : "requests"}, last ${n} days">
  <text class="axis" x="${padL - 6}" y="16" text-anchor="end">${max}</text>
  <line class="grid" x1="${padL}" y1="10" x2="${W - 8}" y2="10"></line>
  <line class="grid" x1="${padL}" y1="${H - padB}" x2="${W - 8}" y2="${H - padB}"></line>
  ${bars}
  ${costLine}
  ${labels}
</svg>`;
}

function tableRows(
  rows: Array<Record<string, string | number>>,
  cols: string[],
): string {
  return rows
    .map(
      (r) =>
        `<tr>${cols
          .map((c, i) => `<td${i === 0 ? "" : ' class="num"'}>${esc(String(r[c] ?? ""))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
}

export function renderDashboardHtml(
  data: DashboardData,
  nonce: string,
): string {
  const failedView = data.filter === "failed";
  const showCost = data.monthCost !== undefined && !failedView; // failed rows have no per-failure token split
  const modelCols = failedView
    ? ["Model", "Failed"]
    : showCost
      ? ["Model", "Requests", "Tokens in / out", "Est. cost"]
      : ["Model", "Requests", "Tokens in / out"];
  const modelRows = failedView
    ? tableRows(
        data.byModel
          .filter((m) => (m.failures ?? 0) > 0)
          .map((m) => ({ Model: m.key, Failed: m.failures ?? 0 })),
        modelCols,
      )
    : tableRows(
        data.byModel.map((m) => ({
          Model: m.key,
          Requests: m.requests,
          "Tokens in / out": `${m.inputTokens.toLocaleString()} / ${m.outputTokens.toLocaleString()}`,
          ...(showCost ? { "Est. cost": m.cost ?? "" } : {}),
        })),
        modelCols,
      );
  const labelCols = failedView ? ["Task", "Failed"] : ["Task", "Requests"];
  const labelRows = failedView
    ? tableRows(
        data.byLabel.filter((l) => (l.failures ?? 0) > 0).map((l) => ({ Task: l.key, Failed: l.failures ?? 0 })),
        labelCols,
      )
    : tableRows(
        data.byLabel.map((l) => ({ Task: l.key, Requests: l.requests })),
        labelCols,
      );
  const hasFailModelRows = data.byModel.some((m) => (m.failures ?? 0) > 0);
  const hasFailLabelRows = data.byLabel.some((l) => (l.failures ?? 0) > 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI SharePoint — Copilot Activity</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    margin: 0; padding: 20px 24px 28px;
    font-size: 13px; line-height: 1.5;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 1.35em; font-weight: 600; margin: 0; }
  h2 { font-size: 1em; font-weight: 600; margin: 22px 0 8px; }
  .muted { color: var(--vscode-descriptionForeground, #999); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
  .card {
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #444));
    border-radius: 6px; padding: 12px 14px;
  }
  .card .k { font-size: 1.5em; font-weight: 600; display: block; }
  .card .s { color: var(--vscode-descriptionForeground, #999); font-size: 0.9em; }
  .card[role="button"] { cursor: pointer; }
  .card[role="button"]:hover { border-color: var(--vscode-focusBorder, #007fd4); }
  .card[role="button"]:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .card.active { border-color: var(--vscode-focusBorder, #007fd4); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, #007fd4); }
  .card.fail .k { color: var(--vscode-charts-red, #f14c4c); }
  .filterbar { margin: 10px 0 2px; padding: 6px 10px; border-radius: 6px; background: var(--vscode-inputValidation-warningBackground, #352a05); border: 1px solid var(--vscode-inputValidation-warningBorder, #6b5310); font-size: 0.92em; }
  .linkish { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; text-decoration: underline; font: inherit; }
  .linkish:hover { color: var(--vscode-textLink-activeForeground, #4daafc); background: none; }
  svg { width: 100%; height: auto; display: block; }
  svg .bar { fill: var(--vscode-charts-blue, #3794ff); }
  svg .bar.fail { fill: var(--vscode-charts-red, #f14c4c); }
  svg .bar.empty { fill: var(--vscode-progressBar-background, #3a3d41); }
  svg .axis { fill: var(--vscode-descriptionForeground, #999); font-size: 10px; }
  svg .grid { stroke: var(--vscode-widget-border, #444); stroke-dasharray: 2 3; }
  svg .costline { stroke: var(--vscode-charts-yellow, #e2c08d); stroke-width: 1.5; }
  svg .costlabel { fill: var(--vscode-charts-yellow, #e2c08d); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  th { color: var(--vscode-descriptionForeground, #999); font-weight: 600; font-size: 0.9em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td:not(:first-child), th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
  .actions { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  button {
    font-family: inherit; font-size: 13px; padding: 5px 14px; border-radius: 3px; cursor: pointer;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground, #ccc);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  footer { margin-top: 22px; font-size: 0.9em; color: var(--vscode-descriptionForeground, #999); border-top: 1px solid var(--vscode-widget-border, #333); padding-top: 10px; }
  .empty { padding: 14px; text-align: center; color: var(--vscode-descriptionForeground, #999); border: 1px dashed var(--vscode-widget-border, #444); border-radius: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Copilot Activity</h1>
    <span class="muted">local request counts — billing lives in GitHub</span>
  </header>

  <div class="cards">
    <div class="card${failedView ? " active" : ""}" data-filter="all" role="button" tabindex="0" title="Show all activity"><span class="k">${data.monthRequests}</span><span class="s">requests this month${failedView ? " — click to show all" : ""}</span></div>
    <div class="card" data-filter="all"><span class="k">${data.todayRequests}</span><span class="s">requests today</span></div>
    ${data.monthFailures > 0 ? `<div class="card fail${failedView ? " active" : ""}" data-filter="failed" role="button" tabindex="0" title="Filter to failed / cancelled"><span class="k">${data.monthFailures}</span><span class="s">failed / cancelled — click to ${failedView ? "keep" : "filter"} (still billed by GitHub)</span></div>` : ""}
    ${data.premiumCost !== undefined ? `<div class="card"><span class="k">${esc(data.premiumCost)}</span><span class="s">est. cost this month (premium requests @ ${esc(data.premiumRate ?? "$0.04")}/req)</span></div>` : ""}
    ${data.monthCost !== undefined ? `<div class="card"><span class="k">${esc(data.monthCost)}</span><span class="s">est. token cost this month (your rate)</span></div>` : ""}
  </div>

  ${failedView ? `<div class="filterbar">Showing <strong>failed / cancelled</strong> only · <button id="btn-clear-filter" class="linkish">show all activity</button></div>` : ""}

  <h2>Last 30 days — ${failedView ? "failures" : "requests"} per day</h2>
  ${barChart(data.daily, failedView)}

  <h2>By model (this month)</h2>
  ${
    (failedView ? hasFailModelRows : data.byModel.length > 0)
      ? `<table><thead><tr>${modelCols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${modelRows}</tbody></table>`
      : `<div class="empty">${failedView ? "No failed or cancelled requests this month. 🎉" : "No requests yet — try “@sharepoint” in chat or “AI SharePoint: Ask Copilot”."}</div>`
  }

  <h2>By task (this month)</h2>
  ${
    (failedView ? hasFailLabelRows : data.byLabel.length > 0)
      ? `<table><thead><tr>${labelCols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${labelRows}</tbody></table>`
      : `<div class="empty">${failedView ? "No failed or cancelled task activity this month." : "No task activity recorded yet."}</div>`
  }

  ${
    data.modelLimits && data.modelLimits.length > 0
      ? `<h2>Model context limits</h2>
  <p class="muted">Reported = the model's advertised input limit. Tested = the largest input actually proven to work (or the learned ceiling). Usable = the per-turn input the chat is actually held to (ceiling minus safety margin). Run “Probe Model Context Limit” to measure.</p>
  <table><thead><tr><th>Model</th><th>Reported</th><th>Tested</th><th>Usable</th></tr></thead><tbody>${tableRows(
    data.modelLimits.map((m) => ({
      Model: `${m.key}${m.drifted ? " ⚠" : ""}`,
      Reported: m.reported?.toLocaleString() ?? "?",
      Tested: m.tested?.toLocaleString() ?? "not tested",
      Usable: m.usable?.toLocaleString() ?? "?",
    })),
    ["Model", "Reported", "Tested", "Usable"],
  )}</tbody></table>`
      : ""
  }

  <div class="actions">
    <button id="btn-export">Export diagnostics bundle…</button>
    <button id="btn-reset" class="secondary">Reset counters…</button>
  </div>

  <footer>
    Counts are this extension's own requests, measured locally — factual, but they say nothing
    about premium-request consumption against your plan. Your GitHub billing/plan page is the
    only authoritative source for that.${
      data.premiumCost !== undefined
        ? " Estimated cost = your requests × each model's published premium-request multiplier × the $0.04/request overage rate; your plan's allowance may make the real charge lower."
        : ""
    }${
      data.monthCost !== undefined
        ? " Token cost multiplies your configured per-token rate by the locally-measured tokens — an estimate from a rate you set."
        : ""
    } Generated ${esc(data.generatedAt)}.
  </footer>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const wire = (id, command) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => vscode.postMessage({ command }));
  };
  wire("btn-export", "export");
  wire("btn-reset", "reset");
  wire("btn-clear-filter", "filter-all");
  // Clickable summary cards filter the chart + tables (failed / all).
  const applyFilter = (value) => vscode.postMessage({ command: "filter", value });
  document.querySelectorAll(".card[data-filter]").forEach((el) => {
    const value = el.getAttribute("data-filter");
    el.addEventListener("click", () => applyFilter(value));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); applyFilter(value); }
    });
  });
</script>
</body>
</html>`;
}
