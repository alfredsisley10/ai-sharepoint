/**
 * Active Directory endpoint auto-discovery (ADR-0020). Pure and injectable:
 * workstation signals + a DNS resolver are passed in, so the whole thing is
 * unit-testable without a domain-joined host or a live DC.
 *
 * Strategy mirrors the Windows DC-locator: derive the DNS domain from the
 * workstation, resolve the AD SRV records, and rank candidates by SRV
 * priority/weight. Global Catalog (forest-wide) is preferred over a single
 * domain controller for breadth of read.
 */

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface DnsResolver {
  resolveSrv(name: string): Promise<SrvRecord[]>;
}

/** Everything we can learn from the workstation, injected for testability. */
export interface HostSignals {
  env: Record<string, string | undefined>;
  /** os.hostname() — may be short or FQDN. */
  hostname: string;
  /** Contents of /etc/resolv.conf on POSIX, if readable. */
  resolvConf?: string;
  /** os.userInfo().username — seeds the bind UPN. */
  username?: string;
}

export interface LdapCandidate {
  /** ldap:// or ldaps:// URL. */
  url: string;
  host: string;
  port: number;
  /** "dc" = domain controller, "gc" = global catalog (forest-wide). */
  kind: "dc" | "gc";
  secure: boolean;
}

export interface DiscoveryResult {
  domain: string;
  baseDn: string;
  candidates: LdapCandidate[];
  /** Human-readable note on which signal produced the domain. */
  via: string;
}

/** "corp.example.com" → "DC=corp,DC=example,DC=com". */
export function domainToBaseDn(domain: string): string {
  return domain
    .split(".")
    .filter(Boolean)
    .map((part) => `DC=${part}`)
    .join(",");
}

/** Candidate DNS domains from workstation signals, most-authoritative first. */
export function collectDomainSignals(signals: HostSignals): Array<{ domain: string; via: string }> {
  const out: Array<{ domain: string; via: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, via: string) => {
    const domain = (raw ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (domain && domain.includes(".") && !seen.has(domain)) {
      seen.add(domain);
      out.push({ domain, via });
    }
  };

  // 1. Gold signal on domain-joined Windows.
  add(signals.env.USERDNSDOMAIN, "USERDNSDOMAIN (Windows domain membership)");

  // 2. The exact DC the user logged on to → its DNS suffix.
  const logon = signals.env.LOGONSERVER?.replace(/^\\+/, "");
  if (logon && signals.env.USERDNSDOMAIN) {
    add(signals.env.USERDNSDOMAIN, `LOGONSERVER ${logon}`);
  }

  // 3. Host FQDN minus the leading hostname label.
  if (signals.hostname.includes(".")) {
    add(signals.hostname.split(".").slice(1).join("."), "host FQDN");
  }

  // 4. POSIX resolver search/domain lines.
  if (signals.resolvConf) {
    for (const line of signals.resolvConf.split("\n")) {
      const m = line.match(/^\s*(?:search|domain)\s+(.+)$/i);
      if (m) {
        for (const d of m[1].trim().split(/\s+/)) {
          add(d, "resolv.conf");
        }
      }
    }
  }
  return out;
}

/** Default bind UPN guess from the username + discovered domain. */
export function guessBindUpn(signals: HostSignals, domain: string): string | undefined {
  const user = signals.username?.trim();
  if (!user) return undefined;
  if (user.includes("@") || user.includes("\\")) return user;
  return `${user}@${domain}`;
}

function rank(records: SrvRecord[]): SrvRecord[] {
  return [...records].sort(
    (a, b) => a.priority - b.priority || b.weight - a.weight || a.name.localeCompare(b.name),
  );
}

/**
 * Resolve AD SRV records for a domain and build ranked LDAP candidates.
 * GC (global catalog) first, then domain controllers. Returns [] if the
 * domain has no AD SRV records (so callers can fall through to the next
 * candidate domain or manual entry).
 */
export async function discoverForDomain(
  resolver: DnsResolver,
  domain: string,
): Promise<LdapCandidate[]> {
  const gcName = `_gc._tcp.${domain}`;
  const dcName = `_ldap._tcp.dc._msdcs.${domain}`;

  const [gc, dc] = await Promise.all([
    resolver.resolveSrv(gcName).catch(() => [] as SrvRecord[]),
    resolver.resolveSrv(dcName).catch(() => [] as SrvRecord[]),
  ]);

  const candidates: LdapCandidate[] = [];
  const pushed = new Set<string>();
  const push = (host: string, kind: "dc" | "gc") => {
    const port = kind === "gc" ? 3269 : 636; // prefer secure ports
    const key = `${kind}:${host}`;
    if (host && !pushed.has(key)) {
      pushed.add(key);
      candidates.push({
        url: `ldaps://${host}:${port}`,
        host,
        port,
        kind,
        secure: true,
      });
    }
  };

  for (const r of rank(gc)) push(r.name.replace(/\.$/, ""), "gc");
  for (const r of rank(dc)) push(r.name.replace(/\.$/, ""), "dc");
  return candidates;
}

/**
 * Full discovery: try each domain signal until one yields AD SRV records.
 * Throws a descriptive error only when nothing resolves anywhere.
 */
export async function discover(
  resolver: DnsResolver,
  signals: HostSignals,
): Promise<DiscoveryResult> {
  const domains = collectDomainSignals(signals);
  if (domains.length === 0) {
    throw new Error(
      "Could not determine a DNS domain from this workstation (no USERDNSDOMAIN, host FQDN, or resolv.conf search domain). Enter the AD server and base DN manually.",
    );
  }
  const tried: string[] = [];
  for (const { domain, via } of domains) {
    tried.push(domain);
    const candidates = await discoverForDomain(resolver, domain);
    if (candidates.length > 0) {
      return { domain, baseDn: domainToBaseDn(domain), candidates, via };
    }
  }
  // No SRV records, but we still know a domain → offer a best-effort default.
  const best = domains[0];
  throw new Error(
    `No Active Directory SRV records found via DNS for: ${tried.join(", ")}. ` +
      `If you know a domain controller, add it manually (base DN would be ${domainToBaseDn(best.domain)}).`,
  );
}
