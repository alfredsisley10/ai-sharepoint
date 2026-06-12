import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  resolveSourceRef,
  aliasIssue,
  normalizeAlias,
  sourceChatLabel,
  ALIAS_MAX_LENGTH,
} from "../src/context/sourceRef";
import { ContextSource } from "../src/context/types";

const T0 = "2026-06-11T12:00:00.000Z";

function src(partial: Partial<ContextSource> & Pick<ContextSource, "id" | "displayName">): ContextSource {
  return {
    type: "mssql",
    baseUrl: "mssql://host/db",
    deployment: "datacenter",
    authMethod: "basic",
    addedAt: T0,
    ...partial,
  };
}

const fleet: ContextSource[] = [
  src({ id: "a", displayName: "sqlcmdb01.corp.example (mssql)", alias: "CMDB", description: "ServiceNow CMDB replica" }),
  src({ id: "b", displayName: "Corp Wiki", type: "confluence", alias: "Wiki" }),
  src({ id: "c", displayName: "HR database", alias: "HR DB" }),
  src({ id: "d", displayName: "Tracker", type: "jira" }),
];

test("resolution priority: id → alias → display name → type", () => {
  assert.equal(resolveSourceRef(fleet, "a")?.id, "a");
  assert.equal(resolveSourceRef(fleet, "CMDB")?.id, "a");
  assert.equal(resolveSourceRef(fleet, "cmdb")?.id, "a"); // case-insensitive
  assert.equal(resolveSourceRef(fleet, "Corp Wiki")?.id, "b");
  assert.equal(resolveSourceRef(fleet, "jira")?.id, "d");
});

test("the user's phrase resolves when it mentions an alias — the CMDB scenario", () => {
  // "@sharepoint find information about application X in the CMDB database"
  // → a model may pass the phrase fragment instead of the bare alias.
  assert.equal(resolveSourceRef(fleet, "the CMDB database")?.id, "a");
  assert.equal(resolveSourceRef(fleet, "CMDB database")?.id, "a");
  // Multi-word aliases too.
  assert.equal(resolveSourceRef(fleet, "look in HR DB please")?.id, "c");
});

test("alias mention requires word boundaries — short aliases stay safe", () => {
  const tricky = [src({ id: "x", displayName: "Ops", alias: "DB" })];
  assert.equal(resolveSourceRef(tricky, "database")?.id, undefined); // "DB" ⊄ "database"
  assert.equal(resolveSourceRef(tricky, "the DB please")?.id, "x");
});

test("no reference: only a sole source resolves; substring of display name still works", () => {
  assert.equal(resolveSourceRef(fleet, undefined), undefined);
  assert.equal(resolveSourceRef([fleet[0]], undefined)?.id, "a");
  assert.equal(resolveSourceRef(fleet, "sqlcmdb01")?.id, "a");
});

test("aliasIssue: uniqueness is case-insensitive, excluding the source being edited", () => {
  assert.match(aliasIssue("cmdb", fleet) ?? "", /already the alias/);
  assert.equal(aliasIssue("cmdb", fleet, "a"), undefined); // editing CMDB's own source
  assert.equal(aliasIssue("ITSM", fleet), undefined);
  assert.match(aliasIssue("???", fleet) ?? "", /letter or digit/);
  assert.match(aliasIssue("x".repeat(ALIAS_MAX_LENGTH + 1), fleet) ?? "", /short/);
});

test("normalizeAlias trims, collapses whitespace, caps length", () => {
  assert.equal(normalizeAlias("  CMDB  "), "CMDB");
  assert.equal(normalizeAlias("HR   DB"), "HR DB");
  assert.equal(normalizeAlias("x".repeat(100)).length, ALIAS_MAX_LENGTH);
});

test("sourceChatLabel leads with the alias when present", () => {
  assert.equal(sourceChatLabel(fleet[0]), '"CMDB" — sqlcmdb01.corp.example (mssql) (mssql)');
  assert.equal(sourceChatLabel(fleet[3]), "Tracker (jira)");
});

test("site spec file paths: only lists/pages JSON, no traversal or absolutes", async () => {
  const { validateSiteFilePath } = await import("../src/chat/siteDevTools");
  assert.equal(validateSiteFilePath("lists/Projects.json"), undefined);
  assert.equal(validateSiteFilePath("pages/Home Page.json"), undefined);
  for (const bad of ["../evil.json", "/etc/passwd", "lists\\x.json", "scripts/run.json", "lists/x.exe", "lists/.hidden.json"]) {
    assert.ok(validateSiteFilePath(bad), bad);
  }
});
