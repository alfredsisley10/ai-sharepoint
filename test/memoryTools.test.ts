import { test } from "node:test";
import * as assert from "node:assert/strict";
import { resolveMemoryTarget } from "../src/context/memory";
import { ContextSource } from "../src/context/types";
import { SiteConnection } from "../src/auth/sitesStore";

const sources = [
  { id: "src-1", displayName: "CMDB", alias: "cmdb", type: "postgres" } as ContextSource,
  { id: "src-2", displayName: "Jira Cloud", type: "jira" } as ContextSource,
];
const sites = [
  { siteUrl: "https://contoso.sharepoint.com/sites/intra", displayName: "Intranet", role: "managed" } as SiteConnection,
];

test("resolveMemoryTarget matches a source by alias or display name (case-insensitive)", () => {
  assert.deepEqual(resolveMemoryTarget("cmdb", sources, sites)?.scope, { kind: "source", key: "src-1" });
  assert.deepEqual(resolveMemoryTarget("CMDB", sources, sites)?.scope, { kind: "source", key: "src-1" });
  assert.deepEqual(resolveMemoryTarget("jira cloud", sources, sites)?.scope, { kind: "source", key: "src-2" });
});

test("resolveMemoryTarget matches a site by title or URL (trailing slash tolerant)", () => {
  assert.deepEqual(resolveMemoryTarget("Intranet", sources, sites)?.scope, { kind: "site", key: "https://contoso.sharepoint.com/sites/intra" });
  assert.deepEqual(
    resolveMemoryTarget("https://contoso.sharepoint.com/sites/intra/", sources, sites)?.scope,
    { kind: "site", key: "https://contoso.sharepoint.com/sites/intra" },
  );
});

test("resolveMemoryTarget returns undefined for an unknown/empty target (tool then lists options)", () => {
  assert.equal(resolveMemoryTarget("nope", sources, sites), undefined);
  assert.equal(resolveMemoryTarget("  ", sources, sites), undefined);
});
