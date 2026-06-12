import * as vscode from "vscode";
import { ModelCostTable } from "./modelCosts";
import { UsageMeter } from "./meter";
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
}

export interface AskResult {
  text: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Wraps the VS Code Language Model API (ADR-0001 — the only ToS-compliant way
 * to consume Copilot). Enumerates entitled models and counts every request —
 * including failed/cancelled ones, which are still billed by GitHub at send
 * time (REVIEW C8). The published multiplier table is used ONLY to prefer
 * cheaper models (auto-downshift); the extension does not estimate or track
 * premium-request consumption — GitHub billing is the authoritative source.
 */
export class CopilotService {
  private readonly costs = new ModelCostTable();

  constructor(private readonly meter: UsageMeter) {}

  /** Models the signed-in user is entitled to, cheapest first. */
  async listModels(): Promise<ModelInfo[]> {
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
   * Send one counted chat request. Streams via `onChunk` and returns the full
   * text. Usage is recorded in a `finally` so failures and cancellations are
   * still counted.
   */
  async ask(opts: AskOptions, nowIso: () => string): Promise<AskResult> {
    const model = opts.model ?? (await this.pickDefaultModel());
    const modelKey = model.family || model.id;

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
        { justification: "AI SharePoint request (uses your Copilot subscription)" },
        opts.token,
      );
      for await (const fragment of response.text) {
        text += fragment;
        opts.onChunk?.(fragment);
      }
      ok = true;
    } finally {
      if (wireEnabled()) {
        emitWire(
          ok ? "copilot" : "copilot",
          ok ? "←" : "✗",
          `${model.id} — ${text.length} chars (${Date.now() - started}ms)${ok ? "" : " — failed/cancelled (still billed by GitHub)"}`,
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
      inputTokens,
      outputTokens,
    };
  }
}
