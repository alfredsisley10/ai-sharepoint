import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";

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
 * Copilot Activity tree view: factual, locally measured counts of the
 * requests THIS extension made — requests today/this month, failures, and
 * per-model / per-task breakdowns with token totals. No premium-unit
 * estimates, no allowance gauge: there is no authoritative local source for
 * either (GitHub billing is), and estimated numbers misled users.
 */
export class UsageTreeProvider implements vscode.TreeDataProvider<UsageNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly meter: UsageMeter,
    private readonly now: () => string,
    /** False until Copilot Chat is installed AND signed in (models exist). */
    private readonly copilotAvailable: () => boolean = () => true,
  ) {
    meter.onDidChange(() => this.emitter.fire());
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
    // No Copilot and nothing ever recorded → empty tree, so the viewsWelcome
    // guidance (install Copilot Chat / sign in) shows instead of zeros.
    if (!this.copilotAvailable() && this.meter.requestsThisMonth(nowIso) === 0) {
      return [];
    }
    const monthRequests = this.meter.requestsThisMonth(nowIso);
    const monthFailures = this.meter.failuresThisMonth(nowIso);
    const byModel = this.meter.byModelThisMonth(nowIso);
    const byLabel = this.meter.byLabelThisMonth(nowIso);

    return [
      {
        id: "month",
        label: `${monthRequests} request(s) this month`,
        description: monthFailures > 0 ? `${monthFailures} failed` : undefined,
        icon: new vscode.ThemeIcon("dashboard"),
        tooltip:
          "Requests this extension made through your Copilot subscription — a factual local count. Premium-request consumption against your plan is NOT tracked here (there is no authoritative local source); check your GitHub billing/plan page for that.",
        command: { command: "aiSharePoint.showUsage", title: "Open activity dashboard" },
      },
      {
        id: "today",
        label: `Today: ${this.meter.requestsToday(nowIso)} request(s)`,
        icon: new vscode.ThemeIcon("calendar"),
      },
      {
        id: "byModel",
        label: "By model (this month)",
        icon: new vscode.ThemeIcon("circuit-board"),
        description: byModel.length === 0 ? "no requests yet" : undefined,
        children: byModel.map((m) => ({
          id: `model:${m.key}`,
          label: m.key,
          description: `${m.requests} req · ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out`,
          icon: new vscode.ThemeIcon("symbol-misc"),
          tooltip: m.failures ? `${m.failures} failed` : undefined,
        })),
      },
      {
        id: "byLabel",
        label: "By task (this month)",
        icon: new vscode.ThemeIcon("tasklist"),
        description: byLabel.length === 0 ? "no requests yet" : undefined,
        children: byLabel.map((l) => ({
          id: `label:${l.key}`,
          label: l.key,
          description: `${l.requests} req`,
          icon: new vscode.ThemeIcon("symbol-event"),
        })),
      },
    ];
  }
}
