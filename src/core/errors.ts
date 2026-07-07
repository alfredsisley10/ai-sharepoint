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
  | "copilot.entitlement"
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
      // Provider-neutral on purpose: this is the FALLBACK for an auth
      // rejection whose thrower didn't attach its own summary, and it fires for
      // EVERY connector — Jira/Confluence/DB/LDAP/Splunk/ServiceNow/Grafana as
      // well as Microsoft sign-in. It must not presume Entra: a Jira basic-auth
      // 401 is a wrong username/password, not a tenant/client-ID problem
      // (pilot: after a password rotation, a rejected Jira credential surfaced
      // "check that this app is allowed in your tenant", which is nonsense for
      // basic auth). Lead with the universally-correct action; keep the Entra
      // path as a clearly-scoped aside.
      return "Sign-in was rejected. Re-enter the credential — the username, password, token, or session cookie may be wrong, expired, or revoked. (For a Microsoft/Entra sign-in only: also confirm this app is allowed in your tenant, or configure a custom client ID — see the admin guide.)";
    case "graph.forbidden":
      return "Your account lacks permission for this site or the required Graph scope was not consented.";
    case "graph.notFound":
      return "The site URL could not be resolved. Check the URL and that the site still exists.";
    case "graph.throttled":
      // Shared by every rate-limited source (Graph, Splunk, Power BI, …).
      return "The service is rate-limiting requests. Wait a moment and retry.";
    case "copilot.unavailable":
      return "Install and sign in to GitHub Copilot, then retry.";
    case "copilot.entitlement":
      return "GitHub answered “not authorized for this Copilot feature” (403). Common causes: the Copilot subscription/seat lapsed, or an organization policy disables the feature (an org admin can check GitHub → Copilot → Policies). Requests are paused briefly so the refusal isn't hammered — run “Check Copilot Status” to retry once it's fixed.";
    case "network":
      // Fallback only — a fingerprinted proxy/TLS-inspection/filter failure
      // carries its own targeted summary (see core/networkDiagnostics). This
      // covers the un-fingerprinted case, which is HOST-AGNOSTIC by definition:
      // the failing host may be any connector (Jira, Postgres, LDAP, a Grafana
      // instance…), NOT necessarily a Microsoft endpoint. Naming
      // login.microsoftonline.com / graph.microsoft.com here was wrong — it told
      // users of non-Microsoft connectors to allowlist Microsoft hosts (pilot: a
      // Jira basic-auth refresh reported it "could not access Microsoft Graph").
      // Keep the remediation about the connector's OWN host.
      return "Network request failed — the service couldn't be reached. On a corporate network this is usually a proxy or TLS-inspection appliance: check VS Code's \"http.proxy\", trust the proxy's root CA (e.g. NODE_EXTRA_CA_CERTS / \"http.systemCertificates\"), and confirm this connector's host is allowlisted — see Admin Guide §3.";
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
