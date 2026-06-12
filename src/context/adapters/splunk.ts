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
 * Searches dispatch as asynchronous jobs — exactly like Splunk Web — so when
 * the search head is at its concurrent-search limit the job QUEUES for a
 * slot instead of being refused (oneshot dispatches hard-fail with 503 in
 * that state, which made the connector fail while the same user's browser
 * kept working). A fail-closed SPL barrier blocks mutating/exfiltrating
 * commands, and a bounded default time window keeps an unscoped question
 * from becoming an all-time scan.
 */

export const SPLUNK_DEFAULT_EARLIEST = "-24h";

/** Job-lifecycle clocks. Mutable on purpose: tests shrink them so queue
 *  scenarios run in milliseconds — not a public API. */
export const SPLUNK_JOB_TUNING = {
  /** Default total budget to ride the queue + run the search. */
  defaultWaitMs: 90_000,
  pollInitialMs: 250,
  pollMaxMs: 2_000,
  /** Backoff between dispatch attempts when splunkd refuses for capacity. */
  dispatchRetryMs: [2_000, 4_000],
};

/** Per-query {"wait": seconds} clamp — long enough for a busy queue, short
 *  enough that a chat tool call can't hang a session indefinitely. */
const WAIT_MIN_S = 5;
const WAIT_MAX_S = 600;

/** splunkd's capacity refusals all spell out concurrency in the message
 *  ("maximum number of concurrent historical searches … reached"). */
const CONCURRENCY_RE = /concurren/i;

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
  /** Seconds to wait for a queued/running job (clamped 5–600). */
  wait?: number;
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
 *  - JSON spec {"spl": "...", "earliest": "-7d", "latest": "now", "limit": n, "wait": s}
 *  - raw SPL ("search index=web error", "| tstats …", "index=main …")
 *  - free text → keyword search of the default index (last 24 h). */
