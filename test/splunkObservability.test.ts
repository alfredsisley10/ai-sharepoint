import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  deriveSplunkObsEndpoints,
  splunkObsEndpointsOf,
  parseSplunkObsSpec,
  splunkObsSearchPath,
  mapSplunkObsResults,
} from "../src/context/adapters/splunkObservability";

test("deriveSplunkObsEndpoints accepts realms, app/api URLs, and the splunk.com domains", () => {
  assert.deepEqual(deriveSplunkObsEndpoints("us1"), {
    realm: "us1",
    apiBase: "https://api.us1.signalfx.com",
    appBase: "https://app.us1.signalfx.com",
  });
  assert.equal(deriveSplunkObsEndpoints("https://app.eu0.signalfx.com/#/home")?.realm, "eu0");
  assert.equal(deriveSplunkObsEndpoints("https://api.us2.signalfx.com")?.realm, "us2");
  assert.equal(
    deriveSplunkObsEndpoints("https://app.jp0.observability.splunk.com")?.realm,
    "jp0",
  );
  assert.equal(deriveSplunkObsEndpoints("https://example.com"), undefined);
  assert.equal(deriveSplunkObsEndpoints("not a url"), undefined);
});

test("splunkObsEndpointsOf reads the stored descriptor (web + default type params)", () => {
  const ep = splunkObsEndpointsOf({
    baseUrl: "https://api.us1.signalfx.com?web=https%3A%2F%2Fapp.us1.signalfx.com&type=incident",
  });
  assert.equal(ep.apiBase, "https://api.us1.signalfx.com");
  assert.equal(ep.appBase, "https://app.us1.signalfx.com");
  assert.equal(ep.defaultType, "incident");
  // Missing params degrade to derived app base + metric default.
  const bare = splunkObsEndpointsOf({ baseUrl: "https://api.eu0.signalfx.com" });
  assert.equal(bare.appBase, "https://app.eu0.signalfx.com");
  assert.equal(bare.defaultType, "metric");
});

test("parseSplunkObsSpec: JSON specs, free text to the default type, bad input rejected", () => {
  assert.deepEqual(parseSplunkObsSpec('{"type": "detector", "query": "cpu", "limit": 5}'), {
    type: "detector",
    query: "cpu",
    limit: 5,
  });
  assert.deepEqual(parseSplunkObsSpec("cpu utilization", "incident"), {
    type: "incident",
    query: "cpu utilization",
  });
  assert.throws(() => parseSplunkObsSpec("   "), /Empty/);
  assert.throws(() => parseSplunkObsSpec("{not json"), /JSON/);
});

test("splunkObsSearchPath builds capped per-type paths; bare metric words become contains-matches", () => {
  assert.equal(
    splunkObsSearchPath({ type: "metric", query: "cpu" }, 25),
    "/v2/metric?query=name%3A*cpu*&limit=25",
  );
  assert.equal(
    splunkObsSearchPath({ type: "metric", query: "name:jvm.*" }, 25),
    "/v2/metric?query=name%3Ajvm.*&limit=25",
  );
  assert.equal(
    splunkObsSearchPath({ type: "detector", query: "disk", limit: 500 }, 25),
    "/v2/detector?name=disk&limit=25", // spec limit capped by maxResults
  );
  assert.equal(
    splunkObsSearchPath({ type: "incident", query: "x" }, 10),
    "/v2/incident?limit=10&includeResolved=false",
  );
});

test("mapSplunkObsResults: detectors/dashboards deep-link and carry fetchable ids", () => {
  const hits = mapSplunkObsResults(
    { type: "detector", query: "" },
    { results: [{ id: "D1", name: "High CPU", description: "fires at 90%" }] },
    "https://app.us1.signalfx.com/",
    25,
  );
  assert.equal(hits[0].title, "High CPU");
  assert.equal(hits[0].url, "https://app.us1.signalfx.com/#/detector/D1");
  assert.equal(hits[0].meta?.id, "detector:D1");
  assert.match(hits[0].excerpt ?? "", /90%/);
});

test("mapSplunkObsResults: incidents accept bare-array payloads and filter locally", () => {
  const payload = [
    { incidentId: "I1", severity: "Critical", detectorName: "High CPU", anomalyState: "ANOMALOUS", detectorId: "D1" },
    { incidentId: "I2", severity: "Warning", detectorName: "Disk space", anomalyState: "ANOMALOUS" },
  ];
  const all = mapSplunkObsResults({ type: "incident", query: "" }, payload, "https://app.x", 25);
  assert.equal(all.length, 2);
  const filtered = mapSplunkObsResults({ type: "incident", query: "cpu" }, payload, "https://app.x", 25);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, "Critical: High CPU");
  assert.equal(filtered[0].meta?.state, "ANOMALOUS");
});
