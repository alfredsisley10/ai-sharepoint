/**
 * Durable LDAP endpoint locators (ADR-0020 amendment).
 *
 * When endpoints come from DNS SRV discovery, the source must NOT pin the
 * server DNS happened to return at add time — domain controllers are rotated,
 * renamed, and retired. Instead the descriptor stores the *lookup itself* as
 * a pseudo-URL (`ldaps+srv://_gc._tcp.corp.example`), re-resolved on every
 * connection with ranked failover — the same durability model as the Windows
 * DC locator. Static `ldap(s)://host` URLs remain supported for manually
 * entered servers. Pure module.
 */

import { SrvRecord } from "./discovery";

export type LdapTarget =
  | { kind: "static"; url: string }
  | {
      kind: "srv";
      /** Full SRV record name, e.g. _gc._tcp.corp.example */
      srvName: string;
      /** ldaps+srv → implicit TLS on the secure port for the record type. */
      secure: boolean;
    };

export function gcSrvName(domain: string): string {
  return `_gc._tcp.${domain}`;
}

export function dcSrvName(domain: string): string {
  return `_ldap._tcp.dc._msdcs.${domain}`;
}

/** Durable locator URL for a discovered domain. */
export function srvLocatorUrl(domain: string, record: "gc" | "dc"): string {
  return `ldaps+srv://${record === "gc" ? gcSrvName(domain) : dcSrvName(domain)}`;
}

export function isSrvLocator(baseUrl: string): boolean {
  return /^ldaps?\+srv:\/\//i.test(baseUrl.trim());
}

/** Parse a source baseUrl into a connect target. */
export function parseLdapTarget(baseUrl: string): LdapTarget {
  const trimmed = baseUrl.trim();
  const m = trimmed.match(/^(ldaps?)\+srv:\/\/([^/?#\s]+)/i);
  if (m) {
    return {
      kind: "srv",
      srvName: m[2].toLowerCase(),
      secure: m[1].toLowerCase() === "ldaps",
    };
  }
  return { kind: "static", url: trimmed };
}

/** SRV ranking: lowest priority first, then highest weight (RFC 2782 spirit). */
export function rankSrv(records: SrvRecord[]): SrvRecord[] {
  return [...records].sort(
    (a, b) => a.priority - b.priority || b.weight - a.weight || a.name.localeCompare(b.name),
  );
}

/**
 * Secure-port mapping for AD: SRV records advertise the plaintext ports
 * (3268 GC / 389 DC); implicit-TLS listeners are fixed companions.
 */
function securePortFor(srvName: string): number {
  return srvName.startsWith("_gc.") ? 3269 : 636;
}

/**
 * Resolved, ranked connect URLs for a target (capped for bounded failover).
 * Static targets resolve to themselves.
 */
export function candidateUrls(
  target: LdapTarget,
  records: SrvRecord[],
  max = 3,
): string[] {
  if (target.kind === "static") {
    return [target.url];
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const r of rankSrv(records)) {
    const host = r.name.replace(/\.$/, "");
    if (!host || seen.has(host)) continue;
    seen.add(host);
    urls.push(
      target.secure
        ? `ldaps://${host}:${securePortFor(target.srvName)}`
        : `ldap://${host}:${r.port}`,
    );
    if (urls.length >= max) break;
  }
  return urls;
}
