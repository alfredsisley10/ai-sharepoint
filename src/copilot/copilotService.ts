import * as vscode from "vscode";
import { ModelCostTable } from "./modelCosts";
import { UsageMeter } from "./meter";
import { BudgetGuard, BudgetVerdict } from "./budget";
import { EntitlementGate, isEntitlementFailure } from "./entitlementGate";
import { AppError } from "../core/errors";
import { wireEnabled, emitWire, capDetail } from "../core/wireLog";

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
  multiplier: number;
  badge: string;
  tier: string;
}

export interface AskOptions {
  prompt: string;
  /** Task label recorded in the ledger, e.g. "askCopilot", "chat". */
  label: string;
  onChunk?: (text: string) => void;
  token?: vscode.CancellationToken;
  model?: vscode.LanguageModelChat;
  /** Set after the user explicitly confirmed exceeding the hard cap. */
  overrideBudget?: boolean;
}

export interface AskResult {
  text: string;
  modelId: string;
  premiumUnits: number;
  inputTokens: number;
  outputTokens: number;
  verdict: BudgetVerdict;
}

/**
 * Wraps the VS Code Language Model API (ADR-0001 — the only ToS-compliant way
 * to consume Copilot). Enumerates entitled models, enforces budget guardrails
 * (PLAN §4), and meters every request — including failed/cancelled ones, which
 * are still billed by GitHub at send time (REVIEW C8).
 */
export class CopilotService {
  private readonly costs = new ModelCostTable();
  // Pilot: a 403 "not authorized to use this Copilot feature" must not be
  // re-hit by every chat turn / indexing batch — short-circuit locally.
  private readonly gate = new EntitlementGate();

  constructor(
    private readonly meter: UsageMeter,
    private readonly budget: BudgetGuard,
  ) {}

  /** Close the entitlement pause early — the user explicitly retrying
   *  ("Check Copilot Status") after fixing the subscription/policy. */
  resetEntitlementGate(): void {
    this.gate.reset();
  }

  /** Fail FAST (no Copilot traffic) while the entitlement pause is open. */
  private assertEntitled(): void {
    const block = this.gate.check(Date.now());
    if (!block) return;
    const mins = Math.max(1, Math.ceil(block.remainingMs / 60_000));
    throw new AppError(
      `Copilot requests are paused (~${mins} min left) after GitHub answered: ${block.reason}`,
      "copilot.entitlement",
      `Copilot said "not authorized for this feature" — requests are paused ~${mins} min so the refusal isn't hammered. Fix the subscription/org policy, then run "Check Copilot Status" to retry immediately.`,
    );
  }

  /** Models the signed-in user is entitled to, cheapest first. */
  async listModels(): Promise<ModelInfo[]> {
    this.assertEntitled();
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    return models
      .map((m) => {
        const key = m.family || m.id;
        return {
          id: m.id,
          name: m.name,
          vendor: m.vendor,
          family: m.family,
          maxInputTokens: m.maxInputTokens,
          multiplier: this.costs.multiplierFor(key),
          badge: this.costs.badgeFor(key),
          tier: this.costs.tierFor(key),
        };
      })
      .sort(
        (a, b) => a.multiplier - b.multiplier || b.maxInputTokens - a.maxInputTokens,
      );
  }

  /**
   * Default model policy (PLAN §4 auto-downshift): the configured preferred
   * family when available, otherwise the cheapest entitled model with the
   * largest context window.
   */
  async pickDefaultModel(): Promise<vscode.LanguageModelChat> {
    this.assertEntitled();
    const all = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (all.length === 0) {
      throw new AppError(
        "No Copilot chat models are available. Ensure GitHub Copilot is installed and signed in.",
        "copilot.unavailable",
      );
    }
    const preferred = vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<string>("copilot.preferredModelFamily", "");
    if (preferred) {
      const match = all.find(
        (m) => m.family === preferred || m.id === preferred,
      );
      if (match) return match;
    }
    return [...all].sort(
      (a, b) =>
        this.costs.multiplierFor(a.family || a.id) -
          this.costs.multiplierFor(b.family || b.id) ||
        b.maxInputTokens - a.maxInputTokens,
    )[0];
  }

  /**
   * Send one metered chat request. Streams via `onChunk` and returns the full
   * text. Budget policy runs first (may throw BudgetBlockedError); usage is
   * recorded in a `finally` so failures and cancellations are still counted.
   */
  async ask(opts: AskOptions, nowIso: () => string): Promise<AskResult> {
    this.assertEntitled();
    const model = opts.model ?? (await this.pickDefaultModel());
    const modelKey = model.family || model.id;
    const verdict = this.budget.enforce(
      this.costs.multiplierFor(modelKey),
      nowIso(),
      opts.overrideBudget,
    );

    const messages = [vscode.LanguageModelChatMessage.User(opts.prompt)];
    let inputTokens = 0;
    try {
      inputTokens = await model.countTokens(opts.prompt);
    } catch {
      // Token counting is best-effort; metering falls back to 0 input tokens.
    }

    const started = Date.now();
    if (wireEnabled()) {
      emitWire(
        "copilot",
        "→",
        `${model.id} (task: ${opts.label}, ~${inputTokens} input tokens)`,
        capDetail(opts.prompt),
      );
    }
    let text = "";
    let ok = false;
    let outputTokens = 0;
    try {
      const response = await model.sendRequest(
        messages,
        { justification: "AI SharePoint request (metered against your Copilot allowance)" },
        opts.token,
      );
      for await (const fragment of response.text) {
        text += fragment;
        opts.onChunk?.(fragment);
      }
      ok = true;
      this.gate.reset(); // entitlement proven — close any stale pause
    } catch (err) {
      if (isEntitlementFailure(err)) {
        // Open the pause so chat turns / indexing batches / pickers fail
        // fast locally instead of re-hitting the refusal (pilot).
        const reason = err instanceof Error ? err.message : String(err);
        this.gate.open(reason, Date.now());
        throw new AppError(
          `GitHub Copilot rejected the request as not authorized: ${reason}`,
          "copilot.entitlement",
          'Copilot answered "not authorized for this feature" — the subscription/seat may have lapsed, or an organization policy disables it. Requests are paused ~5 min so the refusal isn\'t hammered; run "Check Copilot Status" to retry sooner.',
        );
      }
      throw err;
    } finally {
      if (wireEnabled()) {
        emitWire(
          ok ? "copilot" : "copilot",
          ok ? "←" : "✗",
          `${model.id} — ${text.length} chars (${Date.now() - started}ms)${ok ? "" : " — failed/cancelled (still metered)"}`,
          text ? capDetail(text) : undefined,
        );
      }
      if (text) {
        try {
          outputTokens = await model.countTokens(text);
        } catch {
          outputTokens = Math.ceil(text.length / 4); // rough fallback
        }
      }
      await this.meter.record(
        modelKey,
        inputTokens,
        outputTokens,
        nowIso(),
        opts.label,
        ok,
      );
    }

    return {
      text,
      modelId: model.id,
      premiumUnits: this.costs.multiplierFor(modelKey),
      inputTokens,
      outputTokens,
      verdict,
    };
  }
}
