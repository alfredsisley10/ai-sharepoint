/**
 * Operating-system trust for LDAPS (ADR-0020 amendment, pilot finding:
 * "unable to get local issuer certificate").
 *
 * LDAP is raw TLS, so it bypasses VS Code's patched fetch stack and lands on
 * Node's bundled Mozilla CA list — which does not contain enterprise internal
 * CAs. This module assembles the CA set from, in order:
 *
 *   1. Node's bundled defaults (`tls.rootCertificates`) — public CAs keep
 *      working; passing an explicit `ca` REPLACES defaults, so they must be
 *      re-included.
 *   2. The OS trust store via `tls.getCACertificates("system")` (Node ≥22.15,
 *      cross-platform, no native code) — feature-detected.
 *   3. Well-known Linux CA bundle files (pure fs read).
 *   4. `NODE_EXTRA_CA_CERTS` (re-applied for explicit-`ca` contexts).
 *   5. An admin-pinned PEM bundle path (settings) — the deterministic answer
 *      on runtimes without (2).
 *
 * Pure Node module (fs/tls only) — unit-testable via splitPemBundle and an
 * injectable reader.
 */

import * as fs from "node:fs";
import * as tls from "node:tls";

const LINUX_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // RHEL/Fedora
  "/etc/ssl/ca-bundle.pem", // SUSE
];

/** Split a PEM bundle into individual certificates. */
export function splitPemBundle(text: string): string[] {
  return (
    text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  ).map((c) => c.trim());
}

export interface TrustSources {
  readFile?: (path: string) => string;
  systemCerts?: () => string[];
  env?: Record<string, string | undefined>;
}

let cached: { key: string; cas: string[] | undefined } | undefined;

/**
 * Build the CA list for LDAPS connections. Returns undefined when nothing
 * beyond Node's defaults is available — callers then omit `ca` entirely so
 * Node's standard behavior (defaults + NODE_EXTRA_CA_CERTS) applies untouched.
 */
export function loadTrustedCAs(
  pinnedBundlePath: string | undefined,
  sources?: TrustSources,
): string[] | undefined {
  const key = pinnedBundlePath ?? "";
  if (cached && cached.key === key && !sources) {
    return cached.cas;
  }

  const readFile =
    sources?.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const env = sources?.env ?? process.env;
  const extras: string[] = [];

  // OS trust store (Node ≥ 22.15) — feature-detected, never throws.
  try {
    const getCAs =
      sources?.systemCerts ??
      ((tls as unknown as { getCACertificates?: (t: string) => string[] })
        .getCACertificates
        ? () =>
            (
              tls as unknown as { getCACertificates: (t: string) => string[] }
            ).getCACertificates("system")
        : undefined);
    if (getCAs) {
      extras.push(...getCAs());
    }
  } catch {
    // OS store unreadable — continue with other sources.
  }

  for (const path of LINUX_BUNDLES) {
    try {
      extras.push(...splitPemBundle(readFile(path)));
      break; // one bundle is the full store
    } catch {
      // not present — try next
    }
  }

  for (const path of [env.NODE_EXTRA_CA_CERTS, pinnedBundlePath]) {
    if (!path?.trim()) continue;
    try {
      extras.push(...splitPemBundle(readFile(path.trim())));
    } catch {
      // unreadable pinned/extra bundle — surfaced via connection errors + docs
    }
  }

  let cas: string[] | undefined;
  if (extras.length > 0) {
    const seen = new Set<string>();
    cas = [...tls.rootCertificates, ...extras].filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
  }
  if (!sources) {
    cached = { key, cas };
  }
  return cas;
}

/** Test hook. */
export function clearTrustCache(): void {
  cached = undefined;
}
