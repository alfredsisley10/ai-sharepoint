import { Client } from "ldapts";
import { promises as dnsPromises } from "node:dns";
import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ContextItem,
  ReadCaps,
} from "../types";
import {
  DEFAULT_ATTRIBUTES,
  buildFilter,
  entryToHit,
  entryToItem,
  RawEntry,
} from "./ldapShape";
import { AppError, classifyError } from "../../core/errors";
import { wireEnabled, emitWire } from "../../core/wireLog";
import { parseLdapTarget, candidateUrls } from "./srvLocator";
import { loadTrustedCAs } from "./osTrust";
import { DnsResolver } from "./discovery";

/** TLS knobs resolved from settings (ADR-0020 §5 + amendment). */
export interface LdapTlsOptions {
  rejectUnauthorized: boolean;
  useStartTls: boolean;
  /** Admin-pinned PEM bundle (aiSharePoint.ldap.caCertificatesFile). */
  caBundlePath?: string;
}

const defaultResolver: DnsResolver = {
  resolveSrv: (name) => dnsPromises.resolveSrv(name),
};

/** LDAP result code 49 — invalid credentials (feeds the ADR-0009 breaker). */
const LDAP_INVALID_CREDENTIALS = 49;

function bindDn(credential: ContextCredential): string {
  // username holds a UPN (user@domain), DOMAIN\\user, or a full DN.
  return credential.username ?? "";
}

/** Map an ldapts error to our taxonomy; bind rejections must classify as
 *  auth.failed so the lockout tracker counts them (ADR-0009). */
function toAppError(err: unknown): AppError {
  const e = err as { code?: number; name?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === LDAP_INVALID_CREDENTIALS || /invalid ?credentials/i.test(msg)) {
    return new AppError(
      `LDAP bind rejected (invalid credentials).`,
      "auth.failed",
      "Active Directory rejected these credentials.",
    );
  }
  if (/unable to get local issuer|self.signed certificate|unable to verify the first certificate|certificate has expired|ERR_TLS_CERT/i.test(msg)) {
    return new AppError(
      `LDAPS certificate validation failed: ${msg}. The server presents an internal-CA certificate not in the trusted set.`,
      "config",
      "LDAPS certificate not trusted — ensure the corporate CA is in the OS trust store, or point aiSharePoint.ldap.caCertificatesFile at your CA bundle (Admin Guide §7).",
    );
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket/i.test(msg)) {
    return new AppError(`LDAP connection failed: ${msg}`, "network");
  }
  if (e?.code === 4 || /size ?limit/i.test(msg)) {
    // sizeLimitExceeded is expected when more than the cap matches — not fatal.
    return new AppError("LDAP size limit reached (results capped).", "config");
  }
  return new AppError(`LDAP error: ${msg}`, "unknown");
}

/**
 * Resolve the source's connect URLs. SRV locators (ldaps+srv://…) re-resolve
 * on every connection — the durable, server-agnostic path (ADR-0020
 * amendment); static URLs pass through unchanged.
 */
export async function resolveConnectUrls(
  source: Pick<ContextSource, "baseUrl">,
  resolver: DnsResolver = defaultResolver,
): Promise<string[]> {
  const target = parseLdapTarget(source.baseUrl);
  if (target.kind === "static") {
    return [target.url];
  }
  let records;
  try {
    records = await resolver.resolveSrv(target.srvName);
  } catch (err) {
    throw new AppError(
      `DNS SRV lookup failed for ${target.srvName}: ${err instanceof Error ? err.message : String(err)}`,
      "network",
      "Active Directory SRV lookup failed — are you on the corporate network?",
    );
  }
  const urls = candidateUrls(target, records);
  if (urls.length === 0) {
    throw new AppError(
      `DNS returned no servers for ${target.srvName}.`,
      "network",
      "No domain controllers resolved via DNS.",
    );
  }
  return urls;
}

function tlsOptionsFor(tls: LdapTlsOptions): Record<string, unknown> {
  // Pilot finding: raw TLS bypasses VS Code's networking, so internal-CA
  // LDAPS fails against Node's bundled roots. Append OS-store / pinned CAs.
  const ca = loadTrustedCAs(tls.caBundlePath);
  return {
    rejectUnauthorized: tls.rejectUnauthorized,
    ...(ca ? { ca } : {}),
  };
}

