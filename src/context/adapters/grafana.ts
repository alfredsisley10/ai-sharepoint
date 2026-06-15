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
 * Grafana connector (ADR-0033/0036): read-only reads against a Grafana
 * instance (Cloud stack or self-hosted) with a service-account token (Bearer)
 * or basic auth. Surfaces dashboards/folders (search), unified-alerting rule
 * STATE (the Viewer-readable Prometheus-style endpoint), annotations,
 * datasources, and — the `panel` type — **live panel data**: a dashboard
 * panel's own native queries executed through `/api/ds/query`, with the
 * returned data frames summarized (per-series last/min/max, datasource-type
 * agnostic). This lifts the ADR-0033 deferral so the assistant can read what a
 * panel actually shows, not just its title/type.
 */

export type GrafanaObjectType =
  | "dashboard"
  | "folder"
  | "alert"
  | "annotation"
  | "datasource"
  | "panel";

const OBJECT_TYPES = new Set<GrafanaObjectType>([
  "dashboard",
  "folder",
  "alert",
  "annotation",
  "datasource",
  "panel",
]);

export function grafanaBaseOf(source: Pick<ContextSource, "baseUrl">): string {
  const u = new URL(source.baseUrl);
  return `${u.protocol}//${u.host}`;
}

export interface GrafanaSpec {
  type: GrafanaObjectType;
  query: string;
  limit?: number;
  /** Restrict dashboard searches to a folder (search hits/browse carry it). */
  folderUid?: string;
  /** panel type: which panel (id or title substring); blank = all panels. */
  panel?: string;
  /** panel type: time range (Grafana relative or epoch-ms). Defaults now-6h. */
  from?: string;
  to?: string;
}

/** Parse a chat/bookmark query:
 *  - JSON spec {"type": "alert", "query": "cpu", "limit": 25, "folderUid": "…"}
 *  - live data {"type": "panel", "query": "<dash uid/title>", "panel": "<id/title>", "from": "now-24h"}
 *  - free text → dashboard search. */
export function parseGrafanaSpec(query: string): GrafanaSpec {
  const trimmed = query.trim();
  if (trimmed.startsWith("{")) {
    let raw: {
      type?: unknown;
      query?: unknown;
      limit?: unknown;
      folderUid?: unknown;
      panel?: unknown;
      from?: unknown;
      to?: unknown;
    };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(
        'Grafana queries are JSON: {"type": "dashboard|folder|alert|annotation|datasource|panel", "query": "cpu", "limit": 25} — or plain text to search dashboards. For live data: {"type":"panel","query":"<dashboard uid or title>","panel":"<id or title>"}.',
        "config",
      );
    }
    const type =
      typeof raw.type === "string" && OBJECT_TYPES.has(raw.type as GrafanaObjectType)
        ? (raw.type as GrafanaObjectType)
        : "dashboard";
    const strField = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    return {
      type,
      query: typeof raw.query === "string" ? raw.query.trim() : "",
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
      ...(strField(raw.folderUid) ? { folderUid: strField(raw.folderUid) } : {}),
      ...(strField(raw.panel) ? { panel: strField(raw.panel) } : {}),
      ...(strField(raw.from) ? { from: strField(raw.from) } : {}),
      ...(strField(raw.to) ? { to: strField(raw.to) } : {}),
    };
  }
  if (!trimmed) throw new AppError("Empty Grafana query.", "config");
  return { type: "dashboard", query: trimmed };
}

/** API path per object type — pure so query construction is test-locked.
 *  Alert/annotation/datasource listings are filtered locally. */
export function grafanaSearchPath(spec: GrafanaSpec, maxResults: number): string {
  const limit = Math.min(Math.max(spec.limit ?? maxResults, 1), maxResults);
  switch (spec.type) {
    case "dashboard":
      return (
        `/api/search?type=dash-db&limit=${limit}` +
        (spec.query ? `&query=${encodeURIComponent(spec.query)}` : "") +
        (spec.folderUid ? `&folderUIDs=${encodeURIComponent(spec.folderUid)}` : "")
      );
    case "folder":
      return (
        `/api/search?type=dash-folder&limit=${limit}` +
        (spec.query ? `&query=${encodeURIComponent(spec.query)}` : "")
      );
    case "alert":
      // Unified alerting rule state — readable with the Viewer role.
      return "/api/prometheus/grafana/api/v1/rules";
    case "annotation":
      return `/api/annotations?limit=${limit}`;
    case "datasource":
      return "/api/datasources";
    case "panel":
      // Live panel data takes a multi-step /api/ds/query path, not a search URL.
      throw new AppError("Grafana panel data uses the live-query path, not a search URL.", "config");
  }
}

