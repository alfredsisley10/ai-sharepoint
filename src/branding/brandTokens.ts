/**
 * Brand-token engine for a FULL product rename (white-label). Renaming the
 * product entirely from "AI SharePoint" means rewriting brand tokens across the
 * whole source tree — package.json, compiled TS strings, docs — then recompiling.
 *
 * The hard rule: the word **"SharePoint"** on its own is Microsoft's product
 * (the thing this extension integrates with) and must NEVER be renamed. Only our
 * own distinctive brand tokens are replaced:
 *   - "AI SharePoint"  → the new display name
 *   - "@sharepoint"    → the new chat handle
 *   - "aiSharePoint"   → the camelCase identifier namespace  (command/setting/view IDs)
 *   - "aisharepoint"   → the lowercase tool/folder prefix     (aisharepoint_* tools)
 *   - "ai-sharepoint"  → the kebab id                         (schema ids, .vsix name)
 *
 * The last three are INTERNAL identifiers that also key stored settings and
 * data; renaming them strands an existing deployment (like the extension ID), so
 * it is opt-in and greenfield-only. All pure and unit-tested; the flow walks the
 * tree and applies these.
 */

export interface DeepBrandConfig {
  /** New product display name (replaces "AI SharePoint"). */
  displayName: string;
  /** New chat handle without the @ (replaces the @sharepoint participant). */
  handle: string;
  /** Opt-in: also rename the internal identifier namespaces. Greenfield only —
   *  it changes settings keys and globalState keys, stranding existing data. */
  renameIdentifiers: boolean;
  /** camelCase identifier namespace replacing "aiSharePoint" (e.g. "contosoDocs").
   *  Defaults to camelCase of `kebabName` when omitted. */
  idNamespace?: string;
  /** kebab id replacing "ai-sharepoint" (e.g. "contoso-docs"); usually the
   *  extension `name`. */
  kebabName: string;
}

export interface BrandToken {
  find: string;
  replace: string;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAMESPACE_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

/** "contoso-docs" / "Contoso Docs" → "contosoDocs". */
export function camelize(input: string): string {
  const parts = input.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "brand";
  return parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

export function validateDeepBrand(cfg: Partial<DeepBrandConfig>): string[] {
  const errs: string[] = [];
  if (!cfg.displayName || !cfg.displayName.trim()) errs.push("Display name is required.");
  if (!cfg.handle || !HANDLE_RE.test(cfg.handle)) {
    errs.push("Chat handle must be lowercase letters, digits, or hyphens (e.g. contosodocs).");
  }
  if (cfg.renameIdentifiers) {
    if (!cfg.kebabName || !KEBAB_RE.test(cfg.kebabName)) {
      errs.push("Internal id (kebab) must be lowercase letters, digits, or hyphens.");
    }
    const ns = cfg.idNamespace ?? (cfg.kebabName ? camelize(cfg.kebabName) : "");
    if (!ns || !NAMESPACE_RE.test(ns)) {
      errs.push("Identifier namespace must start with a letter and be alphanumeric (e.g. contosoDocs).");
    }
  }
  return errs;
}

/** Build the ordered token list. The display tokens always apply; identifier
 *  tokens only when `renameIdentifiers` is set. */
export function buildBrandTokens(cfg: DeepBrandConfig): BrandToken[] {
  const tokens: BrandToken[] = [
    { find: "AI SharePoint", replace: cfg.displayName },
    { find: "@sharepoint", replace: `@${cfg.handle}` },
  ];
  if (cfg.renameIdentifiers) {
    const ns = cfg.idNamespace || camelize(cfg.kebabName);
    tokens.push(
      { find: "aiSharePoint", replace: ns },
      { find: "ai-sharepoint", replace: cfg.kebabName },
      { find: "aisharepoint", replace: ns.toLowerCase() },
    );
  }
  return tokens;
}

/**
 * Apply tokens to a text (literal, case-sensitive, single pass per token). None
 * of the find-tokens is a substring of another, so order is irrelevant for
 * correctness; "SharePoint" alone is never a token, so Microsoft's product name
 * is preserved.
 */
export function applyBrandTokens(text: string, tokens: BrandToken[]): string {
  let out = text;
  for (const t of tokens) {
    if (t.find && t.find !== t.replace) out = out.split(t.find).join(t.replace);
  }
  return out;
}

/** Count how many tokens appear in a text (for reporting/dry-run). */
export function countTokenHits(text: string, tokens: BrandToken[]): number {
  let n = 0;
  for (const t of tokens) {
    if (!t.find) continue;
    n += text.split(t.find).length - 1;
  }
  return n;
}
