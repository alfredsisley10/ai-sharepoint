import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ContextItem,
  ReadCaps,
} from "../types";
import { fetchJson } from "../http";
import { AppError } from "../../core/errors";

/**
 * ServiceNow connector (ADR-0028): read-only Table API access to any
 * instance (incidents, changes, CMDB CIs, knowledge, …). Auth is Basic
 * (integration/service account) or an OAuth bearer token — both ride the
 * shared fetchJson, so lockout protection, caps, caching, and verbose
 * wire logging apply unchanged.
 */

const enc = encodeURIComponent;

export const SNOW_DEFAULT_TABLE = "incident";

export interface SnowSpec {
  table: string;
  /** ServiceNow encoded query (sysparm_query) — already in native syntax. */
  query: string;
  fields?: string[];
  limit?: number;
}

const TABLE_RE = /^[a-z0-9_]+$/;

/** Parse a chat/bookmark query:
 *  - JSON spec {"table": "...", "query": "...", "fields": [...], "limit": n}
 *  - native encoded query ("active=true^priority=1") → default table
 *  - free text → text-index search (123TEXTQUERY321) on the default table. */
export function parseSnowSpec(query: string, defaultTable?: string): SnowSpec {
  const trimmed = query.trim();
  const fallback = defaultTable?.trim() || SNOW_DEFAULT_TABLE;
  if (trimmed.startsWith("{")) {
    let raw: { table?: unknown; query?: unknown; fields?: unknown; limit?: unknown };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(
        'ServiceNow queries are JSON: {"table": "incident", "query": "active=true^…", "fields": ["number"], "limit": 25} — or plain text / a native encoded query.',
        "config",
      );
    }
    const table = (typeof raw.table === "string" && raw.table.trim()) || fallback;
    if (!TABLE_RE.test(table)) {
      throw new AppError(`"${table}" is not a valid ServiceNow table name.`, "config");
    }
    return {
      table,
      query: typeof raw.query === "string" ? raw.query.trim() : "",
      ...(Array.isArray(raw.fields)
        ? { fields: raw.fields.filter((f): f is string => typeof f === "string") }
        : {}),
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
    };
  }
  if (!trimmed) throw new AppError("Empty ServiceNow query.", "config");
  // Native encoded queries use ^ joins and = conditions; anything else is
  // free text, sent through the zing text index.
  const looksEncoded = /[\^]|^[a-z0-9_.]+(=|!=|LIKE|IN)/.test(trimmed);
  return {
    table: fallback,
    query: looksEncoded ? trimmed : `123TEXTQUERY321=${trimmed}`,
  };
}

export function defaultSnowTable(source: Pick<ContextSource, "baseUrl">): string | undefined {
  try {
    return new URL(source.baseUrl).searchParams.get("table") ?? undefined;
  } catch {
    return undefined;
  }
}

function instanceBase(source: Pick<ContextSource, "baseUrl">): string {
  const u = new URL(source.baseUrl);
  return `${u.protocol}//${u.host}`;
}

type SnowRecord = Record<string, unknown>;

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    // sysparm_display_value=true leaves reference fields as {display_value}.
    const dv = (v as { display_value?: unknown }).display_value;
    return dv === null || dv === undefined ? "" : String(dv);
  }
  return String(v);
};

function recordTitle(table: string, r: SnowRecord): string {
  const number = str(r.number);
  const name = str(r.name) || str(r.short_description) || str(r.title);
  if (number && name) return `${number}: ${name}`;
  return number || name || `${table}/${str(r.sys_id)}`;
}

function recordUrl(base: string, table: string, r: SnowRecord): string {
  return `${base}/nav_to.do?uri=${enc(`${table}.do?sys_id=${str(r.sys_id)}`)}`;
}

const META_FIELDS = ["state", "priority", "assigned_to", "category", "sys_updated_on"] as const;

function recordMeta(table: string, r: SnowRecord): Record<string, string> {
  const meta: Record<string, string> = { table, ...(str(r.sys_id) ? { sys_id: str(r.sys_id) } : {}) };
  for (const f of META_FIELDS) {
    const v = str(r[f]);
    if (v) meta[f] = v;
  }
  return meta;
}

/** Single deliberate verification read (ADR-0009): confirms auth AND that
 *  the default table is readable by this account. */
