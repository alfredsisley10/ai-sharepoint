import * as tls from "node:tls";
import { loadTrustedCAs } from "../context/ldap/osTrust";

/**
 * Make the extension's HTTP (Node's global `fetch`/undici AND `https`) trust the
 * OS / enterprise certificate store — not just Node's bundled Mozilla roots.
 *
 * This is the fix for a TLS-inspecting corporate proxy whose re-signing CA the
 * device (and Edge/Chrome) trust but Node doesn't: `fetch` verifies against the
 * bundled roots and dies with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. VS Code's
 * proxy-agent loads the system store into `https.globalAgent`, but "global
 * agents do not affect fetch()", so token/Graph/connectivity calls still fail.
 *
 * The lever is `tls.setDefaultCACertificates` (Node ≥ 22.15): it augments the
 * DEFAULT TLS context that undici's `fetch` and `https` both use, so it fixes
 * fetch WITHOUT touching the dispatcher — VS Code's proxy handling is preserved.
 * On older runtimes (VS Code 1.95 = Node 20) the API is absent, so this is a
 * no-op and the fallback is `NODE_EXTRA_CA_CERTS` / the pinned CA-file setting
 * (see the connectivity-probe guidance and the Trust-Proxy-CA command).
 */

export type FetchTrustResult =
  | { applied: true; total: number }
  | { applied: false; reason: "no-extra-cas" | "unsupported-runtime" | "error"; detail?: string };

interface TlsWithDefaults {
  setDefaultCACertificates?: (certs: ReadonlyArray<string | Buffer>) => void;
}

export function installFetchTrust(pinnedBundlePath?: string): FetchTrustResult {
  const setDefault = (tls as unknown as TlsWithDefaults).setDefaultCACertificates;
  if (typeof setDefault !== "function") return { applied: false, reason: "unsupported-runtime" };
  try {
    // loadTrustedCAs returns Node's defaults PLUS the OS-store / bundle / env /
    // pinned extras — or undefined when there's nothing beyond the defaults.
    const cas = loadTrustedCAs(pinnedBundlePath);
    if (!cas || cas.length === 0) return { applied: false, reason: "no-extra-cas" };
    setDefault(cas);
    return { applied: true, total: cas.length };
  } catch (err) {
    return { applied: false, reason: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
