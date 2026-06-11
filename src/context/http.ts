import { AppError } from "../core/errors";
import { ContextCredential } from "./types";
import { wireEnabled, emitWire, capDetail, safeHeaders, safeUrl } from "../core/wireLog";

/** Shared fetch wrapper for context adapters: auth header construction,
 *  timeouts, response-size caps, status→ErrorCode mapping. Pure. */

export function authHeader(credential: ContextCredential): string {
  if (credential.method === "pat") {
    return `Bearer ${credential.secret}`;
  }
  const user = credential.username ?? "";
  return `Basic ${Buffer.from(`${user}:${credential.secret}`).toString("base64")}`;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function fetchJson<T>(
  url: string,
  credential: ContextCredential,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const started = Date.now();
  if (wireEnabled()) {
    emitWire(
      "http",
      "→",
      `GET ${safeUrl(url)}`,
      safeHeaders({
        Authorization: authHeader(credential),
        Accept: "application/json",
        ...extraHeaders,
      }),
    );
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: authHeader(credential),
        Accept: "application/json",
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire("http", "✗", `GET ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`);
    throw new AppError(
      `Context request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (!res.ok && wireEnabled()) {
    emitWire("http", "✗", `GET ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError(
      `Authentication rejected by the source (${res.status}).`,
      "auth.failed",
      "The source rejected these credentials.",
    );
  }
  if (res.status === 404) {
    throw new AppError(`Not found (404) at the source.`, "graph.notFound");
  }
  if (res.status === 429 || res.status === 503) {
    throw new AppError(`Source is throttling requests (${res.status}).`, "graph.throttled");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AppError(
      `Source request failed (${res.status} ${res.statusText}): ${body.slice(0, 300)}`,
      "unknown",
    );
  }
  const text = await res.text();
  if (wireEnabled()) {
    emitWire(
      "http",
      "←",
      `GET ${safeUrl(url)} ${res.status} · ${text.length} bytes (${Date.now() - started}ms)`,
      capDetail(text),
    );
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new AppError(
      `Source response exceeded the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB read cap (ADR-0012).`,
      "config",
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(
      "Source returned non-JSON content (proxy page or HTML login redirect?).",
      "network",
    );
  }
}

/** Strip HTML to plain text for model-facing excerpts (rough but safe). */
export function htmlToText(html: string, maxChars: number): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
