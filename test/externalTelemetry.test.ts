import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  sanitizeDimensions,
  envDimensions,
  splunkHecEvent,
  otlpCounterMetrics,
  seriesKey,
  TelemetryEnv,
} from "../src/diagnostics/telemetrySink";
import { ExternalTelemetry } from "../src/diagnostics/externalTelemetry";
import { effectiveTelemetryConfig, telemetryStatus } from "../src/diagnostics/telemetryConfig";

const ENV: TelemetryEnv = {
  extVersion: "0.68.0",
  extChannel: "whitelabel",
  vscodeVersion: "1.95.0",
  osType: "Darwin",
  osVersion: "23.5.0",
  osPlatform: "darwin",
  installId: "11111111-2222-3333-4444-555555555555",
};

const tick = () => new Promise((r) => setImmediate(r));

function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

test("sanitizeDimensions keeps categorical tokens and DROPS anything free-form / sensitive", () => {
  const out = sanitizeDimensions({
    type: "github",
    deployment: "cloud",
    code: "auth.failed",
    tool: "aisharepoint_search_context",
    count: 5,
    ok: true,
    // all of these must be dropped — they could carry sensitive/free content:
    q: "find the secret roadmap doc", // spaces
    email: "jdoe@corp.example", // @
    url: "https://corp.example/x", // :// and /
    path: "/Users/jane/secret.txt", // /
    long: "x".repeat(80), // > 64 chars
    "Bad Key": "v", // invalid key
  });
  assert.deepEqual(out, {
    type: "github",
    deployment: "cloud",
    code: "auth.failed",
    tool: "aisharepoint_search_context",
    count: "5",
    ok: "true",
  });
});

test("envDimensions exposes only non-identifying environment tokens", () => {
  assert.deepEqual(envDimensions(ENV), {
    extVersion: "0.68.0",
    vscodeVersion: "1.95.0",
    osType: "Darwin",
    osVersion: "23.5.0",
    osPlatform: "darwin",
    installId: "11111111-2222-3333-4444-555555555555",
    extChannel: "whitelabel",
  });
});

test("splunkHecEvent nests event + env + dims under a HEC envelope", () => {
  const ev = splunkHecEvent("search", { type: "github" }, ENV, 1_700_000_000);
  assert.equal(ev.time, 1_700_000_000);
  assert.equal(ev.sourcetype, "aisharepoint:event");
  const body = ev.event as Record<string, string>;
  assert.equal(body.event, "search");
  assert.equal(body.type, "github");
  assert.equal(body.extVersion, "0.68.0");
  assert.equal(body.installId, ENV.installId);
});

test("otlpCounterMetrics builds a monotonic cumulative Sum with per-series data points", () => {
  const payload = otlpCounterMetrics(
    [
      { event: "tool.invoke", dims: { tool: "x" }, count: 2 },
      { event: "error", dims: { code: "network" }, count: 1 },
    ],
    ENV,
    "1000",
    "2000",
  );
  const metric = (payload as any).resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.name, "aisharepoint.events");
  assert.equal(metric.sum.aggregationTemporality, 2);
  assert.equal(metric.sum.isMonotonic, true);
  assert.equal(metric.sum.dataPoints.length, 2);
  const toolDp = metric.sum.dataPoints.find((d: any) =>
    d.attributes.some((a: any) => a.key === "tool" && a.value.stringValue === "x"),
  );
  assert.equal(toolDp.asInt, "2");
  assert.equal(toolDp.startTimeUnixNano, "1000");
  assert.equal(toolDp.timeUnixNano, "2000");
  assert.ok(toolDp.attributes.some((a: any) => a.key === "event" && a.value.stringValue === "tool.invoke"));
});

test("seriesKey is stable regardless of dimension order", () => {
  assert.equal(seriesKey("e", { a: "1", b: "2" }), seriesKey("e", { b: "2", a: "1" }));
});

