import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  groupSourcesByType,
  groupFiles,
  groupReferenceSites,
  isSourceGroup,
} from "../src/ui/sourceGrouping";
import { ContextSource } from "../src/context/types";
import { SiteConnection } from "../src/auth/sitesStore";
import { FileSource } from "../src/context/files/fileSources";

const T0 = "2026-07-01T12:00:00.000Z";

function src(
  partial: Partial<ContextSource> & Pick<ContextSource, "id" | "displayName" | "type">,
): ContextSource {
  return {
    baseUrl: "https://example/",
    deployment: "cloud",
    authMethod: "basic",
    addedAt: T0,
    ...partial,
  };
}

function site(partial: Partial<SiteConnection> & Pick<SiteConnection, "siteUrl">): SiteConnection {
  return {
    displayName: partial.siteUrl,
    role: "reference",
    authProviderId: "aad",
    cacheHandle: "h",
    tenantHost: "contoso.sharepoint.com",
    ...partial,
  };
}

function file(id: string, kind: FileSource["kind"]): FileSource {
  return { id, label: `${id}.${kind}`, kind, location: { kind: "local", path: `/tmp/${id}` }, addedAt: T0 };
}

test("groupSourcesByType: a lone source of a type stays at the top level (no nesting)", () => {
  const out = groupSourcesByType([
    src({ id: "a", displayName: "Corp Wiki", type: "confluence" }),
    src({ id: "b", displayName: "Tracker", type: "jira" }),
  ]);
  assert.equal(out.length, 2);
  assert.ok(!out.some(isSourceGroup), "singletons must not be wrapped in a group");
});

test("groupSourcesByType: folds MORE THAN ONE same-type source under a group", () => {
  const out = groupSourcesByType([
    src({ id: "a", displayName: "SN Prod", type: "servicenow" }),
    src({ id: "b", displayName: "Corp Wiki", type: "confluence" }),
    src({ id: "c", displayName: "SN Dev", type: "servicenow" }),
  ]);
  assert.equal(out.length, 2); // servicenow (2) group + lone confluence
  const group = out.find(isSourceGroup);
  assert.ok(group, "the two ServiceNow sources should be grouped");
  assert.equal(group!.label, "ServiceNow (2)");
  assert.equal(group!.id, "group:type:servicenow");
  assert.equal(group!.children.length, 2);
  assert.ok(out.some((n) => !isSourceGroup(n)), "the lone Confluence source stays ungrouped");
});

test("groupSourcesByType: group order follows first appearance; members keep store order", () => {
  const out = groupSourcesByType([
    src({ id: "j1", displayName: "Jira A", type: "jira" }),
    src({ id: "s1", displayName: "SN A", type: "servicenow" }),
    src({ id: "j2", displayName: "Jira B", type: "jira" }),
    src({ id: "s2", displayName: "SN B", type: "servicenow" }),
  ]);
  assert.deepEqual(out.map((n) => (isSourceGroup(n) ? n.label : "leaf")), ["Jira (2)", "ServiceNow (2)"]);
  const jira = out[0];
  assert.ok(isSourceGroup(jira));
  assert.deepEqual((jira as { children: ContextSource[] }).children.map((s) => s.id), ["j1", "j2"]);
});

test("groupFiles: one file stays flat; MORE THAN ONE folds under a Files group", () => {
  assert.deepEqual(groupFiles([]), []);
  const one = groupFiles([file("a", "pdf")]);
  assert.equal(one.length, 1);
  assert.ok(!isSourceGroup(one[0]));

  const many = groupFiles([file("a", "pdf"), file("b", "xlsx"), file("c", "csv")]);
  assert.equal(many.length, 1);
  assert.ok(isSourceGroup(many[0]));
  assert.equal((many[0] as { label: string }).label, "Files (3)");
  assert.equal((many[0] as { id: string }).id, "group:files");
  assert.equal((many[0] as { children: unknown[] }).children.length, 3);
});

test("groupReferenceSites: 0 or 1 site is not grouped; 2+ fold under one header", () => {
  assert.deepEqual(groupReferenceSites([]), []);
  const one = groupReferenceSites([site({ siteUrl: "https://c.sharepoint.com/sites/A" })]);
  assert.equal(one.length, 1);
  assert.ok(!isSourceGroup(one[0]));

  const many = groupReferenceSites([
    site({ siteUrl: "https://c.sharepoint.com/sites/A" }),
    site({ siteUrl: "https://c.sharepoint.com/sites/B" }),
  ]);
  assert.equal(many.length, 1);
  assert.ok(isSourceGroup(many[0]));
  assert.equal((many[0] as { label: string }).label, "SharePoint sites (2)");
});

test("isSourceGroup does not misclassify a FileSource (whose .kind is a FileKind)", () => {
  assert.equal(isSourceGroup(file("a", "pdf")), false);
  assert.equal(isSourceGroup(site({ siteUrl: "https://x" })), false);
});
