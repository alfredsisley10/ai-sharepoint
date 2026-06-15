import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildRetrievalBody,
  retrievalHitsToContext,
  buildSearchRequest,
  searchHitsToContext,
  surfacesOf,
  scopesForSurfaces,
  parseM365Query,
  searchM365Copilot,
  verifyM365Copilot,
} from "../src/context/adapters/m365copilot";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const SRC: ContextSource = {
  id: "m1",
  type: "m365copilot",
  displayName: "Microsoft 365 Copilot",
  baseUrl: "https://graph.microsoft.com/v1.0/copilot/retrieval?surfaces=sharePoint",
  deployment: "cloud",
  authMethod: "aad-sso",
  addedAt: "2026-06-15T00:00:00Z",
};
const src = (surfaces: string): ContextSource => ({
  ...SRC,
  baseUrl: `https://graph.microsoft.com/v1.0/copilot/retrieval?surfaces=${surfaces}`,
});

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

test("surfacesOf reads enabled surfaces (default sharePoint; dataSource back-compat; bogus dropped)", () => {
  assert.deepEqual(surfacesOf({ ...SRC, baseUrl: "https://graph.microsoft.com/v1.0" }), ["sharePoint"]);
  assert.deepEqual(surfacesOf(src("message,event,person")), ["message", "event", "person"]);
  assert.deepEqual(surfacesOf({ ...SRC, baseUrl: "https://graph/x?dataSource=externalItem" }), ["externalItem"]);
  assert.deepEqual(surfacesOf(src("message,bogus,event")), ["message", "event"]);
});

test("scopesForSurfaces maps surfaces to delegated Graph scopes (deduped, qualified)", () => {
  assert.deepEqual(scopesForSurfaces(["sharePoint"]), [
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/Sites.Read.All",
  ]);
  assert.deepEqual(scopesForSurfaces(["message", "event"]), [
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Calendars.Read",
  ]);
  assert.deepEqual(scopesForSurfaces(["externalItem"]), ["https://graph.microsoft.com/ExternalItem.Read.All"]);
});

test("parseM365Query accepts plain text or a {query,filter} spec", () => {
  assert.deepEqual(parseM365Query("vpn help"), { query: "vpn help" });
  assert.deepEqual(parseM365Query('{"query":"vpn","filter":"path:\\"x\\""}'), { query: "vpn", filter: 'path:"x"' });
  assert.deepEqual(parseM365Query("{not json"), { query: "{not json" });
});

test("buildRetrievalBody caps the query, clamps results, requests metadata", () => {
  const b = buildRetrievalBody("x".repeat(2000), "externalItem", 100, 'path:"https://x"');
  assert.equal((b.queryString as string).length, 1500);
  assert.equal(b.dataSource, "externalItem");
  assert.equal(b.maximumNumberOfResults, 25);
  assert.equal(b.filterExpression, 'path:"https://x"');
  assert.deepEqual(b.resourceMetadata, ["title", "author", "lastModifiedTime"]);
  const b2 = buildRetrievalBody("q", "sharePoint", 0);
  assert.equal(b2.maximumNumberOfResults, 1);
  assert.equal("filterExpression" in b2, false);
});

test("retrievalHitsToContext maps title/excerpt/score/metadata", () => {
  const out = retrievalHitsToContext(
    {
      retrievalHits: [
        {
          webUrl: "https://contoso.sharepoint.com/sites/HR/Shared%20Documents/Leave-Policy.docx",
          extracts: [
            { text: "Employees accrue 20 days.", relevanceScore: 0.91 },
            { text: "Carryover capped at 5." },
          ],
          resourceType: "driveItem",
          resourceMetadata: { Title: "Leave Policy 2026", Author: "HR Team", LastModifiedTime: "2026-01-02" },
          sensitivityLabel: { displayName: "Confidential" },
        },
      ],
    },
    DEFAULT_CAPS,
  );
  assert.equal(out[0].title, "Leave Policy 2026"); // from metadata, not the URL
  assert.equal(out[0].excerpt, "Employees accrue 20 days. … Carryover capped at 5.");
  assert.deepEqual(out[0].meta, {
    type: "driveItem",
    author: "HR Team",
    lastModified: "2026-01-02",
    relevance: "0.910",
    sensitivity: "Confidential",
  });
});

test("retrievalHitsToContext tolerates missing fields and empty payloads", () => {
  assert.deepEqual(retrievalHitsToContext(null, DEFAULT_CAPS), []);
  const out = retrievalHitsToContext({ retrievalHits: [{}] }, DEFAULT_CAPS);
  assert.equal(out[0].title, "(untitled result)");
  assert.equal(out[0].url, "");
});

test("buildSearchRequest makes one sub-request per entity type, clamped", () => {
  const r = buildSearchRequest(["message", "event"], "q", 100) as {
    requests: Array<{ entityTypes: string[]; size: number; query: { queryString: string } }>;
  };
  assert.equal(r.requests.length, 2);
  assert.deepEqual(r.requests[0].entityTypes, ["message"]);
  assert.deepEqual(r.requests[1].entityTypes, ["event"]);
  assert.equal(r.requests[0].size, 25);
  assert.equal(r.requests[0].query.queryString, "q");
});

