import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";

/**
 * Status-bar activity counter: today's request count from this extension —
 * a factual local measure. No allowance percentage and no budget coloring:
 * premium-request consumption can only be read authoritatively from GitHub
 * billing, so the extension does not estimate it.
 */
export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly meter: UsageMeter,
    private readonly now: () => string,
  ) {
    this.item = vscode.window.createStatusBarItem(
      "aiSharePoint.usage",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = "AI SharePoint: Copilot activity";
    this.item.command = "aiSharePoint.showUsage";
    this.refresh();
    this.item.show();
    meter.onDidChange(() => this.refresh());
  }

  refresh(): void {
    const nowIso = this.now();
    const today = this.meter.requestsToday(nowIso);
    const month = this.meter.requestsThisMonth(nowIso);
    this.item.text = `$(graph-line) ${today} today`;
    const tooltip = new vscode.MarkdownString(
      [
        "**AI SharePoint — Copilot activity** _(local request counts)_",
        "",
        `| | |`,
        `|---|---|`,
        `| Today | ${today} request(s) |`,
        `| This month | ${month} request(s) |`,
        "",
        "_Premium-request consumption against your plan is not tracked — your GitHub billing/plan page is the authoritative source._",
        "",
        `$(dashboard) Click for the activity dashboard`,
      ].join("\n"),
    );
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
