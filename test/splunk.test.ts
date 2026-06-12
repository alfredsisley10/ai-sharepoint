import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseSplunkSpec,
  splIssue,
  defaultSplunkIndex,
  searchSplunk,
  verifySplunk,
  browseSplunkCandidates,
  SPLUNK_DEFAULT_EARLIEST,
  SPLUNK_JOB_TUNING,
} from "../src/context/adapters/splunk";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";
import { AppError } from "../src/core/errors";

// Shrink the job-lifecycle clocks so queue scenarios run in milliseconds.
SPLUNK_JOB_TUNING.pollInitialMs = 1;
SPLUNK_JOB_TUNING.pollMaxMs = 2;
SPLUNK_JOB_TUNING.dispatchRetryMs = [1, 1];

const T0 = "2026-06-11T12:00:00.000Z";

const SRC: ContextSource = {
  id: "sp1",
  type: "splunk",
  displayName: "Corp Splunk",
  baseUrl: "https://splunk.corp.example:8089?index=web&web=https%3A%2F%2Fsplunk.corp.example%3A8000",
  deployment: "datacenter",
  authMethod: "pat",
  addedAt: T0,
};
const CRED = { method: "pat" as const, secret: "splunk-token" };

function withFetch<T>(
  responder: (url: string, init?: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const r = responder(String(url), init);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** Stateful splunkd mock for the queued-job lifecycle:
 *  POST …/search/jobs → {sid} · GET …/jobs/<sid> → status per poll ·
 *  GET …/jobs/<sid>/results → rows · DELETE …/jobs/<sid> → 200. */
function splunkJobMock(cfg: {
  results?: Array<Record<string, unknown>>;
  /** dispatchState per status poll before the job turns DONE/FAILED. */
  states?: string[];
  failedWith?: Array<{ type?: string; text?: string }>;
  neverDone?: boolean;
  /** Consumed one per dispatch POST before dispatch succeeds. */
  dispatchFailures?: Array<{ status: number; body: unknown }>;
}) {
  const calls: Array<{ method: string; url: string; body?: string; auth?: string }> = [];
  let polls = 0;
  const responder = (url: string, init?: RequestInit): { status?: number; body: unknown } => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: String(init.body) } : {}),
      ...((init?.headers as Record<string, string>)?.Authorization
        ? { auth: (init?.headers as Record<string, string>).Authorization }
        : {}),
    });
    if (init?.method === "POST") {
      const refusal = cfg.dispatchFailures?.shift();
      return refusal ?? { body: { sid: "sid42" } };
    }
    if (init?.method === "DELETE") return { body: {} };
    if (url.includes("/search/jobs/sid42/results")) return { body: { results: cfg.results ?? [] } };
    if (url.includes("/search/jobs/sid42?")) {
      const pending = cfg.neverDone || polls < (cfg.states?.length ?? 0);
      const state = cfg.states?.[polls] ?? "QUEUED";
      polls += 1;
      if (pending) {
        return { body: { entry: [{ content: { isDone: false, isFailed: false, dispatchState: state } }] } };
      }
      if (cfg.failedWith) {
        return { body: { entry: [{ content: { isDone: false, isFailed: true, dispatchState: "FAILED", messages: cfg.failedWith } }] } };
      }
      return { body: { entry: [{ content: { isDone: true, isFailed: false, dispatchState: "DONE" } }] } };
    }
    return { body: {} };
  };
  return { responder, calls };
}

test("parseSplunkSpec: JSON spec, raw SPL passthrough, free text scoped to the default index", () => {
  assert.deepEqual(parseSplunkSpec('{"spl": "index=web error", "earliest": "-7d", "limit": 10}'), {
    spl: "search index=web error",
    earliest: "-7d",
    latest: "now",
    limit: 10,
  });
  // Raw SPL forms keep their shape; generating commands keep the pipe.
  assert.equal(parseSplunkSpec("search index=web error | stats count by host").spl, "search index=web error | stats count by host");
  assert.equal(parseSplunkSpec('| savedsearch "Errors by host"').spl, '| savedsearch "Errors by host"');
  assert.equal(parseSplunkSpec("index=main failed login").spl, "search index=main failed login");
  // Free text → default index + bounded window.
  const free = parseSplunkSpec("email outage berlin", "web");
  assert.equal(free.spl, "search index=web email outage berlin");
  assert.equal(free.earliest, SPLUNK_DEFAULT_EARLIEST);
  assert.throws(() => parseSplunkSpec("{nope"), /JSON/);
  assert.throws(() => parseSplunkSpec('{"earliest": "-1h"}'), /needs an spl/);
  // Queue-wait override travels in the spec, clamped to sane bounds.
  assert.equal(parseSplunkSpec('{"spl": "index=a x", "wait": 240}').wait, 240);
  assert.equal(parseSplunkSpec('{"spl": "index=a x", "wait": 2}').wait, 5);
  assert.equal(parseSplunkSpec('{"spl": "index=a x", "wait": 99999}').wait, 600);
  assert.equal(parseSplunkSpec('{"spl": "index=a x", "wait": "soon"}').wait, undefined);
  assert.equal(parseSplunkSpec('{"spl": "index=a x"}').wait, undefined);
});

