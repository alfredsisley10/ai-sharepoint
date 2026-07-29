import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  classifyTlsFailure,
  parseCertAltNames,
  suggestConnectionNames,
  withMssqlHost,
  withTrustServerCertificate,
  mssqlHostOf,
  describeTlsFailure,
  withTrustIgnoredHint,
} from "../src/context/db/mssqlCertRecovery";

// The real Node message for the flagship case: connected by IP, cert names the FQDN.
const ALTNAME_ERR =
  "Failed to connect to 10.4.2.9:1433 - Hostname/IP does not match certificate's altnames: Host: 10.4.2.9. is not in the cert's altnames: DNS:sql01.corp.example, DNS:sql01";

test("classifyTlsFailure separates certificate problems from everything else", () => {
  assert.equal(classifyTlsFailure(ALTNAME_ERR), "altname-mismatch");
  assert.equal(classifyTlsFailure("Error: self signed certificate in certificate chain"), "self-signed");
  assert.equal(classifyTlsFailure("unable to get local issuer certificate"), "untrusted-chain");
  assert.equal(classifyTlsFailure("certificate has expired"), "expired");
  assert.equal(classifyTlsFailure("SSL routines::wrong version number"), "other-tls");
  // NOT TLS — these must never be offered certificate remedies.
  assert.equal(classifyTlsFailure("Login failed for user 'sa'. (error 18456, state 1)"), undefined);
  assert.equal(classifyTlsFailure("Timeout: Request failed to complete in 30000ms"), undefined);
  assert.equal(classifyTlsFailure("Cannot open database \"Sales\" requested by the login."), undefined);
  assert.equal(classifyTlsFailure(""), undefined);
});

test("an EXPIRED self-signed cert reads as expired, not self-signed", () => {
  // Both phrases appear; the more actionable one must win.
  assert.equal(classifyTlsFailure("self signed certificate ... certificate has expired"), "expired");
});

test("parseCertAltNames extracts the presented host and the certificate's names", () => {
  const alt = parseCertAltNames(ALTNAME_ERR);
  assert.equal(alt.presentedHost, "10.4.2.9");
  assert.deepEqual(alt.dnsNames, ["sql01.corp.example", "sql01"]);
  assert.deepEqual(alt.ipNames, []);
});

test("parseCertAltNames handles IP entries, wildcards, and trailing prose", () => {
  const alt = parseCertAltNames(
    "Hostname/IP does not match certificate's altnames: DNS:*.corp.example, IP Address:10.4.2.9, DNS:sql01.corp.example — server said: nope",
  );
  assert.deepEqual(alt.dnsNames, ["*.corp.example", "sql01.corp.example"]);
  assert.deepEqual(alt.ipNames, ["10.4.2.9"]);
});

test("parseCertAltNames degrades to empty rather than throwing on junk", () => {
  for (const junk of ["", "totally unrelated error", "altnames:", "Host: x is not in"]) {
    const alt = parseCertAltNames(junk);
    assert.ok(Array.isArray(alt.dnsNames) && Array.isArray(alt.ipNames));
  }
});

test("suggesting a name: the FQDN for an IP connection ranks first", () => {
  const s = suggestConnectionNames("10.4.2.9", parseCertAltNames(ALTNAME_ERR));
  assert.equal(s[0].host, "sql01.corp.example");
  assert.match(s[0].reason, /full name/i);
  // The bare short name is still offered, but ranked below the FQDN and warned about.
  assert.equal(s[1].host, "sql01");
  assert.match(s[1].reason, /may not resolve/i);
});

test("suggesting a name: a short name is expanded to the certificate's FQDN", () => {
  const s = suggestConnectionNames("sql01", parseCertAltNames(ALTNAME_ERR));
  assert.equal(s[0].host, "sql01.corp.example");
  // The name the user already typed is never suggested back at them.
  assert.ok(!s.some((x) => x.host === "sql01"));
});

