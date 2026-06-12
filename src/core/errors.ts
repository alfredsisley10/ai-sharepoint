/**
 * Error classification shared by notifications, error reports, and the
 * diagnostics bundle. Codes are coarse on purpose: they aggregate well across
 * an enterprise fleet without carrying user data. Pure module.
 */

export type ErrorCode =
  | "auth.cancelled"
  | "auth.timeout"
  | "auth.failed"
  | "graph.forbidden"
  | "graph.notFound"
  | "graph.throttled"
  | "graph.error"
  | "copilot.unavailable"
  | "network"
  | "config"
  | "unknown";

/** An error that already knows its classification and user-facing summary. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    /** Short, safe, actionable summary for notifications. */
    readonly userSummary?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Classify an arbitrary thrown value into a coarse ErrorCode. */
export function classifyError(err: unknown): ErrorCode {
  if (err instanceof AppError) {
    return err.code;
  }
  const text = (err instanceof Error ? `${err.name} ${err.message}` : String(err)).toLowerCase();
  if (/user[_ ]?cancel|cancell?ed|aborted by user/.test(text)) return "auth.cancelled";
  if (/timed? ?out/.test(text) && /sign-?in|auth/.test(text)) return "auth.timeout";
  if (/aadsts|authorization failed|invalid_grant|interaction_required|login/.test(text)) return "auth.failed";
  if (/\b403\b|forbidden|accessdenied|access denied/.test(text)) return "graph.forbidden";
  if (/\b404\b|not ?found|itemnotfound/.test(text)) return "graph.notFound";
  if (/\b429\b|throttl|toomanyrequests|\b503\b/.test(text)) return "graph.throttled";
  if (/graph request failed/.test(text)) return "graph.error";
  if (/no copilot|language model|consent|copilot/.test(text)) return "copilot.unavailable";
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|network|socket/.test(text)) return "network";
  return "unknown";
}

/** Short remediation hint per code, shown next to error notifications. */
export function adviceFor(code: ErrorCode): string | undefined {
  switch (code) {
    case "auth.cancelled":
      return undefined; // user action, no advice needed
    case "auth.timeout":
      return "The sign-in window may have been blocked. Try again, or use the device-code sign-in method.";
    case "auth.failed":
      return "Sign-in was rejected. Check with your administrator that this app is allowed in your tenant, or configure a custom client ID (see the admin guide).";
    case "graph.forbidden":
      return "Your account lacks permission for this site or the required Graph scope was not consented.";
    case "graph.notFound":
      return "The site URL could not be resolved. Check the URL and that the site still exists.";
    case "graph.throttled":
      // Shared by every rate-limited source (Graph, Splunk, Power BI, …).
      return "The service is rate-limiting requests. Wait a moment and retry.";
    case "copilot.unavailable":
      return "Install and sign in to GitHub Copilot, then retry.";
    case "network":
      return "Network request failed. Behind a corporate proxy or TLS-inspection appliance, check VS Code's proxy settings (http.proxy) and that login.microsoftonline.com / graph.microsoft.com are allowlisted — see the Admin Guide §3.";
    default:
      return undefined;
  }
}

/** Per-code advice is a FALLBACK: an AppError that carries its own
 *  remediation (userSummary) knows better than the generic text — a Splunk
 *  session expiry must never surface Entra tenant/client-ID guidance
 *  (pilot: "check with your administrator that this app is allowed in your
 *  tenant" shown for an expired splunkd cookie). */
export function adviceForError(err: unknown, code: ErrorCode): string | undefined {
  if (err instanceof AppError && err.userSummary) return undefined;
  return adviceFor(code);
}
