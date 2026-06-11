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
    /** False until Copilot Chat is installed AND signed in (models exist). */
    private readonly copilotAvailable: () => boolean = () => true,
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
    // No Copilot and nothing ever metered → empty tree, so the viewsWelcome
    // guidance (install Copilot Chat / sign in) shows instead of zeros.
    if (!this.copilotAvailable() && this.meter.requestsThisMonth(nowIso) === 0) {
      return [];
    }
    const verdict = this.budget.evaluate(0, nowIso);
    const used = this.meter.premiumUnitsThisMonth(nowIso);
    const monthRequests = this.meter.requestsThisMonth(nowIso);
    // The default-model policy prefers the cheapest entitled model, which is
    // usually an INCLUDED (0×) one — real requests, zero premium units. Say
    // so, or the static gauge reads as a broken meter (pilot feedback).
    const allIncluded = monthRequests > 0 && used === 0;
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
        description: `~${used.toFixed(1)} / ${verdict.allowance} units${allIncluded ? " · all on included 0× models" : ""}`,
        icon: stateIcon,
        tooltip: allIncluded
          ? `${monthRequests} request(s) this month ran on included (0×) models — they cost no premium units, so the gauge stays at 0%. Premium models (e.g. Claude Sonnet 1×, Claude Opus 10×) consume the allowance; pick one via "List Copilot Models" or the chat model picker. Estimate per ADR-0003 — not the live GitHub bill.`
          : "Estimate from this extension's local meter and the model multiplier table (ADR-0003) — not the live GitHub bill. Click for the dashboard.",
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
        children: byModel.map((m) => {
          const multiplier = this.meter.multiplierFor(m.key);
          return {
            id: `model:${m.key}`,
            label: m.key,
            description: `${m.requests} req · ~${m.premiumUnits.toFixed(1)} units · ${multiplier}×${multiplier === 0 ? " included" : ""}`,
            icon: new vscode.ThemeIcon("symbol-misc"),
            tooltip: `${m.inputTokens.toLocaleString()} tokens in / ${m.outputTokens.toLocaleString()} out${m.failures ? ` · ${m.failures} failed` : ""}${multiplier === 0 ? "\nIncluded (0×) model: requests here never consume the premium allowance." : ""}`,
          };
        }),
      },
      {
        id: "byLabel",
        label: "By task (this month)",
        icon: new vscode.ThemeIcon("tasklist"),
        description: byLabel.length === 0 ? "no usage yet" : undefined,
        children: byLabel.map((l) => ({
          id: `label:${l.key}`,
          label: l.key,
          description: `${l.requests} req · ~${l.premiumUnits.toFixed(1)} units${l.premiumUnits === 0 ? " (0× models)" : ""}`,
          icon: new vscode.ThemeIcon("symbol-event"),
          tooltip:
            l.premiumUnits === 0
              ? "These requests ran on included (0×) models — counted, but no premium units consumed."
              : undefined,
        })),
      },
    ];
  }
}
