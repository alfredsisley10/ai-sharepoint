import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseGrafanaSpec,
  grafanaSearchPath,
  mapGrafanaResults,
} from "../src/context/adapters/grafana";

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
