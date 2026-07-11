/**
 * Small, pure intent heuristics for the chat participant (unit-tested).
 */

/**
 * Does this prompt ask to OPTIMIZE / clean up / review a Confluence space or
 * site? Used to offer a project workspace so the cleanup is tracked, cached, and
 * restartable. Requires both a Confluence-ish subject and a cleanup-ish verb so
 * a plain "search my wiki" doesn't trip it.
 */
export function looksLikeConfluenceOptimization(prompt: string): boolean {
  const p = ` ${prompt.toLowerCase()} `;
  const subject = /(confluence|wiki|\bspace\b|\bspaces\b|\bpages?\b|\bsite\b|documentation|knowledge base)/.test(p);
  const action =
    /(optimi[sz]e|clean ?up|clean up|tidy|declutter|audit|reconcile|consolidat|remediat|review|refresh|stale|out[- ]?of[- ]?date|find owners|page owners|inaccurate|inconsistent|duplicate)/.test(
      p,
    );
  return subject && action;
}

/**
 * Does this prompt point at Confluence-flavored content (spaces, wiki pages,
 * CQL, a knowledge base)? Used to suppress the speculative live SharePoint
 * read on turns that are really about the reference sources — an explicit
 * site URL or site name still forces the read, so cross-source asks work.
 * Pure + unit-tested.
 */
export function hasConfluenceSignal(prompt: string): boolean {
  return /(confluence|wiki|knowledge base|\bspaces?\b|\bcql\b)/i.test(prompt);
}

const SPACE_KEY_STOPWORDS = new Set([
  "THE", "THIS", "THAT", "OUR", "MY", "AN", "EACH", "EVERY", "WHOLE", "ENTIRE",
  "CONFLUENCE", "WIKI", "KNOWLEDGE", "MAIN", "SAME", "ONE", "ANY", "SOME",
]);

/** Best-effort Confluence space key from an optimization prompt: the token in
 *  "space X" / "X space" (keys are short alnum). Conservative — returns
 *  undefined rather than guess from arbitrary capitalized words. Pure. */
export function extractSpaceKey(prompt: string): string | undefined {
  const m =
    prompt.match(/\bspace\s*[:#]?\s*["“']?([A-Za-z][A-Za-z0-9]{1,14})["”']?/i) ||
    prompt.match(/\b([A-Za-z][A-Za-z0-9]{1,14})["”']?\s+space\b/i);
  const raw = m?.[1];
  if (!raw) return undefined;
  const up = raw.toUpperCase();
  return SPACE_KEY_STOPWORDS.has(up) ? undefined : up;
}

/** Fields to pre-populate the project wizard with when a user is starting a
 *  Confluence space cleanup — so "Create a project to track this" opens with a
 *  sensible name, goals, instructions, and the Confluence source(s) already
 *  selected, instead of a blank form. Pure + unit-tested. */
export interface ProjectSeed {
  name: string;
  goals: string;
  instructions: string;
  sourceIds: string[];
  spaceKey?: string;
}

export function confluenceOptimizationSeed(prompt: string, confluenceSourceIds: string[]): ProjectSeed {
  const spaceKey = extractSpaceKey(prompt);
  const where = spaceKey ? `the ${spaceKey} Confluence space` : "a Confluence space";
  return {
    name: spaceKey ? `Confluence ${spaceKey} cleanup` : "Confluence space cleanup",
    goals: `Optimize and clean up ${where}: surface page owners, stale/inaccurate pages, and broken links, then prepare recommended revisions and owner outreach.`,
    instructions: `Drive this as a Confluence space optimization. Build a space dossier for ${spaceKey ? `space ${spaceKey}` : "the target space"} (owners, staleness, data-quality per page), review the flagged pages, draft owner communications, and track remediation as work items. Cite page titles + URLs in findings.`,
    sourceIds: confluenceSourceIds,
    ...(spaceKey ? { spaceKey } : {}),
  };
}
