import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  flattenNetworkError,
  hostOf,
  detectProxyInterference,
  detectProxyFromError,
} from "../src/core/networkDiagnostics";

test("flattenNetworkError surfaces the TLS errno hidden in err.cause", () => {
  // The shape Node's fetch throws on a TLS-inspecting proxy: a generic
  // "fetch failed" whose cause carries the real code.
  const cause = Object.assign(new Error("self-signed certificate in certificate chain"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
  const err = new TypeError("fetch failed", { cause });
  const flat = flattenNetworkError(err);
  assert.match(flat, /fetch failed/);
  assert.match(flat, /self_signed_cert_in_chain/);
});

test("flattenNetworkError walks AggregateError members", () => {
  const agg = new AggregateError(
    [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    "all attempts failed",
  );
  assert.match(flattenNetworkError(agg), /econnrefused/);
});

test("hostOf extracts the host", () => {
  assert.equal(hostOf("https://contoso.atlassian.net/wiki/rest/api"), "contoso.atlassian.net");
  assert.equal(hostOf("not a url"), undefined);
  assert.equal(hostOf(undefined), undefined);
});

test("detects TLS interception (untrusted re-signed cert) with CA-trust guidance", () => {
  const d = detectProxyInterference({ errorText: "fetch failed unable_to_verify_leaf_signature", host: "graph.microsoft.com" });
  assert.equal(d?.kind, "tls-inspection");
  assert.match(d!.message, /graph\.microsoft\.com/);
  assert.match(d!.summary, /NODE_EXTRA_CA_CERTS/);
  assert.match(d!.summary, /never by disabling/i);
});

test("detects proxy authentication required (407)", () => {
  const byStatus = detectProxyInterference({ status: 407, host: "wiki.corp" });
  assert.equal(byStatus?.kind, "proxy-auth");
  assert.match(byStatus!.summary, /http\.proxy/);
  const byText = detectProxyInterference({ errorText: "407 proxy authentication required" });
  assert.equal(byText?.kind, "proxy-auth");
});

test("detects a vendor block page and names the vendor", () => {
  const d = detectProxyInterference({
    status: 200,
    bodyText: "<html><title>Zscaler</title><body>Your request was blocked by the proxy.</body></html>",
    host: "id.atlassian.com",
  });
  assert.equal(d?.kind, "blocked");
  assert.equal(d?.vendor, "Zscaler");
  assert.match(d!.summary, /ALLOWLIST id\.atlassian\.com/);
});

test("detects a generic block phrase and proxy hop headers without a named vendor", () => {
  const phrase = detectProxyInterference({ status: 403, bodyText: "This website has been blocked by your organization." });
  assert.equal(phrase?.kind, "blocked");
  assert.equal(phrase?.vendor, undefined);

  const hdr = detectProxyInterference({ status: 200, headers: { Via: "1.1 secure-proxy", "X-Cache": "MISS from gw" }, bodyText: "<html>nope</html>" });
  assert.equal(hdr?.kind, "blocked");
});

test("detects DNS resolution failure (hedged: filter OR offline)", () => {
  const d = detectProxyInterference({ errorText: "getaddrinfo ENOTFOUND wiki.example.com", host: "wiki.example.com" });
  assert.equal(d?.kind, "dns-filtered");
  assert.match(d!.summary, /VPN/);
});

test("detects an unreachable proxy distinctly from a blocked target", () => {
  const d = detectProxyInterference({ errorText: "tunneling socket could not be established, statusCode=403" });
  assert.equal(d?.kind, "proxy-unreachable");
});

test("does NOT cry proxy on ordinary API errors (no fingerprint)", () => {
  // A real permission 403 — no vendor, no filter phrase, no proxy header.
  assert.equal(detectProxyInterference({ status: 403, bodyText: '{"error":{"code":"accessDenied","message":"You do not have permission."}}' }), undefined);
  // A plain 500.
  assert.equal(detectProxyInterference({ status: 500, bodyText: "Internal Server Error" }), undefined);
  // A normal success-ish body.
  assert.equal(detectProxyInterference({ status: 200, bodyText: "{\"value\":[]}" }), undefined);
  // A bare connection refused with no proxy context isn't claimed as proxy-unreachable.
  assert.equal(detectProxyInterference({ errorText: "connect econnrefused 10.0.0.5:443" }), undefined);
});

test("detectProxyFromError flattens a thrown fetch error end-to-end", () => {
  const cause = Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
  const err = new TypeError("fetch failed", { cause });
  const d = detectProxyFromError(err, "https://contoso.sharepoint.com/sites/x");
  assert.equal(d?.kind, "tls-inspection");
  assert.match(d!.message, /contoso\.sharepoint\.com/);
});
