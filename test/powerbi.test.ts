import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parsePowerBiSpec,
  daxIssue,
  searchPowerBi,
  browsePowerBi,
  verifyPowerBi,
  POWERBI_SCOPES,
} from "../src/context/adapters/powerbi";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const T0 = "2026-06-11T12:00:00.000Z";
const DS_ID = "11111111-2222-3333-4444-555555555555";

const SRC: ContextSource = {
  id: "p1",
  type: "powerbi",
  displayName: "Corp Power BI",
  baseUrl: "https://api.powerbi.com/v1.0/myorg",
  deployment: "cloud",
  authMethod: "aad-sso",
  addedAt: T0,
};

const token = async () => "aad-token";

function withFetch<T>(
  responder: (url: string, init?: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const r = responder(String(url), init);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("parsePowerBiSpec: JSON spec, bare DAX with a default dataset, clear errors", () => {
  assert.deepEqual(parsePowerBiSpec('{"dataset": "Sales", "dax": "EVALUATE Customers"}'), {
    dataset: "Sales",
    dax: "EVALUATE Customers",
  });
  assert.deepEqual(parsePowerBiSpec("EVALUATE Customers", "Sales"), {
    dataset: "Sales",
    dax: "EVALUATE Customers",
  });
  assert.throws(() => parsePowerBiSpec("EVALUATE X"), /no default dataset/);
  assert.throws(() => parsePowerBiSpec('{"dax": "EVALUATE X"}'), /needs a dataset/);
  assert.throws(() => parsePowerBiSpec('{"dataset": "S"}'), /needs a dax/);
  assert.throws(() => parsePowerBiSpec("{not json"), /JSON/);
});

test("daxIssue requires EVALUATE/DEFINE and bounds the length", () => {
  assert.equal(daxIssue("EVALUATE TOPN(25, Sales)"), undefined);
  assert.equal(daxIssue("DEFINE VAR x = 1 EVALUATE Sales"), undefined);
  assert.match(daxIssue("DROP TABLE x") ?? "", /start with EVALUATE/);
  assert.match(daxIssue(`EVALUATE ${"x".repeat(8001)}`) ?? "", /too long/);
});

test("searchPowerBi resolves the dataset by name and posts executeQueries", async () => {
  const calls: string[] = [];
  const hits = await withFetch(
    (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/datasets") && !url.includes("/groups/")) {
        return { body: { value: [] } };
      }
      if (url.includes("/groups?")) {
        return { body: { value: [{ id: "g1", name: "Finance" }] } };
      }
      if (url.endsWith("/groups/g1/datasets")) {
        return { body: { value: [{ id: DS_ID, name: "Sales Model" }] } };
      }
      if (url.includes("/executeQueries")) {
        const body = JSON.parse(String(init?.body)) as { queries: Array<{ query: string }> };
        assert.equal(body.queries[0].query, "EVALUATE TOPN(5, Sales)");
        return {
          body: {
            results: [
              {
                tables: [
                  { rows: [{ "Sales[Region]": "EMEA", "Sales[Total]": 42 }] },
                ],
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    },
    () =>
      searchPowerBi(
        SRC,
        token,
        '{"dataset": "sales model", "dax": "EVALUATE TOPN(5, Sales)"}',
        DEFAULT_CAPS,
      ),
  );
  assert.equal(hits.length, 1);
  assert.ok(calls.some((c) => c.startsWith("POST") && c.includes(`/groups/g1/datasets/${DS_ID}/executeQueries`)));
});

test("unknown datasets fail with the visible-dataset inventory", async () => {
  await assert.rejects(
    withFetch(
      (url) =>
        url.includes("/groups?")
          ? { body: { value: [] } }
          : { body: { value: [{ id: DS_ID, name: "Ops" }] } },
      () => searchPowerBi(SRC, token, '{"dataset": "nope", "dax": "EVALUATE X"}', DEFAULT_CAPS),
    ),
    /No visible Power BI dataset matches "nope".*Ops/s,
  );
});

test("browsePowerBi turns datasets into INFO.TABLES starter bookmarks", async () => {
  const candidates = await withFetch(
    (url) => {
      if (url.endsWith("/datasets") && !url.includes("/groups/")) {
        return { body: { value: [{ id: DS_ID, name: "Sales Model" }] } };
      }
      if (url.includes("/groups?")) return { body: { value: [] } };
      return { status: 404, body: {} };
    },
    () => browsePowerBi(token, DEFAULT_CAPS),
  );
  assert.equal(candidates[0].name, "Sales Model (My workspace)");
  const locator = JSON.parse(candidates[0].locator) as { dataset: string; dax: string };
  assert.equal(locator.dataset, DS_ID);
  assert.match(locator.dax, /INFO\.TABLES/);
});

test("verify checks workspace access; scopes target the Power BI audience", async () => {
  const result = await withFetch(
    () => ({ body: { value: [] } }),
    () => verifyPowerBi(token, DEFAULT_CAPS),
  );
  assert.equal(result.account, "Microsoft 365 (Power BI)");
  for (const scope of POWERBI_SCOPES) {
    assert.match(scope, /^https:\/\/analysis\.windows\.net\/powerbi\/api\//);
  }
});

test("401 maps to auth.failed with license/consent advice", async () => {
  await assert.rejects(
    withFetch(
      () => ({ status: 401, body: {} }),
      () => verifyPowerBi(token, DEFAULT_CAPS),
    ),
    /rejected the sign-in/,
  );
});

test("azInvocation uses shell:true for the Windows .cmd shim; parseAzTokenOutput extracts the token", async () => {
  const { azInvocation, parseAzTokenOutput, POWERBI_RESOURCE } = await import(
    "../src/context/adapters/powerbi"
  );
  // Same CVE-2024-27980 posture as gcloud: .cmd shims need a shell on Windows.
  assert.deepEqual(azInvocation("win32"), { bin: "az.cmd", shell: true });
  assert.deepEqual(azInvocation("linux"), { bin: "az", shell: false });
  assert.equal(
    parseAzTokenOutput(JSON.stringify({ accessToken: "tok123", expiresOn: "2026-06-12 13:00:00" })),
    "tok123",
  );
  assert.throws(() => parseAzTokenOutput("ERROR: Please run 'az login'"), /no access token/);
  assert.throws(() => parseAzTokenOutput("{}"), /no access token/);
  assert.equal(POWERBI_RESOURCE, "https://analysis.windows.net/powerbi/api");
});

test("verify reports the sign-in path it actually used (az / token / Microsoft 365)", async () => {
  const azLabelled = await withFetch(
    () => ({ body: { value: [] } }),
    () => verifyPowerBi(token, DEFAULT_CAPS, "Azure CLI SSO (Power BI)"),
  );
  assert.equal(azLabelled.account, "Azure CLI SSO (Power BI)");
});
