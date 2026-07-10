import { Sheet } from "./files/sheet";
import { avoidReservedName } from "./files/safeName";
import { NewWorkItem } from "./workItems";

/**
 * Confluence "space dossier" (ADR-0048 follow-up) — the PURE core.
 *
 * Aggregates a target Confluence space into a persistent, exportable picture for
 * content-management: one row per page with its owner (recency-weighted, LDAP
 * active-employee checked), staleness, and data-quality flags (broken links,
 * currency issues). The renderers below turn that into the workspace artifacts
 * (`inventory.md/.json`, `owners.md`, `dossier.xlsx`) and seed work items /
 * per-owner outreach. All pure string/record math → unit-tested; contextService
 * gathers the per-page facts and chatWorkspaceStore writes the files.
 */

export interface DossierOwner {
  sam: string;
  active: boolean;
  contact?: string;
}

export interface DossierPage {
  id: string;
  title: string;
  url: string;
  /** Immediate parent page id — set by the hierarchy (area) walk so exports can
   *  pivot by subtree; the flat whole-space enumeration leaves it unset. */
  parentId?: string;
  /** Depth below the dossier root (root = 0), from the hierarchy walk. */
  depth?: number;
  owners: DossierOwner[];
  hasOwnerLabel: boolean;
  lastUpdated?: string;
  staleDays?: number;
  brokenLinks: number;
  /** Currency/data-quality issues surfaced by the currency review. */
  issues: string[];
  /** Current page body as plain text — cached for flagged pages so we can show
   *  the current state and seed a recommended revision. Absent when not fetched. */
  content?: string;
  /** Page version number at capture time (for the current-content header). */
  version?: number;
  /** When there's no (active) owner TAG, the recency-weighted top contributor we
   *  suggest as the TARGET owner — so ownership can be established (a "set the
   *  owner tag" recommended update). Distinct from `owners` (the tagged owners);
   *  `active` reflects the directory check (false/unknown when none is wired). */
  suggestedOwner?: { sam: string; active: boolean; contact?: string; basis: string };
}

export interface SpaceDossier {
  spaceKey: string;
  /** Set when the dossier is scoped to an AREA — the subtree rooted at one
   *  parent page — rather than the whole space (users often own one area, not
   *  the space). Every human-facing "Space X" line then reads
   *  "Space X — area “Root Title”" (see spaceScopeSuffix). */
  area?: { rootPageId: string; rootTitle: string };
  generatedAt: string;
  pages: DossierPage[];
  /** Pages discovered in the space (may exceed `pages.length` if capped). */
  totalPages: number;
  /** True when enumeration hit the page cap and the dossier is a partial view. */
  truncated: boolean;
  /** Pages that could not be reviewed at all (a fetch/review error). They still
   *  appear in `pages` with a "could not review" issue, but this counts them so
   *  the dossier can say plainly how complete it is. */
  reviewFailures?: number;
  /** True when at least one review failed because the source THROTTLED us
   *  (429/503). This is the important distinction: those pages aren't
   *  data-quality problems, the dossier is just INCOMPLETE — re-run it.
   *  (The current builder ABORTS on a throttle instead of degrading, so this
   *  is only seen on dossiers persisted by older builds.) */
  throttled?: boolean;
  /** Diagnostics for TARGET-OWNER detection on untagged pages, so a zero-owner
   *  result is explainable (the common cause: no directory wired, so nothing
   *  can be active-verified). */
  ownerDetection?: {
    /** An LDAP/M365 directory was available to verify active employees. */
    directoryWired: boolean;
    /** Pages with no (active) owner tag — the candidates for suggestion. */
    ownerlessPages: number;
    /** How many got a suggested target owner. */
    suggested: number;
    /** How many had no usable contributor history to suggest from. */
    noContributorHistory: number;
    /** How many pages' HISTORY READS FAILED outright (endpoint/auth/network) —
     *  distinct from "no history": all-failing means a systemic problem to fix,
     *  not an empty space. */
    historyReadFailures?: number;
    /** A sample failure message, so the summary is directly troubleshootable. */
    historyReadSampleError?: string;
  };
}

