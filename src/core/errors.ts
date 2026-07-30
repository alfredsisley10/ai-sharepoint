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

/**
 * Fields drivers put the real reason in when `message` is empty or useless.
 *
 * `err.message` is the obvious place and often the WRONG one: mysql2 puts the
 * server's text in `sqlMessage`, MongoDB in `errmsg`, node-postgres splits it
 * across `detail`/`hint`/`where`, and tedious wraps the original in
 * `originalError`. An extractor that reads only `.message` reports nothing at
 * all for those — which is how a log line ends in "failed: " with the reason
 * sitting unread on the object.
 */
const DETAIL_KEYS = ["sqlMessage", "errmsg", "detail", "hint", "where", "reason", "description"];
/** Object-valued fields worth descending into. */
const NESTED_KEYS = ["originalError", "info", "cause", "error", "err"];
/** Short codes worth appending — they are what a DBA searches for. */
const CODE_KEYS = ["code", "errno", "number", "state", "sqlState", "codeName", "severity", "class"];

/**
 * Everything readable about a thrown value, as one line — and NEVER the empty
 * string.
 *
 * A message that says only "failed:" is worse than useless: it looks like the
 * error was reported when it wasn't, so the reader stops looking. This walks
 * the message, the driver-specific detail fields, the aggregate members, and
 * the cause chain; if all of that is empty it falls back to the object's own
 * properties and finally to naming the type. Loop-safe and depth-bounded, so a
 * self-referencing error can't hang the logger.
 */
export function describeError(err: unknown): string {
  // `throw undefined` is legal and does happen. "failed: undefined" is at
  // least honest; "failed: " is the bug this function exists to prevent.
  if (err === undefined) return "undefined (nothing was thrown)";
  if (err === null) return "null (nothing was thrown)";
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const add = (text: string): void => {
    const t = text.trim();
    // Drivers repeat themselves (message === sqlMessage is common); a line that
    // says the same thing three times reads as noise and hides the codes.
    if (t && !parts.some((p) => p === t || p.includes(t))) parts.push(t);
  };
  const visit = (cur: unknown, depth: number): void => {
    if (cur === null || cur === undefined || depth > 4 || parts.length > 8) return;
    if (typeof cur !== "object") {
      add(String(cur));
      return;
    }
    if (seen.has(cur)) return;
    seen.add(cur);
    const e = cur as Record<string, unknown>;
    if (typeof e.message === "string") add(e.message);
    for (const k of DETAIL_KEYS) {
      if (typeof e[k] === "string") add(e[k] as string);
    }
    const codes = CODE_KEYS.filter((k) => typeof e[k] === "string" || typeof e[k] === "number").map(
      (k) => `${k}=${String(e[k])}`,
    );
    if (codes.length > 0) add(codes.join(" "));
    // AggregateError (and driver equivalents): the members carry the reasons.
    if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) visit(sub, depth + 1);
    for (const k of NESTED_KEYS) visit(e[k], depth + 1);
  };
  visit(err, 0);
  if (parts.length === 0) {
    // Nothing in the known places — dump what the object actually has rather
    // than giving up. Own property names include non-enumerables like `stack`
    // on Errors, which is why this is a last resort and not the first move.
    try {
      const own = JSON.stringify(err, Object.getOwnPropertyNames(Object(err)).slice(0, 20));
      if (own && own !== "{}" && own !== "null") add(own.slice(0, 400));
    } catch {
      /* circular or unserializable — fall through to the type name */
    }
  }
  if (parts.length === 0) {
    const s = String(err);
    add(
      s && s !== "[object Object]"
        ? s
        : `unreadable ${typeof err} value${
            (err as { constructor?: { name?: string } })?.constructor?.name
              ? ` (${(err as { constructor?: { name?: string } }).constructor!.name})`
              : ""
          }`,
    );
  }
  return parts.join(" | ");
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
