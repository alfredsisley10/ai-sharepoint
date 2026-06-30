import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildReferenceExport,
  parseReferenceImport,
  planMemoryImport,
  planPromptImport,
  exportLeakBlockers,
  isReferenceExportSchema,
  REFERENCE_EXPORT_SCHEMA,
} from "../src/context/referenceExport";
import { ContextSource, ContextBookmark } from "../src/context/types";
import { MemoryItem, MemoryScope, MemoryScopeKind } from "../src/context/memory";
import { PromptItem, PromptScope, PromptScopeKind } from "../src/context/promptLibrary";
import { scanForLeaks } from "../src/diagnostics/bundle";

const T0 = "2026-06-11T12:00:00.000Z";

function sources(): ContextSource[] {
  return [
    {
      id: "s1",
      type: "confluence",
      displayName: "Corp Wiki",
      alias: "Wiki",
      description: "Engineering knowledge base",
      baseUrl: "https://confluence.corp.example",
      deployment: "datacenter",
      authMethod: "pat",
      addedAt: T0,
      account: "jdoe", // must NOT be exported
      lastVerifiedAt: T0, // must NOT be exported
    },
    {
      id: "s2",
      type: "ldap",
      displayName: "Corp AD",
      baseUrl: "ldaps://gc1.corp.example:3269",
      baseDn: "DC=corp,DC=example",
      deployment: "datacenter",
      authMethod: "ldap-simple",
      addedAt: T0,
    },
  ];
}

function bookmarks(): ContextBookmark[] {
  return [
    { id: "b1", sourceId: "s1", name: "Release docs", locator: 'siteSearch ~ "release"', kind: "query" },
    { id: "b2", sourceId: "gone", name: "Orphan", locator: "x", kind: "query" },
  ];
}

test("export contains exactly the allowlisted fields — no ids/accounts/secrets", () => {
  const exp = buildReferenceExport(sources(), bookmarks(), T0);
  assert.equal(exp.$schema, REFERENCE_EXPORT_SCHEMA);
  for (const s of exp.sources) {
    const keys = Object.keys(s).sort();
    for (const forbidden of ["id", "account", "lastVerifiedAt", "secret", "username", "addedAt"]) {
      assert.ok(!keys.includes(forbidden), `forbidden key ${forbidden}`);
    }
  }
  const json = JSON.stringify(exp);
  assert.ok(!json.includes("jdoe"));
  // Defense-in-depth: serialized export passes the credential leak scan.
  const blockers = scanForLeaks(json).filter((f) => f.severity === "block");
  assert.deepEqual(blockers, []);
});

test("orphan bookmarks are excluded from export", () => {
  const exp = buildReferenceExport(sources(), bookmarks(), T0);
  assert.equal(exp.bookmarks.length, 1);
  assert.equal(exp.bookmarks[0].source, "Corp Wiki");
});

test("round-trip: export → import regenerates ids and remaps bookmarks", () => {
  const schemaFixture = {
    catalog: { fetchedAt: T0, engine: "mssql" as const, database: "CMDB", tables: [{ name: "Applications", kind: "table" as const, columns: [] }] },
    semanticState: "indexed" as const,
  };
  const exp = buildReferenceExport(
    sources(),
    bookmarks(),
    T0,
    new Map([["s1", schemaFixture]]),
  );
  assert.ok(exp.schemas && exp.schemas["Corp Wiki"]);
  let n = 0;
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => `new-${n++}`);
  assert.equal(parsed.sources.length, 2);
  assert.equal(parsed.bookmarks.length, 1);
  assert.equal(parsed.sources[0].id, "new-0");
  assert.equal(parsed.bookmarks[0].sourceId, parsed.sources[0].id);
  assert.equal(parsed.sources[0].account, undefined); // recipients re-verify
  assert.equal(parsed.sources[0].lastVerifiedAt, undefined);
  assert.deepEqual(parsed.warnings, []);
  // Alias + description travel with the config so the whole team can say
  // "…in the Wiki" — and the LDAP source without them stays clean.
  assert.equal(parsed.sources[0].alias, "Wiki");
  assert.equal(parsed.sources[0].description, "Engineering knowledge base");
  assert.equal(parsed.sources[1].alias, undefined);
  // The schema index travels too, remapped to the regenerated id.
  assert.equal(parsed.schemas.length, 1);
  assert.equal(parsed.schemas[0].sourceId, parsed.sources[0].id);
  assert.equal(parsed.schemas[0].schema.catalog.database, "CMDB");
});

