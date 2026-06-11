import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseWindowsAccount,
  buildMssqlAuthentication,
  parseMssqlParams,
  mssqlUrlIssue,
  mssqlPortAndInstance,
  parseSsmsServerName,
  ssmsToUrl,
  resolveMssqlEndpoint,
} from "../src/context/db/mssqlAuth";
import { parseDbUrl } from "../src/context/db/dbAdapters";

test("parseWindowsAccount handles DOMAIN\\user, UPN, and plain logins", () => {
  assert.deepEqual(parseWindowsAccount("CORP\\jdoe"), { domain: "CORP", user: "jdoe" });
  assert.deepEqual(parseWindowsAccount("jdoe@corp.example.com"), { domain: "CORP", user: "jdoe" });
  assert.equal(parseWindowsAccount("sa"), null);
  assert.equal(parseWindowsAccount("report_reader"), null);
});

test("explicit ntlm method → Windows Authentication with parsed domain", () => {
  const auth = buildMssqlAuthentication({ method: "ntlm", username: "CORP\\jdoe", secret: "pw" });
  assert.deepEqual(auth, {
    type: "ntlm",
    options: { userName: "jdoe", password: "pw", domain: "CORP" },
  });
});

test("basic method with a Windows-shaped account infers NTLM (SQL logins cannot contain backslash)", () => {
  const auth = buildMssqlAuthentication({ method: "basic", username: "CORP\\svc", secret: "pw" });
  assert.equal(auth.type, "ntlm");
  const upn = buildMssqlAuthentication({ method: "basic", username: "svc@corp.example", secret: "pw" });
  assert.equal(upn.type, "ntlm");
  assert.equal((upn.options as { domain: string }).domain, "CORP");
});

test("plain SQL logins use SQL Server Authentication", () => {
  const auth = buildMssqlAuthentication({ method: "basic", username: "report_reader", secret: "pw" });
  assert.deepEqual(auth, {
    type: "default",
    options: { userName: "report_reader", password: "pw" },
  });
});

test("ntlm with an unparseable account degrades to empty domain rather than failing", () => {
  const auth = buildMssqlAuthentication({ method: "ntlm", username: "justuser", secret: "pw" });
  assert.equal(auth.type, "ntlm");
  assert.equal((auth.options as { domain: string }).domain, "");
});

test("parseMssqlParams: named instance, encryption, certificate trust", () => {
  const p = parseMssqlParams(new URLSearchParams("instance=PROD&trustServerCertificate=true"));
  assert.deepEqual(p, { instanceName: "PROD", encrypt: true, trustServerCertificate: true });
  const defaults = parseMssqlParams(new URLSearchParams(""));
  assert.deepEqual(defaults, { encrypt: true, trustServerCertificate: false });
  assert.equal(parseMssqlParams(new URLSearchParams("encrypt=false")).encrypt, false);
});

test("alternate ports flow through the connection URL (enterprise non-1433 instances)", () => {
  const alt = parseDbUrl({ baseUrl: "mssql://sqlhost.corp.example:14330/Sales" });
  assert.equal(alt.port, 14330);
  assert.equal(alt.host, "sqlhost.corp.example");
  assert.equal(alt.database, "Sales");
  // No port → adapter defaults to 1433 (port stays undefined here).
  assert.equal(parseDbUrl({ baseUrl: "mssql://sqlhost/Sales" }).port, undefined);
});

test("mssqlUrlIssue: valid forms pass; port+instance conflict and missing db are rejected", () => {
  assert.equal(mssqlUrlIssue("mssql://host:14330/Sales"), undefined);
  assert.equal(mssqlUrlIssue("mssql://host/Sales?instance=PROD"), undefined);
  assert.equal(mssqlUrlIssue("mssql://host:1433/Sales?instance=PROD"), undefined); // legal — port wins
  assert.ok(mssqlPortAndInstance("mssql://host:1433/Sales?instance=PROD"));
  assert.match(mssqlUrlIssue("mssql://host:14330") ?? "", /database name/);
  assert.match(mssqlUrlIssue("not a url") ?? "", /valid connection URL/);
});

test("parseSsmsServerName handles every SSMS server-name form DBAs hand out", () => {
  assert.deepEqual(parseSsmsServerName("server.corp.com\\PROD,14330"), {
    host: "server.corp.com",
    instance: "PROD",
    port: 14330,
  });
  assert.deepEqual(parseSsmsServerName("server.corp.com,14330"), {
    host: "server.corp.com",
    port: 14330,
  });
  assert.deepEqual(parseSsmsServerName("server\\PROD"), { host: "server", instance: "PROD" });
  assert.deepEqual(parseSsmsServerName("server"), { host: "server" });
  assert.equal(parseSsmsServerName("mssql://server/db"), null); // URLs handled elsewhere
  assert.equal(parseSsmsServerName("server,99999"), null); // invalid port
});

test("ssmsToUrl applies SqlClient precedence: port wins, instance only as Browser fallback", () => {
  assert.equal(
    ssmsToUrl({ host: "server.corp.com", instance: "PROD", port: 14330 }, "Sales"),
    "mssql://server.corp.com:14330/Sales",
  );
  assert.equal(
    ssmsToUrl({ host: "server", instance: "PROD" }, "Sales"),
    "mssql://server/Sales?instance=PROD",
  );
  assert.equal(ssmsToUrl({ host: "server" }, "Sales"), "mssql://server/Sales");
});

test("resolveMssqlEndpoint: explicit port beats instance; instance beats default", () => {
  assert.deepEqual(
    resolveMssqlEndpoint(14330, { instanceName: "PROD", encrypt: true, trustServerCertificate: false }),
    { port: 14330 },
  );
  assert.deepEqual(
    resolveMssqlEndpoint(undefined, { instanceName: "PROD", encrypt: true, trustServerCertificate: false }),
    { instanceName: "PROD" },
  );
  assert.deepEqual(
    resolveMssqlEndpoint(undefined, { encrypt: true, trustServerCertificate: false }),
    { port: 1433 },
  );
});
