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
  const exp = buildReferenceExport(sources(), bookmarks(), T0);
  let n = 0;
  const parsed = parseReferenceImport(JSON.stringify(exp), T0, () => `new-${n++}`);
  assert.equal(parsed.sources.length, 2);
  assert.equal(parsed.bookmarks.length, 1);
  assert.equal(parsed.sources[0].id, "new-0");
  assert.equal(parsed.bookmarks[0].sourceId, parsed.sources[0].id);
  assert.equal(parsed.sources[0].account, undefined); // recipients re-verify
  assert.equal(parsed.sources[0].lastVerifiedAt, undefined);
  assert.deepEqual(parsed.warnings, []);
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
