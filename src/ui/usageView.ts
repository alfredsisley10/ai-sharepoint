import * as vscode from "vscode";
import { UsageMeter } from "../copilot/meter";
import { costEnabled, estimateCost, formatCost } from "../copilot/tokenCost";
import { readTokenRates } from "../copilot/tokenRates";
import { premiumCostEnabled, estimatePremiumCost } from "../copilot/premiumCost";
import { readPremiumPricing } from "../copilot/premiumPricing";
import { ModelCostTable } from "../copilot/modelCosts";
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
  private readonly costs = new ModelCostTable();

  constructor(
    private readonly meter: UsageMeter,
    private readonly now: () => string,
    /** False until Copilot Chat is installed AND signed in (models exist). */
    private readonly copilotAvailable: () => boolean = () => true,
    private readonly modelLimits?: ModelLimitsStore,
  ) {
    this.meterListener = meter.onDidChange(() => this.emitter.fire());
    // The cost rows are derived from settings (usage.pricePerPremiumRequest and
    // the token rates), so re-render when those change — otherwise editing the
    // price leaves a stale "Est. cost this month" until the next request.
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiSharePoint.usage")) this.emitter.fire();
    });
  }

  private readonly meterListener: vscode.Disposable;
  private readonly configWatcher: vscode.Disposable;

  dispose(): void {
    this.meterListener.dispose();
    this.configWatcher.dispose();
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire();
  }

  /** A "Model context limits" branch: per-model reported (advertised) vs. tested
   *  (measured) input-context limits. Empty until the advertised limits are
   *  captured (on startup) or a probe has run. */
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
          "Reported = the model's advertised maxInputTokens. Tested = the largest input actually proven to work (or the learned ceiling) — when present, it's the limit in effect. Chats use the tested limit when available (else reported), minus ~15% headroom for the system prompt, tool schemas and chat history. Run “Probe Model Context Limit” to measure a model's real limit.",
        children: rows.map((r) => {
          const tested = r.measured ? `${n(r.knownGood ?? r.effectiveCap)} ✓` : "not tested";
          return {
            id: `limit:${r.key}`,
            label: r.key,
            description: `reported ${n(r.advertised)} · tested ${tested}${r.drifted ? " · ⚠ advertised changed" : ""}`,
            icon: new vscode.ThemeIcon(r.drifted ? "warning" : "circuit-board"),
            tooltip: new vscode.MarkdownString(
              [
                `**${r.key}**`,
                "",
                `- Reported (advertised): ${n(r.advertised)}`,
                r.measured
                  ? `- **Tested: ${n(r.knownGood ?? r.effectiveCap)} ✓** — the limit in effect${r.knownGood !== undefined ? " (largest input proven to work)" : " (ceiling learned from an overflow)"}`
                  : "- Tested: not yet measured",
                ...(r.knownGood !== undefined && r.effectiveCap !== undefined
                  ? [`- Learned overflow ceiling: ${n(r.effectiveCap)}`]
                  : []),
                ...(r.usable !== undefined
                  ? [
                      "",
                      `_Chats use the tested limit when available (else reported), minus ~15% headroom for the system prompt, tool schemas and chat history — here **${n(r.usable)}** tokens per turn._`,
                    ]
                  : []),
                ...(r.drifted ? ["", "⚠ The advertised limit changed since it was last measured — consider re-probing."] : []),
                ...(r.measured ? [] : ["", "Not yet measured — run “Probe Model Context Limit”."]),
              ].join("\n"),
            ),
            // Pass THIS row's model key so the probe tests the clicked model —
            // without it the command falls back to picking a model itself.
            command: {
              command: "aiSharePoint.probeModelContextLimit",
              title: "Probe Model Context Limit",
              arguments: [r.key],
            },
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
    // Copilot's own pricing model: premium requests × multiplier × price. On by
    // default (published $0.04/request), so dollars show without configuration.
    const premium = readPremiumPricing();
    const premiumCost = premiumCostEnabled(premium)
      ? formatCost(estimatePremiumCost(byModel, (k) => this.costs.multiplierFor(k), premium), premium.currency)
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
      ...(premiumCost !== undefined
        ? [
            {
              id: "premiumCost",
              label: `Est. cost this month: ${premiumCost}`,
              icon: new vscode.ThemeIcon("credit-card"),
              tooltip: new vscode.MarkdownString(
                "Estimate at GitHub's published **$0.04 / premium request** overage rate × each model's premium-request multiplier × your local request counts.\n\nYour plan includes a monthly premium-request allowance, so the real charge may be lower — **GitHub billing is authoritative**. Click to change the rate in Settings.",
              ),
              command: { command: "workbench.action.openSettings", title: "Edit premium-request price", arguments: ["@id:aiSharePoint.usage.pricePerPremiumRequest"] },
            } as UsageNode,
          ]
        : []),
      ...(monthCost !== undefined
        ? [
            {
              id: "cost",
              label: `Est. token cost this month: ${monthCost}`,
              icon: new vscode.ThemeIcon("symbol-number"),
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
        children: byModel.map((m) => {
          // Per-model premium-request cost: this model's requests × ITS published
          // multiplier × the price. Always available (default $0.04); the
          // token-rate cost is additional and only when a rate is configured.
          const premiumLine = premiumCostEnabled(premium)
            ? ` · ${formatCost(estimatePremiumCost([m], (k) => this.costs.multiplierFor(k), premium), premium.currency)} (${this.costs.badgeFor(m.key)})`
            : "";
          const tokenLine = showCost ? ` · ${formatCost(estimateCost(m.inputTokens, m.outputTokens, rates), rates.currency)} tokens` : "";
          return {
            id: `model:${m.key}`,
            label: m.key,
            description: `${m.requests} req · ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out${premiumLine}${tokenLine}`,
            icon: new vscode.ThemeIcon("symbol-misc"),
            tooltip: new vscode.MarkdownString(
              [
                m.failures ? `${m.failures} failed` : "",
                premiumCostEnabled(premium)
                  ? `Premium-request estimate: ${m.requests} req × ${this.costs.badgeFor(m.key)} × ${formatCost(premium.pricePerRequest, premium.currency)} (an estimate — GitHub billing is authoritative).`
                  : "",
              ].filter(Boolean).join("\n\n"),
            ),
          };
        }),
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
          // Per-task premium cost isn't derivable (a task aggregates across
          // models, and the premium multiplier is per-model), so show the
          // token-based cost when a rate is configured; requests otherwise.
          description: `${l.requests} req${
            showCost ? ` · ${formatCost(estimateCost(l.inputTokens, l.outputTokens, rates), rates.currency)} tokens` : ""
          }`,
          icon: new vscode.ThemeIcon("symbol-event"),
          tooltip: showCost
            ? undefined
            : "Set a per-token rate (AI SharePoint › Usage) to see a token-cost estimate per task. Premium-request cost is shown per model (a task spans models, so its premium multiplier isn't well-defined).",
        })),
      },
    ];
  }
}
