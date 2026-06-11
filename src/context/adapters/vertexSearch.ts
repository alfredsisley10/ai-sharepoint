import { execFile } from "node:child_process";
import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ReadCaps,
} from "../types";
import { AppError } from "../../core/errors";

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

async function postVertex<T>(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AppError(
      `Vertex AI Search request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError(
      `Vertex AI Search rejected the token (${res.status}).`,
      "auth.failed",
      "Google SSO tokens expire after ~1 hour. gcloud mode refreshes automatically — if this persists, run `gcloud auth login`; for pasted tokens, paste a fresh one via Test Context Source.",
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
  return (await res.json()) as T;
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
