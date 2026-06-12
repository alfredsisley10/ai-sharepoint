import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildSnowAuthUrl,
  parseSnowTokenResponse,
  snowTokensFromSecret,
  snowTokenExpired,
  SNOW_REDIRECT_URI,
} from "../src/context/adapters/servicenowAuth";

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
