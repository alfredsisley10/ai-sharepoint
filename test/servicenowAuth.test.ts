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
