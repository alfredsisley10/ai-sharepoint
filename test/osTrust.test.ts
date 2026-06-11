import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as tls from "node:tls";
import {
  splitPemBundle,
  loadTrustedCAs,
  clearTrustCache,
} from "../src/context/ldap/osTrust";
import { resolveConnectUrls } from "../src/context/ldap/ldapClient";

const CERT = (n: number) =>
  `-----BEGIN CERTIFICATE-----\nFAKE${n}\n-----END CERTIFICATE-----`;

test("splitPemBundle extracts certificates and ignores surrounding noise", () => {
  const bundle = `# comment\n${CERT(1)}\njunk\n${CERT(2)}\n`;
  assert.deepEqual(splitPemBundle(bundle), [CERT(1), CERT(2)]);
  assert.deepEqual(splitPemBundle("no certs here"), []);
});

test("loadTrustedCAs appends OS-store certs ON TOP of Node's bundled roots", () => {
  clearTrustCache();
  const cas = loadTrustedCAs(undefined, {
    systemCerts: () => [CERT(1)],
    readFile: () => {
      throw new Error("ENOENT");
    },
    env: {},
  });
  assert.ok(cas);
  // Defaults preserved (public CAs keep working) + the OS cert appended.
  assert.ok(cas!.length >= tls.rootCertificates.length + 1);
  assert.ok(cas!.includes(CERT(1)));
  assert.equal(cas![0], tls.rootCertificates[0]);
});

test("pinned bundle file and NODE_EXTRA_CA_CERTS are honored and deduped", () => {
  clearTrustCache();
  const files: Record<string, string> = {
    "/corp/ca.pem": `${CERT(2)}\n${CERT(2)}`,
    "/extra.pem": CERT(3),
  };
  const cas = loadTrustedCAs("/corp/ca.pem", {
    systemCerts: () => [],
    readFile: (p) => {
      if (files[p]) return files[p];
      throw new Error("ENOENT");
    },
    env: { NODE_EXTRA_CA_CERTS: "/extra.pem" },
  });
  assert.ok(cas!.includes(CERT(2)));
  assert.ok(cas!.includes(CERT(3)));
  assert.equal(cas!.filter((c) => c === CERT(2)).length, 1); // deduped
});

test("with no extra sources, returns undefined so Node defaults apply untouched", () => {
  clearTrustCache();
  const cas = loadTrustedCAs(undefined, {
    systemCerts: () => [],
    readFile: () => {
      throw new Error("ENOENT");
    },
    env: {},
  });
  assert.equal(cas, undefined);
});

// --- durable SRV resolution at the client boundary ----------------------------

test("srv locators re-resolve per connection; static URLs pass through", async () => {
  const urls = await resolveConnectUrls(
    { baseUrl: "ldaps+srv://_gc._tcp.corp.example" },
    {
      resolveSrv: async (name) => {
        assert.equal(name, "_gc._tcp.corp.example");
        return [
          { name: "gc2.corp.example", port: 3268, priority: 0, weight: 10 },
          { name: "gc1.corp.example", port: 3268, priority: 0, weight: 90 },
        ];
      },
    },
  );
  assert.deepEqual(urls, ["ldaps://gc1.corp.example:3269", "ldaps://gc2.corp.example:3269"]);

  const fixed = await resolveConnectUrls({ baseUrl: "ldaps://pinned:636" }, {
    resolveSrv: async () => {
      throw new Error("must not be called for static URLs");
    },
  });
  assert.deepEqual(fixed, ["ldaps://pinned:636"]);
});

test("srv resolution failures classify as network with actionable messages", async () => {
  await assert.rejects(
    resolveConnectUrls(
      { baseUrl: "ldaps+srv://_gc._tcp.corp.example" },
      { resolveSrv: async () => { throw new Error("ENOTFOUND"); } },
    ),
    /SRV lookup failed/,
  );
  await assert.rejects(
    resolveConnectUrls(
      { baseUrl: "ldaps+srv://_gc._tcp.corp.example" },
      { resolveSrv: async () => [] },
    ),
    /no servers/,
  );
});
