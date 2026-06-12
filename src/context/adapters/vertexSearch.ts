import { execFile } from "node:child_process";
import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ReadCaps,
} from "../types";
import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, safeJson, safeUrl } from "../../core/wireLog";

/**
 * Vertex AI Search connector (ADR-0026): read-only enterprise search +
 * Gemini-grounded answers against a Vertex AI Search app (Discovery
 * Engine API). SSO comes from the workstation's existing Google sign-in
 * via `gcloud auth print-access-token` (the gcloud CLI holds the SSO
 * session); a pasted OAuth access token is the fallback. No keys or
 * Google secrets are ever persisted for the gcloud path.
 */

export const VERTEX_DEFAULT_ENDPOINT = "https://discoveryengine.googleapis.com";

export interface VertexParts {
  endpoint?: string;
  projectId: string;
  location: string;
  engineId: string;
}

/** Build the serving-config URL stored as the source's baseUrl. */
export function buildVertexServingConfig(parts: VertexParts): string {
  const endpoint = (parts.endpoint?.trim() || VERTEX_DEFAULT_ENDPOINT).replace(/\/+$/, "");
  return (
    `${endpoint}/v1/projects/${parts.projectId.trim()}/locations/${parts.location.trim() || "global"}` +
    `/collections/default_collection/engines/${parts.engineId.trim()}/servingConfigs/default_search`
  );
}

/** Validate/parse a stored serving-config URL (also accepts pasted ones). */
export function vertexUrlIssue(baseUrl: string): string | undefined {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return "Enter a valid https:// serving-config URL.";
  }
  if (u.protocol !== "https:") return "HTTPS only.";
  if (!/\/v1\/projects\/[^/]+\/locations\/[^/]+\/collections\/[^/]+\/engines\/[^/]+\/servingConfigs\/[^/]+$/.test(u.pathname)) {
    return "Expected …/v1/projects/<p>/locations/<l>/collections/<c>/engines/<e>/servingConfigs/<s>.";
  }
  return undefined;
}

/** "project/engine" label for display. */
export function vertexLabel(baseUrl: string): string {
  const m = baseUrl.match(/\/projects\/([^/]+)\/.*\/engines\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : baseUrl;
}

// --- auth ---------------------------------------------------------------------

const GCLOUD_TIMEOUT_MS = 15_000;

function gcloudBinary(): string {
  return process.platform === "win32" ? "gcloud.cmd" : "gcloud";
}

/** Access token for the call: pasted token (pat) or live from gcloud SSO. */
export function getVertexToken(credential: ContextCredential): Promise<string> {
  if (credential.method !== "gcloud-sso") {
    return Promise.resolve(credential.secret);
  }
  return new Promise((resolve, reject) => {
    execFile(
      gcloudBinary(),
      ["auth", "print-access-token"],
      { timeout: GCLOUD_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new AppError(
              `Could not obtain a Google SSO token from the gcloud CLI: ${stderr?.trim() || err.message}`,
              "auth.failed",
              "Sign in once with `gcloud auth login` (your corporate Google SSO), then retry. The extension never stores Google tokens — each call asks the CLI.",
            ),
          );
          return;
        }
        const token = stdout.trim();
        if (!token) {
          reject(
            new AppError(
              "gcloud returned an empty access token.",
              "auth.failed",
              "Run `gcloud auth login` and retry.",
            ),
          );
          return;
        }
        resolve(token);
      },
    );
  });
}

// --- HTTP (Discovery Engine is POST-based; mirror fetchJson's taxonomy) --------

/** The serving-config URL carries the project — it doubles as the QUOTA
 *  project the API demands for end-user credentials (pilot: calls failed
 *  with 403 even with the right role because no quota project was sent). */
