import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ReadCaps,
} from "../types";

import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, capDetail, safeUrl } from "../../core/wireLog";

/**
 * Splunk connector (ADR-0029): read-only SPL searches against Splunk
 * Enterprise / Splunk Cloud via the management REST API (port 8089).
 * Oneshot execution (no job lifecycle), a fail-closed SPL barrier against
 * mutating/exfiltrating commands, and a bounded default time window so
 * an unscoped question never becomes an all-time scan.
 */

export const SPLUNK_DEFAULT_EARLIEST = "-24h";

/** Splunk REST accepts three credential schemes: a JWT authentication token
 *  (Bearer), a session key (the `Splunk` scheme — what a browser SSO session
 *  yields, the value of the `splunkd_*` cookie), or HTTP Basic. */
export function splunkAuthHeader(credential: ContextCredential): string {
  if (credential.method === "pat") return `Bearer ${credential.secret}`;
  if (credential.method === "splunk-session") return `Splunk ${credential.secret}`;
  const user = credential.username ?? "";
  return `Basic ${Buffer.from(`${user}:${credential.secret}`).toString("base64")}`;
}

export interface SplunkSpec {
  spl: string;
  earliest: string;
  latest: string;
  limit?: number;
}

/** Commands that write, exfiltrate, or execute — rejected anywhere in the
 *  query (including inside subsearches/map bodies, since the whole text is
 *  scanned). SPL itself has no read-only session, so this IS the barrier. */
const BLOCKED_SPL = [
  "delete",
  "collect",
  "mcollect",
  "meventcollect",
  "tscollect",
  "outputlookup",
  "outputcsv",
  "sendemail",
  "sendalert",
  "script",
  "runshellscript",
  "dump",
] as const;

const BLOCKED_RE = new RegExp(
  `(?:^|\\|)\\s*(${BLOCKED_SPL.join("|")})\\b`,
  "i",
);

export function splIssue(spl: string): string | undefined {
  if (!spl.trim()) return "Empty SPL query.";
  if (spl.length > 8_000) return "SPL query too long (max 8000 chars).";
  const m = spl.match(BLOCKED_RE);
  if (m) {
    return `The SPL command "${m[1]}" is blocked — this connector is read-only (no delete/collect/output*/send*/script commands).`;
  }
  return undefined;
}

/** True when the text already reads as SPL rather than free text. */
function looksLikeSpl(q: string): boolean {
  return /^search\s|^\|\s*\w|(^|\s)index\s*=|\|\s*(stats|tstats|head|table|timechart|top|rare|where|eval|savedsearch)\b/i.test(
    q.trim(),
  );
}

/** Users know the URL they open in a browser, not the management port.
 *  Derive REST-API candidates: Splunk Cloud web URLs map to :8089 on the
 *  stack (and the api.<stack> form some stacks/trials use); on-prem web
 *  (:8000 or bare) maps to the same host on :8089. Already-:8089 URLs pass
 *  through. */
export function deriveSplunkApiCandidates(input: string): string[] {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return [];
  }
  if (u.port === "8089") return [`https://${u.hostname}:8089`];
  const host = u.hostname;
  const out = [`https://${host}:8089`];
  const m = host.match(/^([^.]+)\.splunkcloud\.com$/i);
  if (m) out.push(`https://${m[1]}.api.splunkcloud.com:8089`);
  return out;
}