test("projects travel with the export: memberships remapped, unknown members dropped", () => {
  const exp = buildReferenceExport(sources(), bookmarks(), T0, undefined, [
    {
      id: "p1",
      name: "AI Automation",
      description: "Initiative scope",
      goals: "Build a knowledge base",
      instructions: "Prefer the Wiki; cite pages.",
      aiContext: "- the user answers in German",
      sourceIds: ["s1", "ghost"],
    },
  ]);
  assert.equal(exp.projects?.[0].name, "AI Automation");
  assert.equal(exp.projects?.[0].goals, "Build a knowledge base");
  assert.equal(exp.projects?.[0].aiContext, "- the user answers in German");
  assert.deepEqual(exp.projects?.[0].sources, ["Corp Wiki"]); // ghost dropped
  let n = 0;
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => `new-${n++}`);
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.projects[0].name, "AI Automation");
  assert.equal(parsed.projects[0].instructions, "Prefer the Wiki; cite pages.");
  assert.equal(parsed.projects[0].goals, "Build a knowledge base");
  assert.equal(parsed.projects[0].aiContext, "- the user answers in German");
  assert.deepEqual(parsed.projects[0].sourceIds, [parsed.sources[0].id]);
});

test("import drops duplicate aliases within a file (first wins) with a warning", () => {
  const doc = {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt: T0,
    notice: "",
    sources: [
      { type: "mssql", displayName: "CMDB primary", alias: "CMDB", baseUrl: "mssql://a/CMDB", deployment: "datacenter", authMethod: "basic" },
      { type: "mssql", displayName: "CMDB replica", alias: "cmdb", baseUrl: "mssql://b/CMDB", deployment: "datacenter", authMethod: "basic" },
    ],
    bookmarks: [],
  };
  const parsed = parseReferenceImport(JSON.stringify(doc), T0, () => crypto.randomUUID());
  assert.equal(parsed.sources[0].alias, "CMDB");
  assert.equal(parsed.sources[1].alias, undefined);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /Duplicate alias/);
});

test("import rejects wrong schema and bad JSON", () => {
  assert.throws(() => parseReferenceImport("{not json", T0, () => "x"), /Not valid JSON/);
  assert.throws(
    () => parseReferenceImport(JSON.stringify({ $schema: "other" }), T0, () => "x"),
    /reference-config/,
  );
});

test("reference-config is portable across white-labeled builds (neutral + legacy brand-prefixed $schema)", () => {
  // The neutral id contains no brand token, so every build emits the same one.
  assert.equal(REFERENCE_EXPORT_SCHEMA, "reference-config/v1");
  // Accept the neutral id and any legacy/other-brand "<kebab>/reference-config/v1".
  for (const ok of [
    "reference-config/v1",
    "ai-sharepoint/reference-config/v1", // original build
    "contoso-docs/reference-config/v1", // a white-label
    "northwind-portal/reference-config/v1", // another white-label
  ]) {
    assert.ok(isReferenceExportSchema(ok), `should accept ${ok}`);
  }
  for (const bad of ["other", "reference-config/v2", "x/reference-config", undefined, 42]) {
    assert.ok(!isReferenceExportSchema(bad), `should reject ${String(bad)}`);
  }
  // A file exported by a *different* white-label imports successfully here.
  let n = 0;
  const doc = {
    $schema: "contoso-docs/reference-config/v1",
    exportedAt: T0,
    notice: "",
    sources: [{ type: "jira", displayName: "J", baseUrl: "https://j.example", deployment: "cloud", authMethod: "basic" }],
    bookmarks: [],
  };
  const parsed = parseReferenceImport(JSON.stringify(doc), T0, () => `id-${n++}`);
  assert.equal(parsed.sources.length, 1, "cross-brand reference-config imported");
});