/** A page is "stale" past this age (matches the currency review's default). */
export const STALE_DAYS = 180;

/** The dossier's scope for a human-facing line: `spaceKey` plus, when the
 *  dossier is AREA-scoped, the root page. */
export type DossierScope = Pick<SpaceDossier, "spaceKey" | "area">;

/** The scope tail appended to every human-facing "Space X" / "space X" line:
 *  empty for a whole-space dossier, ` — area “Root Title”` when area-scoped —
 *  the ONE wording shared by the renderers, tool replies, and command toasts. */
export function spaceScopeSuffix(d: Pick<SpaceDossier, "area">): string {
  return d.area ? ` — area “${d.area.rootTitle}”` : "";
}

/** Filesystem-safe folder name for a page id — the SINGLE definition shared by
 *  the on-disk writer and the outreach link so their paths never diverge. */
export function pageFolderName(id: string): string {
  return avoidReservedName(id.replace(/[^A-Za-z0-9._-]/g, "-") || "page");
}

export interface PageFlags {
  stale: boolean;
  /** No CURRENT (active) owner could be resolved. */
  ownerless: boolean;
  /** Broken links or other currency issues. */
  dataQuality: boolean;
  flagged: boolean;
}

export function flagsFor(p: DossierPage): PageFlags {
  const stale = p.staleDays !== undefined && p.staleDays >= STALE_DAYS;
  const ownerless = !p.owners.some((o) => o.active);
  const dataQuality = p.brokenLinks > 0 || p.issues.length > 0;
  return { stale, ownerless, dataQuality, flagged: stale || ownerless || dataQuality };
}

/** The owner to attribute a page to: the first ACTIVE owner, else the first. */
export function primaryOwner(p: DossierPage): DossierOwner | undefined {
  return p.owners.find((o) => o.active) ?? p.owners[0];
}

export interface DossierSummary {
  totalPages: number;
  captured: number;
  truncated: boolean;
  flagged: number;
  stale: number;
  ownerless: number;
  dataQuality: number;
  owners: number;
  /** Pages that failed to review (subset of `captured`). */
  reviewFailures: number;
  /** A throttle (429/503) caused at least one failure — the dossier is
   *  incomplete for a transient reason; re-running should recover it. */
  throttled: boolean;
}

export function summarizeDossier(d: SpaceDossier): DossierSummary {
  let flagged = 0;
  let stale = 0;
  let ownerless = 0;
  let dataQuality = 0;
  const owners = new Set<string>();
  for (const p of d.pages) {
    const f = flagsFor(p);
    if (f.flagged) flagged += 1;
    if (f.stale) stale += 1;
    if (f.ownerless) ownerless += 1;
    if (f.dataQuality) dataQuality += 1;
    const o = primaryOwner(p);
    if (o) owners.add(o.sam);
  }
  return {
    totalPages: d.totalPages,
    captured: d.pages.length,
    truncated: d.truncated,
    flagged,
    stale,
    ownerless,
    dataQuality,
    owners: owners.size,
    reviewFailures: d.reviewFailures ?? 0,
    throttled: d.throttled ?? false,
  };
}

export interface OwnerGroup {
  owner: DossierOwner | { sam: string; active: false; contact?: undefined };
  pages: DossierPage[];
  stale: number;
  dataQuality: number;
}

/** Group pages by their primary owner (unowned pages under "(unassigned)"),
 *  most-flagged owners first. */
export function groupByOwner(d: SpaceDossier): OwnerGroup[] {
  const map = new Map<string, OwnerGroup>();
  for (const p of d.pages) {
    const o = primaryOwner(p);
    const key = o?.sam ?? "(unassigned)";
    let g = map.get(key);
    if (!g) {
      g = { owner: o ?? { sam: "(unassigned)", active: false }, pages: [], stale: 0, dataQuality: 0 };
      map.set(key, g);
    }
    g.pages.push(p);
    const f = flagsFor(p);
    if (f.stale) g.stale += 1;
    if (f.dataQuality) g.dataQuality += 1;
  }
  return [...map.values()].sort(
    (a, b) => b.stale + b.dataQuality - (a.stale + a.dataQuality) || b.pages.length - a.pages.length,
  );
}

