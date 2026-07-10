import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  SpaceDossier,
  DossierPage,
  flagsFor,
  primaryOwner,
  summarizeDossier,
  groupByOwner,
  groupBySuggestedOwner,
  renderSuggestedOwnerOutreachDraft,
  renderInventoryMarkdown,
  renderInventoryJson,
  renderOwnersMarkdown,
  dossierSheets,
  dossierWorkItemSeeds,
  renderOutreachDraft,
  renderCurrentContent,
  renderRecommendedScaffold,
  pageFolderName,
  spaceScopeSuffix,
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

test("dossierSheets carries the suggested TARGET owner in its own machine-readable columns", () => {
  const suggested = { sam: "asmith", active: false, contact: "a@c.com", basis: "top contributor (directory not wired — unverified)" };
  const sheets = dossierSheets(
    dossier([
      page({ id: "1", title: "Tagged" }), // assigned owner, no suggestion
      page({ id: "9", title: "Orphan", owners: [], suggestedOwner: suggested }),
    ]),
  );
  const [header, tagged, orphan] = sheets[0]!.rows as [string[], string[], string[]];
  const col = (name: string) => header.indexOf(name);
  // Distinct columns — never blended into the assigned-owner column.
  assert.ok(col("Target owner (suggested)") > col("Owner"), "target-owner column exists");
  assert.ok(col("Target owner contact") > 0);
  assert.ok(col("Target owner basis") > 0);
  assert.equal(orphan[col("Owner")], "");
  assert.equal(orphan[col("Target owner (suggested)")], "asmith");
  assert.equal(orphan[col("Target owner contact")], "a@c.com");
  assert.equal(orphan[col("Target owner basis")], suggested.basis);
  assert.equal(tagged[col("Owner")], "jdoe");
  assert.equal(tagged[col("Target owner (suggested)")], "");
});

test("dossierSheets Owners sheet includes suggested-owner rows (Role column) for export-only outreach", () => {
  const sheets = dossierSheets(
    dossier([
      page({ id: "1", owners: [{ sam: "jdoe", active: true, contact: "j@c.com" }] }),
      page({
        id: "9",
        owners: [],
        staleDays: 400,
        suggestedOwner: { sam: "asmith", active: false, contact: "a@c.com", basis: "top contributor (directory not wired — unverified)" },
      }),
    ]),
  );
  const rows = sheets[1]!.rows;
  const header = rows[0]!;
  assert.ok(header.includes("Role") && header.includes("Basis"));
  const role = header.indexOf("Role");
  const active = header.indexOf("Active");
  const assigned = rows.find((r) => r[0] === "jdoe")!;
  assert.equal(assigned[role], "assigned");
  const sug = rows.find((r) => r[0] === "asmith")!;
  assert.equal(sug[role], "suggested");
  // Unverified must not be reported as a hard "no".
  assert.equal(sug[active], "unverified");
  assert.equal(sug[header.indexOf("Contact")], "a@c.com");
  assert.equal(sug[header.indexOf("Pages")], "1");
  assert.equal(sug[header.indexOf("Stale")], "1");
  assert.match(sug[header.indexOf("Basis")]!, /directory not wired/);
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
  // Scaffold names the suggested target owner (with its basis) + the label to add.
  const scaffold = renderRecommendedScaffold(d.pages[0]!);
  assert.match(scaffold, /Suggested target owner: \*\*asmith\*\*/);
  assert.match(scaffold, /suggested — unverified/);
  assert.match(scaffold, /directory not wired/);
  // Inventory owner cell (human-clear trust level) + the no-directory note.
  const inv = renderInventoryMarkdown(d);
  assert.match(inv, /→ asmith \(suggested — unverified\)/);
  assert.match(inv, /Owner detection:/);
  assert.match(inv, /No LDAP\/M365 directory is wired/);
});

test("inventory owner cell shows the suggestion next to an INACTIVE tagged owner", () => {
  const d = dossier([
    page({
      id: "7",
      owners: [{ sam: "gone", active: false }], // tagged but inactive → still ownerless
      suggestedOwner: { sam: "asmith", active: true, basis: "top active contributor" },
    }),
  ]);
  const inv = renderInventoryMarkdown(d);
  assert.match(inv, /gone \(inactive\) · → asmith \(suggested\)/);
});

