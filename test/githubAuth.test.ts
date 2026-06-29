import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  parseGithubAppSecret,
  buildGithubAppJwt,
  mintInstallationToken,
} from "../src/context/adapters/githubAuth";

// A throwaway RSA key pair for signing/verifying (PKCS#1, like GitHub App keys).
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

function decodeB64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

test("parseGithubAppSecret validates the three required fields", () => {
  assert.deepEqual(parseGithubAppSecret(JSON.stringify({ appId: "1", installationId: "2", privateKey: "k" })), {
    appId: "1",
    installationId: "2",
    privateKey: "k",
  });
  assert.throws(() => parseGithubAppSecret("not json"), /not valid JSON/);
  assert.throws(() => parseGithubAppSecret(JSON.stringify({ appId: "1", installationId: "2" })), /missing/);
});

test("buildGithubAppJwt produces a verifiable RS256 JWT with GitHub's claims", () => {
  const now = 1_750_000_000;
  const jwt = buildGithubAppJwt("123456", privateKey, now);
  const [h, p, sig] = jwt.split(".");
  assert.equal([h, p, sig].length, 3);

  const header = JSON.parse(decodeB64Url(h).toString("utf8"));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });

  const payload = JSON.parse(decodeB64Url(p).toString("utf8"));
  assert.equal(payload.iss, "123456");
  assert.equal(payload.iat, now - 60); // backdated for clock drift
  assert.equal(payload.exp, now + 9 * 60); // ≤ 10 minutes out
  assert.ok(payload.exp - payload.iat <= 600);

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  assert.ok(verifier.verify(publicKey, decodeB64Url(sig)), "signature must verify with the public key");
});

test("mintInstallationToken POSTs the JWT to the installation endpoint and returns the token", async () => {
  const seen: { url: string; method?: string; auth?: string } = { url: "" };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.url = String(url);
    seen.method = init?.method;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.auth = headers["Authorization"] ?? headers["authorization"];
    return new Response(JSON.stringify({ token: "ghs_installation", expires_at: "2026-06-29T13:00:00Z" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const res = await mintInstallationToken(
      "https://github.corp.example/api/v3",
      { appId: "123456", installationId: "777", privateKey },
      1_750_000_000,
      30_000,
    );
    assert.equal(res.token, "ghs_installation");
    assert.equal(res.expiresAtMs, Date.parse("2026-06-29T13:00:00Z"));
    assert.equal(seen.url, "https://github.corp.example/api/v3/app/installations/777/access_tokens");
    assert.equal(seen.method, "POST");
    assert.match(seen.auth ?? "", /^Bearer /); // app JWT travels as a Bearer token
  } finally {
    globalThis.fetch = original;
  }
});
