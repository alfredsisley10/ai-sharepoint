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
 * Splunk Observability Cloud connector (ADR-0032) — the former SignalFx.
 * Read-only REST reads against `https://api.<realm>.signalfx.com`
 * (metrics/dimensions metadata, detectors, dashboards, active incidents),
 * authenticated with an access token sent as `X-SF-TOKEN`. SignalFlow
 * program execution (streamed computation) is deliberately out of scope
 * for v1 — searches stay bounded, synchronous metadata/state reads.
 */

export type SplunkObsObjectType =
  | "metric"
  | "dimension"
  | "detector"
  | "dashboard"
  | "incident";

const OBJECT_TYPES = new Set<SplunkObsObjectType>([
  "metric",
  "dimension",
  "detector",
  "dashboard",
  "incident",
]);

export interface SplunkObsEndpoints {
  realm: string;
  apiBase: string;
  appBase: string;
}

const endpointsForRealm = (realm: string): SplunkObsEndpoints => ({
  realm,
  apiBase: `https://api.${realm}.signalfx.com`,
  appBase: `https://app.${realm}.signalfx.com`,
});

/** Users paste what they have: the app URL, the API URL, or just the realm
 *  ("us1"). Realms follow the <region><digit> shape (us0, us1, eu0, jp0…). */
export function deriveSplunkObsEndpoints(input: string): SplunkObsEndpoints | undefined {
  const t = input.trim().replace(/\/+$/, "");
  if (/^[a-z]{2}\d+$/i.test(t)) return endpointsForRealm(t.toLowerCase());
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  const m = u.hostname.match(
    /^(?:app|api|ingest|stream)\.([a-z]{2}\d+)\.(?:signalfx\.com|observability\.splunk\.com)$/i,
  );
  return m ? endpointsForRealm(m[1].toLowerCase()) : undefined;
}

/** The descriptor stores the API base plus display/default params:
 *  `https://api.us1.signalfx.com?web=https://app.us1.signalfx.com&type=metric`. */
export function splunkObsEndpointsOf(
  source: Pick<ContextSource, "baseUrl">,
): SplunkObsEndpoints & { defaultType: SplunkObsObjectType } {
  const u = new URL(source.baseUrl);
  const apiBase = `${u.protocol}//${u.host}`;
  const realm = u.hostname.match(/^api\.([a-z]{2}\d+)\./i)?.[1]?.toLowerCase() ?? "";
  const web = u.searchParams.get("web");
  const typeParam = u.searchParams.get("type") as SplunkObsObjectType | null;
  return {
    realm,
    apiBase,
    appBase: web ?? (realm ? `https://app.${realm}.signalfx.com` : apiBase),
    defaultType: typeParam && OBJECT_TYPES.has(typeParam) ? typeParam : "metric",
  };
}

export interface SplunkObsSpec {
  type: SplunkObsObjectType;
  query: string;
  limit?: number;
}

/** Parse a chat/bookmark query:
 *  - JSON spec {"type": "detector", "query": "cpu", "limit": 25}
 *  - free text → the source's default object type. */
export function parseSplunkObsSpec(
  query: string,
  defaultType: SplunkObsObjectType = "metric",
): SplunkObsSpec {
  const trimmed = query.trim();
  if (trimmed.startsWith("{")) {
    let raw: { type?: unknown; query?: unknown; limit?: unknown };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(
        'Splunk Observability queries are JSON: {"type": "metric|dimension|detector|dashboard|incident", "query": "cpu", "limit": 25} — or plain text for the default type.',
        "config",
      );
    }
    const type =
      typeof raw.type === "string" && OBJECT_TYPES.has(raw.type as SplunkObsObjectType)
        ? (raw.type as SplunkObsObjectType)
        : defaultType;
    return {
      type,
      query: typeof raw.query === "string" ? raw.query.trim() : "",
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
    };
  }
  if (!trimmed) throw new AppError("Empty Splunk Observability query.", "config");
  return { type: defaultType, query: trimmed };
}

/** Metric/dimension search uses the lucene-ish `name:` syntax; bare words
 *  become contains-matches, raw `field:value` queries pass through. */
