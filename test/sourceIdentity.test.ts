import { test } from "node:test";
import * as assert from "node:assert/strict";
import Module from "node:module";
import { ALIAS_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } from "../src/context/sourceRef";

// extensionHelpers imports the "vscode" host module at load time for its
// interactive helpers; buildSourceIdentitySeed itself is pure. Stub the module
// loader so the pure helper is testable outside the extension host. (Imports
// above this line must not pull in vscode; extensionHelpers is required AFTER
// the stub is installed.)
type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: LoadFn };
const originalLoad = moduleInternals._load;
moduleInternals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return {};
  return originalLoad.call(this, request, parent, isMain);
};

const { buildSourceIdentitySeed } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/extensionHelpers") as typeof import("../src/extensionHelpers");

test("confluence: write-scope space key drives name, alias, and description", () => {
  const seed = buildSourceIdentitySeed("confluence", "https://yourorg.atlassian.net/wiki", {
    spaceKey: "ENG",
  });
  assert.equal(seed.typeLabel, "Confluence");
  assert.equal(seed.displayName, "ENG · Confluence");
  assert.equal(seed.aliasSuggestion, "ENG");
  assert.equal(seed.description, "Confluence space ENG at yourorg.atlassian.net");
});

test("confluence: no space key falls back to the host, with no alias", () => {
  const seed = buildSourceIdentitySeed("confluence", "https://yourorg.atlassian.net/wiki");
  assert.equal(seed.displayName, "yourorg.atlassian.net · Confluence");
  assert.equal(seed.aliasSuggestion, undefined);
  assert.equal(seed.description, "Confluence at yourorg.atlassian.net");
});

test("jira: managed project key drives name and alias; reference falls back to host", () => {
  const managed = buildSourceIdentitySeed("jira", "https://yourorg.atlassian.net", {
    projectKey: "OPS",
  });
  assert.equal(managed.displayName, "OPS · Jira");
  assert.equal(managed.aliasSuggestion, "OPS");
  assert.equal(managed.description, "Jira project OPS at yourorg.atlassian.net");

  const reference = buildSourceIdentitySeed("jira", "https://yourorg.atlassian.net");
  assert.equal(reference.displayName, "yourorg.atlassian.net · Jira");
  assert.equal(reference.aliasSuggestion, undefined);
});

test("mssql: wizard host/database extras beat the noisy mssql:// URL", () => {
  const seed = buildSourceIdentitySeed(
    "mssql",
    "mssql://sqlserver.corp.example:1433/Sales?instance=PROD&trustServerCertificate=true",
    { host: "sqlserver.corp.example", database: "Sales" },
  );
  assert.equal(seed.typeLabel, "SQL Server");
  assert.equal(seed.displayName, "Sales @ sqlserver.corp.example");
  assert.equal(seed.aliasSuggestion, "Sales");
  assert.equal(seed.description, "SQL Server database Sales on sqlserver.corp.example");
});

test("postgres/mysql/mongodb: db name and host parse straight from the URL", () => {
  const pg = buildSourceIdentitySeed("postgres", "postgresql://pghost.corp.example:5432/mydb");
  assert.equal(pg.displayName, "mydb @ pghost.corp.example");
  assert.equal(pg.aliasSuggestion, "mydb");
  assert.equal(pg.description, "PostgreSQL database mydb on pghost.corp.example");

  const my = buildSourceIdentitySeed("mysql", "mysql://mysqlhost.corp.example:3306/shop?ssl=true");
  assert.equal(my.displayName, "shop @ mysqlhost.corp.example");
  assert.equal(my.aliasSuggestion, "shop");

  const mongo = buildSourceIdentitySeed("mongodb", "mongodb+srv://mongo.corp.example/inventory");
  assert.equal(mongo.displayName, "inventory @ mongo.corp.example");
  assert.equal(mongo.aliasSuggestion, "inventory");
  assert.equal(mongo.description, "MongoDB database inventory on mongo.corp.example");
});

test("servicenow: instance subdomain names it; default table lands in the description", () => {
  const seed = buildSourceIdentitySeed("servicenow", "https://acme.service-now.com?table=incident");
  assert.equal(seed.displayName, "acme · ServiceNow");
  assert.equal(seed.aliasSuggestion, undefined);
  assert.equal(seed.description, "ServiceNow instance at acme.service-now.com · default table: incident");

  // The threaded pick wins over what rides on the URL.
  const picked = buildSourceIdentitySeed("servicenow", "https://acme.service-now.com?table=incident", {
    defaultTable: "cmdb_ci",
  });
  assert.match(picked.description ?? "", /default table: cmdb_ci/);
});

test("splunk: host names it; app and default index land in the description", () => {
  const seed = buildSourceIdentitySeed(
    "splunk",
    "https://acme.splunkcloud.com:8089?app=lob_search&index=main",
    { app: "lob_search", index: "main" },
  );
  assert.equal(seed.displayName, "acme.splunkcloud.com · Splunk");
  assert.equal(seed.description, "Splunk at acme.splunkcloud.com · app: lob_search · default index: main");

  // Without extras the same facts are recovered from the stored baseUrl.
  const fromUrl = buildSourceIdentitySeed("splunk", "https://acme.splunkcloud.com:8089?app=lob_search&index=main");
  assert.equal(fromUrl.description, seed.description);
});