test("renderOutreachDraft addresses the owner and lists their flagged pages", () => {
  const group = groupByOwner(
    dossier([page({ title: "Old", staleDays: 400, owners: [{ sam: "jdoe", active: true, contact: "j@c.com" }] })]),
  )[0]!;
  const md = renderOutreachDraft(group, { spaceKey: "ENG", generatedAt: "2026-07-07T00:00:00.000Z" });
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
  assert.match(renderOutreachDraft(withContent, { spaceKey: "ENG", generatedAt: "t" }), /\(\.\.\/pages\/42\/recommended\.md\)/);
  // A non-numeric id links through the sanitized folder name, matching disk.
  const oddId = groupByOwner(
    dossier([page({ id: "a b/c", title: "Odd", staleDays: 400, content: "x", owners: [{ sam: "jdoe", active: true }] })]),
  )[0]!;
  assert.match(renderOutreachDraft(oddId, { spaceKey: "ENG", generatedAt: "t" }), /\(\.\.\/pages\/a-b-c\/recommended\.md\)/);
  const noContent = groupByOwner(
    dossier([page({ id: "42", title: "Old", staleDays: 400, owners: [{ sam: "jdoe", active: true }] })]),
  )[0]!;
  assert.doesNotMatch(renderOutreachDraft(noContent, { spaceKey: "ENG", generatedAt: "t" }), /recommended\.md/);
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

// --- suggested TARGET owners across the export surfaces (FIX: outreach can
// --- proceed from the export alone) ------------------------------------------

const suggestedFixture = () =>
  dossier([
    page({
      id: "9",
      title: "Orphan",
      owners: [],
      staleDays: 400,
      content: "body",
      suggestedOwner: { sam: "asmith", active: false, contact: "a@c.com", basis: "top contributor (directory not wired — unverified)" },
    }),
    page({
      id: "10",
      title: "Orphan 2",
      owners: [],
      brokenLinks: 1,
      suggestedOwner: { sam: "asmith", active: false, contact: "a@c.com", basis: "top contributor (directory not wired — unverified)" },
    }),
    page({ id: "1", title: "Tagged" }),
  ]);

test("groupBySuggestedOwner groups untagged pages by suggested owner with flag counts", () => {
  const groups = groupBySuggestedOwner(suggestedFixture());
  assert.equal(groups.length, 1);
  const g = groups[0]!;
  assert.equal(g.sam, "asmith");
  assert.equal(g.contact, "a@c.com");
  assert.equal(g.pages.length, 2);
  assert.equal(g.stale, 1);
  assert.equal(g.dataQuality, 1);
  assert.match(g.basis, /directory not wired/);
});

test("renderOwnersMarkdown adds a suggested-target-owners section, separate from assigned owners", () => {
  const md = renderOwnersMarkdown(suggestedFixture());
  assert.match(md, /## jdoe/); // assigned rollup intact
  assert.match(md, /## Suggested target owners/);
  assert.match(md, /### → asmith · a@c\.com · _suggested — unverified_/);
  assert.match(md, /basis: top contributor \(directory not wired — unverified\)/);
  assert.match(md, /\[Orphan\]\(https:\/\/wiki\/1\)/);
  assert.match(md, /owners\|<sam>/); // the how-to-establish instruction
  // No suggestions → no section.
  assert.doesNotMatch(renderOwnersMarkdown(dossier([page()])), /Suggested target owners/);
});

test("renderSuggestedOwnerOutreachDraft asks the suggested owner to accept ownership", () => {
  const g = groupBySuggestedOwner(suggestedFixture())[0]!;
  const md = renderSuggestedOwnerOutreachDraft(g, { spaceKey: "ENG", generatedAt: "2026-07-07T00:00:00.000Z" });
  assert.match(md, /# Outreach draft — asmith \(suggested target owner\)/);
  assert.match(md, /To: a@c\.com/);
  assert.match(md, /SUGGESTED owner \(top contributor \(directory not wired — unverified\)\)/);
  assert.match(md, /Hi asmith/);
  assert.match(md, /\[Orphan\]\(https:\/\/wiki\/1\)/);
  assert.match(md, /owners\|asmith/); // the label that establishes ownership
  // Cached content links its recommended revision, like the assigned-owner draft.
  assert.match(md, /\(\.\.\/pages\/9\/recommended\.md\)/);
  // Without a contact, the draft addresses the sam.
  const noContact = { ...g, contact: undefined };
  assert.match(renderSuggestedOwnerOutreachDraft(noContact, { spaceKey: "ENG", generatedAt: "t" }), /To: asmith/);
});

test("renderOutreachDraft names the target owner for ownerless pages under an inactive tagged owner", () => {
  const d = dossier([
    page({
      id: "7",
      title: "Adrift",
      staleDays: 400,
      owners: [{ sam: "gone", active: false, contact: "g@c.com" }],
      suggestedOwner: { sam: "asmith", active: true, contact: "a@c.com", basis: "top active contributor" },
    }),
  ]);
  const md = renderOutreachDraft(groupByOwner(d)[0]!, { spaceKey: "ENG", generatedAt: "t" });
  assert.match(md, /no active owner tag — target owner asmith \(suggested\)/);
});

// --- AREA-scoped dossiers (page hierarchies): every "Space X" surface names
// --- the area, and parent/depth travel into the exports --------------------

const AREA = { rootPageId: "100", rootTitle: "Team Handbook" };

test("spaceScopeSuffix: empty for a whole space, names the area when scoped", () => {
  assert.equal(spaceScopeSuffix({}), "");
  assert.equal(spaceScopeSuffix({ area: AREA }), " — area “Team Handbook”");
});

test("area-scoped inventory + owners headings name the area", () => {
  const d = dossier([page()], { area: AREA });
  assert.match(renderInventoryMarkdown(d), /^# Space ENG — area “Team Handbook” — content inventory/);
  assert.match(renderOwnersMarkdown(d), /^# Space ENG — area “Team Handbook” — by owner/);
  // A whole-space dossier is untouched.
  assert.match(renderInventoryMarkdown(dossier([page()])), /^# Space ENG — content inventory/);
});

test("inventory indents titles by hierarchy depth (non-breaking — table cells collapse plain spaces)", () => {
  const d = dossier(
    [
      page({ id: "100", title: "Root", depth: 0 }),
      page({ id: "101", title: "Child", parentId: "100", depth: 1 }),
      page({ id: "102", title: "Grandchild", parentId: "101", depth: 2 }),
    ],
    { area: AREA },
  );
  const md = renderInventoryMarkdown(d);
  assert.match(md, /\| \[Root\]/, "root (depth 0) gets no indent");
  assert.match(md, /\| &nbsp;&nbsp;\[Child\]/);
  assert.match(md, /\| &nbsp;&nbsp;&nbsp;&nbsp;\[Grandchild\]/);
  // Flat whole-space pages (no depth) are never indented.
  assert.match(renderInventoryMarkdown(dossier([page({ title: "Flat" })])), /\| \[Flat\]/);
});

test("dossierSheets Pages sheet carries Parent ID + Depth for pivoting by area", () => {
  const sheets = dossierSheets(
    dossier([page({ id: "100", title: "Root", depth: 0 }), page({ id: "101", title: "Child", parentId: "100", depth: 1 }), page({ id: "9", title: "Flat" })]),
  );
  const [header, root, child, flat] = sheets[0]!.rows as [string[], string[], string[], string[]];
  const col = (name: string) => header.indexOf(name);
  assert.ok(col("Parent ID") > 0 && col("Depth") > 0);
  assert.equal(root[col("Parent ID")], "");
  assert.equal(root[col("Depth")], "0");
  assert.equal(child[col("Parent ID")], "100");
  assert.equal(child[col("Depth")], "1");
  // Flat enumeration leaves both blank (not "0" — depth was never measured).
  assert.equal(flat[col("Parent ID")], "");
  assert.equal(flat[col("Depth")], "");
});

test("area travels into the JSON export and the work-item findings", () => {
  const d = dossier([page({ staleDays: 400 })], { area: AREA });
  const json = JSON.parse(renderInventoryJson(d));
  assert.deepEqual(json.area, AREA);
  const seeds = dossierWorkItemSeeds(d, "wiki");
  assert.match(seeds[0]!.finding, /space ENG — area “Team Handbook” flagged during content review/);
});

test("outreach drafts name the area of an area-scoped review", () => {
  const scoped = { spaceKey: "ENG", area: AREA, generatedAt: "t" };
  const owned = groupByOwner(dossier([page({ staleDays: 400 })]))[0]!;
  const md = renderOutreachDraft(owned, scoped);
  assert.match(md, /space ENG — area “Team Handbook” · drafted t/);
  assert.match(md, /\*\*ENG\*\* Confluence space — area “Team Handbook”/);
  const sug = groupBySuggestedOwner(suggestedFixture())[0]!;
  assert.match(renderSuggestedOwnerOutreachDraft(sug, scoped), /\*\*ENG\*\* Confluence space — area “Team Handbook”/);
});
