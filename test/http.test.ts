import { test } from "node:test";
import * as assert from "node:assert/strict";
import { diagnoseTransportError } from "../src/context/http";

test("recognizes the HTTP/2 stream-reset class on a WRITE and points at the HTTP/1.1 lever", () => {
  const d = diagnoseTransportError("POST", "net::ERR_HTTP2_PROTOCOL_ERROR");
  assert.ok(d, "should diagnose");
  assert.match(d!.message, /reset before the source replied/);
  // Trust-preserving guidance: HTTP/1.1 via the setting, system certs left ON.
  assert.match(d!.summary, /http\.electronFetch/);
  assert.match(d!.summary, /http\.systemCertificates/i);
  assert.match(d!.summary, /SSL inspection keeps working/i);
  // Names the diagnostic toggle and the read-vs-write asymmetry.
  assert.match(d!.summary, /verboseWire/);
  assert.match(d!.summary, /search works but publishing fails/i);
});

test("PUT/DELETE are treated as writes too", () => {
  for (const m of ["PUT", "DELETE", "post"]) {
    const d = diagnoseTransportError(m, "Error: net::ERR_HTTP2_PROTOCOL_ERROR");
    assert.match(d!.summary, /this WRITE/);
  }
});

test("a GET reset gets the transient/retry guidance, not the write guidance", () => {
  const d = diagnoseTransportError("GET", "net::ERR_HTTP2_PROTOCOL_ERROR");
  assert.ok(d);
  assert.match(d!.summary, /often transient/i);
  assert.doesNotMatch(d!.summary, /this WRITE/);
});

test("matches the related reset shapes (SPDY/QUIC/ECONNRESET/EPROTO)", () => {
  for (const msg of [
    "net::ERR_SPDY_PROTOCOL_ERROR",
    "net::ERR_QUIC_PROTOCOL_ERROR",
    "fetch failed: ECONNRESET",
    "write EPROTO 12345:error:...",
    "net::ERR_CONNECTION_RESET",
  ]) {
    assert.ok(diagnoseTransportError("POST", msg), `should match: ${msg}`);
  }
});

test("does NOT hijack unrelated network errors", () => {
  assert.equal(diagnoseTransportError("GET", "getaddrinfo ENOTFOUND wiki.corp"), undefined);
  assert.equal(diagnoseTransportError("POST", "ECONNREFUSED 10.0.0.1:443"), undefined);
  assert.equal(diagnoseTransportError("GET", "The operation timed out"), undefined);
  assert.equal(diagnoseTransportError("POST", "403 Forbidden"), undefined);
});