async function connectAndBind(
  url: string,
  credential: ContextCredential,
  tls: LdapTlsOptions,
  caps: ReadCaps,
): Promise<Client> {
  const secure = url.toLowerCase().startsWith("ldaps://");
  const client = new Client({
    url,
    timeout: caps.timeoutMs,
    connectTimeout: caps.timeoutMs,
    tlsOptions: secure ? tlsOptionsFor(tls) : undefined,
  });
  try {
    if (!secure && tls.useStartTls) {
      await client.startTLS(tlsOptionsFor(tls));
    }
    // Wire log: bind identity + transport only — the password never leaves
    // this call.
    emitWire("ldap", "→", `bind ${bindDn(credential)} @ ${url}${!secure && tls.useStartTls ? " (StartTLS)" : ""}`);
    await client.bind(bindDn(credential), credential.secret);
    emitWire("ldap", "←", `bind OK @ ${url}`);
    return client;
  } catch (err) {
    emitWire("ldap", "✗", `bind ${bindDn(credential)} @ ${url} — ${err instanceof Error ? err.message : String(err)}`);
    try {
      await client.unbind();
    } catch {
      // best-effort teardown
    }
    throw err;
  }
}

async function withClient<T>(
  source: ContextSource,
  credential: ContextCredential,
  tls: LdapTlsOptions,
  caps: ReadCaps,
  run: (client: Client) => Promise<T>,
  resolver?: DnsResolver,
): Promise<T> {
  const urls = await resolveConnectUrls(source, resolver);
  let client: Client | undefined;
  let lastErr: AppError | undefined;
  for (const url of urls) {
    try {
      client = await connectAndBind(url, credential, tls, caps);
      break;
    } catch (err) {
      const mapped = toAppError(err);
      // Failover is for unreachable servers ONLY. An auth rejection would
      // fail identically everywhere — retrying other DCs with the same
      // credential multiplies lockout exposure (ADR-0009). Stop immediately.
      if (classifyError(mapped) !== "network") {
        throw mapped;
      }
      lastErr = mapped;
    }
  }
  if (!client) {
    throw lastErr ?? new AppError("No LDAP server reachable.", "network");
  }
  try {
    return await run(client);
  } catch (err) {
    throw toAppError(err);
  } finally {
    try {
      await client.unbind();
    } catch {
      // best-effort teardown
    }
  }
}

/** Verify-on-connect: bind + a single base-scope read (ADR-0009). */
export async function verifyLdap(
  source: ContextSource,
  credential: ContextCredential,
  tls: LdapTlsOptions,
  caps: ReadCaps,
): Promise<{ account: string }> {
  return withClient(source, credential, tls, caps, async (client) => {
    // The successful bind is the verification; a tiny base read confirms the
    // base DN is searchable without pulling data.
    if (source.baseDn) {
      await client.search(source.baseDn, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: ["dn"],
        sizeLimit: 1,
        timeLimit: Math.ceil(caps.timeoutMs / 1000),
      });
    }
    return { account: bindDn(credential) || "verified" };
  });
}

/** Search (ANR for free text; raw filter passthrough), size/time capped. */
export async function searchLdap(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  tls: LdapTlsOptions,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  if (!source.baseDn) {
    throw new AppError("This LDAP source has no base DN configured.", "config");
  }
  return withClient(source, credential, tls, caps, async (client) => {
    let entries: RawEntry[];
    const filter = buildFilter(query);
    const started = Date.now();
    if (wireEnabled()) {
      emitWire(
        "ldap",
        "→",
        `search base="${source.baseDn}" scope=sub sizeLimit=${caps.maxResults}`,
        `filter: ${filter}\nattributes: ${DEFAULT_ATTRIBUTES.join(", ")}`,
      );
    }
    try {
      const res = await client.search(source.baseDn!, {
        scope: "sub",
        filter,
        attributes: DEFAULT_ATTRIBUTES,
        sizeLimit: caps.maxResults,
        timeLimit: Math.ceil(caps.timeoutMs / 1000),
        paged: false,
      });
      entries = res.searchEntries as unknown as RawEntry[];
      emitWire("ldap", "←", `search — ${entries.length} entr(ies) (${Date.now() - started}ms) — attribute values withheld (directory data)`);
    } catch (err) {
      // sizeLimitExceeded: return whatever ldapts surfaced rather than failing.
      const e = err as { code?: number; searchEntries?: RawEntry[] };
      if (e?.code === 4 && Array.isArray(e.searchEntries)) {
        entries = e.searchEntries;
      } else {
        throw err;
      }
    }
    return entries.slice(0, caps.maxResults).map(entryToHit);
  });
}

/** Fetch one entry by DN (base scope). */
export async function getLdapEntry(
  source: ContextSource,
  credential: ContextCredential,
  dn: string,
  tls: LdapTlsOptions,
  caps: ReadCaps,
): Promise<ContextItem> {
  return withClient(source, credential, tls, caps, async (client) => {
    const res = await client.search(dn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: DEFAULT_ATTRIBUTES,
      sizeLimit: 1,
      timeLimit: Math.ceil(caps.timeoutMs / 1000),
    });
    const entry = (res.searchEntries as unknown as RawEntry[])[0];
    if (!entry) {
      throw new AppError(`No LDAP entry found at ${dn}.`, "graph.notFound");
    }
    return entryToItem(entry, caps.maxBodyChars);
  });
}