test("splIssue blocks write/exfil/exec commands anywhere — including inside subsearches", () => {
  assert.equal(splIssue("search index=web error | stats count by host"), undefined);
  assert.equal(splIssue("| tstats count where index=web by sourcetype"), undefined);
  assert.equal(splIssue("search a | inputlookup append=t assets.csv"), undefined); // reads are fine
  for (const bad of [
    "search index=web | delete",
    "search a | outputlookup evil.csv",
    "search a | collect index=summary",
    "search a | sendemail to=x@y.example",
    "search a | script python doom",
    "| map search=\"search b | delete\"", // caught inside map body
  ]) {
    assert.match(splIssue(bad) ?? "", /blocked — this connector is read-only/, bad);
  }
  assert.match(splIssue("") ?? "", /Empty/);
});

test("defaultSplunkIndex and the web deep-link come from the descriptor params", () => {
  assert.equal(defaultSplunkIndex(SRC), "web");
  assert.equal(defaultSplunkIndex({ baseUrl: "https://x:8089" }), undefined);
});

test("searchSplunk dispatches a queued job like Splunk Web: normal exec, poll through QUEUED, fetch results, delete the job", async () => {
  const mock = splunkJobMock({
    states: ["QUEUED", "RUNNING"], // rides the concurrency queue, then runs
    results: [
      {
        _raw: "2026-06-11 ERROR smtp relay timeout",
        _time: "2026-06-11T09:00:00.000+00:00",
        host: "smtp01",
        source: "/var/log/mail.log",
        sourcetype: "syslog",
        index: "web",
      },
    ],
  });
  const hits = await withFetch(mock.responder, () => searchSplunk(SRC, CRED, "email outage", DEFAULT_CAPS));
  const dispatch = mock.calls[0];
  assert.equal(dispatch.method, "POST");
  assert.match(dispatch.url, /^https:\/\/splunk\.corp\.example:8089\/services\/search\/jobs$/);
  assert.equal(dispatch.auth, "Bearer splunk-token");
  const form = new URLSearchParams(dispatch.body);
  assert.equal(form.get("exec_mode"), "normal"); // queues at the cap; oneshot would be refused
  assert.equal(form.get("search"), "search index=web email outage");
  assert.equal(form.get("earliest_time"), SPLUNK_DEFAULT_EARLIEST);
  assert.equal(form.get("max_count"), String(DEFAULT_CAPS.maxResults));
  assert.ok(form.get("auto_cancel"), "auto_cancel guards against orphaned jobs");
  const resultsCall = mock.calls.find((c) => c.url.includes("/results"));
  assert.match(resultsCall?.url ?? "", /\/services\/search\/jobs\/sid42\/results\?output_mode=json&count=25/);
  const last = mock.calls[mock.calls.length - 1];
  assert.equal(last.method, "DELETE");
  assert.match(last.url, /\/services\/search\/jobs\/sid42$/);
  assert.equal(hits[0].title, "syslog @ 2026-06-11T09:00:00.000+00:00");
  assert.match(hits[0].excerpt ?? "", /smtp relay timeout/);
  assert.equal(hits[0].meta?.host, "smtp01");
  assert.match(hits[0].url, /^https:\/\/splunk\.corp\.example:8000\/en-US\/app\/search\/search\?q=/);
});

test("job stuck QUEUED past the wait budget → throttled error naming the cap; the queued job is cancelled", async () => {
  const prevWait = SPLUNK_JOB_TUNING.defaultWaitMs;
  SPLUNK_JOB_TUNING.defaultWaitMs = 25;
  const mock = splunkJobMock({ neverDone: true });
  try {
    await assert.rejects(
      withFetch(mock.responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS)),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "graph.throttled");
        assert.match(err.message, /concurrent-search limit/);
        assert.match(err.message, /"wait": 300/); // teaches the escape hatch
        return true;
      },
    );
  } finally {
    SPLUNK_JOB_TUNING.defaultWaitMs = prevWait;
  }
  const last = mock.calls[mock.calls.length - 1];
  assert.equal(last.method, "DELETE", "a timed-out queued job must be cancelled, not leaked onto the quota");
});

