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
} from "../src/context/adapters/splunk";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

test("splIssue closes the comment bypass and blocks rest/map/into", () => {
  // comment between a pipe and a blocked command must not slip through
  assert.ok(splIssue("search index=x | ```c``` delete"));
  assert.ok(splIssue("search index=x | rest /services/x method=POST"));
  assert.ok(splIssue('search index=x | map search="savedmutator"'));
  assert.ok(splIssue("| tstats count where index=x into mycollection"));
  // legitimate read SPL still passes
  assert.equal(splIssue("search index=web error | stats count by host"), undefined);
  assert.equal(splIssue("| tstats count where index=web by host"), undefined);
});

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

/** Stateful responder for the async job lifecycle: dispatch → status polls
 *  → results → delete. `states` drives successive status polls. */
function jobResponder(opts: {
  results?: unknown[];
  states?: Array<Partial<{ isDone: boolean; isFailed: boolean; dispatchState: string; messages: unknown[] }>>;
  onDispatch?: (url: string, init?: RequestInit) => void;
}) {
  const log = { dispatches: 0, polls: 0, deleted: false };
  let poll = 0;
  const responder = (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      log.deleted = true;
      return { body: {} };
    }
    if (url.endsWith("/search/jobs") && String(init?.body ?? "").includes("exec_mode=")) {
      log.dispatches += 1;
      opts.onDispatch?.(url, init);
      return { status: 201, body: { sid: "sid123" } };
    }
    if (url.includes("/search/jobs/sid123/results")) {
      return { body: { results: opts.results ?? [] } };
    }
    if (url.includes("/search/jobs/sid123")) {
      log.polls += 1;
      const states = opts.states ?? [{ isDone: true, dispatchState: "DONE" }];
      const content = states[Math.min(poll++, states.length - 1)];
      return { body: { entry: [{ content }] } };
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  return { responder, log };
}

test("searchSplunk dispatches an async job, polls to done, maps results, and deletes the job", async () => {
  let captured: { url?: string; body?: string; auth?: string } = {};
  let resultsUrl = "";
  const { responder, log } = jobResponder({
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
    onDispatch: (url, init) => {
      captured = {
        url,
        body: String(init?.body),
        auth: (init?.headers as Record<string, string>)?.Authorization,
      };
    },
  });
  const hits = await withFetch(
    (url, init) => {
      if (url.includes("/results")) resultsUrl = url;
      return responder(url, init);
    },
    () => searchSplunk(SRC, CRED, "email outage", DEFAULT_CAPS),
  );
  assert.match(captured.url ?? "", /^https:\/\/splunk\.corp\.example:8089\/services\/search\/jobs$/);
  assert.equal(captured.auth, "Bearer splunk-token");
  const form = new URLSearchParams(captured.body);
  assert.equal(form.get("exec_mode"), "normal");
  assert.equal(form.get("search"), "search index=web email outage");
  assert.equal(form.get("earliest_time"), SPLUNK_DEFAULT_EARLIEST);
  assert.equal(form.get("max_count"), String(DEFAULT_CAPS.maxResults));
  assert.ok(Number(form.get("auto_cancel")) > 0, "auto_cancel safety net set");
  assert.match(resultsUrl, new RegExp(`count=${DEFAULT_CAPS.maxResults}`));
  assert.equal(hits[0].title, "syslog @ 2026-06-11T09:00:00.000+00:00");
  assert.match(hits[0].excerpt ?? "", /smtp relay timeout/);
  assert.equal(hits[0].meta?.host, "smtp01");
  assert.match(hits[0].url, /^https:\/\/splunk\.corp\.example:8000\/en-US\/app\/search\/search\?q=/);
  assert.equal(log.deleted, true, "job must be deleted after success");
});

test("a queued job (concurrency cap) waits for a slot like Splunk Web instead of failing", async () => {
  const { responder, log } = jobResponder({
    results: [{ host: "smtp01", count: "42" }],
    states: [
      { isDone: false, dispatchState: "QUEUED" },
      { isDone: false, dispatchState: "RUNNING" },
      { isDone: true, dispatchState: "DONE" },
    ],
  });
  const hits = await withFetch(responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS));
  assert.equal(hits.length, 1);
  assert.ok(log.polls >= 3, `polled through QUEUED→RUNNING→DONE (got ${log.polls})`);
  assert.equal(log.deleted, true);
});

