import * as crypto from "node:crypto";

/**
 * Salted pseudonymization for diagnostics bundles (ADR-0018).
 *
 * Where the redaction layer (redaction.ts) *removes* values, this module
 * replaces them with stable, salted short-hashes so reports from the same
 * installation can be correlated ("the same tenant keeps failing") without
 * revealing the value. The salt never leaves the machine and rotates together
 * with the anonymous installation id, severing all prior correlation.
 *
 * Pure module (node:crypto only) — unit-testable.
 */

/** Salted SHA-256 short token, e.g. "anon-3fa9c41d2b". */
export function anonToken(value: string, salt: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${salt}:${value}`)
    .digest("hex");
  return `anon-${digest.slice(0, 10)}`;
}

/**
 * Anonymize a hostname while keeping its structural suffix readable:
 *   contoso.sharepoint.com  -> anon-ab12cd34ef.sharepoint.com
 *   contoso.sharepoint.us   -> anon-ab12cd34ef.sharepoint.us
 *   anything.else.example   -> anon-ab12cd34ef
 */
export function anonHost(host: string, salt: string): string {
  const lower = host.toLowerCase();
  const m = lower.match(
    /^([a-z0-9-]+)(\.sharepoint(?:-df)?\.(?:com|us|cn|de))$/,
  );
  if (m) {
    return `${anonToken(m[1], salt)}${m[2]}`;
  }
  return anonToken(lower, salt);
}

/** Anonymize the host portion of a URL; returns just the anonymized host. */
export function anonUrlHost(url: string, salt: string): string {
  try {
    return anonHost(new URL(url).hostname, salt);
  } catch {
    return anonToken(url, salt);
  }
}

/** Random identifiers for the anonymous installation id and hash salt. */
export function newAnonymousId(): string {
  return crypto.randomUUID();
}