test("export gate allows a real SharePoint site URL but still blocks genuine secrets", () => {
  // Regression: a managed-site export carries the real `*.sharepoint.com` URL —
  // that's the payload the recipient connects to, NOT a leak. The gate must let
  // it through (the raw-tenant-host rule guards telemetry, a different path).
  const ok = buildReferenceExport([], [], T0, undefined, undefined, [
    { siteUrl: "https://contoso.sharepoint.com/sites/intra", displayName: "Intranet", role: "managed" },
  ]);
  assert.deepEqual(exportLeakBlockers(JSON.stringify(ok)), [], "site URL alone is not a blocker");
  // But an actual secret (an email here) still stops the write.
  const leaky = { ...ok, notice: "ping me at admin@contoso.com" };
  assert.ok(exportLeakBlockers(JSON.stringify(leaky)).includes("email-address"), "real secrets still block");
});

test("export/import round-trips managed sites — secret-free (URL, title, role only)", () => {
  const exp = buildReferenceExport([], [], T0, undefined, undefined, [
    { siteUrl: "https://contoso.sharepoint.com/sites/intra", displayName: "Intranet", role: "managed" },
    { siteUrl: "https://contoso.sharepoint.com/sites/hr/", displayName: "HR", role: "reference" },
  ]);
  assert.equal(exp.sites?.length, 2);
  // No credential/account/handle fields — only the allowlisted three.
  assert.deepEqual(Object.keys(exp.sites![0]).sort(), ["displayName", "role", "siteUrl"]);
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => "x");
  assert.equal(parsed.sites.length, 2);
  assert.equal(parsed.sites[0].siteUrl, "https://contoso.sharepoint.com/sites/intra");
  assert.equal(parsed.sites[1].siteUrl, "https://contoso.sharepoint.com/sites/hr", "trailing slash normalized");
  assert.equal(parsed.sites[1].role, "reference");
});

test("import skips malformed/invalid sites and dedupes by URL", () => {
  const doc = {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt: T0,
    notice: "",
    sources: [],
    bookmarks: [],
    sites: [
      { siteUrl: "https://a.sharepoint.com/sites/x", displayName: "X", role: "managed" },
      { siteUrl: "https://a.sharepoint.com/sites/x/", displayName: "X dup", role: "managed" }, // dup after normalize
      { siteUrl: "not a url", displayName: "Bad URL", role: "managed" },
      { siteUrl: "https://b.com", displayName: "Bad role", role: "owner" },
    ],
  };
  const parsed = parseReferenceImport(JSON.stringify(doc), T0, () => "x");
  assert.equal(parsed.sites.length, 1, "one valid, deduped site");
  assert.equal(parsed.sites[0].displayName, "X");
  assert.ok(parsed.warnings.length >= 2, "malformed entries warned");
});

const SITE_URL = "https://contoso.sharepoint.com/sites/intra";
function memItems(): MemoryItem[] {
  return [
    { id: "m1", scope: { kind: "source", key: "s1" }, title: "Soft deletes", text: "Rows use is_active, not DELETE.", origin: "user", createdAt: T0, updatedAt: T0 },
    { id: "m2", scope: { kind: "site", key: SITE_URL }, title: "Owners", text: "Owned by the Platform team.", tags: ["ownership"], origin: "ai", createdAt: T0, updatedAt: T0 },
  ];
}

test("memory round-trips: source notes re-key to displayName, site notes keep the URL", () => {
  const exp = buildReferenceExport(
    sources(),
    [],
    T0,
    undefined,
    undefined,
    [{ siteUrl: SITE_URL, displayName: "Intranet", role: "managed" }],
    memItems(),
  );
  assert.equal(exp.memory?.length, 2);
  const src = exp.memory!.find((m) => m.scopeKind === "source")!;
  assert.equal(src.scopeRef, "Corp Wiki", "source memory re-keyed to displayName (ids never travel)");
  const site = exp.memory!.find((m) => m.scopeKind === "site")!;
  assert.equal(site.scopeRef, SITE_URL);
  assert.equal(site.origin, "ai");
  assert.deepEqual(site.tags, ["ownership"]);
  // Secret-free: memory text passes the export gate like the rest of the file
  // (the site URL it contains is intended payload, not a leak).
  assert.deepEqual(exportLeakBlockers(JSON.stringify(exp)), []);
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => "x");
  assert.equal(parsed.memory.length, 2);
  assert.equal(parsed.memory.find((m) => m.scopeKind === "source")!.scopeRef, "Corp Wiki");
});

