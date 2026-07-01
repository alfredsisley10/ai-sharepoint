import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  redactText,
  redactError,
  stripStackPaths,
} from "../src/core/redaction";

test("redacts three-segment JWTs", () => {
  const jwt =
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const out = redactText(`token=${jwt} trailing`);
  assert.ok(!out.includes("eyJhbGciOiJSUzI1NiIs"), out);
  assert.ok(out.includes("[redacted"), out);
});

test("redacts bearer credentials and authorization headers", () => {
  const out = redactText(
    `Authorization: Bearer abcdef1234567890TOKEN and basic dXNlcjpwYXNzd29yZA==`,
  );
  assert.ok(!out.includes("abcdef1234567890TOKEN"), out);
  assert.ok(!out.includes("dXNlcjpwYXNzd29yZA"), out);
});

test("redacts emails / UPNs", () => {
  const out = redactText("user dave.smith@contoso.com failed sign-in");
  assert.equal(out, "user [redacted:email] failed sign-in");
});

test("redacts GUIDs", () => {
  const out = redactText("tenant 0fae33d1-1c2a-4b33-9a55-cafe00112233 rejected");
  assert.ok(!out.includes("0fae33d1"), out);
  assert.ok(out.includes("[redacted:guid]"), out);
});

test("redacts SharePoint and onmicrosoft tenant hostnames across clouds", () => {
  for (const host of [
    "contoso.sharepoint.com",
    "agency.sharepoint.us",
    "firm.sharepoint.cn",
    "contoso.onmicrosoft.com",
  ]) {
    const out = redactText(`https://${host}/sites/Marketing failed`);
    assert.ok(!out.includes(host.split(".")[0] + "."), `${host} → ${out}`);
    assert.ok(out.includes("[redacted:tenant]"), out);
  }
});

test("redacts secrets in querystrings and connection strings", () => {
  const out = redactText(
    "https://x/cb?code=AUTHCODE123456&client_secret=shhh-very-secret&state=ok",
  );
  assert.ok(!out.includes("AUTHCODE123456"), out);
  assert.ok(!out.includes("shhh-very-secret"), out);
});

test("redacts user-profile paths on all platforms", () => {
  const out = redactText(
    String.raw`at C:\Users\dsmith\code\x.js and /home/dsmith/x.js and /Users/dsmith/x.js`,
  );
  assert.ok(!out.includes("dsmith"), out);
});

test("redacts non-loopback IPv4 but keeps 127.0.0.1", () => {
  const out = redactText("from 10.1.2.3 via 127.0.0.1");
  assert.ok(!out.includes("10.1.2.3"), out);
  assert.ok(out.includes("127.0.0.1"), out);
});

test("redactError strips stack paths to basenames", () => {
  const err = new Error("boom at user@contoso.com");
  err.stack = `Error: boom\n    at fn (/home/dave/proj/src/thing.ts:10:5)\n    at C:\\Users\\dave\\ext\\dist\\extension.js:1:2`;
  const safe = redactError(err);
  assert.ok(!safe.message.includes("user@contoso.com"));
  assert.ok(!safe.stack!.includes("/home/dave"), safe.stack ?? "");
  assert.ok(!safe.stack!.includes("C:\\Users"), safe.stack ?? "");
  assert.ok(safe.stack!.includes("thing.ts:10:5"), safe.stack ?? "");
});

test("stripStackPaths keeps line:col info", () => {
  const out = stripStackPaths("at /a/b/c/file.js:42:7");
  assert.ok(out.includes("file.js:42:7"), out);
  assert.ok(!out.includes("/a/b/c"), out);
});

test("redactError tolerates non-Error throwables", () => {
  const safe = redactError("string failure from admin@corp.io");
  assert.equal(safe.name, "Error");
  assert.ok(!safe.message.includes("admin@corp.io"));
});