export async function verifyServiceNow(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const table = defaultSnowTable(source) ?? SNOW_DEFAULT_TABLE;
  await fetchJson<{ result?: SnowRecord[] }>(
    `${instanceBase(source)}/api/now/table/${enc(table)}?sysparm_limit=1&sysparm_fields=sys_id`,
    credential,
    caps.timeoutMs,
  );
  return { account: credential.username ?? "token" };
}

export async function searchServiceNow(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const spec = parseSnowSpec(query, defaultSnowTable(source));
  const base = instanceBase(source);
  const limit = Math.min(spec.limit ?? caps.maxResults, caps.maxResults);
  const params = [
    spec.query ? `sysparm_query=${enc(spec.query)}` : "",
    `sysparm_limit=${limit}`,
    "sysparm_display_value=true",
    "sysparm_exclude_reference_link=true",
    ...(spec.fields?.length
      ? [`sysparm_fields=${enc(["sys_id", "number", "short_description", ...spec.fields].join(","))}`]
      : []),
  ]
    .filter(Boolean)
    .join("&");
  const res = await fetchJson<{ result?: SnowRecord[] }>(
    `${base}/api/now/table/${enc(spec.table)}?${params}`,
    credential,
    caps.timeoutMs,
  );
  return (res.result ?? []).slice(0, caps.maxResults).map((r) => ({
    title: recordTitle(spec.table, r),
    url: recordUrl(base, spec.table, r),
    excerpt: (str(r.short_description) || str(r.description)).slice(0, 300),
    meta: recordMeta(spec.table, r),
  }));
}

/** Fetch one record: id is "table/sys_id" (or a bare sys_id against the
 *  default table). Body is a flat, capped field listing. */
export async function getServiceNowItem(
  source: ContextSource,
  credential: ContextCredential,
  id: string,
  caps: ReadCaps,
): Promise<ContextItem> {
  const m = id.trim().match(/^(?:([a-z0-9_]+)\/)?([0-9a-f]{32})$/i);
  if (!m) {
    throw new AppError(
      'ServiceNow items are fetched as "table/sys_id" (e.g. incident/62826bf03710200044e0bfc8bcbe5df1).',
      "config",
    );
  }
  const table = m[1] ?? defaultSnowTable(source) ?? SNOW_DEFAULT_TABLE;
  const base = instanceBase(source);
  const res = await fetchJson<{ result?: SnowRecord }>(
    `${base}/api/now/table/${enc(table)}/${enc(m[2])}?sysparm_display_value=true&sysparm_exclude_reference_link=true`,
    credential,
    caps.timeoutMs,
  );
  const r = res.result ?? {};
  const lines: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    const value = str(v);
    if (!value || k.startsWith("sys_") && !["sys_id", "sys_updated_on", "sys_created_on"].includes(k)) continue;
    lines.push(`${k}: ${value}`);
    if (lines.join("\n").length > caps.maxBodyChars) break;
  }
  return {
    title: recordTitle(table, r),
    url: recordUrl(base, table, r),
    body: lines.join("\n").slice(0, caps.maxBodyChars),
    meta: recordMeta(table, r),
  };
}

/** Curated starter tables → bookmark candidates (no admin-only schema
 *  reads required; unreadable tables simply fail at run time with the
 *  instance's own message). */
export function browseServiceNowCandidates(
  defaultTable?: string,
): Array<{ name: string; locator: string; kind: "query"; detail: string }> {
  const tables: Array<[string, string]> = [
    ["incident", "Incidents"],
    ["change_request", "Change requests"],
    ["problem", "Problems"],
    ["sc_req_item", "Service catalog request items"],
    ["cmdb_ci", "CMDB configuration items"],
    ["cmdb_ci_appl", "CMDB applications"],
    ["kb_knowledge", "Knowledge articles"],
    ["sys_user", "Users"],
    ["sys_user_group", "Groups"],
  ];
  if (defaultTable && !tables.some(([t]) => t === defaultTable)) {
    tables.unshift([defaultTable, `${defaultTable} (default table)`]);
  }
  return tables.map(([table, label]) => ({
    name: `${label} — recently updated`,
    locator: JSON.stringify({
      table,
      query: "ORDERBYDESCsys_updated_on",
      limit: 25,
    }),
    kind: "query",
    detail: `ServiceNow table ${table}`,
  }));
}
