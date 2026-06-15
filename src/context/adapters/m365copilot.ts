import { ContextSource, ContextSearchHit, ReadCaps } from "../types";
import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, safeJson, safeUrl } from "../../core/wireLog";

/**
 * Microsoft 365 Copilot connector (ADR-0034/0035): give @sharepoint the same
 * breadth of grounding the Microsoft 365 Copilot web app has, across two
 * complementary Graph engines, strictly read-only and within the signed-in
 * user's own permissions:
 *
 *  - **Retrieval API** (`POST /copilot/retrieval`) — semantic grounding
 *    extracts from **SharePoint/OneDrive documents** and **Copilot (Graph)
 *    connectors**, with optional KQL scoping.
 *  - **Microsoft Search API** (`POST /search/query`) — breadth across the rest
 *    of Microsoft 365: **Outlook email**, **calendar events**, **Teams
 *    messages**, and **people**. (The Retrieval API does not reach these.)
 *
 * Which surfaces are active is a per-source choice (stored on the baseUrl
 * `?surfaces=` query) so the delegated consent footprint matches exactly what
 * the tenant enabled — SharePoint/OneDrive only, by default. Auth reuses the
 * extension's Microsoft 365 sign-in (aad-sso) or a pasted Graph token (pat).
 */

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Both engines cap free-text at 1,500 characters. */
export const QUERY_CAP = 1500;
/** Both engines cap results at 25 per request. */
export const RESULT_CAP = 25;

/** A groundable Microsoft 365 surface. Retrieval surfaces use the Copilot
 *  Retrieval API; search surfaces use the Microsoft Search API. */
export type M365Surface =
  | "sharePoint" // Retrieval: SharePoint + OneDrive documents
  | "externalItem" // Retrieval: Microsoft 365 Copilot (Graph) connectors
  | "message" // Search: Outlook email
  | "event" // Search: calendar events
  | "chatMessage" // Search: Teams messages
  | "person"; // Search: people / expertise

export const RETRIEVAL_SURFACES: M365Surface[] = ["sharePoint", "externalItem"];
export const SEARCH_SURFACES: M365Surface[] = ["message", "event", "chatMessage", "person"];
const ALL_SURFACES = new Set<M365Surface>([...RETRIEVAL_SURFACES, ...SEARCH_SURFACES]);

/** Delegated Graph scope(s) each surface requires. */
const SURFACE_SCOPES: Record<M365Surface, string[]> = {
  sharePoint: ["Files.Read.All", "Sites.Read.All"],
  externalItem: ["ExternalItem.Read.All"],
  message: ["Mail.Read"],
  event: ["Calendars.Read"],
  chatMessage: ["Chat.Read"],
  person: ["People.Read"],
};

/** Resource metadata fields requested from the Retrieval API for richer hits. */
const RETRIEVAL_METADATA = ["title", "author", "lastModifiedTime"];

/** Token access is injected: the MSAL provider lives in the extension layer. */
export type GraphTokenGetter = (interactive: boolean) => Promise<string>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const clampResults = (n: number): number => Math.max(1, Math.min(Math.floor(n) || 1, RESULT_CAP));

/** Case-insensitive lookup into a metadata bag (SharePoint managed-property
 *  casing varies: title vs Title, lastModifiedTime vs LastModifiedTime). */
function pickMeta(bag: Record<string, unknown> | undefined, name: string): string {
  if (!bag) return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase() === lower) return str(v);
  }
  return "";
}

/** Enabled surfaces from the source baseUrl (`?surfaces=a,b,c`), defaulting to
 *  SharePoint/OneDrive documents. Back-compatible with the first release's
 *  `?dataSource=sharePoint|externalItem`. */
export function surfacesOf(source: ContextSource): M365Surface[] {
  let raw = "";
  try {
    const params = new URL(source.baseUrl).searchParams;
    raw = params.get("surfaces") ?? params.get("dataSource") ?? "";
  } catch {
    raw = "";
  }
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is M365Surface => ALL_SURFACES.has(s as M365Surface));
  return picked.length ? [...new Set(picked)] : ["sharePoint"];
}

