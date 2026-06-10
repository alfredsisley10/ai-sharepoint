import * as vscode from "vscode";
import { ModelCostTable } from "./modelCosts";
import { UsageMeter } from "./meter";

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
  badge: string;
  tier: string;
}

/**
 * Wraps the VS Code Language Model API (ADR-0001 — the only ToS-compliant way
 * to consume Copilot). Enumerates entitled models and runs metered requests.
 */
export class CopilotService {
  private readonly costs = new ModelCostTable();

  constructor(private readonly meter: UsageMeter) {}

  /** Models the signed-in user is entitled to, annotated with relative cost. */
  async listModels(): Promise<ModelInfo[]> {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      family: m.family,
      maxInputTokens: m.maxInputTokens,
      badge: this.costs.badgeFor(m.family || m.id),
      tier: this.costs.tierFor(m.family || m.id),
    }));
  }

  /**
   * Send a single chat prompt to the given (or first available) model, stream
   * the response to `onChunk`, and record the usage. Returns the full text.
   */
  async ask(
    prompt: string,
    onChunk: (text: string) => void,
    nowIso: string,
    token: vscode.CancellationToken,
    label?: string,
    model?: vscode.LanguageModelChat,
  ): Promise<{ text: string; modelId: string; premiumUnits: number }> {
    const chosen =
      model ??
      (await vscode.lm.selectChatModels({ vendor: "copilot" }))[0];
    if (!chosen) {
      throw new Error(
        "No Copilot chat models are available. Ensure GitHub Copilot is installed and signed in.",
      );
    }

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const inputTokens = await chosen.countTokens(prompt);

    const response = await chosen.sendRequest(messages, {}, token);
    let text = "";
    for await (const fragment of response.text) {
      text += fragment;
      onChunk(fragment);
    }

    const outputTokens = await chosen.countTokens(text);
    const premiumUnits = await this.meter.record(
      chosen.family || chosen.id,
      inputTokens,
      outputTokens,
      nowIso,
      label,
    );
    return { text, modelId: chosen.id, premiumUnits };
  }
}
