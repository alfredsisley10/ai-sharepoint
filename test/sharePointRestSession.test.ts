import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  apiBase,
  sessionHeaders,
  parseFormDigest,
  parseSpError,
  getFormDigest,
  verifySharePointSession,
  getListItems,
  createListItem,
  updateListItem,
  sharePointCookieIssue,
  SHAREPOINT_SESSION_USER_AGENT,
} from "../src/auth/sharePointRestSession";

const SITE = "https://contoso.sharepoint.com/sites/Eng";
const COOKIES = "FedAuth=aaa; rtFa=bbb";

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body?: string },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = handler(String(url), init ?? {});
    return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

// --- pure helpers ----------------------------------------------------------

test("apiBase appends /_api and trims trailing slash", () => {
  assert.equal(apiBase(SITE), `${SITE}/_api`);
  assert.equal(apiBase(`${SITE}/`), `${SITE}/_api`);
});

test("sessionHeaders sends the cookie, a browser UA, and JSON Accept", () => {
  const h = sessionHeaders(COOKIES);
  assert.equal(h.Cookie, "FedAuth=aaa; rtFa=bbb");
  assert.equal(h["User-Agent"], SHAREPOINT_SESSION_USER_AGENT);
  assert.match(h.Accept, /odata=nometadata/);
});

test("parseFormDigest reads nometadata and verbose shapes", () => {
  assert.equal(parseFormDigest({ FormDigestValue: "DIG1" }), "DIG1");
  assert.equal(parseFormDigest({ d: { GetContextWebInformation: { FormDigestValue: "DIG2" } } }), "DIG2");
  assert.equal(parseFormDigest({}), undefined);
});

test("parseSpError extracts the message from either error envelope", () => {
  assert.equal(parseSpError(JSON.stringify({ "odata.error": { message: { value: "no perms" } } })), "no perms");
  assert.equal(parseSpError(JSON.stringify({ error: { message: { value: "bad" } } })), "bad");
  assert.match(parseSpError("<html><title>Sign in</title>") ?? "", /Sign in/);
});

test("sharePointCookieIssue flags a missing FedAuth/rtFa", () => {
  assert.equal(sharePointCookieIssue("FedAuth=x; rtFa=y"), undefined);
  assert.match(sharePointCookieIssue("SomeOther=1") ?? "", /FedAuth\/rtFa/);
  assert.match(sharePointCookieIssue("not a cookie") ?? "", /cookie string/);
});

// --- IO --------------------------------------------------------------------

test("getFormDigest POSTs to /_api/contextinfo and returns the digest", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: JSON.stringify({ FormDigestValue: "0x123" }) }),
    () => getFormDigest(SITE, COOKIES, 30000),
  );
  assert.equal(result, "0x123");
  assert.match(calls[0].url, /\/_api\/contextinfo$/);
  assert.equal((calls[0].init as { method?: string }).method, "POST");
});

test("verifySharePointSession returns the web title + current user", async () => {
  const { result } = await withFetch(
    (url) =>
      /currentuser/.test(url)
        ? { body: JSON.stringify({ Title: "Jane Doe", Email: "jane@contoso.com", LoginName: "i:0#.f|m|jane" }) }
        : { body: JSON.stringify({ Title: "Engineering" }) },
    () => verifySharePointSession(SITE, COOKIES, 30000),
  );
  assert.equal(result.webTitle, "Engineering");
  assert.equal(result.account, "Jane Doe");
  assert.equal(result.loginName, "i:0#.f|m|jane");
});

test("getListItems builds a $top/$select query and unwraps .value", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: JSON.stringify({ value: [{ Id: 1, Title: "A" }, { Id: 2, Title: "B" }] }) }),
    () => getListItems(SITE, "Tasks", COOKIES, { select: "Id,Title", top: 10 }, 30000),
  );
  assert.equal(result.length, 2);
  assert.match(calls[0].url, /getbytitle\('Tasks'\)\/items\?/);
  assert.match(calls[0].url, /%24top=10/);
  assert.match(calls[0].url, /%24select=Id%2CTitle/);
});

test("createListItem POSTs fields with the digest", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: JSON.stringify({ Id: 7, Title: "New" }) }),
    () => createListItem(SITE, "Tasks", { Title: "New" }, COOKIES, "0xDIG", 30000),
  );
  assert.equal(result.Id, 7);
  assert.equal((calls[0].init.headers as Record<string, string>)["X-RequestDigest"], "0xDIG");
  assert.equal(JSON.parse(String((calls[0].init as { body?: string }).body)).Title, "New");
});

test("updateListItem uses MERGE + IF-MATCH and tolerates a 204", async () => {
  const { calls } = await withFetch(
    () => ({ status: 204 }),
    () => updateListItem(SITE, "Tasks", 7, { Status: "Done" }, COOKIES, "0xDIG", 30000),
  );
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["X-HTTP-Method"], "MERGE");
  assert.equal(h["IF-MATCH"], "*");
  assert.equal(h["X-RequestDigest"], "0xDIG");
  assert.match(calls[0].url, /\/items\(7\)$/);
});

test("a 403 surfaces a session-rejected auth error with the replayed cookie names", async () => {
  const err = await withFetch(
    () => ({ status: 403, body: JSON.stringify({ "odata.error": { message: { value: "Access denied" } } }) }),
    () => getListItems(SITE, "Tasks", COOKIES, {}, 30000).then(() => undefined, (e) => e),
  );
  const e = (err as { result: unknown }).result as Error;
  assert.match(e.message, /rejected the session \(403\).*Access denied/);
  assert.match(e.message, /FedAuth, rtFa/);
});
