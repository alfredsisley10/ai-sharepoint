/**
 * Built-in starter prompts for the flagship flows (Confluence space cleanup,
 * space dossier, cross-source authoritative review, owner outreach, SharePoint
 * content review). Seeded into the global Prompt Library once so a new user can
 * run the designed workflows with one click instead of composing the ask.
 *
 * Idempotent by design: each seed has a stable id; the store records which ids
 * it has already added, so a seed the user later deletes is NOT re-added, and a
 * NEW built-in shipped in a later release is added without duplicating the rest.
 * Pure module (no vscode) — unit-tested.
 */

export interface SeedPrompt {
  /** Stable id (`builtin:*`) so re-seeding is idempotent. */
  id: string;
  title: string;
  body: string;
  tags: string[];
}

export const BUILTIN_PROMPTS: SeedPrompt[] = [
  {
    id: "builtin:confluence-space-cleanup",
    title: "Optimize & clean up a Confluence space",
    body: "Optimize and clean up our Confluence space <SPACEKEY>. Track it in a project workspace, build a space dossier (owners, stale/inaccurate pages, broken links), and propose recommended revisions and owner outreach.",
    tags: ["confluence", "cleanup", "dossier"],
  },
  {
    id: "builtin:build-space-dossier",
    title: "Build a Confluence space dossier",
    body: "Build a content dossier for Confluence space <SPACEKEY>: for every page resolve the owner (or a suggested target owner when untagged), staleness, and data-quality flags, then open a remediation work item per flagged page.",
    tags: ["confluence", "dossier"],
  },
  {
    id: "builtin:authoritative-cross-check",
    title: "Find content that conflicts with an authoritative source",
    body: "Treat Confluence space <SPACEKEY> as the AUTHORITATIVE source for <TOPIC>. Search the rest of Confluence and our SharePoint sites for pages that are inaccurate or out of date relative to it, and recommend which to correct, merge, or archive — cite page titles + URLs.",
    tags: ["confluence", "sharepoint", "authoritative", "cleanup"],
  },
  {
    id: "builtin:owner-outreach",
    title: "Draft owner outreach for flagged pages",
    body: "For the flagged pages in the current space dossier, draft per-owner outreach: summarize what needs attention (stale, broken links, ownership), attach the recommended revisions, and prepare the messages for my review.",
    tags: ["confluence", "outreach", "communications"],
  },
  {
    id: "builtin:sharepoint-content-review",
    title: "Review a SharePoint site's content for cleanup",
    body: "Review the entire contents of the <SITE> SharePoint site: scan every page and highlight duplicative, out-of-date, or confusing content, then recommend concrete cleanup (merge, archive, update, or delete) citing page titles + URLs.",
    tags: ["sharepoint", "cleanup", "review"],
  },
];

/** The built-ins not yet present in `seededIds` (pure). */
export function newSeedPrompts(seededIds: Iterable<string>): SeedPrompt[] {
  const seen = new Set(seededIds);
  return BUILTIN_PROMPTS.filter((p) => !seen.has(p.id));
}
