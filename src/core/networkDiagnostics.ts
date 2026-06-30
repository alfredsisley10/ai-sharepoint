/**
 * Auto-detect when a network failure is the work of a corporate proxy /
 * TLS-inspection appliance / web content filter — the dominant cause of "it
 * won't connect" inside enterprises — and return targeted, actionable guidance
 * instead of a bare "fetch failed". Pure + unit-tested; the fetch wrappers (HTTP
 * layer, Graph client) call this on failure and attach the result to an AppError.
 *
 * The detector is deliberately CONSERVATIVE: it only fires on specific filtering
 * signals (a 407, an untrusted re-signed TLS cert, a named appliance, a block
 * page, a proxy-unreachable error, a DNS failure). A plain API 403 or 500 with
 * no proxy fingerprint returns `undefined`, so callers fall back to their normal
 * error — we never cry "proxy!" at every error.
 */

export type NetworkFilterKind =
  | "tls-inspection" // proxy re-signs HTTPS with a CA the machine doesn't trust
  | "proxy-auth" // 407 — proxy demands credentials
  | "blocked" // content filter / category block page
  | "dns-filtered" // name resolution blocked or unavailable
  | "proxy-unreachable"; // the configured proxy itself can't be reached

export interface NetworkFilterDiagnosis {
  kind: NetworkFilterKind;
  /** Detected appliance/vendor, when its fingerprint appears. */
  vendor?: string;
  /** One-line factual statement of what was observed. */
  message: string;
  /** Multi-step, actionable remediation for the user. */
  summary: string;
}

/** Flatten an error (and its `cause` chain / AggregateError members) into one
 *  lowercased string, so signals that live in `err.cause.code` (where Node's
 *  fetch hides the TLS errno behind a generic "fetch failed") are visible. */
export function flattenNetworkError(err: unknown, depth = 0): string {
  if (err == null || depth > 4) return "";
  if (typeof err === "string") return err.toLowerCase();
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.name, err.message);
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") parts.push(code);
    const cause = (err as { cause?: unknown }).cause;
    if (cause) parts.push(flattenNetworkError(cause, depth + 1));
    const inner = (err as { errors?: unknown }).errors;
    if (Array.isArray(inner)) for (const e of inner) parts.push(flattenNetworkError(e, depth + 1));
  } else if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const k of ["message", "code", "reason"]) if (typeof o[k] === "string") parts.push(o[k] as string);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** Best-effort hostname from a URL (for messages). */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// Untrusted / re-signed TLS certificate — Node/OpenSSL codes, the human strings,
// and the Chromium net:: equivalents. The signature of SSL inspection.
const TLS_SIGNS =
  /self[ -]?signed cert|self_signed_cert_in_chain|depth_zero_self_signed_cert|unable_to_verify_leaf_signature|unable_to_get_issuer_cert(_locally)?|unable to (verify the first certificate|get local issuer)|cert_untrusted|err_cert_authority_invalid|err_cert_common_name_invalid|err_tls_cert_altname_invalid|ssl certificate problem|certificate is not trusted|untrusted root/;

// The configured proxy can't be reached (vs. the proxy blocking the target).
const PROXY_UNREACHABLE =
  /err_proxy_connection_failed|tunneling socket could not be established|proxy.{0,40}(econnrefused|enotfound|etimedout)|(econnrefused|etimedout).{0,40}proxy/;

// Name resolution failure — could be a DNS filter OR simply offline/VPN-off.
const DNS = /enotfound|eai_again|getaddrinfo|err_name_not_resolved/;

// Filter/block-page phrases. Kept proxy-specific (NOT a bare "access denied",
// which a normal API 403 emits) to avoid false positives.
const BLOCK_MARKERS =
  /request (was )?blocked|blocked by (your |the )?(organization|administrator|policy|network|proxy|firewall|web filter)|content filter|web filter|this (site|page|url|website|content) (is|has been) blocked|denied by policy|policy prohibits|url filtering|category[: ].{0,40}block|access to this (site|page|website) (is|has been) (denied|blocked|restricted)/;

