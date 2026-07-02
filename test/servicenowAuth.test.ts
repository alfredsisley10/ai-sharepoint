import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildSnowAuthUrl,
  parseSnowTokenResponse,
  snowTokensFromSecret,
  snowTokenExpired,
  snowApiKeyIssue,
  snowOidcTokenIssue,
  jwtExpiryMs,
  extractUserToken,
  fetchSnowUserToken,
  SNOW_REDIRECT_URI,
} from "../src/context/adapters/servicenowAuth";

// A minimal unsigned JWT with a controllable exp claim (seconds).
function jwt(expSeconds?: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "x" })}.${b64(expSeconds ? { sub: "u", exp: expSeconds } : { sub: "u" })}.sig`;
}
const NOW = 1_700_000_000_000; // fixed "now" in ms

test("extractUserToken: pulls g_ck from page HTML and the ck field from JSON; undefined otherwise", () => {
  assert.equal(
    extractUserToken('<script>var g_ck = "abcdef0123456789ABCDEF";</script>'),
    "abcdef0123456789ABCDEF",
  );
  assert.equal(extractUserToken("window.g_ck = 'tok_9f8e7d6c5b4a3210';"), "tok_9f8e7d6c5b4a3210");
  assert.equal(extractUserToken('{"user":"x","ck":"JSONck0123456789abcd"}'), "JSONck0123456789abcd");
  assert.equal(extractUserToken("<html>no token here</html>"), undefined);
  assert.equal(extractUserToken('var g_ck = "short";'), undefined); // too short to be a real token
});

test("fetchSnowUserToken: fetches g_ck with the cookies; skips a non-OK endpoint to the next", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(String(url));
    // First endpoint 404s; the second returns a page carrying g_ck.
    if (String(url).endsWith("/api/now/ui/user/current_user")) {
      return new Response("nope", { status: 404 });
    }
    assert.match(init?.headers?.Cookie ?? "", /JSESSIONID=abc/);
    return new Response('<script>var g_ck = "GCK_abcdef0123456789";</script>', { status: 200 });
  }) as typeof fetch;
  try {
    const tok = await fetchSnowUserToken("https://corp.service-now.com/?table=incident", "JSESSIONID=abc; glide=1");
    assert.equal(tok, "GCK_abcdef0123456789");
    assert.equal(seen[0], "https://corp.service-now.com/api/now/ui/user/current_user"); // origin-only, first path
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSnowUserToken: returns undefined (never throws) when every endpoint fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    assert.equal(await fetchSnowUserToken("https://corp.service-now.com", "JSESSIONID=abc"), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("snowApiKeyIssue: flags empty, spaced, and too-short keys; accepts a real one", () => {
  assert.ok(snowApiKeyIssue(""));
  assert.ok(snowApiKeyIssue("has space in it here"));
  assert.ok(snowApiKeyIssue("short"));
  assert.equal(snowApiKeyIssue("a1b2c3d4e5f6g7h8i9j0"), undefined);
});

test("jwtExpiryMs: decodes exp (→ ms); undefined for non-JWT or missing exp", () => {
  assert.equal(jwtExpiryMs(jwt(1_700_000_600)), 1_700_000_600_000);
  assert.equal(jwtExpiryMs(jwt()), undefined); // no exp claim
  assert.equal(jwtExpiryMs("not.a.jwt-ish"), undefined);
  assert.equal(jwtExpiryMs("only-one-segment"), undefined);
});

test("snowOidcTokenIssue: requires a JWT shape and a non-expired token", () => {
  assert.ok(snowOidcTokenIssue("", NOW)); // empty
  assert.ok(snowOidcTokenIssue("abc123", NOW)); // not a JWT
  assert.ok(snowOidcTokenIssue(jwt(NOW / 1000 - 60), NOW)); // expired 60s ago
  assert.equal(snowOidcTokenIssue(jwt(NOW / 1000 + 3600), NOW), undefined); // valid, unexpired
  assert.equal(snowOidcTokenIssue(jwt(), NOW), undefined); // JWT with no exp is accepted (can't prove expiry)
});

test("buildSnowAuthUrl targets oauth_auth.do with PKCE and the loopback redirect", () => {
  const url = new URL(
    buildSnowAuthUrl("https://corp.service-now.com?table=incident", "client123", "state-x", "chal"),
  );
  assert.equal(url.origin, "https://corp.service-now.com");
  assert.equal(url.pathname, "/oauth_auth.do");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client123");
  assert.equal(url.searchParams.get("redirect_uri"), SNOW_REDIRECT_URI);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-x");
});

test("token responses parse with expiry; stored secrets round-trip; expiry has a 60s skew", () => {
  const now = 1_000_000;
  const t = parseSnowTokenResponse(
    { access_token: "at", refresh_token: "rt", expires_in: 1800 },
    "cid",
    undefined,
    now,
  );
  assert.equal(t.accessToken, "at");
  assert.equal(t.refreshToken, "rt");
  assert.equal(t.expiresAt, now + 1800_000);
  const round = snowTokensFromSecret(JSON.stringify(t));
  assert.equal(round.accessToken, "at");
  assert.equal(snowTokenExpired(t, now), false);
  assert.equal(snowTokenExpired(t, now + 1800_000 - 30_000), true); // inside skew
  assert.throws(() => parseSnowTokenResponse({}, "cid", undefined, now), /no access token/);
  assert.throws(() => snowTokensFromSecret("{}"), /unreadable/);
});

test("cleanCookieString strips a leading Cookie: header; cookieStringIssue validates pairs", async () => {
  const { cleanCookieString, cookieStringIssue } = await import("../src/context/adapters/servicenowAuth");
  assert.equal(cleanCookieString("  Cookie: JSESSIONID=abc; glide=1 "), "JSESSIONID=abc; glide=1");
  assert.equal(cleanCookieString("JSESSIONID=abc"), "JSESSIONID=abc");
  assert.equal(cookieStringIssue("JSESSIONID=abc; glide_user_route=g"), undefined);
  assert.match(cookieStringIssue("not-a-cookie") ?? "", /cookie string/);
});

test("cleanCookieString normalizes a DevTools cookie-TABLE paste (full set, tab-separated rows)", async () => {
  const { cleanCookieString } = await import("../src/context/adapters/servicenowAuth");
  // Edge/Chrome Application → Cookies: select-all + copy = header row + one
  // tab-separated row per cookie, extra columns after value.
  const tablePaste = [
    "Name\tValue\tDomain\tPath\tExpires / Max-Age\tSize\tHttpOnly\tSecure",
    "JSESSIONID\tABC123\tcorp.service-now.com\t/\tSession\t38\t✓\t✓",
    "glide_user_route\tglide.abcdef\tcorp.service-now.com\t/\t2027-06-12\t28\t\t✓",
    "BIGipServerpool_corp\t1234.5678.0000\tcorp.service-now.com\t/\tSession\t34\t\t",
  ].join("\n");
  assert.equal(
    cleanCookieString(tablePaste),
    "JSESSIONID=ABC123; glide_user_route=glide.abcdef; BIGipServerpool_corp=1234.5678.0000",
  );
});

test("cleanCookieString accepts Firefox Copy-All JSON and name=value lines", async () => {
  const { cleanCookieString } = await import("../src/context/adapters/servicenowAuth");
  const ffJson = JSON.stringify([
    { name: "JSESSIONID", value: "ABC", host: "corp.service-now.com" },
    { name: "glide_user_route", value: "glide.x" },
  ]);
  assert.equal(cleanCookieString(ffJson), "JSESSIONID=ABC; glide_user_route=glide.x");
  assert.equal(
    cleanCookieString("JSESSIONID=ABC\nglide_user_route=glide.x\n"),
    "JSESSIONID=ABC; glide_user_route=glide.x",
  );
});

test("cleanCookieString drops Set-Cookie attributes and duplicate names; result is header-legal", async () => {
  const { cleanCookieString } = await import("../src/context/adapters/servicenowAuth");
  assert.equal(
    cleanCookieString("JSESSIONID=ABC; Path=/; Secure; HttpOnly; SameSite=None; JSESSIONID=OLD"),
    "JSESSIONID=ABC",
  );
  // No CR/LF/TAB may survive into the header value (fetch would throw).
  const cleaned = cleanCookieString("JSESSIONID\tABC\t/\nglide\tx\ty");
  assert.ok(!/[\r\n\t]/.test(cleaned), cleaned);
});

test("cookieNames lists names only — the safe diagnostic for rejected sessions", async () => {
  const { cookieNames } = await import("../src/context/adapters/servicenowAuth");
  assert.deepEqual(cookieNames("Cookie: JSESSIONID=secretvalue; glide_user_route=g"), [
    "JSESSIONID",
    "glide_user_route",
  ]);
  assert.deepEqual(cookieNames("garbage"), []);
});

test("describeSnowRejection: missing session cookies are called out by name", async () => {
  const { describeSnowRejection } = await import("../src/context/adapters/servicenowAuth");
  const d = describeSnowRejection({
    status: 401,
    bodyText: "{}",
    requestUrl: "https://corp.service-now.com/api/now/table/incident",
    storedCookies: "glide_user_route=g; BIGipServerpool=1.2.3",
  });
  assert.equal(d.kind, "auth");
  assert.match(d.summary, /missing JSESSIONID/);
  assert.match(d.summary, /corp\.service-now\.com/);
});

test("describeSnowRejection: an off-host redirect names the SSO gateway", async () => {
  const { describeSnowRejection } = await import("../src/context/adapters/servicenowAuth");
  const d = describeSnowRejection({
    bodyText: "<html><title>Corp Single Sign-On</title></html>",
    requestUrl: "https://corp.service-now.com/api/now/table/incident",
    finalUrl: "https://sso.corp.example/idp/startSSO",
    storedCookies: "JSESSIONID=a; glide_user_route=g",
  });
  assert.equal(d.kind, "auth");
  assert.match(d.message, /redirected to sso\.corp\.example/);
  assert.match(d.summary, /SSO\/login front-end \(sso\.corp\.example\)/);
});

test("describeSnowRejection: a hibernating-instance page is infrastructure, not an auth failure", async () => {
  const { describeSnowRejection } = await import("../src/context/adapters/servicenowAuth");
  const d = describeSnowRejection({
    bodyText: "<html><head><title>Instance Hibernating</title></head></html>",
    requestUrl: "https://dev12345.service-now.com/api/now/table/incident",
    storedCookies: "JSESSIONID=a; glide_user_route=g",
  });
  assert.equal(d.kind, "other");
  assert.match(d.message, /Instance Hibernating/);
});

test("snow-session secret: plain cookies round-trip; the JSON form carries the g_ck token", async () => {
  const { buildSnowSessionSecret, parseSnowSessionSecret } = await import(
    "../src/context/adapters/servicenowAuth"
  );
  // No token → plain string (backward compatible with stored captures).
  assert.equal(buildSnowSessionSecret("JSESSIONID=a; glide=b"), "JSESSIONID=a; glide=b");
  assert.deepEqual(parseSnowSessionSecret("JSESSIONID=a; glide=b"), { cookies: "JSESSIONID=a; glide=b" });
  // With token → JSON form, parsed back out.
  const secret = buildSnowSessionSecret("JSESSIONID=a", "TOK1234567890ABCDEF");
  assert.deepEqual(parseSnowSessionSecret(secret), { cookies: "JSESSIONID=a", userToken: "TOK1234567890ABCDEF" });
  // Firefox Copy-All JSON (array) is a cookie capture, not the secret form.
  const ff = JSON.stringify([{ name: "JSESSIONID", value: "a" }]);
  assert.deepEqual(parseSnowSessionSecret(ff), { cookies: ff });
});

test("userTokenIssue: empty is fine (optional); junk is rejected with g_ck guidance", async () => {
  const { userTokenIssue } = await import("../src/context/adapters/servicenowAuth");
  assert.equal(userTokenIssue(""), undefined);
  assert.equal(userTokenIssue("0123456789abcdef0123456789abcdef"), undefined);
  assert.match(userTokenIssue("short") ?? "", /g_ck/);
  assert.match(userTokenIssue("has spaces in it which tokens never do") ?? "", /g_ck/);
});

test("describeSnowRejection: complete fresh cookies + 'User Not Authenticated' without a token points at g_ck", async () => {
  const { describeSnowRejection } = await import("../src/context/adapters/servicenowAuth");
  const noToken = describeSnowRejection({
    status: 401,
    bodyText: JSON.stringify({ error: { message: "User Not Authenticated", detail: "Required to provide Auth information" } }),
    requestUrl: "https://corp.service-now.com/api/now/table/incident",
    storedCookies: "JSESSIONID=a; glide_user_route=g; BIGipServerpool=1.2.3",
    userTokenSent: false,
  });
  assert.match(noToken.summary, /X-UserToken/);
  assert.match(noToken.summary, /g_ck/);
  // Once a token IS sent, the g_ck hint must not fire as the primary cause.
  const withToken = describeSnowRejection({
    status: 401,
    bodyText: JSON.stringify({ error: { message: "User Not Authenticated" } }),
    requestUrl: "https://corp.service-now.com/api/now/table/incident",
    storedCookies: "JSESSIONID=a; glide_user_route=g",
    userTokenSent: true,
  });
  assert.ok(!withToken.summary.startsWith("Complete, fresh cookies"), withToken.summary);
});