test("dispatch refused at the cap: bounded retry recovers; exhausted retries surface splunkd's own message", async () => {
  const refusal = {
    status: 503,
    body: {
      messages: [
        {
          type: "FATAL",
          text: 'Search not executed: The maximum number of concurrent historical searches on this instance has been reached. concurrency_category="historical"',
        },
      ],
    },
  };
  // One refusal, then the retry lands.
  const recovered = splunkJobMock({ dispatchFailures: [refusal], results: [] });
  await withFetch(recovered.responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS));
  assert.equal(recovered.calls.filter((c) => c.method === "POST").length, 2);

  // Saturated beyond the retry budget → the real splunkd reason reaches the user.
  const saturated = splunkJobMock({ dispatchFailures: [refusal, refusal, refusal, refusal] });
  await assert.rejects(
    withFetch(saturated.responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS)),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "graph.throttled");
      assert.match(err.message, /maximum number of concurrent historical searches/);
      assert.match(err.userSummary ?? "", /concurrent-search limit/);
      return true;
    },
  );
  assert.equal(saturated.calls.filter((c) => c.method === "DELETE").length, 0, "no job to clean when dispatch never succeeded");
});

test("a FAILED job surfaces splunkd's job messages and still cleans up", async () => {
  const mock = splunkJobMock({
    failedWith: [
      { type: "INFO", text: "Your timerange was substituted" },
      { type: "FATAL", text: "Error in 'lookup' command: cannot find 'assets.csv'." },
    ],
  });
  await assert.rejects(
    withFetch(mock.responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS)),
    /Splunk search failed: .*lookup.*assets\.csv/,
  );
  const last = mock.calls[mock.calls.length - 1];
  assert.equal(last.method, "DELETE");
});

test("transforming-search rows (stats) render as field rows; blocked SPL never reaches the wire", async () => {
  const hits = await withFetch(
    splunkJobMock({ results: [{ host: "smtp01", count: "42" }] }).responder,
    () => searchSplunk(SRC, CRED, "search index=web | stats count by host", DEFAULT_CAPS),
  );
  assert.match(hits[0].title, /host=smtp01/);
  assert.match(hits[0].excerpt ?? "", /count: 42/);
  let fetched = false;
  await assert.rejects(
    withFetch(
      () => {
        fetched = true;
        return { body: {} };
      },
      () => searchSplunk(SRC, CRED, "search index=web | delete", DEFAULT_CAPS),
    ),
    /read-only/,
  );
  assert.equal(fetched, false, "blocked SPL must be rejected before any request");
});

test("verify reads current-context; 401 classifies as auth.failed", async () => {
  const v = await withFetch(
    (url) => {
      assert.match(url, /\/services\/authentication\/current-context\?output_mode=json$/);
      return { body: { entry: [{ content: { username: "search.readonly" } }] } };
    },
    () => verifySplunk(SRC, CRED, DEFAULT_CAPS),
  );
  assert.equal(v.account, "search.readonly");
  await assert.rejects(
    withFetch(() => ({ status: 401, body: {} }), () => verifySplunk(SRC, CRED, DEFAULT_CAPS)),
    /rejected the sign-in/,
  );
});

test("browse: saved searches + non-internal indexes, each listing best-effort", async () => {
  const candidates = await withFetch(
    (url) =>
      url.includes("/saved/searches")
        ? { body: { entry: [{ name: "Errors by host" }] } }
        : { body: { entry: [{ name: "web" }, { name: "_internal" }] } },
    () => browseSplunkCandidates(SRC, CRED, DEFAULT_CAPS),
  );
  assert.equal(candidates[0].name, "Saved search: Errors by host");
  assert.match(JSON.parse(candidates[0].locator).spl, /savedsearch "Errors by host"/);
  assert.ok(candidates.some((c) => c.name.includes("Index web")));
  assert.ok(!candidates.some((c) => c.name.includes("_internal")));
  // Permission gap on indexes leaves saved searches intact.
  const partial = await withFetch(
    (url) =>
      url.includes("/saved/searches")
        ? { body: { entry: [{ name: "Errors by host" }] } }
        : { status: 403, body: {} },
    () => browseSplunkCandidates(SRC, CRED, DEFAULT_CAPS),
  );
  assert.equal(partial.length, 1);
});