/** Delegated, fully-qualified Graph scopes for a source's enabled surfaces. */
export function scopesForSurfaces(surfaces: M365Surface[]): string[] {
  const set = new Set<string>();
  for (const s of surfaces) for (const sc of SURFACE_SCOPES[s]) set.add(`https://graph.microsoft.com/${sc}`);
  return [...set];
}

export function scopesForSource(source: ContextSource): string[] {
  return scopesForSurfaces(surfacesOf(source));
}

/** Parse a query that is either plain natural language or a JSON spec
 *  `{"query": "...", "filter": "<KQL>"}` (the filter scopes both engines). */
export function parseM365Query(raw: string): { query: string; filter?: string } {
  const t = (raw ?? "").trim();
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t) as { query?: unknown; queryString?: unknown; filter?: unknown; filterExpression?: unknown };
      const q = str(o.query ?? o.queryString).trim();
      const f = str(o.filter ?? o.filterExpression).trim();
      if (q) return { query: q, ...(f ? { filter: f } : {}) };
    } catch {
      // not JSON — fall through to plain text
    }
  }
  return { query: t };
}

// ---------------------------------------------------------------------------
// Retrieval API (semantic doc/connector grounding)
// ---------------------------------------------------------------------------

export type RetrievalDataSource = "sharePoint" | "externalItem";

/** Build the Retrieval API request body (pure, testable). */
export function buildRetrievalBody(
  query: string,
  dataSource: RetrievalDataSource,
  maxResults: number,
  filterExpression?: string,
): Record<string, unknown> {
  return {
    queryString: query.slice(0, QUERY_CAP),
    dataSource,
    maximumNumberOfResults: clampResults(maxResults),
    resourceMetadata: RETRIEVAL_METADATA,
    ...(filterExpression ? { filterExpression } : {}),
  };
}

interface RetrievalHit {
  webUrl?: string;
  extracts?: Array<{ text?: string; relevanceScore?: number }>;
  resourceType?: string;
  resourceMetadata?: Record<string, unknown>;
  sensitivityLabel?: { displayName?: string } | null;
}