test("powerbi: picked dataset + workspace name it; bare connection stays 'Power BI'", () => {
  const seed = buildSourceIdentitySeed("powerbi", "https://api.powerbi.com/v1.0/myorg?dataset=guid", {
    datasetName: "Sales KPIs",
    workspaceName: "Finance",
  });
  assert.equal(seed.displayName, "Sales KPIs (Finance) · Power BI");
  assert.equal(seed.aliasSuggestion, "Sales KPIs");
  assert.equal(seed.description, 'Power BI dataset "Sales KPIs" in workspace "Finance"');

  const bare = buildSourceIdentitySeed("powerbi", "https://api.powerbi.com/v1.0/myorg");
  assert.equal(bare.displayName, "Power BI");
  assert.equal(bare.aliasSuggestion, undefined);
  assert.equal(bare.description, undefined);
});

test("splunkobs: the realm is parsed from the API host", () => {
  const seed = buildSourceIdentitySeed(
    "splunkobs",
    "https://api.us1.signalfx.com?web=https%3A%2F%2Fapp.us1.signalfx.com&type=metric",
  );
  assert.equal(seed.displayName, "us1 · Splunk Observability Cloud");
  assert.equal(seed.description, "Splunk Observability Cloud realm us1");
});

test("aternity: the account name is parsed from the OData host; default table lands in the description", () => {
  const seed = buildSourceIdentitySeed(
    "aternity",
    "https://us3-odata.aternity.com?web=https%3A%2F%2Fus3.aternity.com&table=HEALTH_EVENTS",
  );
  assert.equal(seed.displayName, "us3 · Riverbed Aternity");
  assert.equal(
    seed.description,
    "Riverbed Aternity end-user experience monitoring at us3-odata.aternity.com · default table: HEALTH_EVENTS",
  );
});

test("m365copilot: fixed name; surfaces land in the description", () => {
  const seed = buildSourceIdentitySeed(
    "m365copilot",
    "https://graph.microsoft.com/v1.0/copilot/retrieval?surfaces=sharePoint,message",
    { surfaces: ["sharePoint", "message"] },
  );
  assert.equal(seed.displayName, "Microsoft 365 Copilot");
  assert.equal(seed.description, "Microsoft 365 Copilot retrieval · surfaces: sharePoint, message");

  // Imported/edited sources rebuild the same seed from the baseUrl alone.
  const fromUrl = buildSourceIdentitySeed(
    "m365copilot",
    "https://graph.microsoft.com/v1.0/copilot/retrieval?surfaces=sharePoint,message",
  );
  assert.equal(fromUrl.description, seed.description);
});

test("github: host names it; deployment colors the description", () => {
  const ghes = buildSourceIdentitySeed("github", "https://github.corp.example", {
    deployment: "datacenter",
  });
  assert.equal(ghes.displayName, "github.corp.example · GitHub");
  assert.equal(ghes.description, "GitHub Enterprise Server at github.corp.example");

  const cloud = buildSourceIdentitySeed("github", "https://github.com", { deployment: "cloud" });
  assert.equal(cloud.displayName, "github.com · GitHub");
  assert.equal(cloud.description, "GitHub at github.com");
});

test("grafana: host names it; deployment colors the description", () => {
  const cloud = buildSourceIdentitySeed("grafana", "https://acme.grafana.net", { deployment: "cloud" });
  assert.equal(cloud.displayName, "acme.grafana.net · Grafana");
  assert.equal(cloud.description, "Grafana Cloud at acme.grafana.net");

  const dc = buildSourceIdentitySeed("grafana", "https://grafana.corp.example", {
    deployment: "datacenter",
  });
  assert.equal(dc.description, "Self-hosted Grafana at grafana.corp.example");
});

test("ldap: domain derives from the base DN (not the SRV lookup host); base DN in description", () => {
  const seed = buildSourceIdentitySeed("ldap", "ldaps+srv://_gc._tcp.corp.example", {
    baseDn: "DC=corp,DC=example",
  });
  assert.equal(seed.typeLabel, "LDAP / Active Directory");
  assert.equal(seed.displayName, "corp.example · LDAP / Active Directory");
  assert.equal(seed.description, "Active Directory / LDAP directory corp.example · base DN: DC=corp,DC=example");

  // Without a base DN the SRV prefix is stripped from the host.
  const noDn = buildSourceIdentitySeed("ldap", "ldaps+srv://_gc._tcp.corp.example");
  assert.equal(noDn.displayName, "corp.example · LDAP / Active Directory");
});

test("alias suggestion falls back to none when the token fails alias validation", () => {
  // No letter/digit → aliasIssue rejects it, so no suggestion (name still forms).
  const symbols = buildSourceIdentitySeed("postgres", "postgresql://h.example/%2A%2A%2A");
  assert.equal(symbols.displayName, "*** @ h.example");
  assert.equal(symbols.aliasSuggestion, undefined);

  // Over the alias length cap → rejected too.
  const long = buildSourceIdentitySeed("mssql", "mssql://h.example/db", {
    host: "h.example",
    database: "x".repeat(ALIAS_MAX_LENGTH + 1),
  });
  assert.equal(long.aliasSuggestion, undefined);
});

test("composed descriptions never exceed DESCRIPTION_MAX_LENGTH", () => {
  const seed = buildSourceIdentitySeed("ldap", "ldaps://dc01.corp.example", {
    baseDn: `OU=${"very-long-".repeat(30)}unit,DC=corp,DC=example`,
  });
  assert.ok((seed.description ?? "").length <= DESCRIPTION_MAX_LENGTH);
  assert.ok((seed.description ?? "").length > 0);
});
