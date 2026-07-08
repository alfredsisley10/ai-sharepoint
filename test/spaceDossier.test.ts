import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  SpaceDossier,
  DossierPage,
  flagsFor,
  primaryOwner,
  summarizeDossier,
  groupByOwner,
  renderInventoryMarkdown,
  renderInventoryJson,
  renderOwnersMarkdown,
  dossierSheets,
  dossierWorkItemSeeds,
  renderOutreachDraft,
  renderCurrentContent,
  renderRecommendedScaffold,
  pageFolderName,
  STALE_DAYS,
} from "../src/context/spaceDossier";

const page = (over: Partial<DossierPage> = {}): DossierPage => ({
  id: "1",
  title: "Page",
  url: "https://wiki/1",
  owners: [{ sam: "jdoe", active: true, contact: "jdoe@corp.com" }],
  hasOwnerLabel: false,
  brokenLinks: 0,
  issues: [],
  ...over,
});

const dossier = (pages: DossierPage[], over: Partial<SpaceDossier> = {}): SpaceDossier => ({
  spaceKey: "ENG",
  generatedAt: "2026-07-07T00:00:00.000Z",
  pages,
  totalPages: pages.length,
  truncated: false,
  ...over,
});

test("flagsFor: stale, ownerless, and data-quality", () => {
  assert.deepEqual(flagsFor(page()), { stale: false, ownerless: false, dataQuality: false, flagged: false });
  assert.equal(flagsFor(page({ staleDays: STALE_DAYS })).stale, true);
  assert.equal(flagsFor(page({ staleDays: STALE_DAYS - 1 })).stale, false);
  assert.equal(flagsFor(page({ owners: [{ sam: "x", active: false }] })).ownerless, true);
  assert.equal(flagsFor(page({ owners: [] })).ownerless, true);
  assert.equal(flagsFor(page({ brokenLinks: 2 })).dataQuality, true);
  assert.equal(flagsFor(page({ issues: ["broken owner tag"] })).dataQuality, true);
  assert.equal(flagsFor(page({ brokenLinks: 1 })).flagged, true);
});

test("primaryOwner prefers the first active owner", () => {
  assert.equal(
    primaryOwner(page({ owners: [{ sam: "inactive", active: false }, { sam: "active", active: true }] }))?.sam,
    "active",
  );
  assert.equal(primaryOwner(page({ owners: [{ sam: "only", active: false }] }))?.sam, "only");
  assert.equal(primaryOwner(page({ owners: [] })), undefined);
});

test("summarizeDossier counts flags and distinct owners", () => {
  const d = dossier(
    [
      page({ id: "1", owners: [{ sam: "a", active: true }] }),
      page({ id: "2", staleDays: 400, owners: [{ sam: "a", active: true }] }),
      page({ id: "3", brokenLinks: 3, owners: [{ sam: "b", active: false }] }),
    ],
    { totalPages: 5, truncated: true },
  );
  const s = summarizeDossier(d);
  assert.equal(s.captured, 3);
  assert.equal(s.totalPages, 5);
  assert.equal(s.truncated, true);
  assert.equal(s.stale, 1);
  assert.equal(s.ownerless, 1); // page 3's only owner is inactive
  assert.equal(s.dataQuality, 1);
  assert.equal(s.flagged, 2);
  assert.equal(s.owners, 2);
});

test("summarizeDossier + inventory surface review failures and throttling", () => {
  const d = dossier([page({ id: "1", issues: ["could not review"], owners: [] })], {
    reviewFailures: 1,
    throttled: true,
  });
  const s = summarizeDossier(d);
  assert.equal(s.reviewFailures, 1);
  assert.equal(s.throttled, true);
  const md = renderInventoryMarkdown(d);
  assert.match(md, /could not be reviewed because the source throttled/i);
  assert.match(md, /INCOMPLETE/);
  // Without a throttle the warning stays generic (no re-run advice tied to 429).
  const md2 = renderInventoryMarkdown(dossier([page({ id: "1", issues: ["could not review"] })], { reviewFailures: 1 }));
  assert.match(md2, /1 page\(s\) could not be reviewed/);
  assert.doesNotMatch(md2, /throttled/i);
});

test("groupByOwner buckets pages, unassigned last-ish, most-flagged first", () => {
  const d = dossier([
    page({ id: "1", owners: [{ sam: "a", active: true }], staleDays: 400 }),
    page({ id: "2", owners: [{ sam: "a", active: true }], brokenLinks: 2 }),
    page({ id: "3", owners: [] }),
  ]);
  const groups = groupByOwner(d);
  const a = groups.find((g) => g.owner.sam === "a")!;
  assert.equal(a.pages.length, 2);
  assert.equal(a.stale, 1);
  assert.equal(a.dataQuality, 1);
  assert.ok(groups.some((g) => g.owner.sam === "(unassigned)"));
});

