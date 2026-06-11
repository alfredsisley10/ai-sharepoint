import { ContextSource } from "./types";

/**
 * Alias-aware source referencing.
 *
 * A source can carry a short, unique **alias** (e.g. "CMDB") — the handle
 * users naturally say in chat ("find application X in the CMDB database") —
 * plus a free-text description of what the source contains. Resolution is
 * pure and deterministic so the chat tools, the participant, and the
 * commands all match references identically.
 */

export const ALIAS_MAX_LENGTH = 32;
export const DESCRIPTION_MAX_LENGTH = 200;

/** Trim, collapse inner whitespace, and cap length. Case is preserved
 *  (matching is case-insensitive). */
export function normalizeAlias(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, ALIAS_MAX_LENGTH);
}

/** Validate a (non-empty) alias against the other sources. Returns a
 *  human-readable problem, or undefined when the alias is usable. */
export function aliasIssue(
  raw: string,
  existing: ContextSource[],
  excludeId?: string,
): string | undefined {
  const alias = normalizeAlias(raw);
  if (!/[\p{L}\p{N}]/u.test(alias)) {
    return "An alias needs at least one letter or digit.";
  }
  if (raw.trim().length > ALIAS_MAX_LENGTH) {
    return `Keep aliases short (≤ ${ALIAS_MAX_LENGTH} characters) — they're chat handles.`;
  }
  const taken = existing.find(
    (s) => s.id !== excludeId && s.alias?.toLowerCase() === alias.toLowerCase(),
  );
  if (taken) {
    return `"${alias}" is already the alias of "${taken.displayName}" — aliases must be unique so chat references are unambiguous.`;
  }
  return undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `reference` contains `alias` as a whole word ("the CMDB
 *  database" ⊃ "CMDB"), so models may pass the user's phrase verbatim.
 *  Word boundaries keep short aliases safe ("DB" never matches "database"). */
function referenceMentionsAlias(reference: string, alias: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(alias)}([^\\p{L}\\p{N}]|$)`, "iu").test(
    reference,
  );
}

/**
 * Resolve a user/model-supplied reference to a source. Most-specific first:
 * exact id → exact alias → exact display name → type → alias mentioned in
 * the reference → display-name substring. No reference resolves only a sole
 * source. Case-insensitive throughout (ids excepted).
 */
export function resolveSourceRef(
  all: ContextSource[],
  reference?: string,
): ContextSource | undefined {
  if (!reference?.trim()) {
    return all.length === 1 ? all[0] : undefined;
  }
  const ref = reference.trim().toLowerCase();
  return (
    all.find((s) => s.id === reference) ??
    all.find((s) => s.alias?.toLowerCase() === ref) ??
    all.find((s) => s.displayName.toLowerCase() === ref) ??
    all.find((s) => s.type === ref) ??
    all.find((s) => s.alias && referenceMentionsAlias(reference, s.alias)) ??
    all.find((s) => s.displayName.toLowerCase().includes(ref))
  );
}

/** One-line chat-facing label: alias first when present. */
export function sourceChatLabel(s: ContextSource): string {
  return `${s.alias ? `"${s.alias}" — ` : ""}${s.displayName} (${s.type})`;
}
