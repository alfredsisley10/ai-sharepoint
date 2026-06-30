/**
 * Verbose wire logging: one process-global tap that every integration
 * (Graph, Confluence/Jira HTTP, MSAL token endpoints, LDAP, databases,
 * Power BI, Copilot/vscode.lm) emits request/response events into.
 *
 * Redaction is layered and fail-closed:
 *  1. STRUCTURAL — taps never hand secrets to this module: Authorization
 *     headers are reduced to their scheme, token-endpoint bodies are
 *     withheld entirely, bind/login passwords are never in the strings.
 *  2. KEY-BASED — `safeJson` masks values of secret-shaped keys
 *     (password/token/secret/credential/…) in anything that is logged.
 *  3. REGEX — the extension-side sink writes through the Logger, which
 *     applies the global `redactText` pass to every line (same engine
 *     that guards diagnostics exports).
 *
 * When no sink is installed (the default), emitting is a no-op and the
 * `wireEnabled()` guard lets call sites skip building detail strings.
 */

export interface WireEvent {
  /** Integration tag: graph, http, msal, ldap, mssql, postgres, mysql,
   *  mongodb, powerbi, copilot, tool. */
  integration: string;
  /** "→" request · "←" response · "✗" failure. */
  direction: "→" | "←" | "✗";
  /** One line: METHOD/operation, target, status, duration. */
  summary: string;
  /** Optional capped multi-line payload detail (already structurally safe). */
  detail?: string;
}

export type WireSink = (event: WireEvent) => void;

let sink: WireSink | undefined;

export function setWireSink(next: WireSink | undefined): void {
  sink = next;
}

export function wireEnabled(): boolean {
  return sink !== undefined;
}

export function emitWire(
  integration: string,
  direction: WireEvent["direction"],
  summary: string,
  detail?: string,
): void {
  try {
    sink?.({ integration, direction, summary, ...(detail ? { detail } : {}) });
  } catch {
    // Logging must never break the integration it observes.
  }
}

/** Per-event payload cap — wire logs are for inspection, not archival. */
export const WIRE_DETAIL_CAP = 4_000;

export function capDetail(s: string): string {
  return s.length > WIRE_DETAIL_CAP
    ? `${s.slice(0, WIRE_DETAIL_CAP)}… [${s.length - WIRE_DETAIL_CAP} more chars truncated]`
    : s;
}

const SECRET_KEY_RE =
  /pass(word)?|secret|token|credential|authorization|assertion|cookie|api[-_]?key|private[-_]?key|session/i;

/** Headers whose NAME matches SECRET_KEY_RE but whose value is a fixed,
 *  non-secret marker — never masked, so the wire log can be used to confirm
 *  they actually left the client (e.g. the CSRF bypass token "no-check"). */
const NON_SECRET_HEADER_RE = /^x-atlassian-token$/i;

/** Mask secret-shaped keys recursively, then stringify + cap. Safe on
 *  any value (cycles fall back to a placeholder). */
export function safeJson(value: unknown): string {
  const mask = (v: unknown, depth: number): unknown => {
    if (depth > 6 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => mask(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***" : mask(val, depth + 1);
    }
    return out;
  };
  try {
    return capDetail(JSON.stringify(mask(value, 0), null, 1) ?? String(value));
  } catch {
    return "[unserializable payload]";
  }
}

/** Render headers with secret-bearing values reduced to their scheme
 *  ("Bearer ***") or fully masked. */
export function safeHeaders(headers: Record<string, string | undefined>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (SECRET_KEY_RE.test(k) && !NON_SECRET_HEADER_RE.test(k)) {
      const scheme = v.match(/^(Basic|Bearer|Negotiate|NTLM)\b/i)?.[1];
      lines.push(`${k}: ${scheme ? `${scheme} ***` : "***"}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

/** Mask credential material that can appear inside URLs (user:pass@host,
 *  token/key/code query parameters). */
export function safeUrl(url: string): string {
  return url
    .replace(/\/\/([^/@:]+):([^/@]+)@/, "//$1:***@")
    .replace(/([?&](?:access_)?(?:token|key|code|secret|sig|signature|password)=)[^&#\s]+/gi, "$1***");
}
