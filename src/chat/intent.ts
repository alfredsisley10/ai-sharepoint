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