type Obj = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Map an API payload to hits — pure, exported for tests. */
export function mapGrafanaResults(
  spec: GrafanaSpec,
  payload: unknown,
  base: string,
  maxResults: number,
): ContextSearchHit[] {
  const root = base.replace(/\/+$/, "");
  const out: ContextSearchHit[] = [];
  const push = (h: ContextSearchHit) => {
    if (out.length < maxResults) out.push(h);
  };
  if (spec.type === "dashboard" || spec.type === "folder") {
    for (const r of (Array.isArray(payload) ? payload : []) as Obj[]) {
      push({
        title: s(r.title) || spec.type,
        url: s(r.url) ? `${root}${s(r.url)}` : root,
        meta: {
          kind: spec.type,
          ...(s(r.uid) ? { id: `${spec.type}:${s(r.uid)}` } : {}),
          ...(s(r.folderTitle) ? { folder: s(r.folderTitle) } : {}),
          ...(Array.isArray(r.tags) && r.tags.length
            ? { tags: (r.tags as unknown[]).map(s).join(", ").slice(0, 80) }
            : {}),
        },
      });
    }
    return out;
  }
  if (spec.type === "alert") {
    const groups =
      ((payload as { data?: { groups?: unknown } })?.data?.groups as Obj[] | undefined) ?? [];
    const q = spec.query.toLowerCase();
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const r of (Array.isArray(g.rules) ? g.rules : []) as Obj[]) {
        const hay = `${s(r.name)} ${s(g.name)} ${JSON.stringify(r.labels ?? {})}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        push({
          title: `${s(r.state) || "inactive"}: ${s(r.name) || "rule"}`,
          url: `${root}/alerting/list`,
          ...(s((r.annotations as Obj | undefined)?.summary)
            ? { excerpt: s((r.annotations as Obj).summary).slice(0, 300) }
            : {}),
          meta: {
            kind: "alert",
            ...(s(g.name) ? { group: s(g.name) } : {}),
            ...(s(r.state) ? { state: s(r.state) } : {}),
            ...(s(r.health) ? { health: s(r.health) } : {}),
          },
        });
      }
    }
    return out;
  }
  if (spec.type === "annotation") {
    const q = spec.query.toLowerCase();
    for (const r of (Array.isArray(payload) ? payload : []) as Obj[]) {
      const hay = `${s(r.text)} ${s(r.alertName)} ${(Array.isArray(r.tags) ? r.tags : []).map(s).join(" ")}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const when = typeof r.time === "number" ? new Date(r.time).toISOString() : "";
      push({
        title: (s(r.alertName) || s(r.text) || "annotation").slice(0, 100),
        url: s(r.dashboardUID) ? `${root}/d/${encodeURIComponent(s(r.dashboardUID))}` : root,
        ...(s(r.text) ? { excerpt: s(r.text).slice(0, 300) } : {}),
        meta: {
          kind: "annotation",
          ...(when ? { time: when } : {}),
          ...(Array.isArray(r.tags) && r.tags.length
            ? { tags: (r.tags as unknown[]).map(s).join(", ").slice(0, 80) }
            : {}),
        },
      });
    }
    return out;
  }
  // datasource
  const q = spec.query.toLowerCase();
  for (const r of (Array.isArray(payload) ? payload : []) as Obj[]) {
    const hay = `${s(r.name)} ${s(r.type)}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    push({
      title: s(r.name) || "datasource",
      url: s(r.uid) ? `${root}/connections/datasources/edit/${encodeURIComponent(s(r.uid))}` : root,
      meta: {
        kind: "datasource",
        ...(s(r.type) ? { type: s(r.type) } : {}),
        ...(r.isDefault === true ? { default: "true" } : {}),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live panel data (ADR-0036): run a panel's native queries via /api/ds/query.
// ---------------------------------------------------------------------------

const MAX_PANELS = 8;
const MAX_FRAMES = 24;
const MAX_SUMMARY_LINES = 40;

/** Flatten a dashboard's panels, descending into row panels. */
export function collectPanels(dashboard: Obj): Obj[] {
  const out: Obj[] = [];
  const walk = (panels: unknown): void => {
    for (const p of (Array.isArray(panels) ? panels : []) as Obj[]) {
      if (s(p.type) === "row") walk(p.panels);
      else out.push(p);
    }
  };
  walk(dashboard.panels);
  return out;
}

/** Select panels by id or title (case-insensitive contains); all when blank. */
export function selectPanels(panels: Obj[], ref?: string): Obj[] {
  const r = (ref ?? "").trim().toLowerCase();
  if (!r) return panels;
  const byId = panels.filter((p) => s(p.id) === r);
  if (byId.length) return byId;
  return panels.filter((p) => s(p.title).toLowerCase().includes(r));
}

function fieldLabel(field: Obj): string {
  const name = s(field.name) || "value";
  const labels = field.labels as Obj | undefined;
  if (labels && typeof labels === "object") {
    const pairs = Object.entries(labels)
      .map(([k, v]) => `${k}=${s(v)}`)
      .join(",");
    if (pairs) return `${name}{${pairs}}`;
  }
  return name;
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return Number(n.toPrecision(5)).toString();
}

/** Build /api/ds/query `queries` from a panel's targets — pass the native query
 *  model through, attaching the resolved datasource, refId, and point caps.
 *  Skips hidden targets and ones without a concrete datasource uid
 *  (default/mixed/expression), which can't be run without datasources:read. */
export function buildDsQueries(panel: Obj, maxDataPoints: number): Obj[] {
  const panelDs = panel.datasource as Obj | undefined;
  const targets = (Array.isArray(panel.targets) ? panel.targets : []) as Obj[];
  const out: Obj[] = [];
  let auto = 0;
  for (const t of targets) {
    if (t.hide === true) continue;
    const ds = (t.datasource ?? panelDs) as Obj | undefined;
    const uid = ds && typeof ds === "object" ? s((ds as Obj).uid) : "";
    if (!uid || uid.startsWith("-- ")) continue;
    const refId = s(t.refId) || String.fromCharCode(65 + (auto % 26));
    auto += 1;
    out.push({ ...t, refId, datasource: ds, maxDataPoints, intervalMs: 60000 });
  }
  return out;
}

/** Summarize an /api/ds/query response (data frames) into compact text —
 *  per non-time field: last/min/max for numeric series, last value otherwise.
 *  Datasource-type agnostic (timeseries and table both reduce to fields). */
export function summarizeFrames(payload: unknown, maxChars: number): string {
  const results =
    (payload as { results?: Record<string, { frames?: Obj[]; error?: string }> } | null)?.results ?? {};
  const lines: string[] = [];
  for (const [refId, r] of Object.entries(results)) {
    if (r && r.error) {
      lines.push(`[${refId}] error: ${s(r.error).slice(0, 160)}`);
      continue;
    }
    const frames = (Array.isArray(r?.frames) ? r.frames : []) as Obj[];
    for (const f of frames.slice(0, MAX_FRAMES)) {
      const schema = (f.schema ?? {}) as Obj;
      const fields = (Array.isArray(schema.fields) ? schema.fields : []) as Obj[];
      const data = (f.data ?? {}) as Obj;
      const values = (Array.isArray(data.values) ? data.values : []) as unknown[][];
      const rowCount = Array.isArray(values[0]) ? values[0].length : 0;
      fields.forEach((fld, i) => {
        if (s(fld.type) === "time") return;
        const col = (Array.isArray(values[i]) ? values[i] : []) as unknown[];
        const label = fieldLabel(fld);
        const nums = col.filter((v): v is number => typeof v === "number" && isFinite(v));
        if (nums.length) {
          lines.push(
            `${label}: last=${fmtNum(nums[nums.length - 1])} min=${fmtNum(Math.min(...nums))} max=${fmtNum(Math.max(...nums))} n=${nums.length}`,
          );
        } else if (col.length) {
          lines.push(
            `${label}: ${s(col[col.length - 1]).slice(0, 60)}${rowCount > 1 ? ` (+${rowCount - 1} more rows)` : ""}`,
          );
        }
      });
    }
  }
  if (!lines.length) return "(no data returned)";
  const more = lines.length > MAX_SUMMARY_LINES ? `\n…(+${lines.length - MAX_SUMMARY_LINES} more series)` : "";
  return (lines.slice(0, MAX_SUMMARY_LINES).join("\n") + more).slice(0, maxChars);
}

interface DashboardLoad {
  uid: string;
  title: string;
  panels: Obj[];
}

/** Load a dashboard model by uid, falling back to a title search. */
async function loadDashboard(
  base: string,
  credential: ContextCredential,
  ref: string,
  timeoutMs: number,
): Promise<DashboardLoad> {
  const byUid = (uid: string) =>
    fetchJson<{ dashboard?: Obj }>(`${base}/api/dashboards/uid/${encodeURIComponent(uid)}`, credential, timeoutMs);
  let uid = ref.trim();
  let res: { dashboard?: Obj };
  try {
    res = await byUid(uid);
  } catch (err) {
    if (err instanceof AppError && err.code === "graph.notFound") {
      const hits = await fetchJson<Obj[]>(
        `${base}/api/search?type=dash-db&limit=1&query=${encodeURIComponent(uid)}`,
        credential,
        timeoutMs,
      );
      const found = Array.isArray(hits) && hits[0] ? s(hits[0].uid) : "";
      if (!found) throw new AppError(`No Grafana dashboard matched "${ref}".`, "graph.notFound");
      uid = found;
      res = await byUid(uid);
    } else {
      throw err;
    }
  }
  const dashboard = (res?.dashboard ?? {}) as Obj;
  return { uid, title: s(dashboard.title) || `dashboard ${uid}`, panels: collectPanels(dashboard) };
}

/** Live panel data: resolve a dashboard, run each selected panel's queries via
 *  /api/ds/query, and return one hit per panel with the data summarized. A
 *  panel that can't run (text/row, default datasource, denied query) degrades
 *  to a noted hit rather than failing the whole read. */
export async function queryGrafanaPanelData(
  source: ContextSource,
  credential: ContextCredential,
  spec: GrafanaSpec,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const base = grafanaBaseOf(source);
  const dash = await loadDashboard(base, credential, spec.query, caps.timeoutMs);
  const selected = selectPanels(dash.panels, spec.panel);
  if (!selected.length) {
    const names = dash.panels.map((p) => s(p.title)).filter(Boolean).join("; ").slice(0, 300);
    throw new AppError(
      `No panel matched${spec.panel ? ` "${spec.panel}"` : ""} on "${dash.title}". Panels: ${names || "(none)"}`,
      "graph.notFound",
    );
  }
  const from = spec.from ?? "now-6h";
  const to = spec.to ?? "now";
  const hits: ContextSearchHit[] = [];
  for (const panel of selected.slice(0, MAX_PANELS)) {
    const url = `${base}/d/${encodeURIComponent(dash.uid)}?viewPanel=${encodeURIComponent(s(panel.id))}`;
    const queries = buildDsQueries(panel, 100);
    const baseMeta = { kind: "panel", dashboard: dash.title } as Record<string, string>;
    if (!queries.length) {
      hits.push({
        title: s(panel.title) || "panel",
        url,
        excerpt: "(no runnable datasource query — a text/row panel, or a default/mixed datasource)",
        meta: baseMeta,
      });
      continue;
    }
    try {
      const res = await fetchJson<unknown>(`${base}/api/ds/query`, credential, caps.timeoutMs, undefined, {
        method: "POST",
        body: { from, to, queries },
      });
      hits.push({
        title: s(panel.title) || "panel",
        url,
        excerpt: summarizeFrames(res, caps.maxBodyChars),
        meta: { ...baseMeta, ...(s(panel.type) ? { type: s(panel.type) } : {}), range: `${from}→${to}` },
      });
    } catch (err) {
      const msg = err instanceof AppError ? err.message : String(err);
      hits.push({ title: s(panel.title) || "panel", url, excerpt: `(live query failed: ${msg.slice(0, 160)})`, meta: baseMeta });
    }
  }
  return hits.slice(0, caps.maxResults);
}

/** Single deliberate verification read (ADR-0009): the smallest dashboard
 *  search — every Viewer-grade token can run it. Org name is a best-effort
 *  label on top. */
export async function verifyGrafana(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const base = grafanaBaseOf(source);
  await fetchJson(`${base}/api/search?limit=1`, credential, caps.timeoutMs);
  const org = await fetchJson<{ name?: string }>(
    `${base}/api/org`,
    credential,
    caps.timeoutMs,
  ).catch(() => undefined);
  return { account: org?.name ?? credential.username ?? "token verified" };
}

export async function searchGrafana(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const base = grafanaBaseOf(source);
  const spec = parseGrafanaSpec(query);
  if (spec.type === "panel") {
    if (!spec.query) {
      throw new AppError(
        'Live panel data needs the dashboard: {"type":"panel","query":"<dashboard uid or title>","panel":"<id or title, optional>"}.',
        "config",
      );
    }
    return queryGrafanaPanelData(source, credential, spec, caps);
  }
  let payload: unknown;
  try {
    payload = await fetchJson<unknown>(
      `${base}${grafanaSearchPath(spec, caps.maxResults)}`,
      credential,
      caps.timeoutMs,
    );
  } catch (err) {
    if (spec.type === "datasource" && err instanceof AppError && err.code === "auth.failed") {
      throw new AppError(
        "Grafana denied the datasource listing — it needs the datasources:read permission (often admin-only).",
        "config",
        "Dashboards, folders, alert state, and annotations remain readable with a Viewer token.",
      );
    }
    throw err;
  }
  return mapGrafanaResults(spec, payload, base, caps.maxResults);
}

/** Item fetch for dashboards: "dashboard:<uid>" (or a bare uid). Returns the
 *  dashboard's description and panel inventory — not the full JSON model. */
export async function getGrafanaItem(
  source: ContextSource,
  credential: ContextCredential,
  id: string,
  caps: ReadCaps,
): Promise<ContextItem> {
  const uid = id.trim().replace(/^dashboard:/, "");
  if (!uid || uid.includes(":")) {
    throw new AppError(
      'Grafana items are fetched as "dashboard:<uid>" (search hits carry this in meta.id).',
      "config",
    );
  }
  const base = grafanaBaseOf(source);
  const res = await fetchJson<{
    dashboard?: { title?: string; description?: string; tags?: unknown[]; panels?: Obj[] };
    meta?: { url?: string; folderTitle?: string };
  }>(`${base}/api/dashboards/uid/${encodeURIComponent(uid)}`, credential, caps.timeoutMs);
  const dash = res.dashboard ?? {};
  const panels = (Array.isArray(dash.panels) ? dash.panels : [])
    .map((p) => `- [panel ${s(p.id)}] ${s(p.title) || "(untitled)"} [${s(p.type)}]`)
    .join("\n");
  const body = [
    s(dash.description),
    panels ? `Panels:\n${panels}` : "",
    panels
      ? `For LIVE data from a panel, search this source with {"type":"panel","query":"${uid}","panel":"<id or title>"} (optional "from"/"to", default now-6h).`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    title: s(dash.title) || `dashboard ${uid}`,
    url: s(res.meta?.url) ? `${base}${s(res.meta?.url)}` : `${base}/d/${encodeURIComponent(uid)}`,
    body: (body || "(no description)").slice(0, caps.maxBodyChars),
    meta: {
      kind: "dashboard",
      id: `dashboard:${uid}`,
      ...(s(res.meta?.folderTitle) ? { folder: s(res.meta?.folderTitle) } : {}),
    },
  };
}

/** Folders + standing alert/annotation views → bookmark candidates. */
export async function browseGrafanaCandidates(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<Array<{ name: string; locator: string; kind: "query"; detail: string }>> {
  const base = grafanaBaseOf(source);
  const out: Array<{ name: string; locator: string; kind: "query"; detail: string }> = [
    {
      name: "Alert rules — current state",
      locator: JSON.stringify({ type: "alert", query: "" }),
      kind: "query",
      detail: "Grafana unified alerting",
    },
    {
      name: "Recent annotations",
      locator: JSON.stringify({ type: "annotation", query: "" }),
      kind: "query",
      detail: "Grafana annotations",
    },
  ];
  const folders = await fetchJson<unknown>(
    `${base}/api/folders?limit=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  ).catch(() => undefined);
  for (const f of (Array.isArray(folders) ? folders : []) as Obj[]) {
    if (!s(f.title) || !s(f.uid)) continue;
    out.push({
      name: `Folder: ${s(f.title)} — dashboards`,
      locator: JSON.stringify({ type: "dashboard", query: "", folderUid: s(f.uid) }),
      kind: "query",
      detail: "Grafana folder",
    });
  }
  return out.slice(0, caps.maxResults * 2);
}