export function defaultSplunkIndex(source: Pick<ContextSource, "baseUrl">): string | undefined {
  try {
    return new URL(source.baseUrl).searchParams.get("index") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Parse a chat/bookmark query:
 *  - JSON spec {"spl": "...", "earliest": "-7d", "latest": "now", "limit": n}
 *  - raw SPL ("search index=web error", "| tstats …", "index=main …")
 *  - free text → keyword search of the default index (last 24 h). */
export function parseSplunkSpec(query: string, defaultIndex?: string): SplunkSpec {
  const trimmed = query.trim();
  if (trimmed.startsWith("{")) {
    let raw: { spl?: unknown; earliest?: unknown; latest?: unknown; limit?: unknown };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(
        'Splunk queries are JSON: {"spl": "search index=web error", "earliest": "-7d", "latest": "now", "limit": 25} — or raw SPL / plain keywords.',
        "config",
      );
    }
    const spl = typeof raw.spl === "string" ? raw.spl.trim() : "";
    if (!spl) throw new AppError("Spec needs an spl query.", "config");
    return {
      spl: normalizeSpl(spl),
      earliest: typeof raw.earliest === "string" && raw.earliest.trim() ? raw.earliest.trim() : SPLUNK_DEFAULT_EARLIEST,
      latest: typeof raw.latest === "string" && raw.latest.trim() ? raw.latest.trim() : "now",
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
    };
  }
  if (!trimmed) throw new AppError("Empty Splunk query.", "config");
  if (looksLikeSpl(trimmed)) {
    return { spl: normalizeSpl(trimmed), earliest: SPLUNK_DEFAULT_EARLIEST, latest: "now" };
  }
  const scope = defaultIndex ? `index=${defaultIndex} ` : "";
  return {
    spl: `search ${scope}${trimmed}`,
    earliest: SPLUNK_DEFAULT_EARLIEST,
    latest: "now",
  };
}

/** Generating commands keep their leading pipe; everything else gets the
 *  `search` head Splunk requires of dispatched queries. */
function normalizeSpl(spl: string): string {
  const s = spl.trim();
  if (s.startsWith("|") || /^search\b/i.test(s)) return s;
  return `search ${s}`;
}

function mgmtBase(source: Pick<ContextSource, "baseUrl">): string {
  const u = new URL(source.baseUrl);
  return `${u.protocol}//${u.host}`;
}

function webBase(source: Pick<ContextSource, "baseUrl">): string | undefined {
  try {
    return new URL(source.baseUrl).searchParams.get("web") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Form-encoded POST to splunkd (the search API is POST-based; fetchJson is
 *  GET-only). Same status taxonomy + wire logging discipline. */
async function postSplunk<T>(
  url: string,
  credential: ContextCredential,
  form: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const started = Date.now();
  if (wireEnabled()) {
    const safeForm = Object.entries(form)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const scheme = credential.method === "pat" ? "Bearer" : credential.method === "splunk-session" ? "Splunk" : "Basic";
    emitWire("splunk", "→", `POST ${safeUrl(url)}`, `Authorization: ${scheme} ***\n${capDetail(safeForm)}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: splunkAuthHeader(credential),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire("splunk", "✗", `POST ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`);
    throw new AppError(
      `Splunk request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (res.status === 401 || res.status === 403) {
    emitWire("splunk", "✗", `POST ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
    throw new AppError(
      `Splunk rejected the sign-in (${res.status}).`,
      "auth.failed",
      "Check the token/credentials and that the account can dispatch searches. Authentication tokens are created under Settings → Tokens in Splunk Web.",
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    emitWire("splunk", "✗", `POST ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`, capDetail(text));
    throw new AppError(
      `Splunk request failed (${res.status}): ${text.slice(0, 300)}`,
      res.status === 429 || res.status === 503 ? "graph.throttled" : "unknown",
    );
  }
  if (wireEnabled()) {
    emitWire("splunk", "←", `POST ${safeUrl(url)} ${res.status} · ${text.length} bytes (${Date.now() - started}ms)`, capDetail(text));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("Splunk returned non-JSON content (proxy page? wrong port — use the management port, usually 8089).", "network");
  }
}

async function getSplunk<T>(
  url: string,
  credential: ContextCredential,
  timeoutMs: number,
): Promise<T> {
  // GETs ride the shared fetchJson-compatible path via postSplunk's
  // discipline; splunkd accepts output_mode=json on the query string.
  const started = Date.now();
  emitWire("splunk", "→", `GET ${safeUrl(url)}`);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: splunkAuthHeader(credential), Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire("splunk", "✗", `GET ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError(
      `Splunk request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (res.status === 401 || res.status === 403) {
    emitWire("splunk", "✗", `GET ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
    throw new AppError(`Splunk rejected the sign-in (${res.status}).`, "auth.failed");
  }
  if (!res.ok) {
    emitWire("splunk", "✗", `GET ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
    throw new AppError(`Splunk request failed (${res.status}).`, "unknown");
  }
  const parsed = (await res.json()) as T;
  emitWire("splunk", "←", `GET ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
  return parsed;
}

/** Single deliberate verification read: who am I (ADR-0009). */
export async function verifySplunk(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const res = await getSplunk<{ entry?: Array<{ content?: { username?: string } }> }>(
    `${mgmtBase(source)}/services/authentication/current-context?output_mode=json`,
    credential,
    caps.timeoutMs,
  );
  return { account: res.entry?.[0]?.content?.username ?? credential.username ?? "verified" };
}

type SplunkEvent = Record<string, unknown>;

const sval = (v: unknown): string =>
  v === null || v === undefined ? "" : Array.isArray(v) ? v.map(String).join(", ") : String(v);

function eventToHit(e: SplunkEvent, webUrl: string | undefined, spl: string): ContextSearchHit {
  const raw = sval(e._raw);
  const time = sval(e._time);
  const sourcetype = sval(e.sourcetype);
  if (raw) {
    return {
      title: `${sourcetype || "event"}${time ? ` @ ${time}` : ""}`,
      url: webUrl ? `${webUrl.replace(/\/+$/, "")}/en-US/app/search/search?q=${encodeURIComponent(spl)}` : "",
      excerpt: raw.slice(0, 300),
      meta: {
        ...(sval(e.host) ? { host: sval(e.host) } : {}),
        ...(sval(e.source) ? { source: sval(e.source) } : {}),
        ...(sourcetype ? { sourcetype } : {}),
        ...(sval(e.index) ? { index: sval(e.index) } : {}),
        ...(time ? { time } : {}),
      },
    };
  }
  // Transforming-search row (stats/tstats/table): render field pairs.
  const pairs = Object.entries(e).filter(([k]) => !k.startsWith("_"));
  return {
    title: pairs
      .slice(0, 3)
      .map(([k, v]) => `${k}=${sval(v)}`)
      .join(" · ")
      .slice(0, 100) || "result",
    url: webUrl ? `${webUrl.replace(/\/+$/, "")}/en-US/app/search/search?q=${encodeURIComponent(spl)}` : "",
    excerpt: pairs
      .map(([k, v]) => `${k}: ${sval(v)}`)
      .join(" | ")
      .slice(0, 300),
    meta: Object.fromEntries(pairs.slice(0, 5).map(([k, v]) => [k, sval(v).slice(0, 80)])),
  };
}

/** Oneshot SPL search — synchronous, server-capped, time-bounded. */
export async function searchSplunk(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const spec = parseSplunkSpec(query, defaultSplunkIndex(source));
  const issue = splIssue(spec.spl);
  if (issue) throw new AppError(issue, "config");
  const count = Math.min(spec.limit ?? caps.maxResults, caps.maxResults);
  const res = await postSplunk<{ results?: SplunkEvent[] }>(
    `${mgmtBase(source)}/services/search/jobs`,
    credential,
    {
      search: spec.spl,
      exec_mode: "oneshot",
      output_mode: "json",
      count: String(count),
      earliest_time: spec.earliest,
      latest_time: spec.latest,
    },
    caps.timeoutMs,
  );
  const web = webBase(source);
  return (res.results ?? []).slice(0, caps.maxResults).map((e) => eventToHit(e, web, spec.spl));
}

/** Saved searches + indexes → bookmark candidates (each best-effort: a
 *  permission gap on one listing never empties the other). */
export async function browseSplunkCandidates(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<Array<{ name: string; locator: string; kind: "query"; detail: string }>> {
  const base = mgmtBase(source);
  const out: Array<{ name: string; locator: string; kind: "query"; detail: string }> = [];
  const saved = await getSplunk<{ entry?: Array<{ name?: string }> }>(
    `${base}/services/saved/searches?output_mode=json&count=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  ).catch(() => ({ entry: [] }));
  for (const s of saved.entry ?? []) {
    if (!s.name) continue;
    out.push({
      name: `Saved search: ${s.name}`,
      locator: JSON.stringify({ spl: `| savedsearch "${s.name}"`, earliest: SPLUNK_DEFAULT_EARLIEST }),
      kind: "query",
      detail: "Splunk saved search",
    });
  }
  const indexes = await getSplunk<{ entry?: Array<{ name?: string }> }>(
    `${base}/services/data/indexes?output_mode=json&count=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  ).catch(() => ({ entry: [] }));
  for (const idx of indexes.entry ?? []) {
    if (!idx.name || idx.name.startsWith("_")) continue;
    out.push({
      name: `Index ${idx.name} — recent events`,
      locator: JSON.stringify({ spl: `search index=${idx.name}`, earliest: "-1h", limit: 25 }),
      kind: "query",
      detail: "Splunk index",
    });
  }
  return out.slice(0, caps.maxResults * 2);
}