test("wildcards are never suggested verbatim — they cannot be connected to", () => {
  const alt = parseCertAltNames("altnames: DNS:*.corp.example");
  const s = suggestConnectionNames("sql01", alt);
  assert.ok(!s.some((x) => x.host.startsWith("*")), "no wildcard is ever offered as a host");
  // Instead the concrete name the user's short name implies is proposed.
  assert.equal(s[0].host, "sql01.corp.example");
  assert.match(s[0].reason, /wildcard/i);
  // With an IP there is no short name to expand, so we suggest nothing rather
  // than something that cannot work.
  assert.deepEqual(suggestConnectionNames("10.4.2.9", alt), []);
});

test("IP entries are offered last, and nothing is suggested when there is nothing useful", () => {
  const alt = parseCertAltNames("altnames: IP Address:10.4.2.9, DNS:sql01.corp.example");
  const s = suggestConnectionNames("sql-old", alt);
  assert.equal(s[0].host, "sql01.corp.example");
  assert.equal(s[s.length - 1].host, "10.4.2.9");
  // A cert that only names the host we already used yields no suggestions.
  assert.deepEqual(suggestConnectionNames("sql01.corp.example", parseCertAltNames("altnames: DNS:sql01.corp.example")), []);
});

test("withMssqlHost swaps the host and preserves port, database and every parameter", () => {
  const url = "mssql://10.4.2.9:14330/Sales?instance=PROD&trustServerCertificate=true";
  const out = withMssqlHost(url, "sql01.corp.example");
  const u = new URL(out);
  assert.equal(u.hostname, "sql01.corp.example");
  assert.equal(u.port, "14330");
  assert.equal(u.pathname, "/Sales");
  assert.equal(u.searchParams.get("instance"), "PROD");
  assert.equal(u.searchParams.get("trustServerCertificate"), "true");
  // An unparseable URL comes back untouched — the wizard must not lose work.
  assert.equal(withMssqlHost("not a url", "x"), "not a url");
});

test("withTrustServerCertificate toggles the parameter without disturbing the rest", () => {
  const url = "mssql://sql01/Sales?instance=PROD";
  const on = withTrustServerCertificate(url, true);
  assert.equal(new URL(on).searchParams.get("trustServerCertificate"), "true");
  assert.equal(new URL(on).searchParams.get("instance"), "PROD");
  const off = withTrustServerCertificate(on, false);
  assert.equal(new URL(off).searchParams.get("trustServerCertificate"), null);
  assert.equal(new URL(off).searchParams.get("instance"), "PROD");
  assert.equal(withTrustServerCertificate("nope", true), "nope");
});

test("mssqlHostOf reads the host back, safely", () => {
  assert.equal(mssqlHostOf("mssql://sql01.corp.example:1433/Sales"), "sql01.corp.example");
  assert.equal(mssqlHostOf("garbage"), "");
});

test("describeTlsFailure names the certificate's actual names", () => {
  const alt = parseCertAltNames(ALTNAME_ERR);
  const d = describeTlsFailure("altname-mismatch", alt);
  assert.ok(d.includes("10.4.2.9"));
  assert.ok(d.includes("sql01.corp.example"));
  assert.match(describeTlsFailure("self-signed", alt), /self-signed/i);
  assert.match(describeTlsFailure("untrusted-chain", alt), /CA this machine doesn't trust/i);
  assert.match(describeTlsFailure("expired", alt), /expired/i);
});

test("a DROPPED trust request is explained in the error, not just the wire log", () => {
  // Reported: "ignoring SSL errors for MSSQL does not appear to work". The URL
  // parameter is ignored unless the machine-scoped setting is on, and the only
  // trace was a wire-log line — so the option looked broken.
  const base = "SQL Server TLS certificate validation failed: self signed certificate";
  const hinted = withTrustIgnoredHint(base, true);
  assert.ok(hinted.startsWith(base));
  assert.match(hinted, /IGNORED/);
  assert.match(hinted, /allowTrustServerCertificate/);
  // No hint when the request was honored (or never made).
  assert.equal(withTrustIgnoredHint(base, false), base);
  // Never doubled up when the advice already names the setting.
  const already = `${base} — enable aiSharePoint.db.allowTrustServerCertificate`;
  assert.equal(withTrustIgnoredHint(already, true), already);
});
