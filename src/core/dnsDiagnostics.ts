import { promises as dns } from "node:dns";

/**
 * DNS *vantage* diagnostics for link liveness checks (pure — no vscode import).
 *
 * On an Entra-joined workstation over a corporate VPN there are (at least) two
 * distinct DNS paths, and they can disagree:
 *
 *  - the **OS resolver stack** (`getaddrinfo`, what `dns.lookup` uses) — this
 *    is what applications actually get. It honors Windows NRPT rules, the VPN
 *    adapter's per-interface DNS ordering, and the hosts file, so a name like
 *    `wiki.corp.example` covered by an NRPT rule resolves through the VPN's
 *    DNS servers even when every other name uses the local resolver;
 *  - a **direct DNS query** (`dns.resolve*`, Node's c-ares path) — it queries
 *    the configured DNS servers directly and BYPASSES NRPT and the hosts file,
 *    so it shows what plain DNS (the local vantage) says about the name.
 *
 * Probing both paths tells us whether a fetch's `ENOTFOUND` means the link's
 * host is genuinely dead or merely *invisible from this network vantage*
 * (off-VPN, NRPT misrouting, split-horizon DNS). A fetch failure alone is NOT
 * evidence a link is broken.
 */

/** Outcome of probing one hostname over both DNS paths. Each side:
 *  `true` = resolved to at least one address, `false` = the path answered
 *  authoritatively that the name has no address (NXDOMAIN / no A/AAAA data),
 *  `"error"` = the path itself failed (timeout, unreachable/refusing server) —
 *  no verdict on the name. */
export interface DnsPathProbe {
  /** OS resolver stack (getaddrinfo — honors NRPT/VPN adapter ordering/hosts). */
  osPath: boolean | "error";
  /** Direct query to the configured DNS servers (c-ares — bypasses NRPT/hosts). */
  directPath: boolean | "error";
  /** When BOTH paths resolve: do their answer sets share an address? `false`
   *  means split-horizon DNS (same name, different answers per path). Absent
   *  unless both sides resolved. */
  addressesAgree?: boolean;
}

/** Injectable resolvers, for unit tests and callers with custom stacks. */
export interface DnsProbeIo {
  /** OS-path resolver; default `dns.lookup(host, { all: true })`. */
  lookup?: (host: string) => Promise<string[]>;
  /** Direct-path resolver; default `dns.resolve4` with `resolve6` fallback. */
  resolve?: (host: string) => Promise<string[]>;
}

/** c-ares / getaddrinfo codes that mean "the name has no address" (a REAL
 *  answer), as opposed to a transport failure (no answer at all). */
const NAME_HAS_NO_ADDRESS = new Set(["ENOTFOUND", "ENODATA", "NODATA", "NOTFOUND"]);

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

/** Default OS-path resolver: getaddrinfo via `dns.lookup` (all families). */
async function osLookup(host: string): Promise<string[]> {
  const all = await dns.lookup(host, { all: true });
  return all.map((a) => a.address);
}

/** Default direct-path resolver: A records, falling back to AAAA when the name
 *  exists but has no A data (an IPv6-only host must not read as "no address"). */
async function directResolve(host: string): Promise<string[]> {
  try {
    const v4 = await dns.resolve4(host);
    if (v4.length) return v4;
  } catch (err) {
    // Step to AAAA only on "name exists but has no A data". NXDOMAIN
    // (ENOTFOUND) and transport errors propagate — probeSide maps them.
    const code = errCode(err);
    if (code !== "ENODATA" && code !== "NODATA") throw err;
  }
  return dns.resolve6(host);
}

/** Run one resolver, mapping its outcome to a probe side + its addresses. */
async function probeSide(run: () => Promise<string[]>): Promise<{ state: boolean | "error"; addresses: string[] }> {
  try {
    const addresses = await run();
    return { state: addresses.length > 0, addresses };
  } catch (err) {
    return { state: NAME_HAS_NO_ADDRESS.has(errCode(err)) ? false : "error", addresses: [] };
  }
}

/**
 * Probe `host` over both DNS paths concurrently (see module doc). Never
 * throws — every failure is folded into the probe. Resolvers are injectable
 * for tests; defaults hit the real OS resolver and configured DNS servers.
 */
export async function probeDnsPaths(host: string, io?: DnsProbeIo): Promise<DnsPathProbe> {
  const [os, direct] = await Promise.all([
    probeSide(() => (io?.lookup ?? osLookup)(host)),
    probeSide(() => (io?.resolve ?? directResolve)(host)),
  ]);
  const probe: DnsPathProbe = { osPath: os.state, directPath: direct.state };
  if (os.state === true && direct.state === true) {
    // "Agree" = the answer sets share at least one address. Strict equality
    // would misread round-robin / partial answers as split-horizon.
    const directSet = new Set(direct.addresses);
    probe.addressesAgree = os.addresses.some((a) => directSet.has(a));
  }
  return probe;
}

export type DnsVerdict = "resolvable" | "split-dns" | "os-path-only" | "direct-only" | "unresolvable";

/**
 * Turn a two-path probe into a verdict + plain-language note for reports.
 * The note explains what the vantage says about the name — crucially, none of
 * these outcomes proves the LINK is broken; they explain why it couldn't be
 * verified from here.
 */
export function classifyDnsOutcome(probe: DnsPathProbe): { verdict: DnsVerdict; note: string } {
  if (probe.osPath === true && probe.directPath === true) {
    if (probe.addressesAgree === false) {
      return {
        verdict: "split-dns",
        note: "resolves on both DNS paths but to DIFFERENT addresses (split-horizon DNS) — the OS resolver (NRPT/VPN path) and a direct DNS query disagree; reachability depends on which answer this network vantage can route to",
      };
    }
    return {
      verdict: "resolvable",
      note: "resolves consistently via both the OS resolver and a direct DNS query — name resolution is healthy from this vantage",
    };
  }
  if (probe.osPath === true) {
    return {
      verdict: "os-path-only",
      note: "resolves via the OS resolver (NRPT/VPN path) but not by direct DNS query — a VPN-routed name; reachability depends on the VPN tunnel",
    };
  }
  if (probe.directPath === true) {
    return {
      verdict: "direct-only",
      note: "resolves by direct DNS query but NOT via the OS resolver — an NRPT/VPN DNS-path misconfiguration on this workstation is hiding the name from applications",
    };
  }
  return {
    verdict: "unresolvable",
    note: "not resolvable from this network vantage by either path — an intranet-only name (needs the VPN) or a genuinely dead host",
  };
}
