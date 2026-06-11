import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";
import { BudgetGuard } from "../copilot/budget";

/**
 * Status-bar usage gauge (PLAN §4 / ADR-0003): premium-request usage as a
 * percentage of the configured monthly allowance, with budget-state coloring
 * (warning background past the soft cap, error background past the hard cap).
 * The percentage is the headline; we deliberately show no dollar figure.
 */
export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly configListener: vscode.Disposable;

  constructor(
    private readonly meter: UsageMeter,
    private readonly budget: BudgetGuard,
    private readonly now: () => string,
  ) {
    this.item = vscode.window.createStatusBarItem(
      "aiSharePoint.usage",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = "AI SharePoint: Copilot usage";
    this.item.command = "aiSharePoint.showUsage";
    this.refresh();
    this.item.show();
    meter.onDidChange(() => this.refresh());
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiSharePoint")) {
        this.refresh();
      }
    });
  }

  refresh(): void {
    const nowIso = this.now();
    const verdict = this.budget.evaluate(0, nowIso);
    const used = this.meter.premiumUnitsThisMonth(nowIso);
    const today = this.meter.requestsToday(nowIso);
    const pct = Math.min(999, Math.round(verdict.usedPct));

    this.item.text = `$(graph-line) ${pct}% · ${today} today`;
    this.item.backgroundColor =
      verdict.usedPct >= verdict.hardPct && verdict.mode !== "off"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : verdict.usedPct >= verdict.softPct && verdict.mode !== "off"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;

    const tooltip = new vscode.MarkdownString(
      [
        `**AI SharePoint — Copilot usage** _(local estimate, not the GitHub bill)_`,
        "",
        `| | |`,
        `|---|---|`,
        `| This month | ~${used.toFixed(1)} of ${verdict.allowance} premium units (${pct}%) |`,
        `| Today | ${today} request(s) |`,
        `| Budget | soft ${verdict.softPct}% / hard ${verdict.hardPct}% (${verdict.mode}) |`,
        "",
        `$(dashboard) Click for the usage dashboard`,
      ].join("\n"),
    );
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
    this.configListener.dispose();
  }
}