const metricQuery = (q: string): string => (!q ? "*" : q.includes(":") ? q : `name:*${q}*`);

/** API path per object type — pure so query construction is test-locked. */
export function splunkObsSearchPath(spec: SplunkObsSpec, maxResults: number): string {
  const limit = Math.min(Math.max(spec.limit ?? maxResults, 1), maxResults);
  switch (spec.type) {
    case "metric":
      return `/v2/metric?query=${encodeURIComponent(metricQuery(spec.query))}&limit=${limit}`;
    case "dimension":
      return `/v2/dimension?query=${encodeURIComponent(metricQuery(spec.query))}&limit=${limit}`;
    case "detector":
      return `/v2/detector?name=${encodeURIComponent(spec.query)}&limit=${limit}`;
    case "dashboard":
      return `/v2/dashboard?name=${encodeURIComponent(spec.query)}&limit=${limit}`;
    case "incident":
      // No server-side text filter — active incidents are fetched and
      // filtered locally against the query.
      return `/v2/incident?limit=${limit}&includeResolved=false`;
  }
}

type Obj = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Normalize the two payload shapes the API uses ({results: []} vs bare []). */
function resultsOf(payload: unknown): Obj[] {
  if (Array.isArray(payload)) return payload as Obj[];
  const r = (payload as { results?: unknown })?.results;
  return Array.isArray(r) ? (r as Obj[]) : [];
}

/** Map an API payload to hits — pure, exported for tests. */
export function mapSplunkObsResults(
  spec: SplunkObsSpec,
  payload: unknown,
  appBase: string,
  maxResults: number,
): ContextSearchHit[] {
  const items = resultsOf(payload);
  const base = appBase.replace(/\/+$/, "");
  const out: ContextSearchHit[] = [];
  for (const r of items) {
    if (out.length >= maxResults) break;
    switch (spec.type) {
      case "metric":
        out.push({
          title: s(r.name) || "metric",
          url: `${base}/#/metrics`,
          ...(s(r.description) ? { excerpt: s(r.description).slice(0, 300) } : {}),
          meta: { kind: "metric", ...(s(r.type) ? { type: s(r.type) } : {}) },
        });
        break;
      case "dimension":
        out.push({
          title: `${s(r.key)}:${s(r.value)}`,
          url: `${base}/#/metrics`,
          meta: { kind: "dimension" },
        });
        break;
      case "detector":
        out.push({
          title: s(r.name) || "detector",
          url: s(r.id) ? `${base}/#/detector/${encodeURIComponent(s(r.id))}` : base,
          ...(s(r.description) ? { excerpt: s(r.description).slice(0, 300) } : {}),
          meta: { kind: "detector", ...(s(r.id) ? { id: `detector:${s(r.id)}` } : {}) },
        });
        break;
      case "dashboard":
        out.push({
          title: s(r.name) || "dashboard",
          url: s(r.id) ? `${base}/#/dashboard/${encodeURIComponent(s(r.id))}` : base,
          ...(s(r.description) ? { excerpt: s(r.description).slice(0, 300) } : {}),
          meta: { kind: "dashboard", ...(s(r.id) ? { id: `dashboard:${s(r.id)}` } : {}) },
        });
        break;
      case "incident": {
        const hay = `${s(r.detectorName)} ${s(r.displayBody)} ${s(r.severity)}`.toLowerCase();
        if (spec.query && !hay.includes(spec.query.toLowerCase())) break;
        out.push({
          title: `${s(r.severity) || "incident"}: ${s(r.detectorName) || s(r.incidentId) || "alert"}`,
          url: s(r.detectorId) ? `${base}/#/detector/${encodeURIComponent(s(r.detectorId))}` : base,
          ...(s(r.displayBody) ? { excerpt: s(r.displayBody).slice(0, 300) } : {}),
          meta: {
            kind: "incident",
            ...(s(r.anomalyState) ? { state: s(r.anomalyState) } : {}),
            ...(s(r.severity) ? { severity: s(r.severity) } : {}),
          },
        });
        break;
      }
    }
  }
  return out;
}

