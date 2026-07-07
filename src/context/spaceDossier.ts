import { Sheet } from "./files/sheet";
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
}

export interface SpaceDossier {
  spaceKey: string;
  generatedAt: string;
  pages: DossierPage[];
  /** Pages discovered in the space (may exceed `pages.length` if capped). */
  totalPages: number;
  /** True when enumeration hit the page cap and the dossier is a partial view. */
  truncated: boolean;
}

/** A page is "stale" past this age (matches the currency review's default). */
export const STALE_DAYS = 180;

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

function flagBadges(p: DossierPage): string {
  const f = flagsFor(p);
  const b: string[] = [];
  if (f.stale) b.push("STALE");
  if (f.ownerless) b.push("NO OWNER");
  if (f.dataQuality) b.push("DATA");
  return b.join(", ") || "ok";
}

function ownerLabel(p: DossierPage): string {
  const o = primaryOwner(p);
  if (!o) return "—";
  return `${o.sam}${o.active ? "" : " (inactive)"}`;
}

export function renderInventoryMarkdown(d: SpaceDossier): string {
  const s = summarizeDossier(d);
  const lines: string[] = [
    `# Space ${d.spaceKey} — content inventory`,
    "",
    `_Generated ${d.generatedAt} · ${s.captured} of ${s.totalPages} page(s)${d.truncated ? " (capped)" : ""} · ${s.flagged} flagged (${s.stale} stale · ${s.ownerless} no active owner · ${s.dataQuality} data-quality)._`,
    "",
    "| Page | Owner | Updated | Stale (days) | Broken links | Flags |",
    "| --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const p of d.pages) {
    lines.push(
      `| [${escapePipe(p.title)}](${p.url}) | ${escapePipe(ownerLabel(p))} | ${p.lastUpdated?.slice(0, 10) ?? "—"} | ${p.staleDays ?? "—"} | ${p.brokenLinks} | ${flagBadges(p)} |`,
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
  const lines: string[] = [`# Space ${d.spaceKey} — by owner`, "", `_Generated ${d.generatedAt}._`, ""];
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
  return lines.join("\n");
}

/** Two-sheet workbook: one page per row, plus an owner rollup. */
export function dossierSheets(d: SpaceDossier): Sheet[] {
  const pages: string[][] = [
    ["Page", "URL", "Owner", "Owner active", "Contact", "Updated", "Stale days", "Broken links", "Issues", "Flags"],
  ];
  for (const p of d.pages) {
    const o = primaryOwner(p);
    pages.push([
      p.title,
      p.url,
      o?.sam ?? "",
      o ? (o.active ? "yes" : "no") : "",
      o?.contact ?? "",
      p.lastUpdated?.slice(0, 10) ?? "",
      p.staleDays !== undefined ? String(p.staleDays) : "",
      String(p.brokenLinks),
      p.issues.join("; "),
      flagBadges(p),
    ]);
  }
  const owners: string[][] = [["Owner", "Active", "Contact", "Pages", "Stale", "Data-quality"]];
  for (const g of groupByOwner(d)) {
    owners.push([
      g.owner.sam,
      g.owner.active ? "yes" : "no",
      "contact" in g.owner ? g.owner.contact ?? "" : "",
      String(g.pages.length),
      String(g.stale),
      String(g.dataQuality),
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
    const reasons = [
      f.stale ? `stale (${p.staleDays}d since update)` : "",
      f.ownerless ? "no active owner" : "",
      p.brokenLinks > 0 ? `${p.brokenLinks} broken link(s)` : "",
      ...p.issues,
    ].filter(Boolean);
    const o = primaryOwner(p);
    seeds.push({
      title: `Review: ${p.title}`.slice(0, 160),
      finding: `Page in space ${d.spaceKey} flagged during content review — ${reasons.join("; ")}.`,
      target: { source: sourceLabel, kind: "confluence", ref: p.id, url: p.url },
      ...(o && o.sam !== "(unassigned)"
        ? { owner: { sam: o.sam, ...(o.contact ? { contact: o.contact } : {}), basis: "page-contributor" } }
        : {}),
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
 *  owner can be shown exactly what changes are proposed. */
export function renderOutreachDraft(group: OwnerGroup, spaceKey: string, generatedAt: string): string {
  const flagged = group.pages.filter((p) => flagsFor(p).flagged);
  const to = "contact" in group.owner && group.owner.contact ? group.owner.contact : group.owner.sam;
  const lines: string[] = [
    `# Outreach draft — ${group.owner.sam}`,
    "",
    `_To: ${to} · space ${spaceKey} · drafted ${generatedAt}_`,
    "",
    `Hi ${group.owner.sam},`,
    "",
    `As part of a content review of the **${spaceKey}** Confluence space, the following ${flagged.length} page(s) you own look like they need attention:`,
    "",
  ];
  for (const p of flagged) {
    const why = [
      flagsFor(p).stale ? `not updated in ${p.staleDays} days` : "",
      p.brokenLinks > 0 ? `${p.brokenLinks} broken link(s)` : "",
      ...p.issues,
    ].filter(Boolean);
    const rec = p.content !== undefined ? ` · recommended revision: [\`recommended.md\`](../pages/${p.id}/recommended.md)` : "";
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
    f.ownerless ? "No current (active) owner resolved." : "",
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