test("source memory exports via the all-sources name map even when its source descriptor isn't included", () => {
  // Export only s2; m1 references s1 (not exported) — the name map resolves it.
  const withMap = buildReferenceExport([sources()[1]], [], T0, undefined, undefined, undefined, memItems(), new Map([["s1", "Corp Wiki"], ["s2", "Corp AD"]]));
  assert.equal(withMap.memory?.length, 2);
  assert.ok(withMap.memory!.some((m) => m.scopeKind === "source" && m.scopeRef === "Corp Wiki"));
  // Without the map (and s1 absent), the dangling source note is dropped; the site note stays.
  const noMap = buildReferenceExport([sources()[1]], [], T0, undefined, undefined, undefined, memItems());
  assert.equal(noMap.memory?.length, 1);
  assert.equal(noMap.memory?.[0].scopeKind, "site");
});

test("planMemoryImport resolves refs, mints ids, and reports unresolved", () => {
  const parsedMem = [
    { scopeKind: "site" as MemoryScopeKind, scopeRef: SITE_URL, title: "Owners", text: "Platform team.", origin: "user" as const },
    { scopeKind: "source" as MemoryScopeKind, scopeRef: "Corp Wiki", title: "Soft deletes", text: "is_active.", origin: "user" as const },
    { scopeKind: "source" as MemoryScopeKind, scopeRef: "Unknown Src", title: "Orphan", text: "x", origin: "user" as const },
  ];
  const resolve = (kind: MemoryScopeKind, ref: string): MemoryScope | undefined => {
    if (kind === "site" && ref === SITE_URL) return { kind: "site", key: SITE_URL };
    if (kind === "source" && ref === "Corp Wiki") return { kind: "source", key: "local-s1" };
    return undefined;
  };
  let n = 0;
  const plan = planMemoryImport(parsedMem, resolve, [], () => `nm-${n++}`, T0);
  assert.equal(plan.toAdd.length, 2);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].scopeRef, "Unknown Src");
  assert.equal(plan.toAdd[0].scope.key, SITE_URL);
  assert.equal(plan.toAdd[1].scope.key, "local-s1");
  assert.equal(plan.toAdd[0].createdAt, T0);
});

test("planMemoryImport: identical → duplicate; same-title-different → rule merge; within-batch merges", () => {
  const resolve = (kind: MemoryScopeKind): MemoryScope | undefined => ({ kind, key: "local-s1" });
  const existing: MemoryItem[] = [
    { id: "e1", scope: { kind: "source", key: "local-s1" }, title: "Soft deletes", text: "Rows use is_active.", tags: ["db"], origin: "user", createdAt: T0, updatedAt: T0 },
    { id: "e2", scope: { kind: "source", key: "local-s1" }, title: "Owners", text: "Platform team.", origin: "user", createdAt: T0, updatedAt: T0 },
  ];
  const incoming = [
    { scopeKind: "source" as MemoryScopeKind, scopeRef: "Corp Wiki", title: "Soft deletes", text: "Rows use is_active.", tags: ["db"], origin: "user" as const }, // identical → duplicate
    { scopeKind: "source" as MemoryScopeKind, scopeRef: "Corp Wiki", title: "Owners", text: "Also notify SecOps.", origin: "user" as const }, // conflict → merge
    { scopeKind: "source" as MemoryScopeKind, scopeRef: "Corp Wiki", title: "Keys", text: "a", origin: "user" as const }, // new → add
    { scopeKind: "source" as MemoryScopeKind, scopeRef: "Corp Wiki", title: "keys", text: "b", origin: "user" as const }, // within-batch → merges into "Keys"
  ];
  let n = 0;
  const plan = planMemoryImport(incoming, resolve, existing, () => `nm-${n++}`, T0);
  assert.equal(plan.duplicates, 1, "the identical note is a pure duplicate");
  assert.equal(plan.toMerge.length, 1, "the differing 'Owners' note merges");
  assert.equal(plan.toMerge[0].existing.id, "e2");
  assert.match(plan.toMerge[0].merged.text, /Platform team\./);
  assert.match(plan.toMerge[0].merged.text, /Also notify SecOps\./);
  assert.equal(plan.toAdd.length, 1, "one new 'Keys' note");
  assert.equal(plan.toAdd[0].title, "Keys");
  assert.match(plan.toAdd[0].text, /a\n\nb/, "the within-batch 'keys' merged into it");
});

