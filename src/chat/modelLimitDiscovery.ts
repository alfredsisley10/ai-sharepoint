import * as vscode from "vscode";
import { ModelLimitsStore } from "../diagnostics/modelLimitsStore";
import { modelKey, needsEffectiveProbe } from "../core/contextBudget";
import { runContextLimitProbe } from "./contextLimitProbe";
import { PROBE_MAX_STEPS } from "../core/contextProbe";
import { ModelCostTable } from "../copilot/modelCosts";
import { estimateProbeCost } from "../copilot/premiumCost";
import { readPremiumPricing } from "../copilot/premiumPricing";
import { formatCost } from "../copilot/tokenCost";

/**
 * Startup / model-discovery context-limit capture.
 *
 * Two tiers, deliberately separated by cost:
 *  1. `discoverAdvertisedLimits` — FREE. Enumerates the Copilot models and folds
 *     each model's advertised `maxInputTokens` into the store. No LLM calls, no
 *     quota, silent. Runs at activation and whenever the model set changes (the
 *     user may sign in to Copilot after we start), so from the first turn we
 *     budget against real published ceilings instead of the 8192 fallback.
 *  2. `maybeOfferContextProbe` — COSTS A LITTLE QUOTA, so it always ASKS first.
 *     Advertised ≠ what Copilot actually delivers, so for models we've never
 *     measured (or whose advertised ceiling just drifted) we offer a one-time
 *     binary-search probe. Results are cached in the store, so a measured model
 *     is never re-offered unless its advertised limit moves. Gated by a setting
 *     ("Don't ask again" flips it off) and deduped per session.
 */

const OFFER_SETTING = "context.offerProbeOnNewModels";

/** Per-session guard so repeated onDidChangeChatModels fires don't re-prompt. */
let offeredThisSession = false;

/** Test-only: forget the per-session dedup. */
export function _resetDiscovery(): void {
  offeredThisSession = false;
}

export interface ProbeCandidate {
  model: vscode.LanguageModelChat;
  key: string;
  advertised: number;
}

export interface DiscoveryResult {
  /** How many models had an advertised limit recorded. */
  recorded: number;
  /** Models worth offering an effective-limit probe for (new or drifted). */
  candidates: ProbeCandidate[];
}

/**
 * Record advertised ceilings for all Copilot models (free) and return which ones
 * are worth measuring. Best-effort: a Copilot that isn't installed/signed in
 * yet just yields an empty list, and we try again on the next model-change event.
 */
export async function discoverAdvertisedLimits(modelLimits: ModelLimitsStore): Promise<DiscoveryResult> {
  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  } catch {
    return { recorded: 0, candidates: [] };
  }
  const candidates: ProbeCandidate[] = [];
  let recorded = 0;
  for (const model of models) {
    const advertised = model.maxInputTokens;
    if (!advertised || advertised <= 0) continue;
    const key = modelKey(model);
    // Evaluate staleness BEFORE recording, since recording refreshes `advertised`
    // (but never the measured-at baseline, so drift detection stays intact).
    const offer = needsEffectiveProbe(modelLimits.get(key), advertised);
    await modelLimits.recordAdvertised(key, advertised).catch(() => undefined);
    recorded += 1;
    if (offer) candidates.push({ model, key, advertised });
  }
  return { recorded, candidates };
}

function offerEnabled(): boolean {
  return vscode.workspace.getConfiguration("aiSharePoint").get<boolean>(OFFER_SETTING, true);
}

/**
 * If enabled and not already offered this session, ask the user once whether to
 * measure the effective context limit for the given candidate models. Runs the
 * probes on acceptance (with progress + cancellation). No-op when the list is
 * empty, the setting is off, or we've already asked this session.
 */
export async function maybeOfferContextProbe(
  candidates: ProbeCandidate[],
  modelLimits: ModelLimitsStore,
  telemetry?: { record(event: string, props?: Record<string, string>): void },
): Promise<void> {
  if (offeredThisSession || candidates.length === 0 || !offerEnabled()) return;
  offeredThisSession = true;

  const names = candidates.map((c) => c.model.name);
  const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
  // Estimated upper-bound cost across the candidate models (each probe sends up
  // to PROBE_MAX_STEPS requests; premium requests = steps × the model multiplier).
  const costs = new ModelCostTable();
  const pricing = readPremiumPricing();
  const totalCost = candidates.reduce(
    (sum, c) => sum + estimateProbeCost(costs.multiplierFor(c.key), PROBE_MAX_STEPS, pricing.pricePerRequest).cost,
    0,
  );
  const costPhrase = totalCost > 0 ? ` Estimated cost up to ~${formatCost(totalCost, pricing.currency)} at your configured rate.` : "";
  const choice = await vscode.window.showInformationMessage(
    `AI SharePoint can measure the real context limit for ${candidates.length} Copilot model(s) (${list}). ` +
      "The published limit is often larger than Copilot actually delivers, so measuring it lets the extension pack prompts optimally and avoid mid-chat overflows. " +
      `It sends a few short test prompts (uses a little of your Copilot allowance); results are saved so this runs only once per model.${costPhrase}`,
    "Measure now",
    "Not now",
    "Don't ask again",
  );
  if (choice === "Don't ask again") {
    await vscode.workspace
      .getConfiguration("aiSharePoint")
      .update(OFFER_SETTING, false, vscode.ConfigurationTarget.Global)
      .then(undefined, () => undefined);
    return;
  }
  if (choice !== "Measure now") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Measuring Copilot context limits…", cancellable: true },
    async (progress, token) => {
      let done = 0;
      for (const c of candidates) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${c.model.name} (${done + 1}/${candidates.length})…` });
        try {
          await runContextLimitProbe(c.model, c.key, modelLimits, {
            token,
            onStep: (message) => progress.report({ message: `${c.model.name}: ${message}` }),
          });
          done += 1;
        } catch {
          // Network/entitlement error on one model — skip it; passive learning
          // from real turns still catches up, and the others can still measure.
        }
      }
      telemetry?.record("context.probe", { outcome: token.isCancellationRequested ? "cancelled" : "completed" });
      if (done > 0) {
        void vscode.window.showInformationMessage(
          `Measured the context limit for ${done} model(s) — chats now budget to the real ceilings.`,
        );
      }
    },
  );
}
