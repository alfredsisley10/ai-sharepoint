import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ReadCaps,
} from "../types";

import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, capDetail, safeUrl } from "../../core/wireLog";

/**
 * Splunk connector (ADR-0029, amended): read-only SPL searches against
 * Splunk Enterprise / Splunk Cloud via the management REST API (port 8089).
 * Job-mode execution with guaranteed cleanup (oneshot dispatch is rejected
 * outright at the search-concurrency cap, where async jobs queue — see
 * searchSplunk), a fail-closed SPL barrier against mutating/exfiltrating
 * commands, and a bounded default time window so an unscoped question never
 * becomes an all-time scan.
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

/** Remediation for a rejected sign-in, by credential scheme. Splunk browser
 *  sessions EXPIRE routinely (splunkd idle timeout), so a previously-working
 *  source hitting 401 almost always means "capture a fresh cookie" — the
 *  error must carry that guidance itself, or generic Entra advice leaks in. */
function splunkAuthSummary(credential: ContextCredential): string {
  if (credential.method === "splunk-session") {
    return "Your Splunk browser session has expired (splunkd sessions time out). Sign in to Splunk Web again, then run Test Context Source and capture a fresh splunkd_<port> cookie.";
  }
  if (credential.method === "pat") {
    return "The Splunk authentication token was rejected — it may have expired or been revoked. Create a new one under Settings → Tokens in Splunk Web, then update it via Test Context Source.";
  }
  return "Splunk rejected the username/password — verify them (and that the account can dispatch searches), then update them via Test Context Source.";
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
  "rest", // can POST to splunkd management endpoints
  "map", // can invoke a mutating saved search by name (not caught by text scan)
] as const;

const BLOCKED_RE = new RegExp(
  `(?:^|\\|)\\s*(${BLOCKED_SPL.join("|")})\\b`,
  "i",
);

/** Strip SPL block comments (```…```) and collapse whitespace BEFORE scanning,
 *  so the barrier can't be slipped past by inserting a comment between a pipe
 *  and a blocked command (e.g. `| ```x``` delete`). Splunk ignores the comments
 *  at execution, so scanning the stripped form matches what actually runs. */
function normalizeSplForScan(spl: string): string {
  return spl.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ");
}