function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/** Map a Retrieval API response into capped ContextSearchHits (pure, testable). */
export function retrievalHitsToContext(payload: unknown, caps: ReadCaps): ContextSearchHit[] {
  const hits = ((payload as { retrievalHits?: RetrievalHit[] } | null)?.retrievalHits ?? []) as RetrievalHit[];
  return hits.slice(0, caps.maxResults).map((h) => {
    const url = str(h.webUrl);
    const extracts = h.extracts ?? [];
    const excerpt = extracts
      .map((e) => str(e?.text).trim())
      .filter(Boolean)
      .join(" … ")
      .replace(/\s+/g, " ")
      .trim();
    const score = extracts.map((e) => e?.relevanceScore).find((v) => typeof v === "number");
    const rm = h.resourceMetadata;
    const meta: Record<string, string> = {};
    if (h.resourceType) meta.type = str(h.resourceType);
    if (pickMeta(rm, "author")) meta.author = pickMeta(rm, "author");
    if (pickMeta(rm, "lastModifiedTime")) meta.lastModified = pickMeta(rm, "lastModifiedTime");
    if (typeof score === "number") meta.relevance = score.toFixed(3);
    if (h.sensitivityLabel?.displayName) meta.sensitivity = str(h.sensitivityLabel.displayName);
    return {
      title: pickMeta(rm, "title") || titleFromUrl(url) || "(untitled result)",
      url,
      ...(excerpt ? { excerpt: excerpt.slice(0, caps.maxBodyChars) } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Microsoft Search API (breadth: email / calendar / Teams / people)
// ---------------------------------------------------------------------------

/** Build a Microsoft Search request — one sub-request per entity type so a
 *  type the tenant doesn't support can't void the others (pure, testable). */
export function buildSearchRequest(
  entityTypes: M365Surface[],
  queryString: string,
  size: number,
): Record<string, unknown> {
  return {
    requests: entityTypes.map((et) => ({
      entityTypes: [et],
      query: { queryString: queryString.slice(0, QUERY_CAP) },
      from: 0,
      size: clampResults(size),
    })),
  };
}

/** Strip Microsoft Search hit-highlight tags (<c0>…</c0>) and any stray HTML. */
function stripHighlights(s: string): string {
  return s
    .replace(/<\/?c\d+>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SearchResource {
  "@odata.type"?: string;
  subject?: string;
  name?: string;
  displayName?: string;
  title?: string;
  webLink?: string;
  webUrl?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  start?: { dateTime?: string };
}

/** Map a Microsoft Search response (one container per sub-request) into capped
 *  ContextSearchHits with entity-aware titles/links/meta (pure, testable). */
export function searchHitsToContext(payload: unknown, caps: ReadCaps): ContextSearchHit[] {
  const responses = ((payload as { value?: Array<{ hitsContainers?: Array<{ hits?: Array<{ summary?: string; resource?: SearchResource }> }> }> } | null)?.value ?? []);
  const out: ContextSearchHit[] = [];
  for (const resp of responses) {
    for (const c of resp.hitsContainers ?? []) {
      for (const h of c.hits ?? []) {
        const r = h.resource ?? {};
        const kind = str(r["@odata.type"]).replace("#microsoft.graph.", "");
        const title = str(r.subject) || str(r.name) || str(r.displayName) || str(r.title) || `(${kind || "result"})`;
        const url = str(r.webLink) || str(r.webUrl);
        const excerpt = stripHighlights(str(h.summary)).slice(0, caps.maxBodyChars);
        const meta: Record<string, string> = {};
        if (kind) meta.type = kind;
        const from = r.from?.emailAddress?.name || r.from?.emailAddress?.address;
        if (from) meta.from = str(from);
        if (str(r.receivedDateTime)) meta.received = str(r.receivedDateTime);
        if (r.start?.dateTime) meta.start = str(r.start.dateTime);
        if (str(r.lastModifiedDateTime)) meta.lastModified = str(r.lastModifiedDateTime);
        out.push({ title, url, ...(excerpt ? { excerpt } : {}), ...(Object.keys(meta).length ? { meta } : {}) });
        if (out.length >= caps.maxResults) return out;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graph transport
// ---------------------------------------------------------------------------

async function graphFetch<T>(path: string, token: string, timeoutMs: number, body?: unknown): Promise<T> {
  const method = body !== undefined ? "POST" : "GET";
  const started = Date.now();
  if (wireEnabled()) {
    emitWire(
      "m365copilot",
      "→",
      `${method} ${safeUrl(path)}`,
      `Authorization: Bearer ***${body !== undefined ? `\n${safeJson(body)}` : ""}`,
    );
  }
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire(
      "m365copilot",
      "✗",
      `${method} ${safeUrl(path)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`,
    );
    throw new AppError(
      `Microsoft 365 request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (!res.ok) {
    emitWire("m365copilot", "✗", `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`);
  }
  if (res.status === 401) {
    throw new AppError(
      "Microsoft 365 rejected the sign-in (401).",
      "auth.failed",
      "Run “Test Context Source” to re-consent your Microsoft 365 sign-in.",
    );
  }
  if (res.status === 403) {
    const detail = await res.text().catch(() => "");
    throw new AppError(
      `Microsoft 365 refused the request (403): ${detail.slice(0, 300)}`,
      "graph.forbidden",
      "Retrieval needs a Microsoft 365 Copilot licence; each enabled surface needs its delegated scope (Files.Read.All + Sites.Read.All for documents, Mail.Read for email, Calendars.Read for calendar, Chat.Read for Teams, People.Read for people, ExternalItem.Read.All for connectors). Confirm the licence/scopes with an admin (see the Admin Guide).",
    );
  }
  if (res.status === 404) {
    throw new AppError(
      "Microsoft 365 endpoint not found (404) — the tenant may not have this API enabled yet.",
      "config",
    );
  }
  if (res.status === 429) {
    throw new AppError("Microsoft 365 Graph is throttling requests (429).", "graph.throttled");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AppError(`Microsoft 365 request failed (${res.status}): ${detail.slice(0, 300)}`, "unknown");
  }
  const parsed = (await res.json()) as T;
  if (wireEnabled()) {
    emitWire("m365copilot", "←", `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`, safeJson(parsed));
  }
  return parsed;
}

async function retrieveOne(
  ds: RetrievalDataSource,
  token: string,
  query: string,
  filter: string | undefined,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const payload = await graphFetch<unknown>(
    "/copilot/retrieval",
    token,
    caps.timeoutMs,
    buildRetrievalBody(query, ds, caps.maxResults, filter),
  );
  return retrievalHitsToContext(payload, caps);
}

async function runSearch(
  entityTypes: M365Surface[],
  token: string,
  query: string,
  filter: string | undefined,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  // Microsoft Search uses KQL in the queryString, so a filter is appended.
  const queryString = filter ? `(${query}) AND (${filter})` : query;
  const payload = await graphFetch<unknown>(
    "/search/query",
    token,
    caps.timeoutMs,
    buildSearchRequest(entityTypes, queryString, caps.maxResults),
  );
  return searchHitsToContext(payload, caps);
}

/** Verify-on-connect: confirm every enabled engine in one deliberate read each
 *  (ADR-0009) — proving the endpoint, the delegated scopes, and (for retrieval)
 *  the Copilot licence. */
export async function verifyM365Copilot(
  source: ContextSource,
  getToken: GraphTokenGetter,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const surfaces = surfacesOf(source);
  const token = await getToken(true);
  const tasks: Promise<unknown>[] = [];
  const retrieval = surfaces.filter((s): s is RetrievalDataSource => (RETRIEVAL_SURFACES as string[]).includes(s));
  const searchEntities = surfaces.filter((s) => (SEARCH_SURFACES as string[]).includes(s));
  if (retrieval.length) {
    tasks.push(graphFetch("/copilot/retrieval", token, caps.timeoutMs, buildRetrievalBody("test", retrieval[0], 1)));
  }
  if (searchEntities.length) {
    tasks.push(graphFetch("/search/query", token, caps.timeoutMs, buildSearchRequest(searchEntities, "test", 1)));
  }
  await Promise.all(tasks);
  return { account: "Microsoft 365 Copilot" };
}

/** Retrieve grounded context for a natural-language query across the source's
 *  enabled surfaces. Engines run independently — a failing surface doesn't void
 *  the others, but an all-failure surfaces the first error. */
export async function searchM365Copilot(
  source: ContextSource,
  getToken: GraphTokenGetter,
  rawQuery: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const { query, filter } = parseM365Query(rawQuery);
  if (!query) {
    throw new AppError("Provide a natural-language query for Microsoft 365 retrieval/search.", "config");
  }
  const surfaces = surfacesOf(source);
  const retrieval = surfaces.filter((s): s is RetrievalDataSource => (RETRIEVAL_SURFACES as string[]).includes(s));
  const searchEntities = surfaces.filter((s) => (SEARCH_SURFACES as string[]).includes(s));
  const token = await getToken(false);

  const tasks: Promise<ContextSearchHit[]>[] = [];
  for (const ds of retrieval) tasks.push(retrieveOne(ds, token, query, filter, caps));
  if (searchEntities.length) tasks.push(runSearch(searchEntities, token, query, filter, caps));

  const settled = await Promise.allSettled(tasks);
  const hits: ContextSearchHit[] = [];
  const errors: AppError[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") hits.push(...r.value);
    else errors.push(r.reason instanceof AppError ? r.reason : new AppError(String(r.reason), "unknown"));
  }
  if (hits.length === 0 && errors.length) throw errors[0];
  return hits.slice(0, caps.maxResults);
}
