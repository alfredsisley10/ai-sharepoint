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

test("searchSplunk posts a oneshot job and maps raw events with meta", async () => {
  let captured: { url?: string; body?: string; auth?: string } = {};
  const hits = await withFetch(
    (url, init) => {
      captured = {
        url,
        body: String(init?.body),
        auth: (init?.headers as Record<string, string>)?.Authorization,
      };
      return {
        body: {
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
        },
      };
    },
    () => searchSplunk(SRC, CRED, "email outage", DEFAULT_CAPS),
  );
  assert.match(captured.url ?? "", /^https:\/\/splunk\.corp\.example:8089\/services\/search\/jobs$/);
  assert.equal(captured.auth, "Bearer splunk-token");
  const form = new URLSearchParams(captured.body);
  assert.equal(form.get("exec_mode"), "oneshot");
  assert.equal(form.get("search"), "search index=web email outage");
  assert.equal(form.get("earliest_time"), SPLUNK_DEFAULT_EARLIEST);
  assert.equal(form.get("count"), String(DEFAULT_CAPS.maxResults));
  assert.equal(hits[0].title, "syslog @ 2026-06-11T09:00:00.000+00:00");
  assert.match(hits[0].excerpt ?? "", /smtp relay timeout/);
  assert.equal(hits[0].meta?.host, "smtp01");
  assert.match(hits[0].url, /^https:\/\/splunk\.corp\.example:8000\/en-US\/app\/search\/search\?q=/);
});

test("transforming-search rows (stats) render as field rows; blocked SPL never reaches the wire", async () => {
  const hits = await withFetch(
    () => ({ body: { results: [{ host: "smtp01", count: "42" }] } }),
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