export function vertexProjectOf(baseUrl: string): string | undefined {
  return baseUrl.match(/\/projects\/([A-Za-z0-9-]+)\//)?.[1];
}

/** Translate Google's documented 403 families into the actual fix — a
 *  valid token with a missing role is NOT a bad credential (and must not
 *  feed the lockout tracker as one). */
export function explainVertex403(body: string): string {
  if (/serviceusage\.services\.use|quota project|consumer/i.test(body)) {
    return "Your account lacks 'Service Usage Consumer' (roles/serviceusage.serviceUsageConsumer) on the app's project — the extension sends that project as the quota project; ask the app owner to grant the role.";
  }
  if (/has not been used in project|SERVICE_DISABLED|API .* disabled/i.test(body)) {
    return "The Discovery Engine API is not enabled in the app's project — the app owner can enable it (APIs & Services → Discovery Engine API).";
  }
  if (/discoveryengine\.servingConfigs\.(search|answer).*denied|Permission .*denied on resource/i.test(body)) {
    return "Your account lacks the 'Discovery Engine Viewer' role (roles/discoveryengine.viewer) on the app's project — ask the app owner to grant it — or the project/location/engine path is wrong.";
  }
  if (/prohibited by organization'?s policy|VPC Service Controls|securityPolicyViolated/i.test(body)) {
    return "A VPC Service Controls perimeter blocks this API from your network — IT/security owns the perimeter rules.";
  }
  return "Google answered 403 — usually a missing 'Discovery Engine Viewer' role, the API not enabled in the project, or a missing quota-project permission. Ask the search app's owner; the exact server message is in the logs.";
}

async function postVertex<T>(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  quotaProject?: string,
): Promise<T> {
  const started = Date.now();
  if (wireEnabled()) {
    emitWire(
      "vertex",
      "→",
      `POST ${safeUrl(url)}`,
      `Authorization: Bearer ***${quotaProject ? `\nx-goog-user-project: ${quotaProject}` : ""}\n${safeJson(body)}`,
    );
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // End-user credentials need an explicit quota project for this API.
        ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire(
      "vertex",
      "✗",
      `POST ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`,
    );
    throw new AppError(
      `Vertex AI Search request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (!res.ok) {
    emitWire("vertex", "✗", `POST ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
  }
  if (res.status === 401) {
    throw new AppError(
      "Vertex AI Search rejected the token (401).",
      "auth.failed",
      "Google SSO tokens expire after ~1 hour. gcloud mode refreshes automatically — if this persists, run `gcloud auth login`; for pasted tokens, paste a fresh one via Test Context Source.",
    );
  }
  if (res.status === 403) {
    const errBody = await res.text().catch(() => "");
    emitWire("vertex", "✗", `POST ${safeUrl(url)} 403 detail`, errBody.slice(0, 800));
    // 403 with a live token = entitlement, not a bad credential.
    throw new AppError(
      `Vertex AI Search denied the request (403): ${errBody.slice(0, 200)}`,
      "graph.forbidden",
      explainVertex403(errBody),
    );
  }
  if (res.status === 404) {
    throw new AppError(
      "Vertex AI Search app not found (404) — check project, location, and engine ID.",
      "config",
    );
  }
  if (res.status === 429 || res.status === 503) {
    throw new AppError(`Vertex AI Search is throttling requests (${res.status}).`, "graph.throttled");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(
      `Vertex AI Search request failed (${res.status}): ${text.slice(0, 300)}`,
      "unknown",
    );
  }
  const parsed = (await res.json()) as T;
  if (wireEnabled()) {
    emitWire("vertex", "←", `POST ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`, safeJson(parsed));
  }
  return parsed;
}

// --- API surface ----------------------------------------------------------------

interface VertexDocument {
  derivedStructData?: {
    title?: string;
    link?: string;
    htmlTitle?: string;
    displayLink?: string;
    snippets?: Array<{ snippet?: string; htmlSnippet?: string }>;
    extractive_answers?: Array<{ content?: string }>;
  };
  structData?: Record<string, unknown>;
  id?: string;
  name?: string;
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export async function verifyVertex(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const issue = vertexUrlIssue(source.baseUrl);
  if (issue) throw new AppError(`Invalid Vertex serving config: ${issue}`, "config");
  const token = await getVertexToken(credential);
  await postVertex(
    `${source.baseUrl}:search`,
    token,
    { query: "connectivity check", pageSize: 1 },
    caps.timeoutMs,
    vertexProjectOf(source.baseUrl),
  );
  return { account: credential.method === "gcloud-sso" ? "gcloud SSO" : "access token" };
}

export async function searchVertex(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const token = await getVertexToken(credential);
  const res = await postVertex<{
    results?: Array<{ document?: VertexDocument }>;
    totalSize?: number;
  }>(
    `${source.baseUrl}:search`,
    token,
    {
      query,
      pageSize: Math.min(caps.maxResults, 25),
      contentSearchSpec: {
        snippetSpec: { returnSnippet: true },
      },
    },
    caps.timeoutMs,
    vertexProjectOf(source.baseUrl),
  );
  return (res.results ?? []).slice(0, caps.maxResults).map((r, i) => {
    const d = r.document?.derivedStructData ?? {};
    const snippet =
      d.extractive_answers?.[0]?.content ??
      d.snippets?.find((s) => s.snippet || s.htmlSnippet)?.snippet ??
      d.snippets?.find((s) => s.htmlSnippet)?.htmlSnippet ??
      "";
    return {
      title: stripTags(d.title ?? d.htmlTitle ?? r.document?.id ?? `Result ${i + 1}`),
      url: d.link ?? d.displayLink ?? "",
      excerpt: stripTags(snippet).slice(0, caps.maxBodyChars),
      meta: {
        source: "vertex-ai-search",
        ...(r.document?.id ? { id: r.document.id } : {}),
      },
    };
  });
}

export interface VertexAnswer {
  answer: string;
  citations: Array<{ title: string; url: string }>;
}

/** Gemini-grounded answer over the app's corpus (the `:answer` API) —
 *  the "analysis" surface of Vertex AI Search. */
export async function answerVertex(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<VertexAnswer> {
  const token = await getVertexToken(credential);
  const res = await postVertex<{
    answer?: {
      answerText?: string;
      references?: Array<{
        chunkInfo?: {
          documentMetadata?: { title?: string; uri?: string };
        };
        unstructuredDocumentInfo?: { title?: string; uri?: string };
      }>;
    };
  }>(
    `${source.baseUrl}:answer`,
    token,
    {
      query: { text: query },
      answerGenerationSpec: {
        includeCitations: true,
        ignoreAdversarialQuery: true,
        ignoreNonAnswerSeekingQuery: false,
      },
    },
    caps.timeoutMs,
    vertexProjectOf(source.baseUrl),
  );
  const seen = new Set<string>();
  const citations: Array<{ title: string; url: string }> = [];
  for (const ref of res.answer?.references ?? []) {
    const meta = ref.chunkInfo?.documentMetadata ?? ref.unstructuredDocumentInfo;
    const url = meta?.uri ?? "";
    const key = `${meta?.title ?? ""}|${url}`;
    if (!meta || seen.has(key)) continue;
    seen.add(key);
    citations.push({ title: meta.title ?? (url || "(untitled)"), url });
    if (citations.length >= 10) break;
  }
  return {
    answer: (res.answer?.answerText ?? "").slice(0, caps.maxBodyChars),
    citations,
  };
}

// --- guided setup from "all I have is a URL" (pilot) ---------------------------

/** Best-effort extraction of project/location/engine from whatever URL the
 *  user has — a Cloud Console app URL, a pasted serving-config URL, or any
 *  link containing the standard resource segments. */
export function parseVertexHint(input: string): Partial<VertexParts> {
  const out: Partial<VertexParts> = {};
  const text = input.trim();
  const project =
    text.match(/[?&]project=([A-Za-z0-9-]+)/)?.[1] ??
    text.match(/\/projects\/([A-Za-z0-9-]+)/)?.[1];
  const location = text.match(/\/locations\/([A-Za-z0-9-]+)/)?.[1];
  const engine = text.match(/\/engines\/([A-Za-z0-9_-]+)/)?.[1];
  if (project) out.projectId = project;
  if (location) out.location = location;
  if (engine) out.engineId = engine;
  return out;
}

const LOCATION_ENDPOINTS: Record<string, string> = {
  global: VERTEX_DEFAULT_ENDPOINT,
  us: "https://us-discoveryengine.googleapis.com",
  eu: "https://eu-discoveryengine.googleapis.com",
};

export function endpointForLocation(location: string): string {
  return LOCATION_ENDPOINTS[location] ?? VERTEX_DEFAULT_ENDPOINT;
}

export interface VertexEngineInfo {
  engineId: string;
  displayName: string;
  location: string;
}

/** List the search apps (engines) a signed-in user can see in one project,
 *  probing global/us/eu — permission gaps on a location are skipped, so a
 *  plain search-app user still finds their app wherever it lives. */
export async function listVertexEngines(
  token: string,
  projectId: string,
  timeoutMs: number,
): Promise<VertexEngineInfo[]> {
  const out: VertexEngineInfo[] = [];
  for (const location of Object.keys(LOCATION_ENDPOINTS)) {
    try {
      const res = await fetchVertexJson<{
        engines?: Array<{ name?: string; displayName?: string; solutionType?: string }>;
      }>(
        `${endpointForLocation(location)}/v1/projects/${encodeURIComponent(projectId)}/locations/${location}/collections/default_collection/engines`,
        token,
        timeoutMs,
      );
      for (const e of res.engines ?? []) {
        const id = e.name?.match(/\/engines\/([^/]+)$/)?.[1];
        if (!id) continue;
        if (e.solutionType && !/SEARCH/i.test(e.solutionType)) continue;
        out.push({ engineId: id, displayName: e.displayName ?? id, location });
      }
    } catch {
      // No access / no apps in this location — keep probing the others.
    }
  }
  return out;
}

async function fetchVertexJson<T>(url: string, token: string, timeoutMs: number): Promise<T> {
  const started = Date.now();
  emitWire("vertex", "→", `GET ${safeUrl(url)}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  emitWire("vertex", res.ok ? "←" : "✗", `GET ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
  if (!res.ok) {
    throw new AppError(`Vertex listing failed (${res.status}).`, res.status === 403 ? "auth.failed" : "unknown");
  }
  return (await res.json()) as T;
}

/** Projects visible to the gcloud SSO session — via the CLI so it works
 *  with exactly the same sign-in the connector itself uses. */
export function listGcloudProjects(): Promise<Array<{ projectId: string; name: string }>> {
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === "win32" ? "gcloud.cmd" : "gcloud",
      ["projects", "list", "--format=json", "--limit=100"],
      { timeout: 20_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(
            new AppError(
              "Could not list projects via the gcloud CLI.",
              "auth.failed",
              "Run `gcloud auth login` first — or pick manual entry and ask your admin for the project ID.",
            ),
          );
          return;
        }
        try {
          const raw = JSON.parse(stdout) as Array<{ projectId?: string; name?: string }>;
          resolve(
            raw
              .filter((p): p is { projectId: string; name?: string } => Boolean(p.projectId))
              .map((p) => ({ projectId: p.projectId, name: p.name ?? p.projectId })),
          );
        } catch {
          reject(new AppError("gcloud returned unparseable project data.", "unknown"));
        }
      },
    );
  });
}
