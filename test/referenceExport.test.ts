import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildReferenceExport,
  parseReferenceImport,
  REFERENCE_EXPORT_SCHEMA,
} from "../src/context/referenceExport";
import { ContextSource, ContextBookmark } from "../src/context/types";
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
      instructions: "Prefer the Wiki; cite pages.",
      sourceIds: ["s1", "ghost"],
    },
  ]);
  assert.equal(exp.projects?.[0].name, "AI Automation");
  assert.deepEqual(exp.projects?.[0].sources, ["Corp Wiki"]); // ghost dropped
  let n = 0;
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => `new-${n++}`);
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.projects[0].name, "AI Automation");
  assert.equal(parsed.projects[0].instructions, "Prefer the Wiki; cite pages.");
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
