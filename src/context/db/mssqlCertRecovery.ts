/**
 * Recovering from a SQL Server TLS certificate failure (pure).
 *
 * The common pilot case: a DBA hands out an IP or a short NetBIOS name, the
 * server presents a certificate issued for its FQDN, and the TLS handshake fails
 * with a name mismatch. Node's error for that case is unusually helpful — it
 * lists exactly which names the certificate IS valid for:
 *
 *   Hostname/IP does not match certificate's altnames:
 *     Host: 10.4.2.9. is not in the cert's altnames: DNS:sql01.corp.example, DNS:sql01
 *
 * so we can offer "connect as sql01.corp.example instead" rather than making the
 * user guess, restart the wizard, or reach for "trust everything".
 *
 * Pure module — no vscode, no network — so the parsing (which faces
 * inconsistent, version-dependent error text) is unit-tested.
 */

export type TlsFailureKind =
  | "altname-mismatch"
  | "untrusted-chain"
  | "self-signed"
  | "expired"
  | "other-tls";

/** Is this error a TLS/certificate problem at all, and which kind? Returns
 *  undefined for non-TLS failures (bad password, wrong database, timeout …),
 *  which must NOT be offered certificate remedies. */
export function classifyTlsFailure(message: string): TlsFailureKind | undefined {
  const m = message ?? "";
  // Order matters: the altname message also contains the word "certificate",
  // and an expired self-signed cert should read as expired.
  if (/ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate's altnames|altnames/i.test(m)) {
    return "altname-mismatch";
  }
  if (/CERT_HAS_EXPIRED|certificate has expired|NotAfter/i.test(m)) return "expired";
  if (/DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|self[- ]signed certificate/i.test(m)) {
    return "self-signed";
  }
  if (/UNABLE_TO_(GET|VERIFY)_[A-Z_]*ISSUER|unable to get local issuer|unable to verify the first certificate|UNABLE_TO_GET_ISSUER_CERT/i.test(m)) {
    return "untrusted-chain";
  }
  // Anything that still mentions a certificate is a TLS problem we can offer
  // "trust the certificate" for, even if we can't name the exact cause.
  if (/certificate|TLS handshake|SSL routines/i.test(m)) return "other-tls";
  return undefined;
}

export interface CertAltNames {
  /** The name/IP we actually connected as, when the error reports it. */
  presentedHost?: string;
  /** DNS names from the certificate, in the order the error listed them. */
  dnsNames: string[];
  /** IP entries from the certificate. */
  ipNames: string[];
}

/**
 * Pull the certificate's valid names out of a name-mismatch error. Tolerates
 * the several shapes Node has used (`DNS:a, DNS:b`, `IP Address:1.2.3.4`, and a
 * bare comma list) and returns empty arrays rather than throwing on anything
 * unrecognized — a failed parse must degrade to "we couldn't suggest a name",
 * never to a crash mid-wizard.
 */
export function parseCertAltNames(message: string): CertAltNames {
  const out: CertAltNames = { dnsNames: [], ipNames: [] };
  if (!message) return out;
  const host = message.match(/Host:\s*([^\s.,]+(?:\.[^\s.,]+)*)\.?\s+is not in/i);
  if (host) out.presentedHost = host[1];

  // Node's message says "altnames" TWICE — "does not match certificate's
  // altnames: Host: … is not in the cert's altnames: DNS:…" — so take the LAST
  // occurrence; the first is followed by the presented host, not the list.
  const parts = message.split(/altnames:\s*/i);
  const tail = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (!tail) return out;
  // Stop at the end of the list (a following sentence or the frame's end).
  const list = tail.split(/[\n\r]| — |; /)[0] ?? "";
  for (const raw of list.split(",")) {
    const entry = raw.trim().replace(/\.$/, "");
    if (!entry) continue;
    const dns = entry.match(/^DNS:(.+)$/i);
    if (dns) {
      out.dnsNames.push(dns[1].trim());
      continue;
    }
    const ip = entry.match(/^IP(?:\s*Address)?:(.+)$/i);
    if (ip) {
      out.ipNames.push(ip[1].trim());
      continue;
    }
    // A bare name in the list (older Node) — treat as DNS when it looks like one.
    if (/^[A-Za-z0-9*][A-Za-z0-9.*-]*$/.test(entry)) out.dnsNames.push(entry);
  }
  return out;
}

export interface NameSuggestion {
  /** The host to connect as. */
  host: string;
  /** Why we're suggesting it, shown to the user. */
  reason: string;
}

const isIpLiteral = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");

/**
 * Rank connection names to offer, given the certificate's names and what the
 * user typed.
 *
 * Rules that matter:
 *  - **Wildcards can't be dialed.** `*.corp.example` is not a hostname; when the
 *    user's host has a matching suffix we can propose the concrete name their
 *    short name implies, otherwise we drop it rather than suggest something
 *    that cannot connect.
 *  - **Prefer the FQDN.** A cert usually lists both `sql01` and
 *    `sql01.corp.example`; the qualified one is far more likely to resolve.
 *  - **A name that expands what the user typed ranks first** — connecting by IP
 *    or short name and the cert naming the FQDN is the single most common case.
 *  - The host already in use is never suggested back.
 */
