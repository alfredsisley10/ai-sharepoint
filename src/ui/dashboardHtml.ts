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
  daily: Array<{ day: string; requests: number; failures: number }>;
  byModel: Array<{
    key: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byLabel: Array<{ key: string; requests: number }>;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function barChart(daily: DashboardData["daily"]): string {
  const W = 660;
  const H = 170;
  const padL = 30;
  const padB = 24;
  const plotW = W - padL - 8;
  const plotH = H - padB - 14;
  const max = Math.max(1, ...daily.map((d) => d.requests));
  const n = Math.max(1, daily.length);
  const step = plotW / n;
  const barW = Math.max(4, step - 6);

  const bars = daily
    .map((d, i) => {
      const h = Math.max(d.requests > 0 ? 3 : 1, (d.requests / max) * plotH);
      const x = padL + i * step + (step - barW) / 2;
      const y = H - padB - h;
      const cls = d.requests > 0 ? "bar" : "bar empty";
      return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${esc(d.day)}: ${d.requests} request(s)${d.failures > 0 ? ` · ${d.failures} failed` : ""}</title></rect>`;
    })
    .join("");

  const labels = daily
    .map((d, i) =>
      i % 7 === 0
        ? `<text class="axis" x="${(padL + i * step + step / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.day.slice(5))}</text>`
        : "",
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily requests, last ${n} days">
  <text class="axis" x="${padL - 6}" y="16" text-anchor="end">${max}</text>
  <line class="grid" x1="${padL}" y1="10" x2="${W - 8}" y2="10"></line>
  <line class="grid" x1="${padL}" y1="${H - padB}" x2="${W - 8}" y2="${H - padB}"></line>
  ${bars}
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
  const modelRows = tableRows(
    data.byModel.map((m) => ({
      Model: m.key,
      Requests: m.requests,
      "Tokens in / out": `${m.inputTokens.toLocaleString()} / ${m.outputTokens.toLocaleString()}`,
    })),
    ["Model", "Requests", "Tokens in / out"],
  );
  const labelRows = tableRows(
    data.byLabel.map((l) => ({
      Task: l.key,
      Requests: l.requests,
    })),
    ["Task", "Requests"],
  );

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
  svg { width: 100%; height: auto; display: block; }
  svg .bar { fill: var(--vscode-charts-blue, #3794ff); }
  svg .bar.empty { fill: var(--vscode-progressBar-background, #3a3d41); }
  svg .axis { fill: var(--vscode-descriptionForeground, #999); font-size: 10px; }
  svg .grid { stroke: var(--vscode-widget-border, #444); stroke-dasharray: 2 3; }
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
    <div class="card"><span class="k">${data.todayRequests}</span><span class="s">requests today</span></div>
    <div class="card"><span class="k">${data.monthRequests}</span><span class="s">requests this month</span></div>
    ${data.monthFailures > 0 ? `<div class="card"><span class="k">${data.monthFailures}</span><span class="s">failed / cancelled (still billed by GitHub)</span></div>` : ""}
  </div>

  <h2>Last 30 days — requests per day</h2>
  ${barChart(data.daily)}

  <h2>By model (this month)</h2>
  ${
    data.byModel.length > 0
      ? `<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens in / out</th></tr></thead><tbody>${modelRows}</tbody></table>`
      : `<div class="empty">No requests yet — try “@sharepoint” in chat or “AI SharePoint: Ask Copilot”.</div>`
  }

  <h2>By task (this month)</h2>
  ${
    data.byLabel.length > 0
      ? `<table><thead><tr><th>Task</th><th>Requests</th></tr></thead><tbody>${labelRows}</tbody></table>`
      : `<div class="empty">No task activity recorded yet.</div>`
  }

  <div class="actions">
    <button id="btn-export">Export diagnostics bundle…</button>
    <button id="btn-reset" class="secondary">Reset counters…</button>
  </div>

  <footer>
    Counts are this extension's own requests, measured locally — factual, but they say nothing
    about premium-request consumption against your plan. Your GitHub billing/plan page is the
    only authoritative source for that. Generated ${esc(data.generatedAt)}.
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
</script>
</body>
</html>`;
}
