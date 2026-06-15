import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildRetrievalBody,
  retrievalHitsToContext,
  retrievalDataSourceOf,
  searchM365Copilot,
  verifyM365Copilot,
} from "../src/context/adapters/m365copilot";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const SRC: ContextSource = {
  id: "m1",
  type: "m365copilot",
  displayName: "Microsoft 365 Copilot",
  baseUrl: "https://graph.microsoft.com/v1.0/copilot/retrieval?dataSource=sharePoint",
  deployment: "cloud",
  authMethod: "aad-sso",
  addedAt: "2026-06-15T00:00:00Z",
};

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
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

test("retrievalDataSourceOf reads the surface from baseUrl, default sharePoint", () => {
  assert.equal(
    retrievalDataSourceOf({ ...SRC, baseUrl: "https://graph.microsoft.com/v1.0/copilot/retrieval?dataSource=externalItem" }),
    "externalItem",
  );
  assert.equal(
    retrievalDataSourceOf({ ...SRC, baseUrl: "https://graph.microsoft.com/v1.0/copilot/retrieval" }),
    "sharePoint",
  );
  assert.equal(retrievalDataSourceOf({ ...SRC, baseUrl: "not a url" }), "sharePoint");
});

test("buildRetrievalBody caps the query and clamps the result count", () => {
  const b = buildRetrievalBody("x".repeat(2000), "externalItem", 100, 'path:"https://x"');
  assert.equal((b.queryString as string).length, 1500);
  assert.equal(b.dataSource, "externalItem");
  assert.equal(b.maximumNumberOfResults, 25); // clamped to API max
  assert.equal(b.filterExpression, 'path:"https://x"');
  const b2 = buildRetrievalBody("q", "sharePoint", 0);
  assert.equal(b2.maximumNumberOfResults, 1); // floored to 1
  assert.equal("filterExpression" in b2, false);
});

test("retrievalHitsToContext maps hits (title from url, joined extracts, meta)", () => {
  const out = retrievalHitsToContext(
    {
      retrievalHits: [
        {
          webUrl: "https://contoso.sharepoint.com/sites/HR/Shared%20Documents/Leave-Policy.docx",
          extracts: [{ text: "Employees accrue 20 days." }, { text: "Carryover capped at 5." }],
          resourceType: "driveItem",
          sensitivityLabel: { displayName: "Confidential" },
        },
        { webUrl: "https://contoso.sharepoint.com/sites/HR/SitePages/Onboarding.aspx", extracts: [{ text: "Welcome!" }] },
      ],
    },
    DEFAULT_CAPS,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Leave Policy");
  assert.equal(out[0].url, "https://contoso.sharepoint.com/sites/HR/Shared%20Documents/Leave-Policy.docx");
  assert.equal(out[0].excerpt, "Employees accrue 20 days. … Carryover capped at 5.");
  assert.deepEqual(out[0].meta, { type: "driveItem", sensitivity: "Confidential" });
  assert.equal(out[1].title, "Onboarding");
});

test("retrievalHitsToContext tolerates missing fields and empty payloads", () => {
  assert.deepEqual(retrievalHitsToContext(null, DEFAULT_CAPS), []);
  assert.deepEqual(retrievalHitsToContext({}, DEFAULT_CAPS), []);
  const out = retrievalHitsToContext({ retrievalHits: [{}] }, DEFAULT_CAPS);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "(untitled result)");
  assert.equal(out[0].url, "");
  assert.equal(out[0].excerpt, undefined);
});

test("searchM365Copilot posts a retrieval query and maps the response", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        retrievalHits: [
          { webUrl: "https://contoso.sharepoint.com/sites/IT/SitePages/VPN.aspx", extracts: [{ text: "Use the GlobalProtect client." }] },
        ],
      },
    }),
    () => searchM365Copilot(SRC, () => Promise.resolve("tok"), "how do I connect to the VPN", DEFAULT_CAPS),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/copilot\/retrieval$/);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.queryString, "how do I connect to the VPN");
  assert.equal(body.dataSource, "sharePoint");
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "VPN");
  assert.equal(result[0].excerpt, "Use the GlobalProtect client.");
});

test("searchM365Copilot rejects an empty query", async () => {
  await assert.rejects(
    () => searchM365Copilot(SRC, () => Promise.resolve("tok"), "   ", DEFAULT_CAPS),
    /natural-language query/,
  );
});

test("verifyM365Copilot confirms access via a minimal retrieval", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { retrievalHits: [] } }),
    () => verifyM365Copilot(() => Promise.resolve("tok"), DEFAULT_CAPS),
  );
  assert.equal(result.account, "Microsoft 365 Copilot");
  assert.equal(JSON.parse(String(calls[0].init.body)).maximumNumberOfResults, 1);
});

test("verifyM365Copilot turns a 403 into licence/permission guidance", async () => {
  await assert.rejects(
    () =>
      withFetch(
        () => ({ status: 403, body: { error: { message: "not licensed for Copilot" } } }),
        () => verifyM365Copilot(() => Promise.resolve("tok"), DEFAULT_CAPS),
      ),
    /403/,
  );
});