test("import parses and clamps memory notes; malformed ones are skipped with a warning", () => {
  const doc = {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt: T0,
    notice: "",
    sources: [],
    bookmarks: [],
    memory: [
      { scopeKind: "site", scopeRef: SITE_URL + "/", title: "  Owners  ", text: "Platform.", origin: "ai" },
      { scopeKind: "source", scopeRef: "Corp Wiki", title: "X", text: "y", origin: "weird" }, // bad origin → user
      { scopeKind: "nope", scopeRef: "z", title: "T", text: "t", origin: "user" }, // bad kind → skipped
      { scopeKind: "site", scopeRef: "u", title: "", text: "t", origin: "user" }, // empty title → skipped
    ],
  };
  const parsed = parseReferenceImport(JSON.stringify(doc), T0, () => "x");
  assert.equal(parsed.memory.length, 2);
  assert.equal(parsed.memory[0].scopeRef, SITE_URL, "trailing slash normalized on site ref");
  assert.equal(parsed.memory[0].title, "Owners", "title trimmed");
  assert.equal(parsed.memory[1].origin, "user", "unknown origin coerced to user");
  assert.ok(parsed.warnings.some((w) => /memory note/i.test(w)));
});

function promptItems(): PromptItem[] {
  return [
    { id: "g1", scope: { kind: "global" }, title: "Exec summary", body: "Summarize for execs.", createdAt: T0, updatedAt: T0 },
    { id: "s1", scope: { kind: "source", key: "s1" }, title: "Bug triage", body: "Group open bugs by severity.", tags: ["triage"], createdAt: T0, updatedAt: T0 },
    { id: "p1", scope: { kind: "project", key: "proj-1" }, title: "Kickoff", body: "Draft a kickoff agenda.", createdAt: T0, updatedAt: T0 },
  ];
}

test("prompts round-trip: global carries no ref; source/project re-key to names", () => {
  const exp = buildReferenceExport(
    sources(),
    [],
    T0,
    undefined,
    [{ id: "proj-1", name: "AI Automation", sourceIds: ["s1"] }],
    undefined,
    undefined,
    undefined,
    promptItems(),
    new Map([["proj-1", "AI Automation"]]),
  );
  assert.equal(exp.prompts?.length, 3);
  const g = exp.prompts!.find((p) => p.scopeKind === "global")!;
  assert.equal(g.scopeRef, undefined, "global prompt carries no ref");
  assert.equal(exp.prompts!.find((p) => p.scopeKind === "source")!.scopeRef, "Corp Wiki");
  assert.equal(exp.prompts!.find((p) => p.scopeKind === "project")!.scopeRef, "AI Automation");
  assert.deepEqual(exportLeakBlockers(JSON.stringify(exp)), []);
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => "x");
  assert.equal(parsed.prompts.length, 3);
  assert.equal(parsed.prompts.find((p) => p.scopeKind === "global")!.scopeRef, undefined);
});

test("a project-scoped prompt is dropped if the project can't be named", () => {
  // No project name map and the project isn't in the (empty) projects arg → dropped.
  const exp = buildReferenceExport(sources(), [], T0, undefined, undefined, undefined, undefined, undefined, promptItems());
  // global + source survive (source re-keys via byId); project drops.
  assert.equal(exp.prompts?.length, 2);
  assert.ok(!exp.prompts!.some((p) => p.scopeKind === "project"));
});

