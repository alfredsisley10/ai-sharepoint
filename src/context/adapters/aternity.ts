import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ReadCaps,
} from "../types";
import { fetchJson } from "../http";
import { AppError } from "../../core/errors";

/**
 * Riverbed Aternity connector (ADR-0049): read-only reads against the
 * Aternity REST API — an OData service at
 * `https://<account>-odata.aternity.com/aternity.odata/latest/<TABLE>` —
 * for end-user-experience monitoring data (application health, device
 * health, business activities, events). Auth is Basic (an Aternity account
 * with the "OData REST API" role) or a pasted OAuth access token; both
 * ride the shared fetchJson, so lockout protection, caps, caching, and
 * verbose wire logging apply unchanged. GET-only by construction.
 */

const enc = encodeURIComponent;

export const ATERNITY_ODATA_PATH = "/aternity.odata/latest";

/** Table (entity set) names are SHOUTY_SNAKE in the Aternity catalog. */
const TABLE_RE = /^[A-Za-z0-9_]+$/;

/** Aternity's custom OData timeframe function: relative_time(last_24_hours),
 *  relative_time(last_7_days), … — validated, never interpolated raw. */
const TIMEFRAME_RE = /^last_[a-z0-9_]+$/i;

/** Well-known data sources, used as browse fallback when the service
 *  document is not readable and as wizard hints — the live catalog (the
 *  OData service document) is always preferred. */
export const ATERNITY_CURATED_TABLES: Array<[string, string]> = [
  ["APPLICATIONS_DAILY", "Application performance & usage (daily)"],
  ["APPLICATION_EVENTS", "Application events (crashes, hangs, errors)"],
  ["APPLICATION_RESOURCES_HOURLY", "Application resource consumption (hourly)"],
  ["BUSINESS_ACTIVITIES_HOURLY", "Business activity response times (hourly)"],
  ["DEVICES_DAILY", "Device inventory & health scores (daily)"],
  ["DEVICE_EVENTS", "Device events (boots, blue screens, …)"],
  ["HEALTH_EVENTS", "Health events (detected EUE incidents)"],
  ["HOST_RESOURCES_HOURLY", "Device resource consumption (hourly)"],
  ["REMOTE_DISPLAY_HOURLY", "Remote-display latency & quality (hourly)"],
];

export interface AternityEndpoints {
  /** OData API origin, e.g. https://us3-odata.aternity.com */
  apiBase: string;
  /** Browser dashboard origin for deep links, e.g. https://us3.aternity.com */
  appBase: string;
}

/** Users paste what they have: the dashboard URL (`us3.aternity.com`), the
 *  OData URL (`us3-odata.aternity.com`, with or without the service path),
 *  or a bare host. SaaS hosts pair `<account>.aternity.com` (app) with
 *  `<account>-odata.aternity.com` (API); on-prem/custom hosts are used for
 *  both roles as pasted. */
export function deriveAternityEndpoints(input: string): AternityEndpoints | undefined {
  const t = input.trim().replace(/\/+$/, "");
  if (!t) return undefined;
  let u: URL;
  try {
    u = new URL(t.includes("://") ? t : `https://${t}`);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || !u.hostname.includes(".")) return undefined;
  const host = u.hostname.toLowerCase();
  const saas = host.match(/^([a-z0-9-]+?)(-odata)?\.(aternity\.com)$/);
  if (saas) {
    return {
      apiBase: `https://${saas[1]}-odata.${saas[3]}`,
      appBase: `https://${saas[1]}.${saas[3]}`,
    };
  }
  return { apiBase: `https://${u.host}`, appBase: `https://${u.host}` };
}

/** The descriptor stores the API origin plus display/default params:
 *  `https://us3-odata.aternity.com?web=https://us3.aternity.com&table=HEALTH_EVENTS`. */
export function aternityEndpointsOf(
  source: Pick<ContextSource, "baseUrl">,
): AternityEndpoints & { defaultTable?: string } {
  const u = new URL(source.baseUrl);
  const apiBase = `${u.protocol}//${u.host}`;
  const web = u.searchParams.get("web");
  const table = u.searchParams.get("table");
  return {
    apiBase,
    appBase: web ?? apiBase.replace(/-odata\./i, "."),
    ...(table && TABLE_RE.test(table) ? { defaultTable: table } : {}),
  };
}

