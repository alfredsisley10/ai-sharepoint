import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseGrafanaSpec,
  grafanaSearchPath,
  mapGrafanaResults,
  collectPanels,
  selectPanels,
  buildDsQueries,
  summarizeFrames,
  queryGrafanaPanelData,
} from "../src/context/adapters/grafana";
import { ContextSource, ContextCredential, DEFAULT_CAPS } from "../src/context/types";

const GSRC: ContextSource = {
  id: "g1",
  type: "grafana",
  displayName: "Grafana",
  baseUrl: "https://grafana.example.com",
  deployment: "cloud",
  authMethod: "pat",
  addedAt: "2026-06-15T00:00:00Z",
};
const GCRED: ContextCredential = { method: "pat", secret: "token" };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init ?? {});
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("parseGrafanaSpec: free text searches dashboards; JSON specs validate the type", () => {
  assert.deepEqual(parseGrafanaSpec("payment latency"), {
    type: "dashboard",
    query: "payment latency",
  });
  assert.deepEqual(
    parseGrafanaSpec('{"type": "alert", "query": "cpu", "limit": 10}'),
    { type: "alert", query: "cpu", limit: 10 },
  );
  assert.deepEqual(
    parseGrafanaSpec('{"type": "dashboard", "query": "", "folderUid": "F1"}'),
    { type: "dashboard", query: "", folderUid: "F1" },
  );
  assert.throws(() => parseGrafanaSpec(""), /Empty/);
  assert.throws(() => parseGrafanaSpec("{oops"), /JSON/);
});

test("grafanaSearchPath builds capped per-type paths", () => {
  assert.equal(
    grafanaSearchPath({ type: "dashboard", query: "cpu", folderUid: "F1" }, 25),
    "/api/search?type=dash-db&limit=25&query=cpu&folderUIDs=F1",
  );
  assert.equal(
    grafanaSearchPath({ type: "folder", query: "infra", limit: 500 }, 25),
    "/api/search?type=dash-folder&limit=25&query=infra",
  );
  assert.equal(grafanaSearchPath({ type: "alert", query: "x" }, 25), "/api/prometheus/grafana/api/v1/rules");
  assert.equal(grafanaSearchPath({ type: "annotation", query: "" }, 10), "/api/annotations?limit=10");
  assert.equal(grafanaSearchPath({ type: "datasource", query: "" }, 10), "/api/datasources");
});

test("mapGrafanaResults: dashboards prefix relative urls and carry fetchable uids", () => {
  const hits = mapGrafanaResults(
    { type: "dashboard", query: "" },
    [
      {
        uid: "abc",
        title: "Payments",
        url: "/d/abc/payments",
        folderTitle: "Prod",
        tags: ["sre", "payments"],
      },
    ],
    "https://acme.grafana.net/",
    25,
  );
  assert.equal(hits[0].title, "Payments");
  assert.equal(hits[0].url, "https://acme.grafana.net/d/abc/payments");
  assert.equal(hits[0].meta?.id, "dashboard:abc");
  assert.equal(hits[0].meta?.folder, "Prod");
});

test("mapGrafanaResults: alert rule state flattens groups and filters by query", () => {
  const payload = {
    data: {
      groups: [
        {
          name: "infra",
          rules: [
            { name: "High CPU", state: "firing", health: "ok", annotations: { summary: "CPU > 90%" }, labels: { team: "sre" } },
            { name: "Low disk", state: "inactive", health: "ok" },
          ],
        },
      ],
    },
  };
  const all = mapGrafanaResults({ type: "alert", query: "" }, payload, "https://g", 25);
  assert.equal(all.length, 2);
  const firing = mapGrafanaResults({ type: "alert", query: "cpu" }, payload, "https://g", 25);
  assert.equal(firing.length, 1);
  assert.equal(firing[0].title, "firing: High CPU");
  assert.equal(firing[0].meta?.group, "infra");
  assert.match(firing[0].excerpt ?? "", /90%/);
});

test("mapGrafanaResults: annotations get ISO times and dashboard deep links", () => {
  const hits = mapGrafanaResults(
    { type: "annotation", query: "deploy" },
    [
      { id: 1, text: "deploy v2 finished", time: 1781234567000, dashboardUID: "abc", tags: ["deploy"] },
      { id: 2, text: "unrelated note", time: 1781234567000 },
    ],
    "https://g",
    25,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "https://g/d/abc");
  assert.match(hits[0].meta?.time ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("mapGrafanaResults caps output at maxResults", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ uid: `u${i}`, title: `D${i}`, url: `/d/u${i}` }));
  assert.equal(mapGrafanaResults({ type: "dashboard", query: "" }, many, "https://g", 25).length, 25);
});

