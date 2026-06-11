/**
 * Determinism primitives for the site serializer (PLAN §7): the same live
 * site state must always produce byte-identical files, so Git diffs reflect
 * real changes only. Pure module.
 */

/** Keys that are volatile or identity-bearing and never belong in a snapshot. */
const VOLATILE_KEY = /^@odata\.|odata\.|etag$|^eTag$|.*DateTime$|^createdBy$|^lastModifiedBy$|^createdByUser$|^lastModifiedByUser$|^publishingState$/;

/**
 * Recursively drop volatile keys and normalize objects for snapshotting.
 * Arrays keep their order (callers sort collections explicitly where order
 * is not meaningful).
 */
export function sanitizeForSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeForSnapshot);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEY.test(k)) continue;
      if (v === undefined) continue;
      out[k] = sanitizeForSnapshot(v);
    }
    return out;
  }
  return value;
}

/** JSON with recursively sorted keys, 2-space indent, trailing newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Filesystem-safe, deterministic file slug. Distinct inputs that collapse to
 * the same slug get a short content hash suffix appended by the caller.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "item";
}