test("still queued at the deadline → concurrency-cap error, and the job is cancelled", async () => {
  const { responder, log } = jobResponder({
    states: [{ isDone: false, dispatchState: "QUEUED" }],
  });
  await assert.rejects(
    withFetch(responder, () => searchSplunk(SRC, CRED, "errors", { ...DEFAULT_CAPS, timeoutMs: 80 })),
    /queued behind the concurrent-search cap/,
  );
  assert.equal(log.deleted, true, "timed-out job must be cancelled");
});

test("a failed job surfaces the server's message and is cleaned up", async () => {
  const { responder, log } = jobResponder({
    states: [
      {
        isFailed: true,
        dispatchState: "FAILED",
        messages: [{ type: "FATAL", text: "Search not executed: quota exceeded" }],
      },
    ],
  });
  await assert.rejects(
    withFetch(responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS)),
    /Search not executed: quota exceeded/,
  );
  assert.equal(log.deleted, true);
});

test("a dispatch rejection mentioning concurrency gets the saturated-cap explanation", async () => {
  await assert.rejects(
    withFetch(
      () => ({
        status: 503,
        body: { messages: [{ text: "The maximum number of concurrent searches has been reached" }] },
      }),
      () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS),
    ),
    /concurrent-search limit is saturated/,
  );
});

test("transforming-search rows (stats) render as field rows; blocked SPL never reaches the wire", async () => {
  const hits = await withFetch(
    jobResponder({ results: [{ host: "smtp01", count: "42" }] }).responder,
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

test("a rejected sign-in carries scheme-specific remediation — session expiry, never tenant advice", async () => {
  // Browser-session cookie (the scheme that routinely expires): the error
  // itself must say "session expired → re-capture the cookie".
  await assert.rejects(
    withFetch(
      () => ({ status: 401, body: {} }),
      () => verifySplunk(SRC, { method: "splunk-session", secret: "OLDKEY" }, DEFAULT_CAPS),
    ),
    (err: Error & { userSummary?: string }) => {
      assert.match(err.userSummary ?? "", /browser session has expired/);
      assert.match(err.userSummary ?? "", /splunkd_<port> cookie/);
      return true;
    },
  );
  // Token credential → token guidance, on the search (dispatch) path too.
  await assert.rejects(
    withFetch(
      () => ({ status: 401, body: {} }),
      () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS),
    ),
    (err: Error & { userSummary?: string }) => {
      assert.match(err.userSummary ?? "", /authentication token was rejected/);
      return true;
    },
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
  let auth = "";
  const { responder } = jobResponder({
    onDispatch: (_url, init) => {
      auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    },
  });
  await withFetch(responder, () =>
    searchSplunk(SRC, { method: "splunk-session", secret: "SESSIONKEY" }, "errors", DEFAULT_CAPS),
  );
  assert.equal(auth, "Splunk SESSIONKEY");
});

test("defaultSplunkApp reads ?app=; searches dispatch in /servicesNS/-/<app> namespace", async () => {
  const { defaultSplunkApp } = await import("../src/context/adapters/splunk");
  const appSrc: ContextSource = {
    ...SRC,
    baseUrl: "https://acme.splunkcloud.com:8089?app=lob_security&index=web&web=https%3A%2F%2Facme.splunkcloud.com",
  };
  assert.equal(defaultSplunkApp(appSrc), "lob_security");
  assert.equal(defaultSplunkApp(SRC), undefined);

  let url = "";
  const appJob = jobResponder({ onDispatch: (u) => (url = u) });
  await withFetch(appJob.responder, () => searchSplunk(appSrc, CRED, "errors", DEFAULT_CAPS));
  assert.match(url, /\/servicesNS\/-\/lob_security\/search\/jobs$/);

  // No app → default-context /services namespace (unchanged).
  let url2 = "";
  const defaultJob = jobResponder({ onDispatch: (u) => (url2 = u) });
  await withFetch(defaultJob.responder, () => searchSplunk(SRC, CRED, "errors", DEFAULT_CAPS));
  assert.match(url2, /\/services\/search\/jobs$/);
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
    jobResponder({ results: [{ _raw: "x", _time: "t", sourcetype: "s" }] }).responder,
    () => searchSplunk(appSrc, CRED, "errors", DEFAULT_CAPS),
  );
  assert.match(hits[0].url, /\/en-US\/app\/lob_security\/search\?q=/);
});
