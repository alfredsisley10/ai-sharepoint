import costData from "./model-costs.json";

/**
 * Relative premium-request cost lookup for Copilot models.
 *
 * Per ADR-0003 this is an ESTIMATE from a maintained multiplier table, never a
 * live read of the GitHub bill. Matching is by longest substring against the
 * model family/id so e.g. "gpt-4o-mini" wins over "gpt-4o".
 */
export class ModelCostTable {
  private readonly defaultMultiplier: number;
  private readonly multipliers: Record<string, number>;

  constructor() {
    this.defaultMultiplier =
      typeof costData.default === "number" ? costData.default : 1;
    this.multipliers = costData.multipliers ?? {};
  }

  /** Premium-request multiplier for a model id/family. */
  multiplierFor(modelId: string): number {
    const id = modelId.toLowerCase();
    let best: { key: string; value: number } | undefined;
    for (const [key, value] of Object.entries(this.multipliers)) {
      if (id.includes(key.toLowerCase())) {
        if (!best || key.length > best.key.length) {
          best = { key, value };
        }
      }
    }
    return best ? best.value : this.defaultMultiplier;
  }

  /** Plain-language tier for display alongside the badge. */
  tierFor(modelId: string): "Economy" | "Standard" | "Premium" {
    const m = this.multiplierFor(modelId);
    if (m <= 0) return "Economy";
    if (m <= 1) return "Standard";
    return "Premium";
  }

  /** Short relative-cost badge, e.g. "0×", "1×", "10×". */
  badgeFor(modelId: string): string {
    return `${this.multiplierFor(modelId)}×`;
  }
}