export function splIssue(spl: string): string | undefined {
  if (!spl.trim()) return "Empty SPL query.";
  if (spl.length > 8_000) return "SPL query too long (max 8000 chars).";
  const scan = normalizeSplForScan(spl);
  const m = scan.match(BLOCKED_RE);
  if (m) {
    return `The SPL command "${m[1]}" is blocked — this connector is read-only (no delete/collect/output*/send*/rest/map/script commands).`;
  }
  // `… into <dest>` (e.g. `tstats … into <namespace>`) writes — block it.
  if (/\|\s*[^|]*\binto\b/i.test(scan)) {
    return "The SPL `into` clause is blocked — this connector is read-only (it would write to a collection/index).";
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

/** The line-of-business search app to dispatch in (the `?app=` descriptor
 *  param). Splunk Cloud instances that disable the default `search` app and
 *  meter by app REQUIRE searches to run in a specific app's namespace. */
export function defaultSplunkApp(source: Pick<ContextSource, "baseUrl">): string | undefined {
  try {
    return new URL(source.baseUrl).searchParams.get("app") ?? undefined;
  } catch {
    return undefined;
  }
}

/** REST namespace prefix: app-scoped `/servicesNS/-/<app>` when an app is
 *  configured (owner `-` = current user), else the default-context
 *  `/services`. Dispatching in the app namespace is what makes searches run
 *  under the right workload/billing context on locked-down Splunk Cloud. */
function nsPath(source: Pick<ContextSource, "baseUrl">): string {
  const app = defaultSplunkApp(source);
  return app ? `/servicesNS/-/${encodeURIComponent(app)}` : "/services";
}

export interface SplunkApp {
  name: string;
  label: string;
}

/** List the apps the account can see (for the setup wizard's app picker).
 *  Visible, enabled apps only; labels are the human names shown in Splunk. */
export async function listSplunkApps(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  timeoutMs: number,
): Promise<SplunkApp[]> {
  const res = await getSplunk<{
    entry?: Array<{ name?: string; content?: { label?: string; visible?: boolean; disabled?: boolean } }>;
  }>(`${mgmtBase(source)}/services/apps/local?output_mode=json&count=0`, credential, timeoutMs);
  return (res.entry ?? [])
    .filter((a) => a.name && a.content?.visible !== false && a.content?.disabled !== true)
    .map((a) => ({ name: a.name!, label: a.content?.label?.trim() || a.name! }))
    .sort((a, b) => a.label.localeCompare(b.label));
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
      splunkAuthSummary(credential),
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    emitWire("splunk", "✗", `POST ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`, capDetail(text));
    if (/concurren/i.test(text)) {
      throw new AppError(
        `Splunk refused to dispatch the search — its concurrent-search limit is saturated and the job could not even be queued (${res.status}). Retry in a moment. Server said: ${text.slice(0, 300)}`,
        "graph.throttled",
      );
    }
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
    throw new AppError(
      `Splunk rejected the sign-in (${res.status}).`,
      "auth.failed",
      splunkAuthSummary(credential),
    );
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

function eventToHit(
  e: SplunkEvent,
  webUrl: string | undefined,
  spl: string,
  app = "search",
): ContextSearchHit {
  const raw = sval(e._raw);
  const time = sval(e._time);
  const sourcetype = sval(e.sourcetype);
  if (raw) {
    return {
      title: `${sourcetype || "event"}${time ? ` @ ${time}` : ""}`,
      url: webUrl ? `${webUrl.replace(/\/+$/, "")}/en-US/app/${encodeURIComponent(app)}/search?q=${encodeURIComponent(spl)}` : "",
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
    url: webUrl ? `${webUrl.replace(/\/+$/, "")}/en-US/app/${encodeURIComponent(app)}/search?q=${encodeURIComponent(spl)}` : "",
    excerpt: pairs
      .map(([k, v]) => `${k}: ${sval(v)}`)
      .join(" | ")
      .slice(0, 300),
    meta: Object.fromEntries(pairs.slice(0, 5).map(([k, v]) => [k, sval(v).slice(0, 80)])),
  };
}

const POLL_START_MS = 250;
const POLL_MAX_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SplunkJobContent {
  isDone?: boolean;
  isFailed?: boolean;
  dispatchState?: string;
  messages?: Array<{ type?: string; text?: string }>;
}

function jobMessages(content: SplunkJobContent): string {
  const texts = (Array.isArray(content.messages) ? content.messages : [])
    .map((m) => m?.text)
    .filter((t): t is string => Boolean(t));
  return texts.join("; ");
}

/** Best-effort job cleanup — a leaked job would hold a concurrency slot
 *  (and disk quota) against the very cap this connector must respect. */
async function cancelSplunkJob(jobUrl: string, credential: ContextCredential): Promise<void> {
  try {
    const res = await fetch(`${jobUrl}?output_mode=json`, {
      method: "DELETE",
      headers: { Authorization: splunkAuthHeader(credential), Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    emitWire("splunk", res.ok ? "←" : "✗", `DELETE ${safeUrl(jobUrl)} ${res.status}`);
  } catch (err) {
    emitWire("splunk", "✗", `DELETE ${safeUrl(jobUrl)} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Job-mode SPL search — asynchronous dispatch, polled within the time
 *  budget, results fetched once done, and the job ALWAYS deleted.
 *
 *  Why not oneshot: at Splunk's concurrent-search cap, a oneshot dispatch is
 *  rejected outright (503 "maximum number of concurrent searches"), while
 *  async jobs are accepted and QUEUED until a slot frees — which is exactly
 *  what Splunk Web does. On a busy metered stack, oneshot meant every
 *  connector search failed at the cap while the same user's browser session
 *  searched fine; queueing like the browser removes that asymmetry. */
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
  const deadline = Date.now() + caps.timeoutMs;
  const budgetS = Math.ceil(caps.timeoutMs / 1000);
  const dispatched = await postSplunk<{ sid?: string }>(
    `${mgmtBase(source)}${nsPath(source)}/search/jobs`,
    credential,
    {
      search: spec.spl,
      exec_mode: "normal",
      output_mode: "json",
      max_count: String(count),
      earliest_time: spec.earliest,
      latest_time: spec.latest,
      // Server-side safety net: if this client dies mid-poll, the job
      // self-cancels instead of holding a concurrency slot until TTL.
      auto_cancel: String(budgetS + 60),
    },
    caps.timeoutMs,
  );
  const sid = dispatched.sid;
  if (!sid) {
    throw new AppError("Splunk did not return a search id (sid) for the dispatched job.", "unknown");
  }
  const jobUrl = `${mgmtBase(source)}${nsPath(source)}/search/jobs/${encodeURIComponent(sid)}`;
  try {
    let wait = POLL_START_MS;
    let state: SplunkJobContent = {};
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        const queued = (state.dispatchState ?? "").toUpperCase() === "QUEUED";
        throw new AppError(
          queued
            ? `Splunk accepted the search but it stayed queued behind the concurrent-search cap for ${budgetS}s (job cancelled). The instance/app is at its concurrency limit — retry in a moment, or ask the Splunk admin about the app's search quota.`
            : `Splunk search did not finish within ${budgetS}s (state ${state.dispatchState ?? "RUNNING"}; job cancelled). Narrow the time window (earliest/latest) or aggregate in SPL.`,
          queued ? "graph.throttled" : "unknown",
        );
      }
      const status = await getSplunk<{ entry?: Array<{ content?: SplunkJobContent }> }>(
        `${jobUrl}?output_mode=json`,
        credential,
        Math.max(1_000, left),
      );
      state = status.entry?.[0]?.content ?? {};
      if (state.isFailed) {
        throw new AppError(
          `Splunk search failed: ${jobMessages(state) || `dispatch state ${state.dispatchState ?? "FAILED"}`}`,
          "unknown",
        );
      }
      if (state.isDone) break;
      await sleep(Math.min(wait, Math.max(10, deadline - Date.now())));
      wait = Math.min(POLL_MAX_MS, wait * 2);
    }
    const res = await getSplunk<{ results?: SplunkEvent[] }>(
      `${jobUrl}/results?output_mode=json&count=${count}&offset=0`,
      credential,
      Math.max(1_000, deadline - Date.now()),
    );
    const web = webBase(source);
    const app = defaultSplunkApp(source) ?? "search";
    return (res.results ?? []).slice(0, caps.maxResults).map((e) => eventToHit(e, web, spec.spl, app));
  } finally {
    await cancelSplunkJob(jobUrl, credential);
  }
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
    `${base}${nsPath(source)}/saved/searches?output_mode=json&count=${caps.maxResults}`,
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
