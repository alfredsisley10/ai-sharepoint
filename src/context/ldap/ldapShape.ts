/**
 * Pure LDAP helpers (ADR-0020) — filter building, DN heuristics, attribute
 * normalization, and entry→hit/item mapping. No sockets here, so this is
 * fully unit-tested; the thin socket layer lives in ldapClient.ts.
 */

import { ContextSearchHit, ContextItem } from "../types";

/** Curated, non-sensitive attributes returned by default. Credential-bearing
 *  attributes are never requested. */
export const DEFAULT_ATTRIBUTES = [
  "cn",
  "displayName",
  "name",
  "mail",
  "sAMAccountName",
  "userPrincipalName",
  "title",
  "department",
  "company",
  "physicalDeliveryOfficeName",
  "telephoneNumber",
  "mobile",
  "manager",
  "memberOf",
  "objectClass",
  "description",
  "whenCreated",
];

/** RFC 4515 filter-value escaping. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\x00]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      default:
        return "\\00";
    }
  });
}

/**
 * Turn a user query into an LDAP filter. A raw filter (starting with "(") is
 * passed through; anything else becomes an AD Ambiguous Name Resolution match,
 * so "Jane Doe" hits cn/displayName/sAMAccountName/mail/givenName/sn at once.
 */
export function buildFilter(query: string): string {
  const trimmed = query.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed;
  }
  return `(anr=${escapeFilterValue(trimmed)})`;
}

/** Heuristic: does this look like a distinguished name (for get-by-DN)? */
export function isProbablyDn(s: string): boolean {
  return /(^|,)\s*(cn|ou|dc|uid)=/i.test(s) && s.includes(",");
}

type RawAttr = string | string[] | Buffer | Buffer[] | undefined;

/** Coerce an ldapts attribute value to strings, dropping binary blobs. */
export function normalizeAttr(value: RawAttr): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (Buffer.isBuffer(v) ? "" : String(v)))
    .filter((v) => v.length > 0);
}

function first(value: RawAttr): string | undefined {
  return normalizeAttr(value)[0];
}

/** Short-name of a DN's first RDN value, e.g. "CN=Jane Doe,OU=…" → "Jane Doe". */
export function rdnValue(dn: string): string {
  const m = dn.match(/^[^=]+=([^,]+)/);
  return m ? m[1].trim() : dn;
}

export interface RawEntry {
  dn: string;
  [attr: string]: RawAttr;
}

/** Map a search entry to a compact, model-facing hit. */
export function entryToHit(entry: RawEntry): ContextSearchHit {
  const title =
    first(entry.displayName) ?? first(entry.cn) ?? first(entry.name) ?? rdnValue(entry.dn);
  const meta: Record<string, string> = { dn: entry.dn };
  const put = (key: string, attr: RawAttr) => {
    const v = first(attr);
    if (v) meta[key] = v;
  };
  put("mail", entry.mail);
  put("login", entry.sAMAccountName);
  put("upn", entry.userPrincipalName);
  put("title", entry.title);
  put("department", entry.department);
  put("office", entry.physicalDeliveryOfficeName);
  const classes = normalizeAttr(entry.objectClass);
  if (classes.length) {
    meta.kind = classes.includes("group") ? "group" : classes.includes("user") ? "user" : classes[classes.length - 1];
  }
  return { title, url: `ldap:///${encodeURIComponent(entry.dn)}`, meta };
}

/** Map a single entry to a full item with a readable attribute body. */
export function entryToItem(entry: RawEntry, maxBodyChars: number, maxMultivalue = 25): ContextItem {
  const title =
    first(entry.displayName) ?? first(entry.cn) ?? first(entry.name) ?? rdnValue(entry.dn);
  const lines: string[] = [`dn: ${entry.dn}`];
  for (const [key, raw] of Object.entries(entry)) {
    if (key === "dn") continue;
    const values = normalizeAttr(raw as RawAttr);
    if (values.length === 0) continue;
    if (values.length === 1) {
      lines.push(`${key}: ${values[0]}`);
    } else {
      const shown = values.slice(0, maxMultivalue);
      lines.push(`${key} (${values.length}):`);
      lines.push(...shown.map((v) => `  - ${v}`));
      if (values.length > maxMultivalue) {
        lines.push(`  - …and ${values.length - maxMultivalue} more`);
      }
    }
  }
  let body = lines.join("\n");
  if (body.length > maxBodyChars) body = `${body.slice(0, maxBodyChars)}…`;
  const meta: Record<string, string> = {};
  const upn = first(entry.userPrincipalName);
  const mail = first(entry.mail);
  if (upn) meta.upn = upn;
  if (mail) meta.mail = mail;
  return { title, url: `ldap:///${encodeURIComponent(entry.dn)}`, body, meta };
}
