import * as vscode from "vscode";
import { ModelLimitsStore } from "../diagnostics/modelLimitsStore";
import {
  initialProbeWindow,
  nextProbeSize,
  probeConverged,
  probeFiller,
  PROBE_TOLERANCE,
  PROBE_MAX_STEPS,
} from "../core/contextProbe";
import { looksLikeOverflow } from "../core/contextBudget";
import { redactError } from "../core/redaction";

/**
 * Actively measure a Copilot model's REAL input-context limit. Copilot can
 * deliver less than the advertised `maxInputTokens` (varies by org/plan), so
 * this binary-searches the accept/reject boundary with filler prompts and
 * records the result in the ModelLimitsStore for prompt budgeting.
 *
 * Shared by the manual "Probe Model Context Limit" command and the automatic
 * (opt-in, prompted) discovery flow so there's a single measurement path.
 * Injected IO only — the search math lives in core/contextProbe (pure, tested).
 */

export interface ProbeResult {
  advertised: number | undefined;
  /** Largest input that actually succeeded this run. */
  lastGood: number;
  /** The budgeting cap after folding this run's results into the store. */
  effective: number;
  cancelled: boolean;
}

export interface ProbeHooks {
  token: vscode.CancellationToken;
  /** Progress note per step (step is 1-based). */
  onStep?(message: string, step: number): void;
}

export async function runContextLimitProbe(
  model: vscode.LanguageModelChat,
  key: string,
  modelLimits: ModelLimitsStore,
  hooks: ProbeHooks,
): Promise<ProbeResult> {
  const advertised = model.maxInputTokens;
  let { low, high } = initialProbeWindow(advertised, modelLimits.get(key)?.knownGood);
  let lastGood = low;
  for (
    let step = 0;
    step < PROBE_MAX_STEPS && !probeConverged(low, high, PROBE_TOLERANCE) && !hooks.token.isCancellationRequested;
    step++
  ) {
    const target = nextProbeSize(low, high, PROBE_TOLERANCE);
    if (target === undefined) break;
    hooks.onStep?.(`testing ~${target.toLocaleString()} tokens (step ${step + 1}/${PROBE_MAX_STEPS})…`, step + 1);
    const filler = probeFiller(target);
    let measured = target;
    try {
      measured = await model.countTokens(filler);
    } catch {
      /* keep the requested target as the estimate */
    }
    try {
      const resp = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(`${filler}\n\nReply with exactly: OK`)],
        { justification: "AI SharePoint context-limit probe" },
        hooks.token,
      );
      for await (const _part of resp.stream) {
        /* drain — success is reaching the end without an overflow throw */
      }
      lastGood = Math.max(lastGood, measured);
      low = Math.max(low, measured);
      await modelLimits.recordSuccess(key, advertised, measured).catch(() => undefined);
    } catch (err) {
      if (looksLikeOverflow(redactError(err).message)) {
        high = Math.min(high, measured);
        await modelLimits.recordOverflow(key, advertised, measured).catch(() => undefined);
      } else {
        throw err; // network/entitlement — stop and surface it
      }
    }
  }
  return {
    advertised,
    lastGood,
    effective: modelLimits.effectiveLimit(key, advertised) ?? lastGood,
    cancelled: hooks.token.isCancellationRequested,
  };
}
