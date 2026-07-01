import { test } from "node:test";
import * as assert from "node:assert/strict";
import { diagnoseTransportError, fetchJson, authHeaders } from "../src/context/http";
import { ContextCredential } from "../src/context/types";
import { AppError } from "../src/core/errors";

const CRED: ContextCredential = { method: "basic", username: "u", secret: "p" };

test("authHeaders: snow-apikey → x-sn-apikey header, no Authorization/Cookie", () => {
  const h = authHeaders({ method: "snow-apikey", secret: "KEY123" });
  assert.equal(h["x-sn-apikey"], "KEY123");
  assert.equal(h.Authorization, undefined);
  assert.equal(h.Cookie, undefined);
});

test("authHeaders: snow-oidc → Bearer Authorization (third-party OIDC inbound)", () => {
  const h = authHeaders({ method: "snow-oidc", secret: "eyJ.tok.en" });
  assert.equal(h.Authorization, "Bearer eyJ.tok.en");
  assert.equal(h["x-sn-apikey"], undefined);
});

async function withFetchResponse<T>(
  status: number,
  body: string,
  run: () => Promise<T>,
): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    return await run().then(
      () => undefined,
      (e) => e,
    );
  } finally {
    globalThis.fetch = original;
  }
}

async function captureInit(run: () => Promise<unknown>): Promise<RequestInit> {
  let seen: RequestInit = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    seen = init ?? {};
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run().catch(() => undefined);
    return seen;
  } finally {
    globalThis.fetch = original;
  }
}

test("recognizes the HTTP/2 stream-reset class on a WRITE with the read-vs-write asymmetry + caveat", () => {
  const d = diagnoseTransportError("POST", "net::ERR_HTTP2_PROTOCOL_ERROR");
  assert.ok(d, "should diagnose");
  assert.match(d!.message, /reset before the source replied/);
  assert.match(d!.summary, /verboseWire/);
  assert.match(d!.summary, /search works but publishing fails/i);
  // electronFetch is mentioned, but with the honest SSL-inspection caveat
  // (turning it off can break TLS) — not as a guaranteed-safe fix.
  assert.match(d!.summary, /http\.electronFetch/);
  assert.match(d!.summary, /breaks TLS|trust store/i);
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

test("a 403 surfaces the server's reason and classifies as forbidden (not auth.failed)", async () => {
  const err = await withFetchResponse(
    403,
    JSON.stringify({ message: "user 'jdoe' does not have permission to create content here" }),
    () => fetchJson("https://wiki/rest/api/content", CRED, 5000, undefined, { method: "POST", body: { x: 1 } }),
  );
  assert.ok(err instanceof AppError);
  assert.equal((err as AppError).code, "graph.forbidden");
  assert.match((err as AppError).message, /Forbidden \(403\)/);
  assert.match((err as AppError).message, /permission to create content/);
  // Guidance names the likely write-side causes.
  assert.match((err as AppError).userSummary ?? "", /create\/edit permission|read-only|personal space|proxy/i);
});

test("a 401 stays auth.failed and echoes the reason", async () => {
  const err = await withFetchResponse(401, "invalid credentials", () =>
    fetchJson("https://wiki/rest/api/content/1", CRED, 5000),
  );
  assert.ok(err instanceof AppError);
  assert.equal((err as AppError).code, "auth.failed");
  assert.match((err as AppError).message, /Authentication rejected \(401\)/);
});

test("an 'XSRF check failed' 403 gets the CSRF-specific guidance", async () => {
  const err = await withFetchResponse(403, JSON.stringify({ message: "XSRF check failed" }), () =>
    fetchJson("https://wiki.corp/rest/api/content", CRED, 5000, { "X-Atlassian-Token": "no-check" }, { method: "POST", body: { x: 1 } }),
  );
  assert.ok(err instanceof AppError);
  assert.equal((err as AppError).code, "graph.forbidden");
  assert.match((err as AppError).userSummary ?? "", /X-Atlassian-Token/);
  assert.match((err as AppError).userSummary ?? "", /User-Agent/);
  assert.match((err as AppError).userSummary ?? "", /Referer/);
  assert.match((err as AppError).userSummary ?? "", /proxy|Base URL|verboseWire/);
  // Must NOT tell an SSL-inspection user to disable electron fetch (breaks TLS).
  assert.match((err as AppError).userSummary ?? "", /Keep "http\.electronFetch" ENABLED/);
});

test("writes present a same-origin Referer (CSRF: Origin/Referer must not both be null); reads do not", async () => {
  const writeInit = await captureInit(() =>
    fetchJson("https://wiki.corp/rest/api/content", CRED, 5000, undefined, { method: "POST", body: { x: 1 } }),
  );
  assert.equal(writeInit.referrer, "https://wiki.corp");
  assert.equal(writeInit.referrerPolicy, "unsafe-url");

  const readInit = await captureInit(() => fetchJson("https://wiki.corp/rest/api/content/1", CRED, 5000));
  assert.equal(readInit.referrer, undefined, "GET reads don't spoof a Referer");
});