const VENDORS: Array<[RegExp, string]> = [
  [/zscaler|zscloud|zpa\b/, "Zscaler"],
  [/netskope/, "Netskope"],
  [/forcepoint|websense/, "Forcepoint"],
  [/blue ?coat|bluecoat|proxysg|broadcom web|symantec web/, "Symantec / Blue Coat"],
  [/mcafee|skyhigh|web gateway/, "McAfee / Skyhigh"],
  [/cisco umbrella|opendns/, "Cisco Umbrella"],
  [/palo ?alto|pan-os|globalprotect|prisma access/, "Palo Alto"],
  [/fortinet|fortigate|fortiguard/, "Fortinet"],
  [/sophos/, "Sophos"],
  [/squid|x-squid-error/, "Squid"],
  [/cloudflare gateway|cloudflare access|cloudflared|warp/, "Cloudflare Gateway"],
  [/check ?point/, "Check Point"],
  [/barracuda/, "Barracuda"],
  [/\biboss\b/, "iboss"],
  [/trend ?micro|interscan/, "Trend Micro"],
];

function detectVendor(text: string): string | undefined {
  for (const [re, name] of VENDORS) if (re.test(text)) return name;
  return undefined;
}

function normHeaders(headers: Record<string, string> | Headers | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  const asHeaders = headers as { forEach?: (cb: (v: string, k: string) => void) => void };
  if (typeof asHeaders.forEach === "function") {
    // A WHATWG Headers instance (no own enumerable keys — must use forEach).
    asHeaders.forEach((v, k) => (out[k.toLowerCase()] = String(v)));
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/** Proxy/cache hop headers that betray an intermediary on the path. */
function hasProxyHeaders(h: Record<string, string>): boolean {
  return Boolean(h["via"] || h["x-cache"] || h["x-squid-error"] || h["x-bluecoat-via"] || h["proxy-authenticate"]);
}

function tlsAdvice(vendor?: string): string {
  return [
    `An SSL-inspecting proxy${vendor ? ` (${vendor})` : ""} is re-signing HTTPS with a certificate your machine doesn't trust — the most common cause of connection failures on a corporate network.`,
    "Fix it by TRUSTING the proxy's root CA (never by disabling certificate validation):",
    "• Easiest: set the NODE_EXTRA_CA_CERTS environment variable to your corporate root-CA .pem file, then relaunch VS Code.",
    '• Or import the CA into your OS trust store and keep VS Code\'s "http.systemCertificates": true (the default).',
    '• For LDAP / database sources, point "aiSharePoint.ldap.caCertificatesFile" at the CA bundle.',
    "Ask your IT/security team for the proxy's root certificate if you don't have it. See Admin Guide §3.",
  ].join("\n");
}

function proxyAuthAdvice(): string {
  return [
    "Your corporate proxy requires authentication (HTTP 407).",
    '• Set VS Code\'s "http.proxy" to your proxy URL with your credentials included (VS Code accepts the standard user-info form in the URL), or set "http.proxyAuthorization" to the proxy\'s auth header value, then reload the window.',
    "• If the proxy uses Kerberos/NTLM single sign-on, launch VS Code from your authenticated OS session so it can negotiate automatically.",
    "See Admin Guide §3.",
  ].join("\n");
}

function proxyUnreachableAdvice(): string {
  return [
    "VS Code couldn't reach the proxy itself (not the destination).",
    '• Check "http.proxy" host/port (or your system/PAC proxy) is correct.',
    "• Confirm the proxy service is up and that you're on the corporate network or VPN — an off-VPN laptop or a wrong port produces this.",
  ].join("\n");
}

function blockedAdvice(host: string | undefined, vendor?: string): string {
  const target = host ?? "the host";
  return [
    `${vendor ?? "A web content filter"} is blocking the connection to ${target}.`,
    `• Ask your network/security team to ALLOWLIST ${target} (and, for sign-in, login.microsoftonline.com and graph.microsoft.com).`,
    "• If the URL was mis-categorized, request a re-categorization.",
    `• Confirm by opening ${target} in a browser — a block page there proves the filter is the cause.`,
  ].join("\n");
}

function dnsAdvice(host: string | undefined): string {
  const target = host ?? "the server";
  return [
    `The name ${target} didn't resolve — either a DNS filter is blocking it, or you're offline / not on the VPN.`,
    `• Confirm ${target} opens in a browser. If the browser works but this doesn't, VS Code isn't using your proxy/PAC — set "http.proxy".`,
    "• If nothing resolves, reconnect to the network or VPN.",
  ].join("\n");
}

/**
 * Inspect a failed request for filtering/proxy fingerprints. Pass whatever is
 * available: the flattened error text (from `flattenNetworkError`), an HTTP
 * status, a response body, response headers, and the target host. Returns a
 * diagnosis only when a real signal is present, else `undefined`.
 */
export function detectProxyInterference(input: {
  errorText?: string;
  status?: number;
  bodyText?: string;
  headers?: Record<string, string> | Headers;
  host?: string;
}): NetworkFilterDiagnosis | undefined {
  const errText = (input.errorText ?? "").toLowerCase();
  const body = (input.bodyText ?? "").toLowerCase();
  const headers = normHeaders(input.headers);
  const headerText = Object.entries(headers)
    .map(([k, v]) => `${k} ${v}`)
    .join(" ")
    .toLowerCase();
  const combined = `${errText} ${body} ${headerText}`;
  const vendor = detectVendor(combined);
  const host = input.host;

  // 1. Proxy authentication required.
  if (input.status === 407 || /\b407\b|proxy authentication required|proxy-authenticate/.test(combined)) {
    return {
      kind: "proxy-auth",
      vendor,
      message: `The network proxy requires authentication (HTTP 407)${host ? ` before reaching ${host}` : ""}.`,
      summary: proxyAuthAdvice(),
    };
  }

  // 2. TLS interception — an untrusted, re-signed certificate.
  if (TLS_SIGNS.test(errText)) {
    return {
      kind: "tls-inspection",
      vendor,
      message: `The TLS certificate wasn't trusted${host ? ` for ${host}` : ""} — a sign of an SSL-inspecting proxy re-signing HTTPS with a corporate CA your machine doesn't trust.`,
      summary: tlsAdvice(vendor),
    };
  }

  // 3. The proxy itself is unreachable.
  if (PROXY_UNREACHABLE.test(errText)) {
    return {
      kind: "proxy-unreachable",
      vendor,
      message: "Couldn't reach the configured network proxy.",
      summary: proxyUnreachableAdvice(),
    };
  }

  // 4. A content-filter block page / category denial. Requires a real filter
  //    fingerprint (named vendor, block phrase, or proxy hop header) — never a
  //    bare status — so a normal API 403/500 isn't misread as a block.
  const blocked = Boolean(vendor) || BLOCK_MARKERS.test(combined) || hasProxyHeaders(headers);
  if (blocked) {
    return {
      kind: "blocked",
      vendor,
      message: `${vendor ?? "A web content filter"} appears to be blocking the connection${host ? ` to ${host}` : ""}.`,
      summary: blockedAdvice(host, vendor),
    };
  }

  // 5. DNS resolution failure (checked last: less specific than the above).
  if (DNS.test(errText)) {
    return {
      kind: "dns-filtered",
      vendor,
      message: `Couldn't resolve the server name${host ? ` (${host})` : ""}.`,
      summary: dnsAdvice(host),
    };
  }

  return undefined;
}

/** Convenience for fetch `catch` blocks: detect from a thrown error + host. */
export function detectProxyFromError(err: unknown, url?: string): NetworkFilterDiagnosis | undefined {
  return detectProxyInterference({ errorText: flattenNetworkError(err), host: hostOf(url) });
}