/** Single deliberate verification read (ADR-0009): the smallest metric-
 *  metadata query every API-scoped token can run; the org name is a
 *  best-effort label on top (some tokens cannot read the org object). */
export async function verifySplunkObs(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const { apiBase } = splunkObsEndpointsOf(source);
  await fetchJson(`${apiBase}/v2/metric?query=*&limit=1`, credential, caps.timeoutMs);
  const org = await fetchJson<{ organizationName?: string }>(
    `${apiBase}/v2/organization`,
    credential,
    caps.timeoutMs,
  ).catch(() => undefined);
  return { account: org?.organizationName ?? "token verified" };
}

export async function searchSplunkObs(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const { apiBase, appBase, defaultType } = splunkObsEndpointsOf(source);
  const spec = parseSplunkObsSpec(query, defaultType);
  const payload = await fetchJson<unknown>(
    `${apiBase}${splunkObsSearchPath(spec, caps.maxResults)}`,
    credential,
    caps.timeoutMs,
  );
  return mapSplunkObsResults(spec, payload, appBase, caps.maxResults);
}

/** Item fetch for the ids search hits carry: detector:<id> / dashboard:<id>. */
export async function getSplunkObsItem(
  source: ContextSource,
  credential: ContextCredential,
  id: string,
  caps: ReadCaps,
): Promise<ContextItem> {
  const { apiBase, appBase } = splunkObsEndpointsOf(source);
  const m = id.trim().match(/^(detector|dashboard):(.+)$/);
  if (!m) {
    throw new AppError(
      'Splunk Observability items are fetched as "detector:<id>" or "dashboard:<id>" (search hits carry these in meta.id). Metrics/incidents have no item fetch — use search.',
      "config",
    );
  }
  const [, kind, rawId] = m;
  const obj = await fetchJson<Obj>(
    `${apiBase}/v2/${kind}/${encodeURIComponent(rawId)}`,
    credential,
    caps.timeoutMs,
  );
  const body = [
    s(obj.description),
    kind === "detector" && s(obj.programText)
      ? `SignalFlow:\n${s(obj.programText)}`
      : "",
    kind === "dashboard" && Array.isArray(obj.charts)
      ? `${(obj.charts as unknown[]).length} chart(s)`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    title: s(obj.name) || `${kind} ${rawId}`,
    url: `${appBase.replace(/\/+$/, "")}/#/${kind}/${encodeURIComponent(rawId)}`,
    body: (body || "(no description)").slice(0, caps.maxBodyChars),
    meta: { kind, id: `${kind}:${rawId}` },
  };
}

/** Dashboards + detectors → ready-made bookmark candidates (best-effort
 *  each, like the Splunk browse). */
export async function browseSplunkObsCandidates(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<Array<{ name: string; locator: string; kind: "query"; detail: string }>> {
  const { apiBase } = splunkObsEndpointsOf(source);
  const out: Array<{ name: string; locator: string; kind: "query"; detail: string }> = [];
  out.push({
    name: "Active incidents (alerts firing now)",
    locator: JSON.stringify({ type: "incident", query: "" }),
    kind: "query",
    detail: "Splunk Observability incidents",
  });
  const dashboards = await fetchJson<unknown>(
    `${apiBase}/v2/dashboard?limit=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  ).catch(() => undefined);
  for (const d of resultsOf(dashboards)) {
    if (!s(d.name)) continue;
    out.push({
      name: `Dashboard: ${s(d.name)}`,
      locator: JSON.stringify({ type: "dashboard", query: s(d.name) }),
      kind: "query",
      detail: "Splunk Observability dashboard",
    });
  }
  const detectors = await fetchJson<unknown>(
    `${apiBase}/v2/detector?limit=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  ).catch(() => undefined);
  for (const d of resultsOf(detectors)) {
    if (!s(d.name)) continue;
    out.push({
      name: `Detector: ${s(d.name)}`,
      locator: JSON.stringify({ type: "detector", query: s(d.name) }),
      kind: "query",
      detail: "Splunk Observability detector",
    });
  }
  return out.slice(0, caps.maxResults * 2);
}