export interface AternitySpec {
  table: string;
  /** OData $filter expression, already in native syntax. */
  filter?: string;
  /** OData $select column list. */
  select?: string[];
  top?: number;
  /** Aternity relative_time(...) argument, e.g. "last_24_hours". */
  timeframe?: string;
}

/** Parse a chat/bookmark query:
 *  - JSON spec {"table": "HEALTH_EVENTS", "filter": "SEVERITY eq 'CRITICAL'",
 *    "select": ["..."], "top": 25, "timeframe": "last_24_hours"}
 *  - a bare table name → recent rows of that table
 *  - anything else (with a default table configured) → error with guidance,
 *    because the OData API has no free-text search to send words to. */
export function parseAternitySpec(query: string, defaultTable?: string): AternitySpec {
  const trimmed = query.trim();
  const usage =
    'Aternity queries are JSON: {"table": "HEALTH_EVENTS", "filter": "SEVERITY eq \'CRITICAL\'", "select": ["..."], "top": 25, "timeframe": "last_24_hours"} — or a bare table name for recent rows.';
  if (trimmed.startsWith("{")) {
    let raw: {
      table?: unknown;
      filter?: unknown;
      select?: unknown;
      top?: unknown;
      timeframe?: unknown;
    };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(usage, "config");
    }
    const table = (typeof raw.table === "string" && raw.table.trim()) || defaultTable?.trim();
    if (!table) throw new AppError(`No table given and no default table configured. ${usage}`, "config");
    if (!TABLE_RE.test(table)) {
      throw new AppError(`"${table}" is not a valid Aternity table name.`, "config");
    }
    const timeframe = typeof raw.timeframe === "string" ? raw.timeframe.trim() : "";
    if (timeframe && !TIMEFRAME_RE.test(timeframe)) {
      throw new AppError(
        `"${timeframe}" is not a valid Aternity timeframe — use the relative_time forms like "last_24_hours" or "last_7_days".`,
        "config",
      );
    }
    return {
      table,
      ...(typeof raw.filter === "string" && raw.filter.trim() ? { filter: raw.filter.trim() } : {}),
      ...(Array.isArray(raw.select)
        ? { select: raw.select.filter((f): f is string => typeof f === "string" && !!f.trim()) }
        : {}),
      ...(typeof raw.top === "number" ? { top: raw.top } : {}),
      ...(timeframe ? { timeframe } : {}),
    };
  }
  if (!trimmed) throw new AppError("Empty Aternity query.", "config");
  if (TABLE_RE.test(trimmed)) return { table: trimmed };
  throw new AppError(
    `The Aternity OData API has no free-text search — "${trimmed.slice(0, 80)}" can't be sent as-is. ${usage}`,
    "config",
  );
}

/** OData resource path + query options — pure so query construction is
 *  test-locked. The result cap always rides as $top (ADR-0012); the
 *  timeframe composes into $filter via Aternity's relative_time(). */
export function aternityQueryPath(spec: AternitySpec, maxResults: number): string {
  const top = Math.min(Math.max(spec.top ?? maxResults, 1), maxResults);
  const filter = [
    spec.timeframe ? `relative_time(${spec.timeframe})` : "",
    spec.filter ?? "",
  ]
    .filter(Boolean)
    .join(" and ");
  const params = [
    `$top=${top}`,
    ...(filter ? [`$filter=${enc(filter)}`] : []),
    ...(spec.select?.length ? [`$select=${enc(spec.select.join(","))}`] : []),
  ].join("&");
  return `${ATERNITY_ODATA_PATH}/${enc(spec.table)}?${params}`;
}

type Row = Record<string, unknown>;
const s = (v: unknown): string =>
  v === null || v === undefined || typeof v === "object" ? "" : String(v);

/** OData payloads carry rows under "value". */
function rowsOf(payload: unknown): Row[] {
  const v = (payload as { value?: unknown })?.value;
  return Array.isArray(v) ? (v as Row[]) : [];
}

/** Name-ish columns that make a readable row title, in preference order
 *  (matched case-insensitively — the catalog is SHOUTY_SNAKE). */
const TITLE_KEYS = [
  "ACTIVITY_NAME",
  "APPLICATION_NAME",
  "APP_NAME",
  "EVENT_NAME",
  "EVENT_TYPE",
  "DEVICE_NAME",
  "HOSTNAME",
  "USERNAME",
  "USER_NAME",
];

/** Row facts worth surfacing as structured meta when present. */
const META_KEYS = ["SEVERITY", "USERNAME", "DEVICE_NAME", "APPLICATION_NAME", "LOCATION_CITY", "TIMEFRAME"];

