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
 * Grafana connector (ADR-0033): read-only reads against a Grafana instance
 * (Cloud stack or self-hosted) with a service-account token (Bearer) or
 * basic auth. Surfaces dashboards/folders (search), unified-alerting rule
 * STATE (the Viewer-readable Prometheus-style endpoint), annotations, and
 * datasources. Running datasource queries through `/api/ds/query` is
 * deliberately out of scope for v1 — payloads are per-datasource-type and
 * belong behind their own design.
 */

export type GrafanaObjectType =
  | "dashboard"
  | "folder"
  | "alert"
  | "annotation"
  | "datasource";

const OBJECT_TYPES = new Set<GrafanaObjectType>([
  "dashboard",
  "folder",
  "alert",
  "annotation",
  "datasource",
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
}

/** Parse a chat/bookmark query:
 *  - JSON spec {"type": "alert", "query": "cpu", "limit": 25, "folderUid": "…"}
 *  - free text → dashboard search. */
export function parseGrafanaSpec(query: string): GrafanaSpec {
  const trimmed = query.trim();
  if (trimmed.startsWith("{")) {
    let raw: { type?: unknown; query?: unknown; limit?: unknown; folderUid?: unknown };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(
        'Grafana queries are JSON: {"type": "dashboard|folder|alert|annotation|datasource", "query": "cpu", "limit": 25} — or plain text to search dashboards.',
        "config",
      );
    }
    const type =
      typeof raw.type === "string" && OBJECT_TYPES.has(raw.type as GrafanaObjectType)
        ? (raw.type as GrafanaObjectType)
        : "dashboard";
    return {
      type,
      query: typeof raw.query === "string" ? raw.query.trim() : "",
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
      ...(typeof raw.folderUid === "string" && raw.folderUid.trim()
        ? { folderUid: raw.folderUid.trim() }
        : {}),
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
    .map((p) => `- ${s(p.title) || "(untitled)"} [${s(p.type)}]`)
    .join("\n");
  const body = [
    s(dash.description),
    panels ? `Panels:\n${panels}` : "",
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