test("searchHitsToContext maps email/event hits (entity-aware title/url/meta, highlights stripped)", () => {
  const out = searchHitsToContext(
    {
      value: [
        {
          hitsContainers: [
            {
              hits: [
                {
                  summary: "Quarterly <c0>budget</c0> review notes",
                  resource: {
                    "@odata.type": "#microsoft.graph.message",
                    subject: "Q3 budget",
                    webLink: "https://outlook.office.com/owa/abc",
                    from: { emailAddress: { name: "Alice", address: "alice@contoso.com" } },
                    receivedDateTime: "2026-05-01T09:00:00Z",
                  },
                },
              ],
            },
          ],
        },
        {
          hitsContainers: [
            {
              hits: [
                {
                  summary: "Planning",
                  resource: {
                    "@odata.type": "#microsoft.graph.event",
                    subject: "Budget planning",
                    webLink: "https://outlook.office.com/cal/xyz",
                    start: { dateTime: "2026-06-01T10:00:00" },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    DEFAULT_CAPS,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Q3 budget");
  assert.equal(out[0].url, "https://outlook.office.com/owa/abc");
  assert.equal(out[0].excerpt, "Quarterly budget review notes");
  assert.deepEqual(out[0].meta, { type: "message", from: "Alice", received: "2026-05-01T09:00:00Z" });
  assert.equal(out[1].title, "Budget planning");
  assert.deepEqual(out[1].meta, { type: "event", start: "2026-06-01T10:00:00" });
});

test("searchM365Copilot (docs only) posts a retrieval query", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: { retrievalHits: [{ webUrl: "https://x/IT/SitePages/VPN.aspx", extracts: [{ text: "Use GlobalProtect." }] }] },
    }),
    () => searchM365Copilot(SRC, () => Promise.resolve("tok"), "vpn", DEFAULT_CAPS),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/copilot\/retrieval$/);
  assert.equal(result[0].title, "VPN");
});

test("searchM365Copilot (email surface) hits the Search API and maps mailbox results", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        value: [
          {
            hitsContainers: [
              {
                hits: [
                  {
                    summary: "the <c0>policy</c0> attached",
                    resource: { "@odata.type": "#microsoft.graph.message", subject: "Leave policy", webLink: "https://owa/1" },
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
    () => searchM365Copilot(src("message"), () => Promise.resolve("tok"), "leave policy", DEFAULT_CAPS),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/search\/query$/);
  assert.equal(result[0].title, "Leave policy");
  assert.equal(result[0].excerpt, "the policy attached");
});

test("searchM365Copilot fans out to BOTH engines when docs + email are enabled", async () => {
  const { result, calls } = await withFetch(
    (url) =>
      url.endsWith("/copilot/retrieval")
        ? { body: { retrievalHits: [{ webUrl: "https://x/Doc.docx", extracts: [{ text: "doc hit" }] }] } }
        : {
            body: {
              value: [
                { hitsContainers: [{ hits: [{ summary: "mail hit", resource: { "@odata.type": "#microsoft.graph.message", subject: "Mail", webLink: "https://owa/2" } }] }] },
              ],
            },
          },
    () => searchM365Copilot(src("sharePoint,message"), () => Promise.resolve("tok"), "budget", DEFAULT_CAPS),
  );
  assert.equal(calls.length, 2);
  const urls = calls.map((c) => c.url).sort();
  assert.match(urls[0], /\/copilot\/retrieval$/);
  assert.match(urls[1], /\/search\/query$/);
  const titles = result.map((h) => h.title).sort();
  assert.deepEqual(titles, ["Doc", "Mail"]);
});

test("searchM365Copilot keeps one engine's hits when the other fails", async () => {
  const { result } = await withFetch(
    (url) =>
      url.endsWith("/copilot/retrieval")
        ? { body: { retrievalHits: [{ webUrl: "https://x/Doc.docx", extracts: [{ text: "doc hit" }] }] } }
        : { status: 400, body: { error: { message: "chatMessage not supported" } } },
    () => searchM365Copilot(src("sharePoint,chatMessage"), () => Promise.resolve("tok"), "q", DEFAULT_CAPS),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Doc");
});

test("searchM365Copilot rejects an empty query", async () => {
  await assert.rejects(
    () => searchM365Copilot(SRC, () => Promise.resolve("tok"), "   ", DEFAULT_CAPS),
    /natural-language query/,
  );
});

test("verifyM365Copilot verifies each enabled engine", async () => {
  const { result, calls } = await withFetch(
    (url) => (url.endsWith("/copilot/retrieval") ? { body: { retrievalHits: [] } } : { body: { value: [] } }),
    () => verifyM365Copilot(src("sharePoint,message"), () => Promise.resolve("tok"), DEFAULT_CAPS),
  );
  assert.equal(result.account, "Microsoft 365 Copilot");
  assert.equal(calls.length, 2); // one retrieval probe + one search probe
});

test("verifyM365Copilot turns a 403 into licence/permission guidance", async () => {
  await assert.rejects(
    () =>
      withFetch(
        () => ({ status: 403, body: { error: { message: "not licensed" } } }),
        () => verifyM365Copilot(SRC, () => Promise.resolve("tok"), DEFAULT_CAPS),
      ),
    /403/,
  );
});