export function suggestConnectionNames(currentHost: string, alt: CertAltNames): NameSuggestion[] {
  const current = (currentHost ?? "").trim().toLowerCase();
  const shortOfCurrent = current.split(".")[0];
  const seen = new Set<string>([current]);
  const scored: Array<NameSuggestion & { score: number }> = [];

  for (const raw of alt.dnsNames) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name.startsWith("*.")) {
      // Wildcard: only actionable if we can build a concrete name from what the
      // user typed (their short name + the wildcard's domain).
      const domain = name.slice(2);
      if (!shortOfCurrent || isIpLiteral(current) || !domain) continue;
      const candidate = `${shortOfCurrent}.${domain}`;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      scored.push({
        host: candidate,
        reason: `matches the certificate's wildcard ${raw.trim()}`,
        score: 40,
      });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const qualified = name.includes(".");
    // The strongest signal: the cert name is the qualified form of what the
    // user typed (they used the short name or an IP).
    const expandsCurrent = qualified && (name.split(".")[0] === shortOfCurrent || isIpLiteral(current));
    scored.push({
      host: name,
      reason: expandsCurrent
        ? `the certificate's full name for this server`
        : qualified
          ? `named on the server's certificate`
          : `named on the certificate (short name — may not resolve)`,
      score: (expandsCurrent ? 100 : qualified ? 70 : 30),
    });
  }
  // IP entries are valid to connect to but rarely help when the user already
  // used an IP; offered last so a name is always preferred.
  for (const raw of alt.ipNames) {
    const ip = raw.trim();
    if (!ip || seen.has(ip.toLowerCase())) continue;
    seen.add(ip.toLowerCase());
    scored.push({ host: ip, reason: "an IP listed on the certificate", score: 20 });
  }
  return scored.sort((a, b) => b.score - a.score).map(({ host, reason }) => ({ host, reason }));
}

/**
 * Replace the host in an mssql:// URL, preserving port, database, and every
 * query parameter (instance, trustServerCertificate, …). Returns the input
 * unchanged if it can't be parsed — the caller is mid-wizard and must not lose
 * the user's work to a malformed URL.
 */
export function withMssqlHost(url: string, newHost: string): string {
  try {
    const u = new URL(url);
    u.hostname = newHost.trim();
    return u.toString();
  } catch {
    return url;
  }
}

/** Set (or clear) ?trustServerCertificate=true on an mssql:// URL. */
export function withTrustServerCertificate(url: string, trust: boolean): string {
  try {
    const u = new URL(url);
    if (trust) u.searchParams.set("trustServerCertificate", "true");
    else u.searchParams.delete("trustServerCertificate");
    return u.toString();
  } catch {
    return url;
  }
}

/** The host currently in an mssql:// URL (empty when unparseable). */
export function mssqlHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * The note appended to a SQL Server TLS failure when the connection asked to
 * trust the certificate but the machine-scoped allowance is off.
 *
 * Without this the option looks broken: the user ticks "Trust server
 * certificate", the connection fails on the very same certificate error, and the
 * only trace that the request was dropped is a wire-log line they never see.
 */
export const TRUST_IGNORED_HINT =
  "This connection asked to trust the server certificate, but that was IGNORED because the machine-scoped setting aiSharePoint.db.allowTrustServerCertificate is off — certificate validation stayed ON. Enable that setting (or reconnect and choose to trust, which offers to enable it) to honor the request.";

/** Append the ignored-trust explanation to an error message when it applies. */
export function withTrustIgnoredHint(message: string, trustIgnored: boolean): string {
  if (!trustIgnored || message.includes("allowTrustServerCertificate")) return message;
  return `${message} — ${TRUST_IGNORED_HINT}`;
}

/** A short, human explanation of the failure for the recovery prompt. */
export function describeTlsFailure(kind: TlsFailureKind, alt: CertAltNames): string {
  switch (kind) {
    case "altname-mismatch": {
      const names = [...alt.dnsNames, ...alt.ipNames].slice(0, 4).join(", ");
      return `The server's certificate isn't valid for "${alt.presentedHost ?? "the name you entered"}"${
        names ? ` — it's issued for ${names}` : ""
      }.`;
    }
    case "expired":
      return "The server's certificate has expired.";
    case "self-signed":
      return "The server uses a self-signed certificate that isn't trusted by this machine.";
    case "untrusted-chain":
      return "The server's certificate was issued by a CA this machine doesn't trust (often a corporate/internal CA).";
    default:
      return "The TLS handshake with the server failed on certificate validation.";
  }
}
