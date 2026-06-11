import { Client } from "ldapts";
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
import { AppError } from "../../core/errors";

/** TLS knobs resolved from settings (ADR-0020 §5). */
export interface LdapTlsOptions {
  rejectUnauthorized: boolean;
  useStartTls: boolean;
}

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
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket/i.test(msg)) {
    return new AppError(`LDAP connection failed: ${msg}`, "network");
  }
  if (e?.code === 4 || /size ?limit/i.test(msg)) {
    // sizeLimitExceeded is expected when more than the cap matches — not fatal.
    return new AppError("LDAP size limit reached (results capped).", "config");
  }
  return new AppError(`LDAP error: ${msg}`, "unknown");
}

async function withClient<T>(
  source: ContextSource,
  credential: ContextCredential,
  tls: LdapTlsOptions,
  caps: ReadCaps,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const secure = source.baseUrl.toLowerCase().startsWith("ldaps://");
  const client = new Client({
    url: source.baseUrl,
    timeout: caps.timeoutMs,
    connectTimeout: caps.timeoutMs,
    tlsOptions: secure ? { rejectUnauthorized: tls.rejectUnauthorized } : undefined,
  });
  try {
    if (!secure && tls.useStartTls) {
      await client.startTLS({ rejectUnauthorized: tls.rejectUnauthorized });
    }
    await client.bind(bindDn(credential), credential.secret);
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
    try {
      const res = await client.search(source.baseDn!, {
        scope: "sub",
        filter: buildFilter(query),
        attributes: DEFAULT_ATTRIBUTES,
        sizeLimit: caps.maxResults,
        timeLimit: Math.ceil(caps.timeoutMs / 1000),
        paged: false,
      });
      entries = res.searchEntries as unknown as RawEntry[];
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
