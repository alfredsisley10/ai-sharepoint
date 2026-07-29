/**
 * Copilot transport reliability (pure).
 *
 * Reported: indexing and chat requests dying with `net::ERR_HTTP2_PROTOCOL_ERROR`
 * behind a corporate proxy. Research (see the links below) puts the cause in the
 * **fetcher** Copilot Chat uses, not in our requests: Electron's networking stack
 * negotiates HTTP/2, and SSL-inspecting proxies frequently reset those streams —
 * while Node's https / fetch paths (HTTP/1.1) get through. Users and maintainers
 * converge on the same remedy: turn the Electron fetcher OFF and let the Node
 * fetchers handle it.
 *
 * We do NOT own Copilot's networking, so this module cannot fix the transport.
 * What it can do is recognize the signature, know the settings that change it,
 * and compute the exact configuration change to offer — so the user gets a
 * one-click remedy instead of a search.
 *
 * References (July 2026):
 *  - microsoft/vscode#283623 — ERR_HTTP2_PROTOCOL_ERROR, server RST_STREAM
 *    during Copilot chat; Copilot itself logs "Retrying chat request with
 *    default fetcher", i.e. its own retry can be exhausted.
 *  - microsoft/vscode-copilot-release#10262 — Electron fetch failing where
 *    Node https / Node fetch succeed on the same machine; the fix applied is the
 *    three settings below.
 */

/** The Copilot Chat advanced-debug keys that select the transport. They live
 *  INSIDE the `github.copilot.advanced` object, not as top-level settings, so
 *  they must be merged rather than written individually. */
export const FETCHER_KEYS = {
  electron: "debug.useElectronFetcher",
  node: "debug.useNodeFetcher",
  nodeFetch: "debug.useNodeFetchFetcher",
} as const;

export const COPILOT_ADVANCED_SECTION = "github.copilot";
export const COPILOT_ADVANCED_KEY = "advanced";

/** How many transport resets in one session before we offer the remedy. Two,
 *  not one: a single reset is normal internet weather and our own retry usually
 *  absorbs it; a second means the path is systematically broken. */
export const RESET_THRESHOLD = 2;

export type FetcherMode = "electron" | "node" | "unset";

/** Read the effective mode out of the `github.copilot.advanced` object. */
export function currentFetcherMode(advanced: Record<string, unknown> | undefined): FetcherMode {
  const electron = advanced?.[FETCHER_KEYS.electron];
  if (electron === false) return "node";
  if (electron === true) return "electron";
  return "unset"; // Copilot's own default (Electron-first)
}

/**
 * The `github.copilot.advanced` object to write in order to prefer Node's
 * transport. Existing keys are preserved — the object holds unrelated Copilot
 * debug settings and clobbering it would silently discard them.
 */
export function nodeFetcherSettings(
  advanced: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(advanced ?? {}),
    [FETCHER_KEYS.electron]: false,
    [FETCHER_KEYS.node]: true,
    [FETCHER_KEYS.nodeFetch]: true,
  };
}

/** Undo it — back to Copilot's own defaults by REMOVING our keys rather than
 *  writing `true`, so the user isn't left pinned to a setting we invented. */
export function revertFetcherSettings(
  advanced: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(advanced ?? {}) };
  for (const k of Object.values(FETCHER_KEYS)) delete next[k];
  return next;
}

export interface FetcherAdvice {
  /** Should we offer a change at all? */
  offer: boolean;
  /** Short reason, shown to the user. */
  reason: string;
  /** What the offer would do. */
  action: "switch-to-node" | "already-node" | "none";
}

/**
 * Decide whether to offer the transport switch.
 *
 * Deliberately conservative — this changes another extension's settings, so it
 * is only offered when the evidence is specific (repeated *transport resets*,
 * not any failure) and the remedy hasn't already been applied. Once the user is
 * already on the Node fetcher, a further reset is not a fetcher problem and
 * saying so is more useful than offering the same switch again.
 */
export function adviseFetcher(resetCount: number, mode: FetcherMode): FetcherAdvice {
  if (resetCount < RESET_THRESHOLD) {
    return { offer: false, reason: "Not enough evidence yet.", action: "none" };
  }
  if (mode === "node") {
    return {
      offer: false,
      action: "already-node",
      reason:
        "Already using the Node fetcher, so this is not Electron's HTTP/2 stack. The proxy itself is resetting the connection — ask your network team to allow long-lived streaming responses to the Copilot endpoints.",
    };
  }
  return {
    offer: true,
    action: "switch-to-node",
    reason:
      "Repeated connection resets look like Electron's HTTP/2 transport being cut by an SSL-inspecting proxy. Switching Copilot to Node's HTTP/1.1 transport resolves this for most corporate networks.",
  };
}

/** Session counter for transport resets, so the advice is based on a pattern
 *  rather than a single blip. Reset when the user acts on the advice. */
export class ResetTracker {
  private count = 0;
  private offered = false;

  record(): void {
    this.count += 1;
  }

  get resets(): number {
    return this.count;
  }

  /** True at most ONCE per session (until `clear`), so a long run that keeps
   *  hitting resets can't nag on every batch. */
  shouldOffer(mode: FetcherMode): boolean {
    if (this.offered) return false;
    const advice = adviseFetcher(this.count, mode);
    if (advice.offer) {
      this.offered = true;
      return true;
    }
    return false;
  }

  clear(): void {
    this.count = 0;
    this.offered = false;
  }
}