export interface SuggestedOwnerGroup {
  sam: string;
  /** Directory-verified active (false also covers "unverified" — see basis). */
  active: boolean;
  contact?: string;
  basis: string;
  pages: DossierPage[];
  stale: number;
  dataQuality: number;
}

/** Group pages by their SUGGESTED target owner — the outreach list for
 *  ESTABLISHING ownership. Distinct from groupByOwner (the assigned-owner
 *  rollup): a page appears here when it has no (active) owner tag and
 *  target-owner detection produced a candidate, so outreach can proceed from
 *  the export alone. Most pages first. */
export function groupBySuggestedOwner(d: SpaceDossier): SuggestedOwnerGroup[] {
  const map = new Map<string, SuggestedOwnerGroup>();
  for (const p of d.pages) {
    const s = p.suggestedOwner;
    if (!s) continue;
    let g = map.get(s.sam);
    if (!g) {
      g = {
        sam: s.sam,
        active: s.active,
        ...(s.contact ? { contact: s.contact } : {}),
        basis: s.basis,
        pages: [],
        stale: 0,
        dataQuality: 0,
      };
      map.set(s.sam, g);
    }
    g.pages.push(p);
    const f = flagsFor(p);
    if (f.stale) g.stale += 1;
    if (f.dataQuality) g.dataQuality += 1;
  }
  return [...map.values()].sort((a, b) => b.pages.length - a.pages.length || a.sam.localeCompare(b.sam));
}

function flagBadges(p: DossierPage): string {
  const f = flagsFor(p);
  const b: string[] = [];
  if (f.stale) b.push("STALE");
  if (f.ownerless) b.push("NO OWNER");
  if (f.dataQuality) b.push("DATA");
  return b.join(", ") || "ok";
}

/** A suggested TARGET owner (non-null DossierPage.suggestedOwner). */
export type SuggestedOwner = NonNullable<DossierPage["suggestedOwner"]>;

/** How much to trust a suggestion, in plain words, derived from the active
 *  check + basis — the SHARED wording for every human-facing surface. */
export function suggestedOwnerNote(s: Pick<SuggestedOwner, "active" | "basis">): string {
  if (s.active) return "suggested";
  return /unverified/i.test(s.basis) ? "suggested — unverified" : "suggested — inactive per directory";
}

/** Human-clear rendering of a suggested target owner, e.g.
 *  `jdoe (suggested — unverified)`. */
function suggestedOwnerText(s: SuggestedOwner): string {
  return `${s.sam} (${suggestedOwnerNote(s)})`;
}

function suggestedOwnerLabel(s: SuggestedOwner): string {
  return `→ ${suggestedOwnerText(s)}`;
}

function ownerLabel(p: DossierPage): string {
  const o = primaryOwner(p);
  const suggested = p.suggestedOwner ? suggestedOwnerLabel(p.suggestedOwner) : undefined;
  if (!o) {
    // No tagged owner — show the suggested target owner so the inventory names
    // who to establish ownership with.
    return suggested ?? "—";
  }
  const tagged = `${o.sam}${o.active ? "" : " (inactive)"}`;
  // A page whose only tagged owner is inactive is still effectively ownerless —
  // show the suggested target owner alongside so the re-owning candidate is
  // named right in the inventory.
  return !o.active && suggested ? `${tagged} · ${suggested}` : tagged;
}

/** Indent a page's title cell by its hierarchy depth. Markdown collapses plain
 *  leading spaces inside a table cell, so the indent is non-breaking spaces
 *  (capped — pathological nesting must not push the table off-screen). Depthless
 *  pages (flat whole-space enumeration) get no indent. */
function depthIndent(p: DossierPage): string {
  return p.depth ? "&nbsp;&nbsp;".repeat(Math.min(p.depth, 8)) : "";
}

