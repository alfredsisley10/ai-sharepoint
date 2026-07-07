import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";
import { costEnabled, estimateCost, formatCost } from "../copilot/tokenCost";
import { readTokenRates } from "../copilot/tokenRates";
import { ModelLimitsStore } from "../diagnostics/modelLimitsStore";
import { describeModelLimit } from "../core/contextBudget";

interface UsageNode {
  id: string;
  label: string;
  description?: string;
  icon?: vscode.ThemeIcon;
  tooltip?: string | vscode.MarkdownString;
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
    private readonly modelLimits?: ModelLimitsStore,
  ) {
    meter.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  /** A "Model context limits" branch: per-model reported (advertised) vs. tested
   *  (measured) input-context limits and the budgeting cap. Empty until the
   *  advertised limits are captured (on startup) or a probe has run. */
  private contextLimitNodes(): UsageNode[] {
    const rows = (this.modelLimits?.list() ?? []).map(describeModelLimit).sort((a, b) => a.key.localeCompare(b.key));
    if (rows.length === 0) return [];
    const n = (v?: number) => (v === undefined ? "?" : v.toLocaleString());
    return [
      {
        id: "limits",
        label: "Model context limits",
        icon: new vscode.ThemeIcon("dashboard"),
        tooltip:
          "Reported = the model's advertised maxInputTokens. Tested = the largest input actually proven to work (or the learned ceiling). Budget = the cap chats are actually held to. Run “Probe Model Context Limit” to measure a model's real limit.",
        children: rows.map((r) => {
          const tested = r.measured ? n(r.knownGood ?? r.effectiveCap) : "not tested";
          return {
            id: `limit:${r.key}`,
            label: r.key,
            description: `reported ${n(r.advertised)} · tested ${tested}${r.cap !== undefined ? ` · budget ${n(r.cap)}` : ""}${r.drifted ? " · ⚠ advertised changed" : ""}`,
            icon: new vscode.ThemeIcon(r.drifted ? "warning" : "circuit-board"),
            tooltip: new vscode.MarkdownString(
              [
                `**${r.key}**`,
                "",
                `- Reported (advertised): ${n(r.advertised)}`,
                `- Tested — largest that worked: ${n(r.knownGood)}`,
                ...(r.effectiveCap !== undefined ? [`- Tested — learned ceiling (overflow): ${n(r.effectiveCap)}`] : []),
                `- Budgeting cap in use: ${n(r.cap)}`,
                ...(r.drifted ? ["", "⚠ The advertised limit changed since it was last measured — consider re-probing."] : []),
                ...(r.measured ? [] : ["", "Not yet measured — run “Probe Model Context Limit”."]),
              ].join("\n"),
            ),
            command: { command: "aiSharePoint.probeModelContextLimit", title: "Probe Model Context Limit" },
          };
        }),
      },
    ];
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
    const rates = readTokenRates();
    const showCost = costEnabled(rates);
    const monthCost = showCost
      ? formatCost(
          byModel.reduce((sum, m) => sum + estimateCost(m.inputTokens, m.outputTokens, rates), 0),
          rates.currency,
        )
      : undefined;

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
      ...(monthCost !== undefined
        ? [
            {
              id: "cost",
              label: `Est. cost this month: ${monthCost}`,
              icon: new vscode.ThemeIcon("credit-card"),
              tooltip:
                "Estimate = your configured per-token rate × the tokens this extension measured locally. It reflects a rate you set in Settings (AI SharePoint › Usage), not your GitHub bill.",
              command: { command: "workbench.action.openSettings", title: "Edit token rate", arguments: ["aiSharePoint.usage.tokenCost"] },
            } as UsageNode,
          ]
        : []),
      {
        id: "byModel",
        label: "By model (this month)",
        icon: new vscode.ThemeIcon("circuit-board"),
        description: byModel.length === 0 ? "no requests yet" : undefined,
        children: byModel.map((m) => ({
          id: `model:${m.key}`,
          label: m.key,
          description: `${m.requests} req · ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out${
            showCost ? ` · ${formatCost(estimateCost(m.inputTokens, m.outputTokens, rates), rates.currency)}` : ""
          }`,
          icon: new vscode.ThemeIcon("symbol-misc"),
          tooltip: m.failures ? `${m.failures} failed` : undefined,
        })),
      },
      ...this.contextLimitNodes(),
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
