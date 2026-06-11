import { test } from "node:test";
import * as assert from "node:assert/strict";
import { FetchNetworkClient } from "../src/auth/msalNetwork";

type FetchArgs = { url: string; init: RequestInit };

function stubFetch(
  response: { status?: number; headers?: Record<string, string>; body?: string },
  capture: FetchArgs[],
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    capture.push({ url: String(url), init: init ?? {} });
    return new Response(response.body ?? "{}", {
      status: response.status ?? 200,
      headers: response.headers ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function withStub<T>(
  stub: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("POST forwards method, headers, and body; maps JSON + status + headers back", async () => {
  const calls: FetchArgs[] = [];
  const result = await withStub(
    stubFetch(
      {
        status: 200,
        headers: { "content-type": "application/json", "x-ms-request-id": "rid" },
        body: JSON.stringify({ access_token: "tok", expires_in: 3599 }),
      },
      calls,
    ),
    () =>
      new FetchNetworkClient().sendPostRequestAsync<{ access_token: string }>(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=authorization_code&code=x",
        },
      ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "grant_type=authorization_code&code=x");
  assert.equal(result.status, 200);
  assert.equal(result.body.access_token, "tok");
  assert.equal(result.headers["x-ms-request-id"], "rid");
});

test("GET requests carry no body and parse JSON", async () => {
  const calls: FetchArgs[] = [];
  const result = await withStub(
    stubFetch({ body: JSON.stringify({ ok: true }) }, calls),
    () =>
      new FetchNetworkClient().sendGetRequestAsync<{ ok: boolean }>(
        "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
      ),
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(result.body.ok, true);
});

test("non-JSON bodies (proxy block pages) degrade to {} with the HTTP status kept", async () => {
  const result = await withStub(
    stubFetch(
      { status: 403, headers: { "content-type": "text/html" }, body: "<html>blocked</html>" },
      [],
    ),
    () => new FetchNetworkClient().sendGetRequestAsync("https://x.example"),
  );
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, {});
});

test("network failures propagate as rejections (MSAL classifies them)", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(
    withStub(failing, () =>
      new FetchNetworkClient().sendGetRequestAsync("https://unreachable.example"),
    ),
    /fetch failed/,
  );
});
