import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  DEFAULT_PROBE_TARGETS,
  interpretProbe,
  renderConnectivityReport,
  summarizeConnectivity,
  ProbeReport,
} from "../src/core/connectivityProbe";

// #68 — "Test Network / Proxy Connectivity". The pure interpretation layer is
// what we unit-test (the command does the live HTTPS round-trips). It reuses
// the same conservative detector the request paths use, so "reachable" means
// the round-trip completed with no proxy/filter fingerprint.

const SIGNIN = DEFAULT_PROBE_TARGETS[0]!; // login.microsoftonline.com
const GRAPH = DEFAULT_PROBE_TARGETS[1]!; // graph.microsoft.com

test("a clean 200 is reachable", () => {
  const r = interpretProbe(SIGNIN, { status: 200, bodyText: '{"issuer":"https://login.microsoftonline.com/common/v2.0"}' });
  assert.equal(r.reachable, true);
  assert.equal(r.diagnosis, undefined);
  assert.match(r.detail, /Reachable \(HTTP 200\)/);
});

test("a 401 from Graph still proves reachability (the request reached the server)", () => {
  const r = interpretProbe(GRAPH, { status: 401, bodyText: '{"error":{"code":"InvalidAuthenticationToken"}}' });
  assert.equal(r.reachable, true);
  assert.equal(r.host, "graph.microsoft.com");
});

test("a thrown TLS-inspection error is reported as intercepted, with the appliance named", () => {
  const cause = Object.assign(new Error("self-signed certificate in certificate chain (zscaler)"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
  const r = interpretProbe(SIGNIN, { error: new TypeError("fetch failed", { cause }) });
  assert.equal(r.reachable, false);
  assert.equal(r.diagnosis?.kind, "tls-inspection");
  assert.match(r.detail, /TLS intercepted \(Zscaler\)/);
});

test("a vendor block page on a 200 is treated as filtered, not reachable", () => {
  const r = interpretProbe(SIGNIN, {
    status: 200,
    bodyText: "<html><title>Netskope</title><body>This site has been blocked by your administrator.</body></html>",
  });
  assert.equal(r.reachable, false);
  assert.equal(r.diagnosis?.kind, "blocked");
  assert.equal(r.diagnosis?.vendor, "Netskope");
});

test("a 407 response is reported as proxy authentication required", () => {
  const r = interpretProbe(GRAPH, { status: 407 });
  assert.equal(r.reachable, false);
  assert.equal(r.diagnosis?.kind, "proxy-auth");
  assert.match(r.detail, /authentication/i);
});

test("a DNS failure is reported as blocked/unresolved", () => {
  const err = Object.assign(new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"), { code: "ENOTFOUND" });
  const r = interpretProbe(SIGNIN, { error: err });
  assert.equal(r.reachable, false);
  assert.equal(r.diagnosis?.kind, "dns-filtered");
  assert.match(r.detail, /DNS/);
});

test("an opaque connect failure with no proxy fingerprint still reports unreachable with the reason", () => {
  const r = interpretProbe(GRAPH, { error: new Error("socket hang up") });
  assert.equal(r.reachable, false);
  assert.equal(r.diagnosis, undefined);
  assert.match(r.detail, /socket hang up/);
});

test("renderConnectivityReport marks each endpoint and includes remediation + a summary", () => {
  const reports: ProbeReport[] = [
    interpretProbe(SIGNIN, { status: 200 }),
    interpretProbe(GRAPH, {
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
      }),
    }),
  ];
  const text = renderConnectivityReport(reports, "2026-06-30T00:00:00.000Z");
  assert.match(text, /✓ Microsoft sign-in/);
  assert.match(text, /✗ Microsoft Graph API/);
  assert.match(text, /NODE_EXTRA_CA_CERTS/); // the TLS remedy is inlined
  assert.match(text, /1 of 2 endpoint\(s\) appear blocked or filtered/);
});

test("summarizeConnectivity is ok only when every endpoint is reachable", () => {
  const allOk = [interpretProbe(SIGNIN, { status: 200 }), interpretProbe(GRAPH, { status: 401 })];
  assert.equal(summarizeConnectivity(allOk).ok, true);

  const oneBad = [
    interpretProbe(SIGNIN, { status: 200 }),
    interpretProbe(GRAPH, { status: 407 }),
  ];
  const s = summarizeConnectivity(oneBad);
  assert.equal(s.ok, false);
  assert.match(s.message, /graph\.microsoft\.com/);
});
