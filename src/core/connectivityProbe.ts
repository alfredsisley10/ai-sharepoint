/**
 * "Test Network / Proxy Connectivity" — the pure core. The command (in
 * extension.ts) performs the actual HTTPS round-trips; everything that decides
 * *what a result means* lives here so it can be unit-tested without a network.
 *
 * The logic reuses the same conservative detector the live request paths use
 * (networkDiagnostics): a probe is "reachable" when the HTTP round-trip
 * completes without a proxy/filter fingerprint — ANY status, even 401/403,
 * proves the path to the server is clear (those are application-level answers).
 * A thrown error or a block-page/407 response means a corporate proxy / SSL
 * inspector / content filter is in the way, and we surface its targeted advice.
 */

import {
  NetworkFilterDiagnosis,
  detectProxyInterference,
  detectProxyFromError,
  hostOf,
} from "./networkDiagnostics";

export interface ProbeTarget {
  /** Human label for the report ("Microsoft sign-in"). */
  label: string;
  url: string;
}

/**
 * The hosts every Microsoft-backed connector (SharePoint, Outlook, OneDrive,
 * file sources) and all sign-in flows depend on. Both expose an unauthenticated
 * surface, so a clean reach proves the path without needing credentials:
 *  - the sign-in authority's OpenID metadata (always 200 JSON), and
 *  - Graph (a 401 is a *success* signal here — the request reached Graph).
 */
export const DEFAULT_PROBE_TARGETS: ProbeTarget[] = [
  { label: "Microsoft sign-in", url: "https://login.microsoftonline.com/common/.well-known/openid-configuration" },
  { label: "Microsoft Graph API", url: "https://graph.microsoft.com/v1.0/$metadata" },
];

/** What the network attempt produced — either a response (any status) or a
 *  thrown error. Filled in by the command; consumed by `interpretProbe`. */
export interface ProbeOutcome {
  status?: number;
  /** A small leading snippet of the body — enough to spot a block page. */
  bodyText?: string;
  headers?: Record<string, string> | Headers;
  /** Set when the request threw (TLS/connect/DNS failure). */
  error?: unknown;
}

export interface ProbeReport {
  label: string;
  host: string;
  /** True when the HTTP round-trip completed with no filter fingerprint. */
  reachable: boolean;
  status?: number;
  /** Present only when a proxy/filter/TLS-inspection signal was detected. */
  diagnosis?: NetworkFilterDiagnosis;
  /** One-line human summary for the report. */
  detail: string;
}

/** Decide what a single probe outcome means. Pure. */
export function interpretProbe(target: ProbeTarget, outcome: ProbeOutcome): ProbeReport {
  const host = hostOf(target.url) ?? target.url;
  const base = { label: target.label, host };

  if (outcome.error !== undefined) {
    const diagnosis = detectProxyFromError(outcome.error, target.url);
    return {
      ...base,
      reachable: false,
      diagnosis,
      detail: diagnosis
        ? `${diagnosis.kind === "tls-inspection" ? "TLS intercepted" : diagnosis.kind === "dns-filtered" ? "DNS blocked/unresolved" : diagnosis.kind === "proxy-auth" ? "Proxy demands authentication" : diagnosis.kind === "proxy-unreachable" ? "Configured proxy unreachable" : "Blocked by a content filter"}${diagnosis.vendor ? ` (${diagnosis.vendor})` : ""}.`
        : `Couldn't connect — ${firstLine(errorText(outcome.error))}.`,
    };
  }

  // A response came back. A content filter can still answer with its own block
  // page or a 407, so run the same detector over the response shape.
  const diagnosis = detectProxyInterference({
    status: outcome.status,
    bodyText: outcome.bodyText,
    headers: outcome.headers,
    host,
  });
  if (diagnosis) {
    return {
      ...base,
      reachable: false,
      status: outcome.status,
      diagnosis,
      detail: `${diagnosis.vendor ? `${diagnosis.vendor} ` : ""}${diagnosis.kind === "proxy-auth" ? "proxy requires authentication" : "content filter"} (HTTP ${outcome.status ?? "?"}).`,
    };
  }
  return {
    ...base,
    reachable: true,
    status: outcome.status,
    detail: `Reachable (HTTP ${outcome.status ?? "?"}).`,
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/** Render the collected reports as a plain-text block for the Output channel. */
export function renderConnectivityReport(reports: ProbeReport[], stampIso: string): string {
  const lines: string[] = [
    "AI SharePoint — Network / Proxy Connectivity Check",
    stampIso,
    "",
  ];
  for (const r of reports) {
    lines.push(`${r.reachable ? "✓" : "✗"} ${r.label} — ${r.host}`);
    lines.push(`    ${r.detail}`);
    if (r.diagnosis) {
      for (const adviceLine of r.diagnosis.summary.split("\n")) {
        lines.push(`    ${adviceLine}`);
      }
    }
    lines.push("");
  }
  const blocked = reports.filter((r) => !r.reachable);
  lines.push(
    blocked.length === 0
      ? "All endpoints reachable — no proxy/filter interference detected."
      : `${blocked.length} of ${reports.length} endpoint(s) appear blocked or filtered (see guidance above).`,
  );
  return lines.join("\n");
}

/** A short, single-line summary for the notification toast. */
export function summarizeConnectivity(reports: ProbeReport[]): { ok: boolean; message: string } {
  const blocked = reports.filter((r) => !r.reachable);
  if (blocked.length === 0) {
    return { ok: true, message: `All ${reports.length} Microsoft endpoint(s) reachable — no proxy/filter interference detected.` };
  }
  const lead = blocked[0]!;
  return {
    ok: false,
    message: `${blocked.length} of ${reports.length} endpoint(s) blocked or filtered. ${lead.host}: ${lead.detail}`,
  };
}