export function renderInventoryMarkdown(d: SpaceDossier): string {
  const s = summarizeDossier(d);
  const lines: string[] = [
    `# Space ${d.spaceKey}${spaceScopeSuffix(d)} — content inventory`,
    "",
    `_Generated ${d.generatedAt} · ${s.captured} of ${s.totalPages} page(s)${d.truncated ? " (capped)" : ""} · ${s.flagged} flagged (${s.stale} stale · ${s.ownerless} no active owner · ${s.dataQuality} data-quality)._`,
    ...(s.reviewFailures > 0
      ? [
          "",
          `> ⚠ ${s.reviewFailures} page(s) could not be reviewed${s.throttled ? " because the source throttled requests (HTTP 429/503)" : ""} — this inventory is INCOMPLETE${s.throttled ? "; re-run the dossier (optionally with lower concurrency) to fill the gaps" : ""}.`,
        ]
      : []),
    ...(d.ownerDetection
      ? [
          "",
          `> **Owner detection:** ${d.ownerDetection.suggested}/${d.ownerDetection.ownerlessPages} untagged page(s) got a suggested target owner (recency-weighted top contributor).${
            d.ownerDetection.noContributorHistory > 0
              ? ` ${d.ownerDetection.noContributorHistory} had no usable contributor history.`
              : ""
          }${
            (d.ownerDetection.historyReadFailures ?? 0) > 0
              ? ` ⚠ ${d.ownerDetection.historyReadFailures} page(s) FAILED the history read${
                  d.ownerDetection.historyReadSampleError ? ` (e.g. ${d.ownerDetection.historyReadSampleError})` : ""
                } — fix that and re-run the dossier; those pages were left unsuggested.`
              : ""
          }${
            d.ownerDetection.directoryWired
              ? ""
              : " No LDAP/M365 directory is wired, so suggestions are the top contributor **unverified** (active-employee checking is off) — add an LDAP source to confirm who's still active."
          }`,
        ]
      : []),
    "",
    "| Page | Owner | Updated | Stale (days) | Broken links | Flags |",
    "| --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const p of d.pages) {
    lines.push(
      `| ${depthIndent(p)}[${escapePipe(p.title)}](${p.url}) | ${escapePipe(ownerLabel(p))} | ${p.lastUpdated?.slice(0, 10) ?? "—"} | ${p.staleDays ?? "—"} | ${p.brokenLinks} | ${flagBadges(p)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderInventoryJson(d: SpaceDossier): string {
  return JSON.stringify(
    {
      ...d,
      summary: summarizeDossier(d),
      pages: d.pages.map((p) => ({ ...p, flags: flagsFor(p) })),
    },
    null,
    2,
  );
}

export function renderOwnersMarkdown(d: SpaceDossier): string {
  const groups = groupByOwner(d);
  const lines: string[] = [`# Space ${d.spaceKey}${spaceScopeSuffix(d)} — by owner`, "", `_Generated ${d.generatedAt}._`, ""];
  for (const g of groups) {
    const contact = "contact" in g.owner && g.owner.contact ? ` · ${g.owner.contact}` : "";
    const active = g.owner.active ? "" : " · _inactive/unresolved_";
    lines.push(`## ${g.owner.sam}${contact}${active}`);
    lines.push(`${g.pages.length} page(s) · ${g.stale} stale · ${g.dataQuality} data-quality`, "");
    for (const p of g.pages) {
      lines.push(`- [${escapePipe(p.title)}](${p.url}) — ${flagBadges(p)}`);
    }
    lines.push("");
  }
  // Suggested TARGET owners: pages with no (active) owner tag, grouped by the
  // contributor target-owner detection proposes — kept in their own section
  // (never mixed with the assigned owners above) so outreach for ESTABLISHING
  // ownership can proceed from this file alone.
  const suggested = groupBySuggestedOwner(d);
  if (suggested.length) {
    lines.push(
      "## Suggested target owners",
      "",
      "_The pages below have no (active) `owners|` tag; each owner is **suggested** from contribution history. Confirm with them, then set the `owners|<sam>` label to establish ownership._",
      "",
    );
    for (const g of suggested) {
      const contact = g.contact ? ` · ${g.contact}` : "";
      lines.push(`### → ${g.sam}${contact} · _${suggestedOwnerNote(g)}_`);
      lines.push(`${g.pages.length} page(s) · ${g.stale} stale · ${g.dataQuality} data-quality · basis: ${g.basis}`, "");
      for (const p of g.pages) {
        lines.push(`- [${escapePipe(p.title)}](${p.url}) — ${flagBadges(p)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** The "Active" cell for a suggested owner: false means either genuinely
 *  inactive OR merely unverified (no directory) — the basis disambiguates,
 *  and the cell must not claim "no" when nothing was checked. */
function suggestedActiveCell(s: Pick<SuggestedOwner, "active" | "basis">): string {
  return s.active ? "yes" : /unverified/i.test(s.basis) ? "unverified" : "no";
}

/** Two-sheet workbook: one page per row, plus an owner rollup. The suggested
 *  TARGET owner travels in its own columns/rows (never blended into the
 *  assigned-owner column) so the distinction stays machine-readable in the
 *  .xlsx and the derived CSVs. */
export function dossierSheets(d: SpaceDossier): Sheet[] {
  const pages: string[][] = [
    [
      "Page",
      "URL",
      // Hierarchy columns (from the area walk; blank on a flat whole-space
      // enumeration) so users can pivot the export by area/subtree.
      "Parent ID",
      "Depth",
      "Owner",
      "Owner active",
      "Contact",
      "Target owner (suggested)",
      "Target owner contact",
      "Target owner basis",
      "Updated",
      "Stale days",
      "Broken links",
      "Issues",
      "Flags",
    ],
  ];
  for (const p of d.pages) {
    const o = primaryOwner(p);
    const s = p.suggestedOwner;
    pages.push([
      p.title,
      p.url,
      p.parentId ?? "",
      p.depth !== undefined ? String(p.depth) : "",
      o?.sam ?? "",
      o ? (o.active ? "yes" : "no") : "",
      o?.contact ?? "",
      s?.sam ?? "",
      s?.contact ?? "",
      s?.basis ?? "",
      p.lastUpdated?.slice(0, 10) ?? "",
      p.staleDays !== undefined ? String(p.staleDays) : "",
      String(p.brokenLinks),
      p.issues.join("; "),
      flagBadges(p),
    ]);
  }
  const owners: string[][] = [["Owner", "Role", "Active", "Contact", "Pages", "Stale", "Data-quality", "Basis"]];
  for (const g of groupByOwner(d)) {
    owners.push([
      g.owner.sam,
      "assigned",
      g.owner.active ? "yes" : "no",
      "contact" in g.owner ? g.owner.contact ?? "" : "",
      String(g.pages.length),
      String(g.stale),
      String(g.dataQuality),
      "",
    ]);
  }
  // Suggested TARGET owners as their own rows (Role = "suggested"), so outreach
  // for establishing ownership can proceed from the export alone.
  for (const g of groupBySuggestedOwner(d)) {
    owners.push([
      g.sam,
      "suggested",
      suggestedActiveCell(g),
      g.contact ?? "",
      String(g.pages.length),
      String(g.stale),
      String(g.dataQuality),
      g.basis,
    ]);
  }
  return [
    { name: "Pages", rows: pages },
    { name: "Owners", rows: owners },
  ];
}

/** Seed a work item for every FLAGGED page (the remediation backlog, ADR-0045). */
export function dossierWorkItemSeeds(d: SpaceDossier, sourceLabel: string): NewWorkItem[] {
  const seeds: NewWorkItem[] = [];
  for (const p of d.pages) {
    const f = flagsFor(p);
    if (!f.flagged) continue;
    const suggested = p.suggestedOwner;
    const reasons = [
      f.stale ? `stale (${p.staleDays}d since update)` : "",
      f.ownerless
        ? suggested
          ? `no owner tag — suggested owner: ${suggested.sam}${suggested.active ? "" : " (activity unverified)"}`
          : "no active owner"
        : "",
      p.brokenLinks > 0 ? `${p.brokenLinks} broken link(s)` : "",
      ...p.issues,
    ].filter(Boolean);
    const tagged = primaryOwner(p);
    // Attribute the work item to the tagged owner, else to the suggested target
    // owner so there's someone to drive establishing ownership.
    const owner =
      tagged && tagged.sam !== "(unassigned)"
        ? { sam: tagged.sam, ...(tagged.contact ? { contact: tagged.contact } : {}), basis: "page-contributor" as const }
        : suggested
          ? { sam: suggested.sam, ...(suggested.contact ? { contact: suggested.contact } : {}), basis: "page-contributor" as const }
          : undefined;
    seeds.push({
      title: `Review: ${p.title}`.slice(0, 160),
      finding: `Page in space ${d.spaceKey}${spaceScopeSuffix(d)} flagged during content review — ${reasons.join("; ")}.${
        f.ownerless && suggested ? ` Recommended update: establish ownership by adding the label \`owners|${suggested.sam}\`.` : ""
      }`,
      target: { source: sourceLabel, kind: "confluence", ref: p.id, url: p.url },
      ...(owner ? { owner } : {}),
      tags: [
        "space-dossier",
        d.spaceKey,
        ...(f.stale ? ["stale"] : []),
        ...(f.ownerless ? ["ownerless"] : []),
        ...(f.dataQuality ? ["data-quality"] : []),
      ],
    });
  }
  return seeds;
}

/** A per-owner outreach draft (markdown) listing their flagged pages — the
 *  starting point for coordinating communications + follow-ups. Links to each
 *  page's cached recommended revision (relative to the `outreach/` folder) so the
 *  owner can be shown exactly what changes are proposed. Takes the dossier's
 *  scope (not a bare spaceKey) so an area-scoped review names its area. */
export function renderOutreachDraft(group: OwnerGroup, d: DossierScope & Pick<SpaceDossier, "generatedAt">): string {
  const flagged = group.pages.filter((p) => flagsFor(p).flagged);
  const to = "contact" in group.owner && group.owner.contact ? group.owner.contact : group.owner.sam;
  const lines: string[] = [
    `# Outreach draft — ${group.owner.sam}`,
    "",
    `_To: ${to} · space ${d.spaceKey}${spaceScopeSuffix(d)} · drafted ${d.generatedAt}_`,
    "",
    `Hi ${group.owner.sam},`,
    "",
    `As part of a content review of the **${d.spaceKey}** Confluence space${spaceScopeSuffix(d)}, the following ${flagged.length} page(s) you own look like they need attention:`,
    "",
  ];
  for (const p of flagged) {
    const why = [
      flagsFor(p).stale ? `not updated in ${p.staleDays} days` : "",
      // No active owner tag + a detected target owner: name the candidate so
      // the re-owning conversation can start from the draft itself.
      flagsFor(p).ownerless && p.suggestedOwner
        ? `no active owner tag — target owner ${suggestedOwnerText(p.suggestedOwner)}`
        : "",
      p.brokenLinks > 0 ? `${p.brokenLinks} broken link(s)` : "",
      ...p.issues,
    ].filter(Boolean);
    const rec = p.content !== undefined ? ` · recommended revision: [\`recommended.md\`](../pages/${pageFolderName(p.id)}/recommended.md)` : "";
    lines.push(`- [${escapePipe(p.title)}](${p.url}) — ${why.join("; ") || "needs review"}${rec}`);
  }
  lines.push(
    "",
    "Could you review these and either update them, confirm they're still accurate, or let me know if ownership should move? Where noted, a recommended revision is attached for your review. I'll follow up in a week.",
    "",
    "Thanks!",
    "",
  );
  return lines.join("\n");
}

/** An outreach draft for a SUGGESTED target owner: their pages carry no
 *  (active) `owners|` tag, and target-owner detection proposes them from
 *  contribution history. Asks them to confirm/accept ownership (the `owners|`
 *  label) rather than to fix content — the ESTABLISH-ownership counterpart of
 *  renderOutreachDraft, so outreach can proceed straight from the export. */
export function renderSuggestedOwnerOutreachDraft(
  group: SuggestedOwnerGroup,
  d: DossierScope & Pick<SpaceDossier, "generatedAt">,
): string {
  const to = group.contact ?? group.sam;
  const lines: string[] = [
    `# Outreach draft — ${group.sam} (suggested target owner)`,
    "",
    `_To: ${to} · space ${d.spaceKey}${spaceScopeSuffix(d)} · drafted ${d.generatedAt}_`,
    "",
    `_${group.sam} is the SUGGESTED owner (${group.basis}) — these pages have no active \`owners|\` tag yet. Confirm before setting the label._`,
    "",
    `Hi ${group.sam},`,
    "",
    `During a content review of the **${d.spaceKey}** Confluence space${spaceScopeSuffix(d)}, the following ${group.pages.length} page(s) turned up without an (active) owner. Based on the pages' contribution history, you look like the best owner for them:`,
    "",
  ];
  for (const p of group.pages) {
    const rec = p.content !== undefined ? ` · recommended revision: [\`recommended.md\`](../pages/${pageFolderName(p.id)}/recommended.md)` : "";
    lines.push(`- [${escapePipe(p.title)}](${p.url}) — ${flagBadges(p)}${rec}`);
  }
  lines.push(
    "",
    `Could you confirm whether you can own these pages? If so, I'll set the \`owners|${group.sam}\` label so future reviews reach you directly; if not, a pointer to the right owner would help just as much.`,
    "",
    "Thanks!",
    "",
  );
  return lines.join("\n");
}

/** The cached CURRENT state of a page (header + body text), written for flagged
 *  pages so a reviewer/owner can see exactly what exists today. */
export function renderCurrentContent(p: DossierPage): string {
  return [
    `# ${p.title}`,
    "",
    `_${p.url}${p.version !== undefined ? ` · v${p.version}` : ""}${p.lastUpdated ? ` · updated ${p.lastUpdated.slice(0, 10)}` : ""} · captured for content review_`,
    "",
    "---",
    "",
    (p.content ?? "").trim() || "_(no textual content captured)_",
    "",
  ].join("\n");
}

/** A recommended-revision SCAFFOLD, written once per flagged page (never
 *  overwritten on re-run) so the current content, the issues to fix, and a
 *  place for the proposed revision travel together and can be shown to owners. */
export function renderRecommendedScaffold(p: DossierPage): string {
  const f = flagsFor(p);
  const reasons = [
    f.stale ? `Stale — not updated in ${p.staleDays} days.` : "",
    f.ownerless
      ? p.suggestedOwner
        ? `No active owner tag. Suggested target owner: **${p.suggestedOwner.sam}** (${suggestedOwnerNote(p.suggestedOwner)}: ${p.suggestedOwner.basis}) — establish ownership by adding the label \`owners|${p.suggestedOwner.sam}\`.`
        : "No owner tag, and no contributor history was available to suggest one."
      : "",
    p.brokenLinks > 0 ? `${p.brokenLinks} broken link(s).` : "",
    ...p.issues.map((i) => `Issue: ${i}`),
  ].filter(Boolean);
  return [
    `# Recommended revision — ${p.title}`,
    "",
    `_${p.url} · draft for owner review. Edit the “Recommended revision” section below; this file is preserved across dossier refreshes._`,
    "",
    "## Why this page was flagged",
    "",
    ...(reasons.length ? reasons.map((r) => `- ${r}`) : ["- (flagged for review)"]),
    "",
    "## Recommended revision",
    "",
    "_Replace this with the proposed updated content (or a summary of the specific changes to make)._",
    "",
    "## Current content (for reference)",
    "",
    "> " + ((p.content ?? "").trim() || "(no textual content captured)").replace(/\n/g, "\n> "),
    "",
  ].join("\n");
}