test("renderInventoryMarkdown is a table with flags and counts", () => {
  const md = renderInventoryMarkdown(dossier([page({ staleDays: 400, brokenLinks: 1 })]));
  assert.match(md, /# Space ENG — content inventory/);
  assert.match(md, /\| Page \| Owner \| Updated \| Stale \(days\) \| Broken links \| Flags \|/);
  assert.match(md, /STALE/);
  assert.match(md, /DATA/);
});

test("renderInventoryJson embeds flags + summary and parses", () => {
  const json = JSON.parse(renderInventoryJson(dossier([page({ staleDays: 400 })])));
  assert.equal(json.summary.stale, 1);
  assert.equal(json.pages[0].flags.stale, true);
});

test("renderOwnersMarkdown lists contact and pages per owner", () => {
  const md = renderOwnersMarkdown(dossier([page({ owners: [{ sam: "jdoe", active: true, contact: "jdoe@corp.com" }] })]));
  assert.match(md, /## jdoe · jdoe@corp\.com/);
  assert.match(md, /\[Page\]\(https:\/\/wiki\/1\)/);
});

test("dossierSheets yields Pages + Owners sheets with headers", () => {
  const sheets = dossierSheets(dossier([page({ staleDays: 400 })]));
  assert.deepEqual(sheets.map((s) => s.name), ["Pages", "Owners"]);
  assert.equal(sheets[0]!.rows[0]![0], "Page");
  assert.equal(sheets[0]!.rows.length, 2); // header + 1 page
  assert.equal(sheets[1]!.rows[0]![0], "Owner");
});

test("dossierWorkItemSeeds only seeds flagged pages, carrying owner + tags", () => {
  const d = dossier([
    page({ id: "1", title: "Clean page" }), // not flagged
    page({ id: "2", title: "Old page", staleDays: 400, owners: [{ sam: "jdoe", active: true, contact: "j@c.com" }] }),
  ]);
  const seeds = dossierWorkItemSeeds(d, "wiki");
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]!.target.ref, "2");
  assert.equal(seeds[0]!.target.kind, "confluence");
  assert.equal(seeds[0]!.owner?.sam, "jdoe");
  assert.ok(seeds[0]!.tags?.includes("space-dossier"));
  assert.ok(seeds[0]!.tags?.includes("ENG"));
  assert.ok(seeds[0]!.tags?.includes("stale"));
});

test("suggestedOwner drives the work item, scaffold, and inventory for untagged pages", () => {
  const d = dossier(
    [
      page({
        id: "9",
        title: "Orphan",
        owners: [], // no tag → ownerless → flagged
        suggestedOwner: { sam: "asmith", active: false, basis: "top contributor (directory not wired — unverified)" },
      }),
    ],
    { ownerDetection: { directoryWired: false, ownerlessPages: 1, suggested: 1, noContributorHistory: 0 } },
  );
  // Work item is attributed to the suggested owner + recommends setting the tag.
  const seeds = dossierWorkItemSeeds(d, "wiki");
  assert.equal(seeds[0]!.owner?.sam, "asmith");
  assert.match(seeds[0]!.finding, /suggested owner: asmith/);
  assert.match(seeds[0]!.finding, /adding the label `owners\|asmith`/);
  // Scaffold names the suggested owner + the label to add.
  const scaffold = renderRecommendedScaffold(d.pages[0]!);
  assert.match(scaffold, /Suggested owner: \*\*asmith\*\*/);
  assert.match(scaffold, /activity unverified/);
  // Inventory owner cell + the no-directory diagnostic note.
  const inv = renderInventoryMarkdown(d);
  assert.match(inv, /→ asmith \(suggested\)/);
  assert.match(inv, /Owner detection:/);
  assert.match(inv, /No LDAP\/M365 directory is wired/);
});

test("renderOutreachDraft addresses the owner and lists their flagged pages", () => {
  const group = groupByOwner(
    dossier([page({ title: "Old", staleDays: 400, owners: [{ sam: "jdoe", active: true, contact: "j@c.com" }] })]),
  )[0]!;
  const md = renderOutreachDraft(group, "ENG", "2026-07-07T00:00:00.000Z");
  assert.match(md, /To: j@c\.com/);
  assert.match(md, /Hi jdoe/);
  assert.match(md, /not updated in 400 days/);
});

test("pageFolderName matches the on-disk sanitization (outreach link never 404s)", () => {
  assert.equal(pageFolderName("12345"), "12345");
  assert.equal(pageFolderName("a b/c"), "a-b-c");
  assert.equal(pageFolderName(""), "page"); // empty id falls back
  assert.equal(pageFolderName("///"), "---"); // sanitized, non-empty
});

test("renderOutreachDraft links the recommended revision when content was cached", () => {
  const withContent = groupByOwner(
    dossier([page({ id: "42", title: "Old", staleDays: 400, content: "current body", owners: [{ sam: "jdoe", active: true }] })]),
  )[0]!;
  assert.match(renderOutreachDraft(withContent, "ENG", "t"), /\(\.\.\/pages\/42\/recommended\.md\)/);
  // A non-numeric id links through the sanitized folder name, matching disk.
  const oddId = groupByOwner(
    dossier([page({ id: "a b/c", title: "Odd", staleDays: 400, content: "x", owners: [{ sam: "jdoe", active: true }] })]),
  )[0]!;
  assert.match(renderOutreachDraft(oddId, "ENG", "t"), /\(\.\.\/pages\/a-b-c\/recommended\.md\)/);
  const noContent = groupByOwner(
    dossier([page({ id: "42", title: "Old", staleDays: 400, owners: [{ sam: "jdoe", active: true }] })]),
  )[0]!;
  assert.doesNotMatch(renderOutreachDraft(noContent, "ENG", "t"), /recommended\.md/);
});

test("renderCurrentContent shows the header and body", () => {
  const md = renderCurrentContent(page({ title: "Guide", version: 7, content: "The body text." }));
  assert.match(md, /# Guide/);
  assert.match(md, /v7/);
  assert.match(md, /The body text\./);
});

test("renderRecommendedScaffold lists why-flagged, a revision slot, and quoted current", () => {
  const md = renderRecommendedScaffold(page({ title: "Guide", staleDays: 400, brokenLinks: 2, content: "old content" }));
  assert.match(md, /# Recommended revision — Guide/);
  assert.match(md, /## Why this page was flagged/);
  assert.match(md, /not updated in 400 days/);
  assert.match(md, /2 broken link\(s\)/);
  assert.match(md, /## Recommended revision/);
  assert.match(md, /> old content/); // current content quoted for reference
});
