import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  sanitizeForSnapshot,
  stableStringify,
  slugify,
} from "../src/sync/snapshotSanitize";
import { serializeSite, SiteSnapshotInput, MANAGED_PATH } from "../src/sync/serializer";
import {
  buildChangeReport,
  isBlocked,
  hasChanges,
  commitMessageFor,
} from "../src/sync/changeReport";
import {
  parseRemoteUrl,
  validateRemote,
  compareUrl,
  prBranchName,
  repoHygieneFiles,
} from "../src/sync/remotePolicy";

function input(): SiteSnapshotInput {
  return {
    site: {
      id: "s1",
      displayName: "Marketing",
      webUrl: "https://contoso.sharepoint.com/sites/Marketing",
      description: "Team site",
    },
    lists: [
      { id: "l2", displayName: "Zeta Docs", template: "documentLibrary", columns: [{ name: "Title" }] },
      { id: "l1", displayName: "Announcements", columns: [{ name: "Title", "createdDateTime": "x" }] },
    ],
    pages: [
      { id: "p2", title: "Welcome", name: "welcome.aspx", canvasLayout: { sections: [] } },
      { id: "p1", title: "About", name: "about.aspx" },
    ],
  };
}

test("sanitize strips volatile/odata/actor keys recursively", () => {
  const out = sanitizeForSnapshot({
    a: 1,
    eTag: "x",
    lastModifiedDateTime: "2026-01-01",
    createdBy: { user: "u" },
    "@odata.context": "ctx",
    nested: [{ etag: "y", keep: true }],
  }) as Record<string, unknown>;
  assert.deepEqual(out, { a: 1, nested: [{ keep: true }] });
});

test("stableStringify sorts keys at every depth and ends with newline", () => {
  const a = stableStringify({ b: { z: 1, a: 2 }, a: [{ y: 1, x: 2 }] });
  const b = stableStringify({ a: [{ x: 2, y: 1 }], b: { a: 2, z: 1 } });
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
});

test("slugify is fs-safe and stable", () => {
  assert.equal(slugify("Über  Cool / Page!"), "uber-cool-page");
  assert.equal(slugify("___"), "item");
});

test("serializer is deterministic: same site, shuffled input order → byte-identical files", () => {
  const a = serializeSite(input());
  const shuffled = input();
  shuffled.lists.reverse();
  shuffled.pages.reverse();
  const b = serializeSite(shuffled);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [path, content] of a) {
    assert.equal(b.get(path), content, path);
  }
});

test("serializer layout: manifest + per-list + per-page files, volatile stripped", () => {
  const files = serializeSite(input());
  assert.ok(files.has(".aisharepoint/site.json"));
  assert.ok(files.has("lists/announcements.json"));
  assert.ok(files.has("pages/welcome-aspx.json"));
  assert.ok(!files.get("lists/announcements.json")!.includes("createdDateTime"));
  const manifest = JSON.parse(files.get(".aisharepoint/site.json")!);
  assert.equal(manifest.contents.lists.length, 2);
  assert.ok(manifest.notSynced.includes("navigation"));
  for (const path of files.keys()) {
    assert.match(path, MANAGED_PATH);
  }
});

test("slug collisions get deterministic hash suffixes", () => {
  const files = serializeSite({
    ...input(),
    lists: [
      { id: "x1", displayName: "Same Name" },
      { id: "x2", displayName: "Same Name" },
    ],
    pages: [],
  });
  const listPaths = [...files.keys()].filter((p) => p.startsWith("lists/"));
  assert.equal(listPaths.length, 2);
  assert.notEqual(listPaths[0], listPaths[1]);
});

test("change report classifies added/updated/removed/unchanged and scopes removals", () => {
  const next = serializeSite(input());
  const existing = new Map(next);
  // mutate one, drop one, add a stray unmanaged + stale managed file
  const firstList = [...next.keys()].find((p) => p.startsWith("lists/"))!;
  existing.set(firstList, "{}\n");
  const firstPage = [...next.keys()].find((p) => p.startsWith("pages/"))!;
  existing.delete(firstPage);
  existing.set("pages/stale.json", "{}\n");
  existing.set("docs/own-notes.md", "keep me");

  const report = buildChangeReport(next, existing);
  assert.deepEqual(report.added, [firstPage]);
  assert.deepEqual(report.updated, [firstList]);
  assert.deepEqual(report.removed, ["pages/stale.json"]); // unmanaged path untouched
  assert.equal(report.unchanged, next.size - 2);
  assert.ok(hasChanges(report));
  assert.ok(!isBlocked(report));
  assert.match(commitMessageFor("Marketing", report), /^SharePoint pull: Marketing — \+1 ~1 -1 file\(s\)$/);
});

test("embedded secrets in serialized content block the pipeline", () => {
  const next: Map<string, string> = new Map([
    [
      "pages/leaky.json",
      stableStringify({ body: "Bearer abcdefghijklmnop123456 do not commit" }),
    ],
  ]);
  const report = buildChangeReport(next, new Map());
  assert.ok(report.leakFindings.length > 0);
  assert.ok(isBlocked(report));
});

test("remote URL parsing covers https, ssh://, and scp forms", () => {
  for (const url of [
    "https://github.com/org/site-repo.git",
    "ssh://git@github.corp.example/org/site-repo",
    "git@github.corp.example:org/site-repo.git",
  ]) {
    const info = parseRemoteUrl(url);
    assert.ok(info, url);
    assert.equal(info!.repoPath, "org/site-repo");
  }
  assert.equal(parseRemoteUrl("ftp://nope/x"), undefined);
  assert.equal(parseRemoteUrl("https://github.com/justorg"), undefined);
});

test("allowlist gate: github.com default, GHES requires admin opt-in", () => {
  assert.ok(validateRemote("https://github.com/org/repo", ["github.com"]).ok);
  const ghes = validateRemote("git@github.corp.example:org/repo.git", ["github.com"]);
  assert.ok(!ghes.ok);
  assert.match(ghes.reason!, /allowedRemoteHosts/);
  assert.ok(
    validateRemote("git@github.corp.example:org/repo.git", ["github.com", "GitHub.CORP.example"]).ok,
  );
});

test("compare URL + PR branch naming work for github.com and GHES alike", () => {
  const info = parseRemoteUrl("https://github.corp.example/org/repo.git")!;
  assert.equal(
    compareUrl(info, "main", "sharepoint-sync/20260611T120000"),
    "https://github.corp.example/org/repo/compare/main...sharepoint-sync%2F20260611T120000?expand=1",
  );
  assert.equal(prBranchName("2026-06-11T12:00:00.000Z"), "sharepoint-sync/20260611T120000");
});

test("repo hygiene files enforce LF and warn about generated content", () => {
  const files = repoHygieneFiles("Marketing", "https://contoso.sharepoint.com/sites/Marketing");
  assert.match(files.get(".gitattributes")!, /eol=lf/);
  assert.match(files.get("README.md")!, /managed by sync pulls/);
});
