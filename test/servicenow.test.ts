import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseSnowSpec,
  defaultSnowTable,
  searchServiceNow,
  getServiceNowItem,
  browseServiceNowCandidates,
  listSnowTables,
  SNOW_DEFAULT_TABLE,
} from "../src/context/adapters/servicenow";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const T0 = "2026-06-11T12:00:00.000Z";
const SYS_ID = "62826bf03710200044e0bfc8bcbe5df1";

const SRC: ContextSource = {
  id: "sn1",
  type: "servicenow",
  displayName: "Corp ServiceNow",
  baseUrl: "https://corp.service-now.com?table=cmdb_ci_appl",
  deployment: "cloud",
  authMethod: "basic",
  addedAt: T0,
};
const CRED = { method: "basic" as const, username: "integration.readonly", secret: "pw" };

function withFetch<T>(
  responder: (url: string) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const r = responder(String(url));
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("parseSnowSpec: JSON spec, native encoded query, and free text → text index", () => {
  assert.deepEqual(
    parseSnowSpec('{"table": "incident", "query": "active=true^priority=1", "limit": 10}'),
    { table: "incident", query: "active=true^priority=1", limit: 10 },
  );
  // Native encoded queries pass through against the default table.
  assert.deepEqual(parseSnowSpec("active=true^assigned_toISEMPTY", "change_request"), {
    table: "change_request",
    query: "active=true^assigned_toISEMPTY",
  });
  // Free text becomes a zing text-index search.
  assert.deepEqual(parseSnowSpec("email outage berlin"), {
    table: SNOW_DEFAULT_TABLE,
    query: "123TEXTQUERY321=email outage berlin",
  });
  assert.throws(() => parseSnowSpec('{"table": "bad table!"}'), /not a valid ServiceNow table/);
  assert.throws(() => parseSnowSpec("{nope"), /JSON/);
});

test("defaultSnowTable comes from the stored ?table= parameter", () => {
  assert.equal(defaultSnowTable(SRC), "cmdb_ci_appl");
  assert.equal(defaultSnowTable({ baseUrl: "https://x.service-now.com" }), undefined);
});

test("search hits the Table API with display values and maps records", async () => {
  let captured = "";
  const hits = await withFetch(
    (url) => {
      captured = url;
      return {
        body: {
          result: [
            {
              sys_id: SYS_ID,
              number: "INC0010023",
              short_description: "Email outage in Berlin",
              state: "In Progress",
              priority: "1 - Critical",
              assigned_to: { display_value: "Dana Ops" },
            },
          ],
        },
      };
    },
    () => searchServiceNow(SRC, CRED, "email outage", DEFAULT_CAPS),
  );
  assert.match(captured, /^https:\/\/corp\.service-now\.com\/api\/now\/table\/cmdb_ci_appl\?/);
  assert.match(captured, /sysparm_query=123TEXTQUERY321/);
  assert.match(captured, /sysparm_display_value=true/);
  assert.match(captured, /sysparm_limit=25/);
  assert.equal(hits[0].title, "INC0010023: Email outage in Berlin");
  assert.match(hits[0].url, /nav_to\.do\?uri=cmdb_ci_appl\.do/);
  assert.equal(hits[0].meta?.assigned_to, "Dana Ops"); // reference flattened
  assert.equal(hits[0].meta?.table, "cmdb_ci_appl");
});

test("getItem fetches table/sys_id, flattens display values, skips sys_ noise", async () => {
  const item = await withFetch(
    (url) => {
      assert.match(url, new RegExp(`/api/now/table/incident/${SYS_ID}\\?`));
      return {
        body: {
          result: {
            sys_id: SYS_ID,
            number: "INC0010023",
            short_description: "Email outage",
            description: "Users in Berlin cannot send email.",
            sys_mod_count: "17",
            sys_updated_on: "2026-06-11 09:00:00",
            assigned_to: { display_value: "Dana Ops" },
          },
        },
      };
    },
    () => getServiceNowItem(SRC, CRED, `incident/${SYS_ID}`, DEFAULT_CAPS),
  );
  assert.equal(item.title, "INC0010023: Email outage");
  assert.match(item.body, /description: Users in Berlin cannot send email\./);
  assert.match(item.body, /assigned_to: Dana Ops/);
  assert.ok(!item.body.includes("sys_mod_count"));
  assert.match(item.body, /sys_updated_on/); // allowlisted sys_ field kept
  // Bare sys_id uses the default table.
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/cmdb_ci_appl\//);
      return { body: { result: { sys_id: SYS_ID, name: "Billing" } } };
    },
    () => getServiceNowItem(SRC, CRED, SYS_ID, DEFAULT_CAPS),
  );
  await assert.rejects(getServiceNowItem(SRC, CRED, "not-a-sys-id", DEFAULT_CAPS), /table\/sys_id/);
});

