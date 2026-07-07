import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { UsageMeter } from "../copilot/meter";
import { renderDashboardHtml, DashboardData } from "./dashboardHtml";
import { costEnabled, estimateCost, formatCost } from "../copilot/tokenCost";
import { readTokenRates } from "../copilot/tokenRates";
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
  /** Active view filter — toggled by clicking the summary cards. */
  private filter: "all" | "failed" = "all";

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
      while (this.disposables.length) {
        this.disposables.pop()?.dispose();
      }
    });
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: { command?: string; value?: string }) => {
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
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.render();
        }
      }),
    );
    this.render();
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
    return {
      generatedAt: nowIso,
      todayRequests: this.meter.requestsToday(nowIso),
      monthRequests: this.meter.requestsThisMonth(nowIso),
      monthFailures: this.meter.failuresThisMonth(nowIso),
      daily: this.meter.dailySeries(nowIso, 30),
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
      filter: this.filter,
      modelLimits: (this.modelLimits?.list() ?? [])
        .map(describeModelLimit)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((r) => ({
          key: r.key,
          reported: r.advertised,
          tested: r.measured ? r.knownGood ?? r.effectiveCap : undefined,
          cap: r.cap,
          drifted: r.drifted,
        })),
    };
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
