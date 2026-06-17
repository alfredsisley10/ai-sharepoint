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
  spAlias,
  listFolder,
  readFileText,
  uploadTextFile,
  deleteFile,
  buildTextCanvas,
  extractCanvasText,
  listSitePages,
  getSitePage,
  createTextPage,
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

// --- document libraries ----------------------------------------------------

test("spAlias keeps the OData quote delimiters literal, encodes the path interior, doubles apostrophes", () => {
  // encodeURIComponent leaves ' unreserved — exactly what @f='…' needs as delimiters.
  assert.equal(spAlias("@f", "/sites/Eng/Shared Documents"), "@f='%2Fsites%2FEng%2FShared%20Documents'");
  assert.match(spAlias("@f", "/a/O'Brien"), /O''Brien/); // interior ' doubled per OData
});

test("listFolder returns files and folders, hiding the system Forms folder", async () => {
  const { result, calls } = await withFetch(
    (url) =>
      /\/Files\?/.test(url)
        ? { body: JSON.stringify({ value: [{ Name: "a.txt", ServerRelativeUrl: "/x/a.txt" }] }) }
        : { body: JSON.stringify({ value: [{ Name: "Sub", ServerRelativeUrl: "/x/Sub" }, { Name: "Forms", ServerRelativeUrl: "/x/Forms" }] }) },
    () => listFolder(SITE, "/sites/Eng/Shared Documents", COOKIES, 30000),
  );
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.folders.map((f) => f.Name), ["Sub"]);
  assert.match(calls[0].url, /GetFolderByServerRelativeUrl\(@f\)\/Files\?@f='/);
});

test("readFileText requests $value as text/plain and returns the raw body", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: "line one\nline two" }),
    () => readFileText(SITE, "/sites/Eng/Shared Documents/a.txt", COOKIES, 30000),
  );
  assert.equal(result, "line one\nline two");
  assert.match(calls[0].url, /GetFileByServerRelativeUrl\(@f\)\/\$value\?@f=/);
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "text/plain");
});

test("uploadTextFile POSTs the raw body to Files/add with overwrite", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: JSON.stringify({ Name: "note.md", ServerRelativeUrl: "/x/note.md" }) }),
    () => uploadTextFile(SITE, "/x", "note.md", "# Hello", COOKIES, "0xDIG", 30000),
  );
  assert.equal(result.Name, "note.md");
  assert.match(calls[0].url, /Files\/add\(url='note\.md',overwrite=true\)/);
  assert.equal((calls[0].init as { body?: string }).body, "# Hello");
  // raw upload must NOT be sent as application/json
  assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], undefined);
  assert.equal((calls[0].init.headers as Record<string, string>)["X-RequestDigest"], "0xDIG");
});

test("deleteFile tunnels DELETE through POST with IF-MATCH", async () => {
  const { calls } = await withFetch(
    () => ({ status: 204 }),
    () => deleteFile(SITE, "/x/old.txt", COOKIES, "0xDIG", 30000),
  );
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["X-HTTP-Method"], "DELETE");
  assert.equal(h["IF-MATCH"], "*");
});

// --- modern pages ----------------------------------------------------------

test("buildTextCanvas / extractCanvasText round-trip the text", () => {
  const canvas = buildTextCanvas("<p>Hello <b>world</b></p>", "fixed-id");
  const parsed = JSON.parse(canvas) as Array<{ controlType: number }>;
  assert.equal(parsed[0].controlType, 4);
  assert.equal(parsed[1].controlType, 0); // page-settings slice
  assert.equal(extractCanvasText(canvas), "Hello world");
  assert.equal(extractCanvasText("not json"), "");
  assert.equal(extractCanvasText(undefined), "");
});

test("listSitePages unwraps the modern pages collection", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: JSON.stringify({ value: [{ Id: 3, Title: "Home" }] }) }),
    () => listSitePages(SITE, COOKIES, 30000),
  );
  assert.equal(result[0].Title, "Home");
  assert.match(calls[0].url, /\/sitepages\/pages\?/);
});

test("getSitePage extracts readable text from CanvasContent1", async () => {
  const { result } = await withFetch(
    () => ({ body: JSON.stringify({ Id: 3, Title: "Home", CanvasContent1: buildTextCanvas("<p>Body text</p>") }) }),
    () => getSitePage(SITE, 3, COOKIES, 30000),
  );
  assert.equal(result.Title, "Home");
  assert.equal(result.text, "Body text");
});

test("createTextPage creates, saves, and publishes (three calls)", async () => {
  const { result, calls } = await withFetch(
    (url) => (/\/pages$/.test(url) ? { body: JSON.stringify({ Id: 9, Url: "SitePages/x.aspx" }) } : { status: 200, body: "{}" }),
    () => createTextPage(SITE, "New Page", "<p>hi</p>", COOKIES, "0xDIG", 30000),
  );
  assert.equal(result.Id, 9);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/sitepages\/pages$/);
  assert.match(calls[1].url, /\/sitepages\/pages\(9\)\/SavePage$/);
  assert.match(calls[2].url, /\/sitepages\/pages\(9\)\/Publish$/);
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