test("listSnowTables prefers the sys_db_object catalog and filters sys_* noise", async () => {
  const tables = await withFetch(
    (url) => {
      assert.match(url, /sys_db_object/);
      return {
        body: {
          result: [
            { name: "incident", label: "Incident" },
            { name: "u_custom_app", label: "Custom Apps" },
            { name: "sys_properties", label: "System Properties" },
            { name: "sys_user", label: "User" },
            { name: "no_label" },
          ],
        },
      };
    },
    () => listSnowTables(SRC, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(
    tables.map((t) => t.name),
    ["incident", "u_custom_app", "sys_user"],
  );
});

test("listSnowTables falls back to probing curated tables when the catalog is denied", async () => {
  const tables = await withFetch(
    (url) => {
      if (url.includes("sys_db_object")) return { status: 403, body: {} };
      // Only incident and cmdb_ci answer for this account.
      return /\/table\/(incident|cmdb_ci)\?/.test(url) ? { body: { result: [] } } : { status: 403, body: {} };
    },
    () => listSnowTables(SRC, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(tables.map((t) => t.name), ["incident", "cmdb_ci"]);
});

test("browse candidates come from live enumeration with the default table first", async () => {
  const candidates = await withFetch(
    (url) =>
      url.includes("sys_db_object")
        ? { body: { result: [{ name: "incident", label: "Incident" }, { name: "kb_knowledge", label: "Knowledge" }] } }
        : { body: { result: [] } },
    () => browseServiceNowCandidates(SRC, CRED, DEFAULT_CAPS),
  );
  // SRC's default table (cmdb_ci_appl) leads even though the catalog lacks it.
  assert.equal(candidates[0].detail, "ServiceNow table cmdb_ci_appl");
  const locator = JSON.parse(candidates[0].locator) as { table: string; query: string };
  assert.equal(locator.table, "cmdb_ci_appl");
  assert.match(locator.query, /ORDERBYDESCsys_updated_on/);
  assert.ok(candidates.some((c) => c.detail.includes("incident")));
  assert.ok(candidates.some((c) => c.detail.includes("kb_knowledge")));
});

// --- Browser-session cookie replay (snow-session) ---------------------------

const SESSION_TABLE_PASTE = [
  "Name\tValue\tDomain\tPath",
  "JSESSIONID\tABC123\tcorp.service-now.com\t/",
  "glide_user_route\tglide.x\tcorp.service-now.com\t/",
].join("\n");

function withFetchInit<T>(
  responder: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    responder(String(url), init)) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("a stored DevTools-table cookie paste is normalized into a legal Cookie header at send time", async () => {
  let cookie = "";
  let auth: string | undefined;
  await withFetchInit(
    (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      cookie = headers.Cookie ?? "";
      auth = headers.Authorization;
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    () => searchServiceNow(SRC, { method: "snow-session", secret: SESSION_TABLE_PASTE }, "outage", DEFAULT_CAPS),
  );
  assert.equal(cookie, "JSESSIONID=ABC123; glide_user_route=glide.x");
  assert.equal(auth, undefined, "cookie sessions must not send Authorization");
});

test("rejected cookie session (401) reports the replayed cookie NAMES and re-capture guidance", async () => {
  await assert.rejects(
    withFetchInit(
      () => new Response("{}", { status: 401 }),
      () => searchServiceNow(SRC, { method: "snow-session", secret: SESSION_TABLE_PASTE }, "outage", DEFAULT_CAPS),
    ),
    (err: Error & { userSummary?: string }) => {
      assert.match(err.message, /JSESSIONID, glide_user_route/);
      assert.ok(!err.message.includes("ABC123"), "cookie VALUES must never appear in errors");
      assert.match(err.userSummary ?? "", /re-capture/i);
      return true;
    },
  );
});

test("an HTML login page in response to a cookie session explains expiry instead of 'non-JSON'", async () => {
  await assert.rejects(
    withFetchInit(
      () => new Response("<html><body>Sign in to ServiceNow</body></html>", { status: 200 }),
      () => searchServiceNow(SRC, { method: "snow-session", secret: SESSION_TABLE_PASTE }, "outage", DEFAULT_CAPS),
    ),
    /login page \(session expired|login page/,
  );
});
