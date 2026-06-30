/**
 * Prompt Library: reusable, user-authored prompt snippets. Unlike memory (which
 * is injected into the assistant's context), prompts are reuse-on-demand — the
 * user copies one to the clipboard and pastes it into chat. A prompt is either
 * **global** (available everywhere) or attached to a managed site, reference
 * source, or project, so teams keep their best prompts next to the thing they're
 * about. Pure types + operations; the vscode persistence wrapper lives in
 * promptStore.ts, and prompts ride the same secret-free export/import as the rest.
 */

export type PromptScopeKind = "global" | "site" | "source" | "project";

/** Where a prompt lives. `key` is the site URL / source id / project id; it is
 *  omitted for `global` (a prompt available everywhere). */
export interface PromptScope {
  kind: PromptScopeKind;
  key?: string;
}

export interface PromptItem {
  id: string;
  scope: PromptScope;
  /** Short label shown in the tree and used as the dedup key. */
  title: string;
  /** The reusable prompt text (copied to the clipboard on "use"). */
  body: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export const PROMPT_TITLE_MAX = 80;
export const PROMPT_BODY_MAX = 4000;

/** Two scopes are "the same location" — kind matches and (for non-global) so
 *  does the key. Global scopes ignore the key entirely. */
export function samePromptScope(a: PromptScope, b: PromptScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "global") return true;
  return a.key === b.key;
}

/** Normalized dedup key: scope + case/space-folded title. Two prompts with the
 *  same scope and title are "the same" entry (drives import merge). */
export function promptKey(item: Pick<PromptItem, "scope" | "title">): string {
  const scope = item.scope.kind === "global" ? "global" : `${item.scope.kind}:${item.scope.key ?? ""}`;
  return `${scope} ${item.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function listPromptsForScope(items: PromptItem[], scope: PromptScope): PromptItem[] {
  return items
    .filter((p) => samePromptScope(p.scope, scope))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function withPrompt(items: PromptItem[], item: PromptItem): PromptItem[] {
  return [...items.filter((p) => p.id !== item.id), item];
}

export function withUpdatedPrompt(items: PromptItem[], item: PromptItem): PromptItem[] {
  return items.map((p) => (p.id === item.id ? item : p));
}

export function withoutPrompt(items: PromptItem[], id: string): PromptItem[] {
  return items.filter((p) => p.id !== id);
}

/** Drop every prompt attached to an entity (called when a source/site/project is
 *  removed). Never affects global prompts. */
export function withoutPromptScope(items: PromptItem[], scope: PromptScope): PromptItem[] {
  if (scope.kind === "global") return items;
  return items.filter((p) => !samePromptScope(p.scope, scope));
}

/** Clamp/normalize user input into a storable shape (no id/timestamps). */
export function normalizePromptInput(title: string, body: string, tags?: string[]): { title: string; body: string; tags?: string[] } {
  const t = title.trim().slice(0, PROMPT_TITLE_MAX);
  const b = body.trim().slice(0, PROMPT_BODY_MAX);
  const cleanTags = (tags ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 12);
  return { title: t, body: b, ...(cleanTags.length ? { tags: cleanTags } : {}) };
}

/** Distinct scopes that currently hold at least one prompt, ordered for display:
 *  Global first, then sites, sources, projects (stable within a kind). Drives the
 *  Prompt Library tab's top-level folders. */
export function promptScopes(items: PromptItem[]): PromptScope[] {
  const order: PromptScopeKind[] = ["global", "site", "source", "project"];
  const seen = new Map<string, PromptScope>();
  for (const p of items) {
    const k = p.scope.kind === "global" ? "global" : `${p.scope.kind}:${p.scope.key ?? ""}`;
    if (!seen.has(k)) seen.set(k, p.scope);
  }
  return [...seen.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