const findKey = (row: Row, name: string): string | undefined =>
  Object.keys(row).find((k) => k.toUpperCase() === name);

/** Map an OData payload to hits — pure, exported for tests. Rows have no
 *  per-row deep link; hits point at the dashboard origin. */
export function mapAternityRows(
  spec: AternitySpec,
  payload: unknown,
  appBase: string,
  caps: Pick<ReadCaps, "maxResults">,
): ContextSearchHit[] {
  const base = appBase.replace(/\/+$/, "");
  const out: ContextSearchHit[] = [];
  for (const row of rowsOf(payload)) {
    if (out.length >= caps.maxResults) break;
    const titleKey = TITLE_KEYS.map((k) => findKey(row, k)).find((k) => k && s(row[k]));
    const title = titleKey ? s(row[titleKey]) : `${spec.table} row ${out.length + 1}`;
    const excerpt = Object.entries(row)
      .filter(([k, v]) => k !== titleKey && !k.startsWith("@") && s(v))
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${s(v)}`)
      .join(" · ")
      .slice(0, 300);
    const meta: Record<string, string> = { table: spec.table };
    for (const name of META_KEYS) {
      const k = findKey(row, name);
      if (k && k !== titleKey && s(row[k])) meta[k] = s(row[k]).slice(0, 120);
    }
    out.push({ title, url: base, ...(excerpt ? { excerpt } : {}), meta });
  }
  return out;
}

/** Single deliberate verification read (ADR-0009): with a default table,
 *  one $top=1 row (confirms auth AND that the table is readable by this
 *  account); otherwise the OData service document — the smallest read
 *  every OData-role account can run. */
export async function verifyAternity(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const { apiBase, defaultTable } = aternityEndpointsOf(source);
  await fetchJson(
    defaultTable
      ? `${apiBase}${aternityQueryPath({ table: defaultTable, top: 1 }, 1)}`
      : `${apiBase}${ATERNITY_ODATA_PATH}/`,
    credential,
    caps.timeoutMs,
  );
  return { account: credential.username ?? "token verified" };
}

export async function searchAternity(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const { apiBase, appBase, defaultTable } = aternityEndpointsOf(source);
  const spec = parseAternitySpec(query, defaultTable);
  const payload = await fetchJson<unknown>(
    `${apiBase}${aternityQueryPath(spec, caps.maxResults)}`,
    credential,
    caps.timeoutMs,
  );
  return mapAternityRows(spec, payload, appBase, caps);
}

/** OData rows have no stable single-row address — surfaced to the shared
 *  getItem refusal in ContextService; kept here so the guidance lives with
 *  the adapter. */
export function aternityNoItemFetch(): never {
  throw new AppError(
    "Aternity rows have no item fetch — use search with a table name or a JSON OData spec (results carry the matching rows).",
    "config",
  );
}

/** Enumerate the tables this account can read from the OData service
 *  document ("connect, then show me what I have"). */
export async function listAternityTables(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<string[]> {
  const { apiBase } = aternityEndpointsOf(source);
  const doc = await fetchJson<{ value?: Array<{ name?: string; url?: string }> }>(
    `${apiBase}${ATERNITY_ODATA_PATH}/`,
    credential,
    caps.timeoutMs,
  );
  return (doc.value ?? [])
    .map((e) => e.name ?? e.url ?? "")
    .filter((n) => TABLE_RE.test(n));
}

/** Live catalog → bookmark candidates (recent rows per table; the
 *  configured default table listed first). Falls back to the curated set
 *  when the service document is denied. */
export async function browseAternityCandidates(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<Array<{ name: string; locator: string; kind: "query"; detail: string }>> {
  const { defaultTable } = aternityEndpointsOf(source);
  const curatedLabel = new Map(ATERNITY_CURATED_TABLES);
  let tables = await listAternityTables(source, credential, caps).catch(() => [] as string[]);
  if (tables.length === 0) tables = ATERNITY_CURATED_TABLES.map(([t]) => t);
  if (defaultTable) {
    tables = [defaultTable, ...tables.filter((t) => t !== defaultTable)];
  }
  return tables.slice(0, caps.maxResults * 2).map((t) => ({
    name: `${curatedLabel.get(t) ?? t} — recent rows`,
    locator: JSON.stringify({ table: t, top: 25 }),
    kind: "query",
    detail: `Aternity table ${t}`,
  }));
}