test("effectiveTelemetryConfig is opt-in, needs an endpoint, and maps the OTLP header", () => {
  assert.equal(effectiveTelemetryConfig(undefined), undefined);
  assert.equal(effectiveTelemetryConfig({ enabled: false, splunkHecUrl: "https://h", splunkHecToken: "t" }), undefined);
  assert.equal(effectiveTelemetryConfig({ enabled: true }), undefined); // no usable endpoint
  assert.deepEqual(
    effectiveTelemetryConfig({ enabled: true, splunkHecUrl: "https://h/event", splunkHecToken: "t" }),
    { splunk: { url: "https://h/event", token: "t" } },
  );
  assert.deepEqual(
    effectiveTelemetryConfig({ enabled: true, otlpEndpoint: "https://o:4318", otlpHeaderName: "X-Api-Key", otlpHeaderValue: "k" }),
    { otlp: { endpoint: "https://o:4318", headers: { "X-Api-Key": "k" } } },
  );
  // splunk url without a token → not usable
  assert.equal(effectiveTelemetryConfig({ enabled: true, splunkHecUrl: "https://h" }), undefined);
});

test("telemetryStatus reports set/not-set without exposing secret values", () => {
  const st = telemetryStatus({ enabled: true, splunkHecUrl: "https://h/event", splunkHecToken: "supersecret", otlpHeaderName: "X-Api-Key", otlpHeaderValue: "k" });
  assert.equal(st.enabled, true);
  assert.equal(st.splunkUrl, "https://h/event");
  assert.equal(st.splunkTokenSet, true);
  assert.equal(st.otlpHeaderSet, true);
  // the status object must never carry the secret values
  assert.equal(JSON.stringify(st).includes("supersecret"), false);
  assert.equal(JSON.stringify(st).includes("\"k\""), false);
});

test("ExternalTelemetry.emit sends an anonymized Splunk event, no free-form fields", async () => {
  const { impl, calls } = fakeFetch();
  const t = new ExternalTelemetry(ENV, () => ({ splunk: { url: "https://hec/event", token: "tok" } }), {
    fetchImpl: impl,
    nowMs: () => 1_700_000_000_000,
  });
  t.emit("search", { type: "github", q: "free text with spaces", email: "a@b.com" });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hec/event");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Splunk tok");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.event.event, "search");
  assert.equal(body.event.type, "github");
  assert.ok(!("q" in body.event), "free-form q must be dropped");
  assert.ok(!("email" in body.event), "email must be dropped");
});

test("ExternalTelemetry batches OTLP counters and flushes cumulative sums", async () => {
  const { impl, calls } = fakeFetch();
  const t = new ExternalTelemetry(ENV, () => ({ otlp: { endpoint: "https://otel:4318" } }), {
    fetchImpl: impl,
    nowMs: () => 1_700_000_000_000,
  });
  t.emit("tool.invoke", { tool: "x" });
  t.emit("tool.invoke", { tool: "x" });
  t.emit("error", { code: "auth.failed" });
  await tick();
  assert.equal(calls.length, 0, "OTLP is batched — nothing sent until flush");
  t.flush();
  await tick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/metrics$/);
  const dps = JSON.parse(calls[0].init.body as string).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
  const toolDp = dps.find((d: any) => d.attributes.some((a: any) => a.key === "tool" && a.value.stringValue === "x"));
  assert.equal(toolDp.asInt, "2");
});

test("ExternalTelemetry is opt-in (no config → no send) and opportunistic (a failing endpoint never throws)", async () => {
  const { impl, calls } = fakeFetch();
  const off = new ExternalTelemetry(ENV, () => undefined, { fetchImpl: impl });
  off.emit("x", { a: "b" });
  off.flush();
  await tick();
  assert.equal(calls.length, 0);

  const throwing = (async () => {
    throw new Error("endpoint down");
  }) as typeof fetch;
  const t = new ExternalTelemetry(ENV, () => ({ splunk: { url: "u", token: "t" } }), { fetchImpl: throwing });
  assert.doesNotThrow(() => t.emit("x", { a: "b" })); // never blocks/throws the caller
  await tick(); // the swallowed rejection must not surface
});
