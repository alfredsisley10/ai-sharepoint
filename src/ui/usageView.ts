import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";
import { BudgetGuard } from "../copilot/budget";

interface UsageNode {
  id: string;
  label: string;
  description?: string;
  icon?: vscode.ThemeIcon;
  tooltip?: string;
  children?: UsageNode[];
  command?: vscode.Command;
}

/**
 * Usage & Budget tree view (PLAN §4 "Cost view"): headline gauge, today's
 * activity, budget configuration state, and per-model / per-task breakdowns.
 * Everything is labeled as an estimate (ADR-0003).
 */
export class UsageTreeProvider implements vscode.TreeDataProvider<UsageNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly meter: UsageMeter,
    private readonly budget: BudgetGuard,
    private readonly now: () => string,
  ) {
    meter.onDidChange(() => this.emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiSharePoint")) {
        this.emitter.fire();
      }
    });
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children && node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.iconPath = node.icon;
    item.tooltip = node.tooltip;
    item.command = node.command;
    return item;
  }

  getChildren(node?: UsageNode): UsageNode[] {
    if (node) {
      return node.children ?? [];
    }
    const nowIso = this.now();
    const verdict = this.budget.evaluate(0, nowIso);
    const used = this.meter.premiumUnitsThisMonth(nowIso);
    const pct = Math.round(verdict.usedPct);
    const stateIcon =
      verdict.usedPct >= verdict.hardPct
        ? new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"))
        : verdict.usedPct >= verdict.softPct
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"))
          : new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));

    const byModel = this.meter.byModelThisMonth(nowIso);
    const byLabel = this.meter.byLabelThisMonth(nowIso);

    return [
      {
        id: "gauge",
        label: `${pct}% of monthly allowance used`,
        description: `~${used.toFixed(1)} / ${verdict.allowance} units`,
        icon: stateIcon,
        tooltip:
          "Estimate from this extension's local meter and the model multiplier table (ADR-0003) — not the live GitHub bill. Click for the dashboard.",
        command: {
          command: "aiSharePoint.showUsage",
          title: "Open usage dashboard",
        },
      },
      {
        id: "today",
        label: `Today: ${this.meter.requestsToday(nowIso)} request(s)`,
        description: `~${this.meter.premiumUnitsToday(nowIso).toFixed(1)} units`,
        icon: new vscode.ThemeIcon("calendar"),
      },
      {
        id: "budget",
        label: `Budget: soft ${verdict.softPct}% · hard ${verdict.hardPct}%`,
        description: verdict.mode,
        icon: new vscode.ThemeIcon("shield"),
        tooltip:
          "Soft cap warns; hard cap blocks (with explicit override). Configure via “AI SharePoint: Set Copilot Budget”.",
        command: {
          command: "aiSharePoint.setBudget",
          title: "Set Copilot Budget",
        },
      },
      {
        id: "byModel",
        label: "By model (this month)",
        icon: new vscode.ThemeIcon("circuit-board"),
        description: byModel.length === 0 ? "no usage yet" : undefined,
        children: byModel.map((m) => ({
          id: `model:${m.key}`,
          label: m.key,
          description: `${m.requests} req · ~${m.premiumUnits.toFixed(1)} units`,
          icon: new vscode.ThemeIcon("symbol-misc"),
          tooltip: `${m.inputTokens.toLocaleString()} tokens in / ${m.outputTokens.toLocaleString()} out${m.failures ? ` · ${m.failures} failed` : ""}`,
        })),
      },
      {
        id: "byLabel",
        label: "By task (this month)",
        icon: new vscode.ThemeIcon("tasklist"),
        description: byLabel.length === 0 ? "no usage yet" : undefined,
        children: byLabel.map((l) => ({
          id: `label:${l.key}`,
          label: l.key,
          description: `${l.requests} req · ~${l.premiumUnits.toFixed(1)} units`,
          icon: new vscode.ThemeIcon("symbol-event"),
        })),
      },
    ];
  }
}
