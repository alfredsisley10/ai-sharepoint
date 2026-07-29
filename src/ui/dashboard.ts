import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { UsageMeter } from "../copilot/meter";
import { renderDashboardHtml, DashboardData } from "./dashboardHtml";
import { costEnabled, estimateCost, formatCost } from "../copilot/tokenCost";
import { readTokenRates } from "../copilot/tokenRates";
import { premiumCostEnabled, estimatePremiumCost } from "../copilot/premiumCost";
import { readPremiumPricing } from "../copilot/premiumPricing";
import { ModelCostTable } from "../copilot/modelCosts";
import { ModelLimitsStore } from "../diagnostics/modelLimitsStore";
import { describeModelLimit } from "../core/contextBudget";

/**
 * Copilot Activity dashboard webview panel. Singleton; re-renders live while
 * visible (meter events). Webview options are locked down: no scripts beyond
 * the nonce'd button wiring, no local resource roots, no external content.
 */
export class UsageDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly costs = new ModelCostTable();
  /** Active view filter — toggled by clicking the summary cards. */
  private filter: "all" | "failed" = "all";
  /** Set when the webview reports it booted (see the handshake in show()). */
  private ready = false;

  constructor(
    private readonly meter: UsageMeter,
    private readonly now: () => string,
    private readonly modelLimits?: ModelLimitsStore,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "aiSharePoint.usageDashboard",
      "Copilot Activity — AI SharePoint",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [], // dashboard is fully self-contained
        retainContextWhenHidden: false,
      },
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      while (this.disposables.length) {
        this.disposables.pop()?.dispose();
      }
    });
    // If the webview never reports `ready`, its service worker failed to
    // register (a known VS Code/Electron fault) and the panel is blank. Offer
    // the two things that actually help: reload the window, or read the same
    // numbers as text.
    const readyTimer = setTimeout(() => {
      if (this.ready) return;
      const RELOAD = "Reload Window";
      const TEXT = "Show as text";
      void vscode.window
        .showWarningMessage(
          "The Copilot Activity panel didn't finish loading. This is a VS Code webview fault (the service worker failed to register), not a problem with your data.",
          RELOAD,
          TEXT,
        )
        .then((pick) => {
          if (pick === RELOAD) void vscode.commands.executeCommand("workbench.action.reloadWindow");
          else if (pick === TEXT) void this.showAsText();
        });
    }, 5_000);
    this.disposables.push({ dispose: () => clearTimeout(readyTimer) });
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: { command?: string; value?: string }) => {
        if (msg?.command === "ready") {
          this.ready = true;
          clearTimeout(readyTimer);
          return;
        }
        switch (msg?.command) {
          case "export":
            void vscode.commands.executeCommand("aiSharePoint.exportDiagnostics");
            break;
          case "reset":
            void vscode.commands.executeCommand("aiSharePoint.resetUsage");
            break;
          case "filter":
            this.filter = msg.value === "failed" ? "failed" : "all";
            this.render();
            break;
          case "filter-all":
            this.filter = "all";
            this.render();
            break;
        }
      }),
      this.meter.onDidChange(() => {
        if (this.panel?.visible) {
          this.render();
        }
      }),
      // Cost rows derive from settings (premium price / token rates), so
      // re-render when those change — otherwise the dashboard keeps showing the
      // old price until the next request.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("aiSharePoint.usage") && this.panel?.visible) {
          this.render();
        }
      }),
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.render();
        }
      }),
    );
    this.render();
  }

  /**
   * Markdown fallback for when the webview can't boot. Renders the same figures
   * the panel would have shown — a broken webview should not mean losing access
   * to your Copilot usage.
   */
  async showAsText(): Promise<void> {
    const d = this.collect();
    const lines = [
      "# Copilot Activity",
      "",
      `_Generated ${d.generatedAt}. Shown as text because the webview panel could not load._`,
      "",
      `- Requests today: **${d.todayRequests}**`,
      `- Requests this month: **${d.monthRequests}**`,
      `- Failed/cancelled this month: **${d.monthFailures}**`,
      "",
      "## By model (this month)",
      "",
      "| Model | Requests | Failed | Input tokens | Output tokens | Est. cost |",
      "|---|---:|---:|---:|---:|---:|",
      ...d.byModel.map(
        (m) =>
          `| ${m.key} | ${m.requests} | ${m.failures ?? 0} | ${m.inputTokens} | ${m.outputTokens} | ${m.cost ?? "—"} |`,
      ),
      "",
      "## Daily (last 30 days)",
      "",
      "| Day | Requests | Failed |",
      "|---|---:|---:|",
      ...d.daily.map((x) => `| ${x.day} | ${x.requests} | ${x.failures} |`),
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private render(): void {
    if (!this.panel) return;
    const nonce = crypto.randomUUID().replace(/-/g, "");
    this.panel.webview.html = renderDashboardHtml(this.collect(), nonce);
  }

  private collect(): DashboardData {
    const nowIso = this.now();
    const rates = readTokenRates();
    const showCost = costEnabled(rates);
    const byModel = this.meter.byModelThisMonth(nowIso);
    let monthTotal = 0;
    for (const m of byModel) monthTotal += estimateCost(m.inputTokens, m.outputTokens, rates);
    const premium = readPremiumPricing();
    const premiumCost = premiumCostEnabled(premium)
      ? formatCost(estimatePremiumCost(byModel, (k) => this.costs.multiplierFor(k), premium), premium.currency)
      : undefined;
    return {
      generatedAt: nowIso,
      todayRequests: this.meter.requestsToday(nowIso),
      monthRequests: this.meter.requestsThisMonth(nowIso),
      monthFailures: this.meter.failuresThisMonth(nowIso),
      daily: this.meter.dailySeries(nowIso, 30).map((d) => ({
        day: d.day,
        requests: d.requests,
        failures: d.failures,
        // Exact daily premium-request cost from the per-model breakdown.
        ...(premiumCostEnabled(premium)
          ? {
              cost: Object.entries(d.byModel).reduce(
                (sum, [k, s]) => sum + s.requests * this.costs.multiplierFor(k) * premium.pricePerRequest,
                0,
              ),
            }
          : {}),
      })),
      byModel: byModel.map((m) => ({
        key: m.key,
        requests: m.requests,
        failures: m.failures,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        ...(showCost ? { cost: formatCost(estimateCost(m.inputTokens, m.outputTokens, rates), rates.currency) } : {}),
      })),
      byLabel: this.meter.byLabelThisMonth(nowIso).map((l) => ({
        key: l.key,
        requests: l.requests,
        failures: l.failures,
      })),
      ...(showCost ? { monthCost: formatCost(monthTotal, rates.currency) } : {}),
      ...(premiumCost !== undefined
        ? { premiumCost, premiumRate: formatCost(premium.pricePerRequest, premium.currency) }
        : {}),
      filter: this.filter,
      modelLimits: (this.modelLimits?.list() ?? [])
        .map(describeModelLimit)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((r) => ({
          key: r.key,
          reported: r.advertised,
          tested: r.measured ? r.knownGood ?? r.effectiveCap : undefined,
          // Margin-adjusted per-turn budget — quoted inside the headroom
          // caption under the limits table (not shown as its own column).
          usable: r.usable,
          drifted: r.drifted,
        })),
    };
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
