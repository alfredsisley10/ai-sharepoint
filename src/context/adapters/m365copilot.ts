import { ContextSource, ContextSearchHit, ReadCaps } from "../types";
import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, safeJson, safeUrl } from "../../core/wireLog";

/**
 * Microsoft 365 Copilot connector (ADR-0034): leverage Copilot's grounded
 * enterprise context through the Microsoft 365 Copilot **Retrieval API**
 * (`POST /copilot/retrieval`). It returns the same grounding passages Copilot
 * itself reasons over — the most relevant extracts from the user's SharePoint /
 * OneDrive (and, when scoped, Graph connectors) — ranked by Microsoft 365's
 * semantic index and trimmed to what the signed-in user is allowed to see.
 *
 * Strictly read-only and delegated: it reuses the extension's Microsoft 365
 * sign-in (method "aad-sso") or a pasted Graph access token (method "pat"), so
 * there is no new app registration — only delegated Files.Read.All +
 * Sites.Read.All consent and a Microsoft 365 Copilot license on the account.
 */

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Delegated Graph scopes the Retrieval API needs for SharePoint + OneDrive
 *  grounding (both are required; ExternalItem.Read.All would add connectors). */
export const M365_COPILOT_SCOPES = [
  "https://graph.microsoft.com/Files.Read.All",
  "https://graph.microsoft.com/Sites.Read.All",
];

/** Token access is injected: the MSAL provider lives in the extension layer. */
export type GraphTokenGetter = (interactive: boolean) => Promise<string>;

/** Which Microsoft 365 surface to ground on. Persisted on the source's
 *  baseUrl query (`?dataSource=sharePoint|externalItem`); default sharePoint. */
export type RetrievalDataSource = "sharePoint" | "externalItem";

/** The Retrieval API caps queryString at 1,500 characters. */
export const QUERY_CAP = 1500;

export function retrievalDataSourceOf(source: ContextSource): RetrievalDataSource {
  try {
    const v = new URL(source.baseUrl).searchParams.get("dataSource");
    return v === "externalItem" ? "externalItem" : "sharePoint";
  } catch {
    return "sharePoint";
  }
}

interface RetrievalHit {
  webUrl?: string;
  extracts?: Array<{ text?: string }>;
  resourceType?: string;
  resourceMetadata?: Record<string, unknown>;
  sensitivityLabel?: { displayName?: string } | null;
}

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
    maximumNumberOfResults: Math.max(1, Math.min(maxResults, 25)),
    ...(filterExpression ? { filterExpression } : {}),
  };
}

function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/** Map a Retrieval API response into capped ContextSearchHits (pure, testable).
 *  Defensive about field presence — the API is preview and may evolve. */
export function retrievalHitsToContext(payload: unknown, caps: ReadCaps): ContextSearchHit[] {
  const hits = ((payload as { retrievalHits?: RetrievalHit[] } | null)?.retrievalHits ?? []) as RetrievalHit[];
  return hits.slice(0, caps.maxResults).map((h) => {
    const url = String(h.webUrl ?? "");
    const excerpt = (h.extracts ?? [])
      .map((e) => String(e?.text ?? "").trim())
      .filter(Boolean)
      .join(" … ")
      .replace(/\s+/g, " ")
      .trim();
    const meta: Record<string, string> = {};
    if (h.resourceType) meta.type = String(h.resourceType);
    if (h.sensitivityLabel?.displayName) meta.sensitivity = String(h.sensitivityLabel.displayName);
    return {
      title: titleFromUrl(url) || "(untitled result)",
      url,
      ...(excerpt ? { excerpt: excerpt.slice(0, caps.maxBodyChars) } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    };
  });
}

async function graphFetch<T>(
  path: string,
  token: string,
  timeoutMs: number,
  body?: unknown,
): Promise<T> {
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
      `Microsoft 365 Copilot request failed: ${err instanceof Error ? err.message : String(err)}`,
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
      `Microsoft 365 Copilot refused the request (403): ${detail.slice(0, 300)}`,
      "graph.forbidden",
      "The Retrieval API needs a Microsoft 365 Copilot license on the account AND delegated Files.Read.All + Sites.Read.All consent. Confirm the licence and ask an admin to consent those scopes (see the Admin Guide).",
    );
  }
  if (res.status === 404) {
    throw new AppError(
      "Microsoft 365 Copilot Retrieval API not found (404) — this tenant may not have it enabled yet.",
      "config",
    );
  }
  if (res.status === 429) {
    throw new AppError("Microsoft 365 Graph is throttling requests (429).", "graph.throttled");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AppError(
      `Microsoft 365 Copilot request failed (${res.status}): ${detail.slice(0, 300)}`,
      "unknown",
    );
  }
  const parsed = (await res.json()) as T;
  if (wireEnabled()) {
    emitWire("m365copilot", "←", `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`, safeJson(parsed));
  }
  return parsed;
}

/** Verify-on-connect: a minimal retrieval confirms the endpoint, the delegated
 *  scopes, AND the Copilot license in one deliberate read (ADR-0009). */
export async function verifyM365Copilot(
  getToken: GraphTokenGetter,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const token = await getToken(true);
  await graphFetch("/copilot/retrieval", token, caps.timeoutMs, buildRetrievalBody("test", "sharePoint", 1));
  return { account: "Microsoft 365 Copilot" };
}

/** Retrieve grounded passages for a natural-language query. */
export async function searchM365Copilot(
  source: ContextSource,
  getToken: GraphTokenGetter,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  if (!query.trim()) {
    throw new AppError("Provide a natural-language query for Microsoft 365 Copilot retrieval.", "config");
  }
  const token = await getToken(false);
  const body = buildRetrievalBody(query, retrievalDataSourceOf(source), caps.maxResults);
  const payload = await graphFetch<unknown>("/copilot/retrieval", token, caps.timeoutMs, body);
  return retrievalHitsToContext(payload, caps);
}