test("deriveSplunkApiCandidates maps browser URLs to management-API candidates", async () => {
  const { deriveSplunkApiCandidates } = await import("../src/context/adapters/splunk");
  assert.deepEqual(deriveSplunkApiCandidates("https://acme.splunkcloud.com/en-US/app/search"), [
    "https://acme.splunkcloud.com:8089",
    "https://acme.api.splunkcloud.com:8089",
  ]);
  assert.deepEqual(deriveSplunkApiCandidates("https://splunk.corp.example:8000/"), [
    "https://splunk.corp.example:8089",
  ]);
  assert.deepEqual(deriveSplunkApiCandidates("https://splunk.corp.example:8089"), [
    "https://splunk.corp.example:8089",
  ]);
  assert.deepEqual(deriveSplunkApiCandidates("not a url"), []);
});

test("splunkAuthHeader: Bearer for token, Splunk scheme for browser session, Basic otherwise", async () => {
  const { splunkAuthHeader } = await import("../src/context/adapters/splunk");
  assert.equal(splunkAuthHeader({ method: "pat", secret: "jwt123" }), "Bearer jwt123");
  assert.equal(splunkAuthHeader({ method: "splunk-session", secret: "SESSIONKEY" }), "Splunk SESSIONKEY");
  assert.equal(
    splunkAuthHeader({ method: "basic", username: "u", secret: "p" }),
    `Basic ${Buffer.from("u:p").toString("base64")}`,
  );
});

test("a browser-SSO session credential reaches Splunk as the Splunk auth scheme", async () => {
  const mock = splunkJobMock({ results: [] });
  await withFetch(mock.responder, () =>
    searchSplunk(SRC, { method: "splunk-session", secret: "SESSIONKEY" }, "errors", DEFAULT_CAPS),
  );
  for (const call of mock.calls) {
    assert.equal(call.auth, "Splunk SESSIONKEY");
  }
});

test("defaultSplunkApp reads ?app=; searches dispatch in /servicesNS/-/<app> namespace", async () => {
  const { defaultSplunkApp } = await import("../src/context/adapters/splunk");
  const appSrc: ContextSource = {
    ...SRC,
    baseUrl: "https://acme.splunkcloud.com:8089?app=lob_security&index=web&web=https%3A%2F%2Facme.splunkcloud.com",
  };
  assert.equal(defaultSplunkApp(appSrc), "lob_security");
  assert.equal(defaultSplunkApp(SRC), undefined);

  const appMock = splunkJobMock({ results: [] });
  await withFetch(appMock.responder, () => searchSplunk(appSrc, CRED, "errors", DEFAULT_CAPS));
  assert.match(appMock.calls[0].url, /\/servicesNS\/-\/lob_security\/search\/jobs$/);
  // The whole job lifecycle stays in the app namespace (poll/results/delete).
  const lastApp = appMock.calls[appMock.calls.length - 1];
  assert.equal(lastApp.method, "DELETE");
  assert.match(lastApp.url, /\/servicesNS\/-\/lob_security\/search\/jobs\/sid42$/);

  // No app → default-context /services namespace (unchanged).
  const plainMock = splunkJobMock({ results: [] });
  await withFetch(plainMock.responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS));
  assert.match(plainMock.calls[0].url, /\/services\/search\/jobs$/);
});

test("listSplunkApps returns visible, enabled apps by label; deep links target the app", async () => {
  const { listSplunkApps } = await import("../src/context/adapters/splunk");
  const apps = await withFetch(
    (url) => {
      assert.match(url, /\/services\/apps\/local\?/);
      return {
        body: {
          entry: [
            { name: "lob_security", content: { label: "Security LOB", visible: true } },
            { name: "hidden_addon", content: { label: "Hidden", visible: false } },
            { name: "disabled_app", content: { label: "Disabled", disabled: true } },
            { name: "search", content: { label: "Search & Reporting", visible: true } },
          ],
        },
      };
    },
    () => listSplunkApps(SRC, CRED, DEFAULT_CAPS.timeoutMs),
  );
  assert.deepEqual(apps.map((a) => a.name), ["search", "lob_security"]); // sorted by label, hidden/disabled dropped

  const appSrc: ContextSource = {
    ...SRC,
    baseUrl: "https://acme.splunkcloud.com:8089?app=lob_security&web=https%3A%2F%2Facme.splunkcloud.com",
  };
  const hits = await withFetch(
    splunkJobMock({ results: [{ _raw: "x", _time: "t", sourcetype: "s" }] }).responder,
    () => searchSplunk(appSrc, CRED, "errors", DEFAULT_CAPS),
  );
  assert.match(hits[0].url, /\/en-US\/app\/lob_security\/search\?q=/);
});
