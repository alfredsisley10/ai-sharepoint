import { ContextSource, ContextCredential, ReadCaps } from "./types";
import { fetchJson } from "./http";

/**
 * User directory construct (ADR-0041): resolve an AD **sAMAccountName** to
 * whether the user is **active** and how to **contact** them (email/UPN). Used
 * by two flows: the ownership "active contributor" check, and notifying the
 * resolved owner of inaccurate content before cleanup.
 *
 * Backed by either **LDAP** (`sAMAccountName` + `userAccountControl`) or
 * **Microsoft 365** (`onPremisesSamAccountName` + `accountEnabled`) — the pure
 * parsers below normalize both into a common `UserRecord`.
 */

export interface UserRecord {
  sam: string;
  active: boolean;
  displayName?: string;
  email?: string;
  upn?: string;
}

/** AD `userAccountControl`: bit 0x2 (ACCOUNTDISABLE) means disabled. Unknown →
 *  assume active (never falsely deactivate someone on missing data). */
export function isAccountActive(userAccountControl: number | string | undefined): boolean {
  const uac = typeof userAccountControl === "string" ? Number.parseInt(userAccountControl, 10) : userAccountControl;
  if (uac === undefined || Number.isNaN(uac)) return true;
  return (uac & 0x2) === 0;
}

function attr(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key] ?? attrs[key.toLowerCase()];
  const first = Array.isArray(v) ? v[0] : v;
  return first === undefined || first === null ? undefined : String(first);
}

/** Parse an LDAP entry's attributes → UserRecord (pure). */
export function parseLdapUser(attrs: Record<string, unknown>): UserRecord | undefined {
  const sam = attr(attrs, "sAMAccountName");
  if (!sam) return undefined;
  return {
    sam: sam.toLowerCase(),
    active: isAccountActive(attr(attrs, "userAccountControl")),
    ...(attr(attrs, "displayName") ? { displayName: attr(attrs, "displayName") } : {}),
    ...(attr(attrs, "mail") ? { email: attr(attrs, "mail") } : {}),
    ...(attr(attrs, "userPrincipalName") ? { upn: attr(attrs, "userPrincipalName") } : {}),
  };
}

/** Parse a Microsoft Graph user → UserRecord (pure). */
export function parseGraphUser(user: Record<string, unknown>): UserRecord | undefined {
  const sam = user.onPremisesSamAccountName;
  if (!sam) return undefined;
  return {
    sam: String(sam).toLowerCase(),
    active: user.accountEnabled !== false, // absent → assume active
    ...(user.displayName ? { displayName: String(user.displayName) } : {}),
    ...(user.mail ? { email: String(user.mail) } : {}),
    ...(user.userPrincipalName ? { upn: String(user.userPrincipalName) } : {}),
  };
}

/** Resolve a sAMAccountName → record (or undefined if not found). Injected so
 *  the ownership/notification flows don't depend on a specific directory. */
export type UserDirectory = (sam: string) => Promise<UserRecord | undefined>;

/** An "is active?" predicate from a directory (unknown user → inactive, so an
 *  unresolvable contributor never becomes the owner). */
export function activeFromDirectory(dir: UserDirectory): (sam: string) => Promise<boolean> {
  return async (sam) => (await dir(sam))?.active ?? false;
}

/** Best contact handle for a record — email preferred, then UPN. */
export function contactOf(record: UserRecord | undefined): string | undefined {
  return record?.email ?? record?.upn;
}

// ---------------------------------------------------------------------------
// Microsoft 365 directory (Graph) — sam lookups via onPremisesSamAccountName.
// (LDAP-backed directory wires through the existing ldap client — staged.)
// ---------------------------------------------------------------------------

/** Build an M365-backed UserDirectory. `getToken` yields a Graph token (the
 *  reused Microsoft 365 sign-in); needs delegated User.Read.All. */
export function m365UserDirectory(
  graphBase: string,
  getToken: () => Promise<string>,
  caps: ReadCaps,
): UserDirectory {
  return async (sam: string) => {
    const token = await getToken();
    const filter = `onPremisesSamAccountName eq '${sam.replace(/'/g, "''")}'`;
    const res = await fetchJson<{ value?: Array<Record<string, unknown>> }>(
      `${graphBase}/users?$filter=${encodeURIComponent(filter)}&$select=onPremisesSamAccountName,accountEnabled,displayName,mail,userPrincipalName`,
      { method: "pat", secret: token } as ContextCredential,
      caps.timeoutMs,
    );
    const user = (res.value ?? [])[0];
    return user ? parseGraphUser(user) : undefined;
  };
}

/** LDAP search filter for a single user by sAMAccountName (pure/testable). */
export function ldapUserFilter(sam: string): string {
  const esc = sam.replace(/[\\*()\x00]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  return `(&(objectClass=user)(sAMAccountName=${esc}))`;
}

/** Attributes to request for a directory lookup. */
export const USER_DIRECTORY_ATTRS = ["sAMAccountName", "userAccountControl", "displayName", "mail", "userPrincipalName"];

/** Build a directory from an injected LDAP search (entry attrs in, record out).
 *  The search itself is provided by the caller (the configured LDAP source's
 *  client), keeping this module free of the ldap transport. */
export function ldapUserDirectory(
  search: (filter: string, attrs: string[]) => Promise<Array<Record<string, unknown>>>,
): UserDirectory {
  return async (sam: string) => {
    const entries = await search(ldapUserFilter(sam), USER_DIRECTORY_ATTRS);
    const entry = entries[0];
    return entry ? parseLdapUser(entry) : undefined;
  };
}

/** LDAP filter to find a user by EMAIL / UPN — SharePoint and ServiceNow
 *  identify contributors by email, not sAMAccountName, so cross-source
 *  ownership resolves the active-employee check by mail/upn/proxyAddress. */
export function ldapUserFilterByEmail(email: string): string {
  const esc = email.replace(/[\\*()\x00]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  return `(&(objectClass=user)(|(mail=${esc})(userPrincipalName=${esc})(proxyAddresses=smtp:${esc})))`;
}

/** A directory keyed by EMAIL/UPN (for SharePoint/ServiceNow contributors). The
 *  returned record still carries the sam, so a resolved SharePoint owner can be
 *  cross-referenced to AD. */
export function ldapUserDirectoryByEmail(
  search: (filter: string, attrs: string[]) => Promise<Array<Record<string, unknown>>>,
): UserDirectory {
  return async (email: string) => {
    if (!email.includes("@")) return undefined;
    const entries = await search(ldapUserFilterByEmail(email), USER_DIRECTORY_ATTRS);
    const entry = entries[0];
    return entry ? parseLdapUser(entry) : undefined;
  };
}

// Keep the ContextSource import meaningful for callers wiring real sources.
export type DirectorySource = Pick<ContextSource, "id" | "type" | "baseUrl">;
