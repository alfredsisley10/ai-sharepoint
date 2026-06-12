import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { UsageMeter } from "../copilot/meter";
import { renderDashboardHtml, DashboardData } from "./dashboardHtml";

/**
 * Copilot Activity dashboard webview panel. Singleton; re-renders live while
 * visible (meter events). Webview options are locked down: no scripts beyond
 * the nonce'd button wiring, no local resource roots, no external content.
 */
export class UsageDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly meter: UsageMeter,
    private readonly now: () => string,
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
      this.panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
        switch (msg?.command) {
          case "export":
            void vscode.commands.executeCommand("aiSharePoint.exportDiagnostics");
            break;
          case "reset":
            void vscode.commands.executeCommand("aiSharePoint.resetUsage");
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
    return {
      generatedAt: nowIso,
      todayRequests: this.meter.requestsToday(nowIso),
      monthRequests: this.meter.requestsThisMonth(nowIso),
      monthFailures: this.meter.failuresThisMonth(nowIso),
      daily: this.meter.dailySeries(nowIso, 30),
      byModel: this.meter.byModelThisMonth(nowIso).map((m) => ({
        key: m.key,
        requests: m.requests,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
      })),
      byLabel: this.meter.byLabelThisMonth(nowIso).map((l) => ({
        key: l.key,
        requests: l.requests,
      })),
    };
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