export function parseSplunkSpec(query: string, defaultIndex?: string): SplunkSpec {
  const trimmed = query.trim();
  if (trimmed.startsWith("{")) {
    let raw: { spl?: unknown; earliest?: unknown; latest?: unknown; limit?: unknown; wait?: unknown };
    try {
      raw = JSON.parse(trimmed) as typeof raw;
    } catch {
      throw new AppError(
        'Splunk queries are JSON: {"spl": "search index=web error", "earliest": "-7d", "latest": "now", "limit": 25, "wait": 300} — or raw SPL / plain keywords.',
        "config",
      );
    }
    const spl = typeof raw.spl === "string" ? raw.spl.trim() : "";
    if (!spl) throw new AppError("Spec needs an spl query.", "config");
    const wait =
      typeof raw.wait === "number" && Number.isFinite(raw.wait)
        ? Math.min(WAIT_MAX_S, Math.max(WAIT_MIN_S, Math.round(raw.wait)))
        : undefined;
    return {
      spl: normalizeSpl(spl),
      earliest: typeof raw.earliest === "string" && raw.earliest.trim() ? raw.earliest.trim() : SPLUNK_DEFAULT_EARLIEST,
      latest: typeof raw.latest === "string" && raw.latest.trim() ? raw.latest.trim() : "now",
      ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
      ...(wait !== undefined ? { wait } : {}),
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
    const detail = splunkMessageText(text) ?? text.slice(0, 300);
    throw new AppError(
      `Splunk request failed (${res.status}): ${detail}`,
      res.status === 429 || res.status === 503 ? "graph.throttled" : "unknown",
      CONCURRENCY_RE.test(detail)
        ? "Splunk is at its concurrent-search limit. Searches queue for a slot like Splunk Web does; if even queueing is refused, retry shortly, close running searches/dashboards, or ask your Splunk admin about your role's search concurrency."
        : undefined,
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

/** splunkd error bodies carry the real reason in messages[].text (e.g.
 *  "Search not executed: The maximum number of concurrent historical
 *  searches on this instance has been reached.") — surface that, not raw
 *  JSON. */
function splunkMessageText(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ text?: string }> };
    const texts = (parsed.messages ?? [])
      .map((m) => m.text)
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    return texts.length > 0 ? texts.join(" ").slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Queued-job SPL search — dispatched the way Splunk Web dispatches.
 *
 *  Why not oneshot: at the concurrent-search limit splunkd REFUSES oneshot
 *  dispatches outright (503 "maximum number of concurrent … searches …
 *  reached"), while normal asynchronous jobs are QUEUED and run as soon as
 *  a slot frees — which is why the same user's browser searches keep
 *  working on a busy stack. So: dispatch a normal job, ride the queue
 *  within a bounded wait, fetch results, and always delete the job so a
 *  timed-out search never piles onto the user's quota. */
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
  const jobsUrl = `${mgmtBase(source)}${nsPath(source)}/search/jobs`;
  const waitMs = spec.wait !== undefined ? spec.wait * 1000 : SPLUNK_JOB_TUNING.defaultWaitMs;
  const deadline = Date.now() + waitMs;
  const sid = await dispatchSplunkJob(jobsUrl, credential, spec, count, caps.timeoutMs, deadline);
  const jobUrl = `${jobsUrl}/${encodeURIComponent(sid)}`;
  try {
    await waitForSplunkJob(jobUrl, credential, caps.timeoutMs, deadline, waitMs);
    const res = await getSplunk<{ results?: SplunkEvent[] }>(
      `${jobUrl}/results?output_mode=json&count=${count}&offset=0`,
      credential,
      caps.timeoutMs,
    );
    const web = webBase(source);
    const app = defaultSplunkApp(source) ?? "search";
    return (res.results ?? []).slice(0, caps.maxResults).map((e) => eventToHit(e, web, spec.spl, app));
  } finally {
    // Cancels the job if still queued/running and frees the artifact.
    await deleteSplunk(jobUrl, credential, caps.timeoutMs).catch(() => undefined);
  }
}

/** Create the search job. Capacity refusals (graph.throttled) get a short
 *  bounded retry — on a saturated search head a dispatch that is refused
 *  now often lands seconds later. */
async function dispatchSplunkJob(
  jobsUrl: string,
  credential: ContextCredential,
  spec: SplunkSpec,
  count: number,
  timeoutMs: number,
  deadline: number,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await postSplunk<{ sid?: string }>(
        jobsUrl,
        credential,
        {
          search: spec.spl,
          exec_mode: "normal",
          output_mode: "json",
          max_count: String(count),
          earliest_time: spec.earliest,
          latest_time: spec.latest,
          // Server-side mop-up: if the extension dies mid-poll the job
          // cancels itself once nothing touches it for a minute.
          auto_cancel: "60",
        },
        timeoutMs,
      );
      if (!res.sid) throw new AppError("Splunk did not return a search job id (sid).", "unknown");
      return res.sid;
    } catch (err) {
      const backoff = SPLUNK_JOB_TUNING.dispatchRetryMs[attempt];
      const busy = err instanceof AppError && err.code === "graph.throttled";
      if (!busy || backoff === undefined || Date.now() + backoff > deadline) throw err;
      emitWire("splunk", "→", `dispatch refused (capacity) — retry ${attempt + 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

interface SplunkJobStatus {
  isDone?: boolean;
  isFailed?: boolean;
  dispatchState?: string;
  messages?: Array<{ type?: string; text?: string }>;
}

/** Poll the job until DONE (FAILED throws with splunkd's own messages).
 *  QUEUED is the concurrency cap working as designed — same queue the
 *  browser rides — so it counts against the wait budget, not as an error. */
async function waitForSplunkJob(
  jobUrl: string,
  credential: ContextCredential,
  timeoutMs: number,
  deadline: number,
  waitMs: number,
): Promise<void> {
  let delay = SPLUNK_JOB_TUNING.pollInitialMs;
  let state = "";
  for (;;) {
    const res = await getSplunk<{ entry?: Array<{ content?: SplunkJobStatus }> }>(
      `${jobUrl}?output_mode=json`,
      credential,
      timeoutMs,
    );
    const content = res.entry?.[0]?.content ?? {};
    if (content.isFailed) {
      const why = (content.messages ?? [])
        .filter((m) => m.text && m.type !== "DEBUG" && m.type !== "INFO")
        .map((m) => m.text)
        .join(" ");
      throw new AppError(`Splunk search failed: ${why || "the job reported FAILED"}`, "unknown");
    }
    if (content.isDone) return;
    if ((content.dispatchState ?? "") !== state) {
      state = content.dispatchState ?? "";
      emitWire(
        "splunk",
        "←",
        `job ${state || "PENDING"}${state === "QUEUED" ? " — concurrency cap reached, waiting for a slot (like Splunk Web)" : ""}`,
      );
    }
    if (Date.now() + delay > deadline) {
      const waitedS = Math.round(waitMs / 1000);
      const queued = state === "QUEUED";
      throw new AppError(
        queued
          ? `Splunk is at its concurrent-search limit and no slot freed within ${waitedS}s; the queued job was cancelled. Splunk Web rides the same queue — retry shortly, close running searches/dashboards, or extend the wait: {"spl": "…", "wait": 300}.`
          : `Splunk search did not finish within ${waitedS}s (state: ${state || "unknown"}); the job was cancelled. Narrow the time range (earliest/latest) or extend the wait: {"spl": "…", "wait": 300}.`,
        queued ? "graph.throttled" : "unknown",
        queued
          ? "Splunk is at its concurrent-search limit; the search waited in the queue but no slot freed in time. Retry, or add {\"wait\": 300} to the query to wait longer."
          : undefined,
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, SPLUNK_JOB_TUNING.pollMaxMs);
  }
}

/** Best-effort job cleanup. DELETE cancels a queued/running job and frees
 *  the dispatch artifact immediately. */
async function deleteSplunk(url: string, credential: ContextCredential, timeoutMs: number): Promise<void> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: splunkAuthHeader(credential), Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  emitWire("splunk", res.ok ? "←" : "✗", `DELETE ${safeUrl(url)} ${res.status}`);
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