test("planPromptImport: global always resolves; scoped resolves or is unresolved; within-batch same-title merges", () => {
  const parsedPrompts = [
    { scopeKind: "global" as PromptScopeKind, title: "Exec summary", body: "x" },
    { scopeKind: "source" as PromptScopeKind, scopeRef: "Corp Wiki", title: "Bug triage", body: "y" },
    { scopeKind: "project" as PromptScopeKind, scopeRef: "Unknown Proj", title: "Z", body: "z" },
    { scopeKind: "global" as PromptScopeKind, title: "Exec Summary", body: "different body (case-folded title)" },
  ];
  const resolve = (kind: PromptScopeKind, ref?: string): PromptScope | undefined => {
    if (kind === "global") return { kind: "global" };
    if (kind === "source" && ref === "Corp Wiki") return { kind: "source", key: "local-s1" };
    return undefined;
  };
  let n = 0;
  const plan = planPromptImport(parsedPrompts, resolve, [], () => `np-${n++}`, T0);
  // global "Exec summary" + source "Bug triage" are added; the 2nd "Exec Summary"
  // (different body) merges into the first within the same batch (no existing store).
  assert.equal(plan.toAdd.length, 2, "global + source added");
  assert.equal(plan.duplicates, 0);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].scopeRef, "Unknown Proj");
  const exec = plan.toAdd.find((p) => p.scope.kind === "global")!;
  assert.match(exec.body, /x\n\ndifferent body/, "within-batch bodies combined losslessly");
  assert.equal(plan.toAdd.find((p) => p.scope.kind === "source")!.scope.key, "local-s1");
});

test("planPromptImport: identical existing prompt is a pure duplicate; differing one merges", () => {
  const resolve = (_kind: PromptScopeKind): PromptScope | undefined => ({ kind: "global" });
  const existing: PromptItem[] = [
    { id: "g1", scope: { kind: "global" }, title: "Exec summary", body: "Summarize for execs.", createdAt: T0, updatedAt: T0 },
    { id: "g2", scope: { kind: "global" }, title: "Triage", body: "By severity.", createdAt: T0, updatedAt: T0 },
  ];
  const incoming = [
    { scopeKind: "global" as PromptScopeKind, title: "Exec summary", body: "Summarize for execs." }, // identical → duplicate
    { scopeKind: "global" as PromptScopeKind, title: "Triage", body: "Also by component." }, // conflict → merge
  ];
  const plan = planPromptImport(incoming, resolve, existing, () => "np", T0);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.toMerge.length, 1);
  assert.equal(plan.toMerge[0].existing.id, "g2");
  assert.match(plan.toMerge[0].merged.body, /By severity\.\n\nAlso by component\./);
});

test("import parses prompts and clamps/validates; bad kinds and empty bodies are skipped", () => {
  const doc = {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt: T0,
    notice: "",
    sources: [],
    bookmarks: [],
    prompts: [
      { scopeKind: "global", title: "  Keep  ", body: "ok" },
      { scopeKind: "site", scopeRef: "https://x/", title: "Sited", body: "b" },
      { scopeKind: "source", title: "No ref", body: "b" }, // scoped without ref → skipped
      { scopeKind: "nope", title: "Bad kind", body: "b" }, // bad kind → skipped
      { scopeKind: "global", title: "", body: "b" }, // empty title → skipped
    ],
  };
  const parsed = parseReferenceImport(JSON.stringify(doc), T0, () => "x");
  assert.equal(parsed.prompts.length, 2);
  assert.equal(parsed.prompts[0].title, "Keep");
  assert.equal(parsed.prompts[0].scopeRef, undefined, "global keeps no ref");
  assert.equal(parsed.prompts[1].scopeRef, "https://x", "site ref trailing slash normalized");
  assert.ok(parsed.warnings.some((w) => /prompt/i.test(w)));
});

test("import skips malformed entries with warnings, keeps valid ones", () => {
  const doc = {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt: T0,
    notice: "",
    sources: [
      { type: "jira", displayName: "J", baseUrl: "https://j.example", deployment: "cloud", authMethod: "basic" },
      { type: "ldap", displayName: "No DN", baseUrl: "ldaps://x", deployment: "datacenter", authMethod: "ldap-simple" },
      { type: "nope", displayName: "Bad" },
    ],
    bookmarks: [
      { source: "J", name: "Open bugs", locator: "type = Bug", kind: "query" },
      { source: "Missing", name: "X", locator: "y", kind: "query" },
      { source: "J", name: "Bad kind", locator: "z", kind: "wat" },
    ],
  };
  let n = 0;
  const parsed = parseReferenceImport(JSON.stringify(doc), T0, () => `id-${n++}`);
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.bookmarks.length, 1);
  assert.equal(parsed.warnings.length, 4); // ldap w/o baseDn, bad type, missing source, bad kind
});