test("parseGrafanaSpec reads a panel live-data spec", () => {
  assert.deepEqual(
    parseGrafanaSpec('{"type":"panel","query":"abc","panel":"Latency","from":"now-24h"}'),
    { type: "panel", query: "abc", panel: "Latency", from: "now-24h" },
  );
});

test("collectPanels flattens row panels", () => {
  const flat = collectPanels({
    panels: [
      { id: 1, title: "A", type: "timeseries" },
      { id: 2, type: "row", panels: [{ id: 3, title: "B" }, { id: 4, title: "C" }] },
    ],
  });
  assert.deepEqual(flat.map((p) => p.id), [1, 3, 4]);
});

test("selectPanels matches by id then title, else all", () => {
  const panels = [{ id: 2, title: "Latency" }, { id: 5, title: "Errors" }];
  assert.deepEqual(selectPanels(panels, "2").map((p) => p.id), [2]);
  assert.deepEqual(selectPanels(panels, "err").map((p) => p.id), [5]);
  assert.equal(selectPanels(panels).length, 2);
});

test("buildDsQueries passes native targets through, skips hidden/default-datasource", () => {
  const qs = buildDsQueries(
    {
      datasource: { type: "prometheus", uid: "ds1" },
      targets: [
        { refId: "A", expr: "up" },
        { refId: "B", expr: "down", datasource: { uid: "ds2", type: "loki" } },
        { refId: "X", expr: "hidden", hide: true },
        { refId: "Y", expr: "mixed", datasource: { uid: "-- Mixed --" } },
        { expr: "noref", datasource: { uid: "ds3", type: "prometheus" } },
      ],
    },
    100,
  );
  assert.equal(qs.length, 3);
  assert.deepEqual(qs[0].datasource, { type: "prometheus", uid: "ds1" }); // inherited from panel
  assert.equal(qs[0].maxDataPoints, 100);
  assert.equal((qs[1].datasource as { uid: string }).uid, "ds2");
  assert.equal(qs[2].refId, "C"); // auto-assigned after A, B
  assert.equal(qs[2].expr, "noref");
});

test("summarizeFrames reduces frames to last/min/max per series and surfaces errors", () => {
  const out = summarizeFrames(
    {
      results: {
        A: {
          frames: [
            {
              schema: { fields: [{ name: "time", type: "time" }, { name: "value", type: "number", labels: { instance: "web1" } }] },
              data: { values: [[1000, 2000, 3000], [0.2, 0.5, 0.4]] },
            },
          ],
        },
        B: { error: "datasource timeout" },
      },
    },
    8000,
  );
  assert.match(out, /value\{instance=web1\}: last=0.4 min=0.2 max=0.5 n=3/);
  assert.match(out, /\[B\] error: datasource timeout/);
});

test("queryGrafanaPanelData resolves a dashboard and runs the panel's query live", async () => {
  const { result, calls } = await withFetch(
    (url) =>
      url.includes("/api/dashboards/uid/")
        ? {
            body: {
              dashboard: {
                title: "Payments",
                panels: [
                  {
                    id: 2,
                    title: "Latency",
                    type: "timeseries",
                    datasource: { uid: "ds1", type: "prometheus" },
                    targets: [{ refId: "A", expr: "histogram_quantile(0.95, latency)" }],
                  },
                ],
              },
            },
          }
        : {
            body: {
              results: {
                A: {
                  frames: [
                    { schema: { fields: [{ name: "time", type: "time" }, { name: "p95", type: "number" }] }, data: { values: [[1, 2], [120, 135]] } },
                  ],
                },
              },
            },
          },
    () =>
      queryGrafanaPanelData(GSRC, GCRED, parseGrafanaSpec('{"type":"panel","query":"abc","panel":"Latency"}'), DEFAULT_CAPS),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Latency");
  assert.match(result[0].excerpt ?? "", /p95: last=135 min=120 max=135 n=2/);
  const dsCall = calls.find((c) => c.url.endsWith("/api/ds/query"));
  assert.ok(dsCall);
  assert.equal((dsCall.init as { method?: string }).method, "POST");
  const body = JSON.parse(String((dsCall.init as { body?: string }).body));
  assert.equal(body.queries[0].expr, "histogram_quantile(0.95, latency)");
  assert.equal(body.queries[0].datasource.uid, "ds1");
  assert.equal(body.from, "now-6h");
});

test("queryGrafanaPanelData notes panels with no runnable query instead of failing", async () => {
  const { result } = await withFetch(
    (url) =>
      url.includes("/api/dashboards/uid/")
        ? { body: { dashboard: { title: "D", panels: [{ id: 1, title: "Notes", type: "text" }] } } }
        : { body: { results: {} } },
    () => queryGrafanaPanelData(GSRC, GCRED, parseGrafanaSpec('{"type":"panel","query":"abc"}'), DEFAULT_CAPS),
  );
  assert.equal(result.length, 1);
  assert.match(result[0].excerpt ?? "", /no runnable datasource query/);
});
