import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";

/**
 * Status-bar usage gauge (PLAN §4 / ADR-0003): shows premium-request usage as a
 * percentage of the configured monthly allowance, plus today's request count.
 * The percentage is the headline; we deliberately show no dollar figure.
 */
export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly meter: UsageMeter,
    private readonly now: () => string,
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "aiSharePoint.showUsage";
    this.refresh();
    this.item.show();
    meter.onDidChange(() => this.refresh());
  }

  private allowance(): number {
    const configured = vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<number>("copilot.monthlyPremiumRequestAllowance");
    return configured && configured > 0 ? configured : 300;
  }

  refresh(): void {
    const nowIso = this.now();
    const used = this.meter.premiumUnitsThisMonth(nowIso);
    const allowance = this.allowance();
    const pct = Math.min(100, Math.round((used / allowance) * 100));
    const today = this.meter.requestsToday(nowIso);
    this.item.text = `$(graph) ${pct}% · ~${today} today`;
    this.item.tooltip = `Copilot premium requests: ~${used.toFixed(
      1,
    )} of ${allowance} this month (estimate — ADR-0003).\n${today} request(s) today.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
