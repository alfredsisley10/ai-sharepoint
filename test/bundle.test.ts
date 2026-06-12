import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildBundle,
  bundleToMarkdown,
  scanForLeaks,
  BundleInputs,
} from "../src/diagnostics/bundle";

function inputs(scope: BundleInputs["scope"] = "full"): BundleInputs {
  return {
    generatedAt: "2026-06-11T12:00:00.000Z",
    scope,
    anonymousInstallId: "5e0e9a9c-7d1f-4b9e-8a3a-9b1c2d3e4f55",
    environment: {
      extensionVersion: "0.1.0",
      vscodeVersion: "1.100.0",
      platform: "linux-x64",
      uiKind: "desktop",
    },
    settings: { "copilot.preferredModelFamily": "(economy-first default)" },
    sites: [
      {
        tenant: "anon-1a2b3c4d5e.sharepoint.com",
        role: "managed",
        authProviderId: "msal-public-interactive",
        verified: true,
      },
    ],
    usage: {
      monthRequests: 30,
      monthFailures: 1,
      todayRequests: 3,
      byModel: [
        { key: "gpt-test", requests: 30, inputTokens: 100, outputTokens: 200 },
      ],
      byLabel: [{ key: "chat", requests: 30 }],
      daily: [{ day: "2026-06-11", requests: 3, failures: 0 }],
    },
    telemetry: {
      totalsByEvent: { command: 12 },
      daysCovered: 4,
      recentEvents: [{ at: "2026-06-11T11:00:00Z", name: "command", props: { id: "askCopilot" } }],
    },
    errors: [
      {
        firstAt: "2026-06-11T10:00:00Z",
        lastAt: "2026-06-11T10:30:00Z",
        context: "aiSharePoint.testConnection",
        code: "graph.forbidden",
        name: "AppError",
        message: "Graph request failed (403 Forbidden): access denied",
        stack: "AppError: …/sharePointClient.js:42:1",
        count: 2,
      },
    ],
  };
}

test("scope controls bundle sections", () => {
  const full = buildBundle(inputs("full"));
  assert.ok(full.usage && full.errors && full.telemetry);
  const usage = buildBundle(inputs("usage"));
  assert.ok(usage.usage && !usage.errors);
  const errors = buildBundle(inputs("errors"));
  assert.ok(errors.errors && !errors.usage);
});

test("markdown rendering covers every section and the notice", () => {
  const md = bundleToMarkdown(buildBundle(inputs()));
  for (const expected of [
    "diagnostics bundle",
    "anon-1a2b3c4d5e.sharepoint.com",
    "graph.forbidden",
    "Copilot activity",
    "Generated locally",
  ]) {
    assert.ok(md.includes(expected), `missing: ${expected}`);
  }
});

test("a clean bundle passes the leak scan (install id allowlisted)", () => {
  const bundle = buildBundle(inputs());
  const json = JSON.stringify(bundle);
  const findings = scanForLeaks(json, [bundle.anonymousInstallId]);
  assert.deepEqual(
    findings.filter((f) => f.severity === "block"),
    [],
    JSON.stringify(findings),
  );
});

test("leak scan blocks JWTs, raw tenants, emails, bearer creds, secrets", () => {
  const dirty = JSON.stringify({
    a: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.sig123456789",
    b: "contoso.sharepoint.com",
    c: "user@corp.example",
    d: "Bearer abcdef123456789012345",
    e: 'client_secret: "super-secret-value"',
    f: "callback?access_token=abcdef123456&state=x", // keys must stay a superset of redaction.ts
    g: "https://x/cb?code=AUTHCODE123456", // auth codes count only in querystring form
  });
  const found = scanForLeaks(dirty).filter((f) => f.severity === "block");
  const names = found.map((f) => f.pattern).sort();
  for (const expected of [
    "authcode-in-url",
    "bearer-credential",
    "email-address",
    "jwt",
    "raw-tenant-host",
    "secret-assignment",
  ]) {
    assert.ok(names.includes(expected), `missing ${expected} in ${names.join(",")}`);
  }
});

test("JSON error-code fields do not false-positive the secret scan", () => {
  const clean = JSON.stringify({ errors: [{ code: "graph.forbidden", context: "chat" }] });
  const blockers = scanForLeaks(clean).filter((f) => f.severity === "block");
  assert.deepEqual(blockers, []);
});

test("leak scan ignores anonymized tenants but flags raw ones", () => {
  const ok = scanForLeaks(`"anon-1a2b3c4d5e.sharepoint.com"`);
  assert.equal(ok.filter((f) => f.pattern === "raw-tenant-host").length, 0);
  const bad = scanForLeaks(`"fabrikam.sharepoint.us"`);
  assert.equal(bad.filter((f) => f.pattern === "raw-tenant-host").length, 1);
});

test("guids outside the allowlist warn (not block)", () => {
  const findings = scanForLeaks(`"id":"0fae33d1-1c2a-4b33-9a55-cafe00112233"`);
  const guid = findings.find((f) => f.pattern === "guid");
  assert.ok(guid);
  assert.equal(guid!.severity, "warn");
});
