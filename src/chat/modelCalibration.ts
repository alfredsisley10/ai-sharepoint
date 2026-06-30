import * as vscode from "vscode";
import { ModelLimitsStore } from "../diagnostics/modelLimitsStore";
import { calibrationSize, probeFiller } from "../core/contextProbe";
import { looksLikeOverflow } from "../core/contextBudget";
import { redactError } from "../core/redaction";

/**
 * First-use context calibration. GitHub Copilot can deliver less than a model's
 * advertised `maxInputTokens`, varying by org, so the FIRST time a model is used
 * — and only if the user opted in — we send ONE short calibration request near
 * the advertised ceiling to learn its real limit before a genuinely large turn
 * relies on it. Opt-in because it spends a little Copilot quota; single-shot (the
 * "Probe Model Context Limit" command does the full binary search on demand);
 * fire-and-forget so it never delays the user's turn; deduped per model.
 */

const SETTING = "context.autoProbeOnFirstUse";

const done = new Set<string>(); // models calibrated (or skipped) this session
const inFlight = new Set<string>();

export function autoProbeEnabled(): boolean {
  return vscode.workspace.getConfiguration("aiSharePoint").get<boolean>(SETTING, false);
}

/** Test-only: forget the per-session dedup state. */
export function _resetCalibration(): void {
  done.clear();
  inFlight.clear();
}

/**
 * If enabled and this model has no learned record yet, kick off a single
 * background calibration send and record the result. Returns immediately; safe to
 * call on every turn (it self-dedupes and no-ops once a model is known).
 */
export function maybeAutoCalibrate(model: vscode.LanguageModelChat, key: string, limits: ModelLimitsStore): void {
  if (!autoProbeEnabled() || done.has(key) || inFlight.has(key)) return;
  if (limits.get(key)) {
    done.add(key); // we already have data — passive learning suffices
    return;
  }
  const size = calibrationSize(model.maxInputTokens);
  if (!size) {
    done.add(key);
    return;
  }
  inFlight.add(key);
  void (async () => {
    const advertised = model.maxInputTokens;
    try {
      const filler = probeFiller(size);
      let measured = size;
      try {
        measured = await model.countTokens(filler);
      } catch {
        /* keep the estimate */
      }
      const cts = new vscode.CancellationTokenSource();
      try {
        const resp = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(`${filler}\n\nReply with exactly: OK`)],
          { justification: "AI SharePoint first-use context calibration" },
          cts.token,
        );
        for await (const _part of resp.stream) {
          /* drain — reaching the end without an overflow throw means it fit */
        }
        await limits.recordSuccess(key, advertised, measured).catch(() => undefined);
      } catch (err) {
        // Only an overflow teaches us the ceiling; network/entitlement errors are
        // ignored here (passive learning from real turns will catch up).
        if (looksLikeOverflow(redactError(err).message)) {
          await limits.recordOverflow(key, advertised, measured).catch(() => undefined);
        }
      } finally {
        cts.dispose();
      }
    } finally {
      inFlight.delete(key);
      done.add(key);
    }
  })();
}
