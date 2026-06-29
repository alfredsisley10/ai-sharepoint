/**
 * Single source of truth for THIS product's distinctive brand identifiers — the
 * literal find-tokens the rebrand engine searches for. They live in the
 * ORIGIN_BRAND object below and NOWHERE else in the engine (this file's prose is
 * deliberately brand-neutral, so the only identifiers here are the object's
 * values). A white-label export therefore anonymizes the rebrand engine AND its
 * unit tests by regenerating just this one object: the source-archive rebrand
 * replaces these values with the NEW brand's identifiers (see
 * `rebrandOriginModule`), leaving no prior identifiers behind and pointing the
 * exported copy's own rebrand engine at its new brand.
 *
 * Note: the bare word for Microsoft's product is deliberately NOT an identifier
 * here — it must never be renamed. Only the product-distinctive display name,
 * @handle, the camelCase / lowercase / kebab identifier namespaces, and the
 * publisher/owner are origin identity.
 */
export interface OriginBrand {
  /** Distinctive product display name. */
  displayName: string;
  /** Chat handle, without the leading @. */
  handle: string;
  /** camelCase identifier namespace (command / setting / view IDs). */
  namespace: string;
  /** lowercase tool / folder prefix. */
  namespaceLower: string;
  /** kebab id (schema ids, .vsix name). */
  kebab: string;
  /** Marketplace publisher / repository owner. Not a brand token, so the export
   *  must replace it explicitly. */
  publisher: string;
}

export const ORIGIN_BRAND: OriginBrand = {
  displayName: "AI SharePoint",
  handle: "sharepoint",
  namespace: "aiSharePoint",
  namespaceLower: "aisharepoint",
  kebab: "ai-sharepoint",
  publisher: "alfredsisley10",
};

/** The fields that carry a string identifier (drives both regeneration and the
 *  anonymization scan). */
export const ORIGIN_BRAND_FIELDS: (keyof OriginBrand)[] = [
  "displayName",
  "handle",
  "namespace",
  "namespaceLower",
  "kebab",
  "publisher",
];

/**
 * Regenerate this module's `ORIGIN_BRAND` values in place from a new brand,
 * preserving the rest of the file (the interface, the helper functions) so the
 * exported copy keeps a working, self-describing engine. Only the string VALUES
 * inside the `ORIGIN_BRAND` object literal are replaced — the interface
 * (`displayName: string;`) and function bodies (which use expressions, not
 * `key: "literal"`) are left untouched. JSON-encoded values escape quotes
 * safely; a function replacement keeps a `$` in any value literal intact.
 */
export function rebrandOriginModule(src: string, brand: OriginBrand): string {
  let out = src;
  for (const key of ORIGIN_BRAND_FIELDS) {
    const re = new RegExp(`(\\b${key}:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    const value = JSON.stringify(brand[key]);
    out = out.replace(re, (_m, p1: string) => p1 + value);
  }
  return out;
}
