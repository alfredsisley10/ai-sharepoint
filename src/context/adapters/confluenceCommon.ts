import { ContextSource } from "../types";

/**
 * Shared Confluence REST helpers. These three were copy-pasted, byte-for-byte,
 * across a dozen-plus adapter files (confluence, hierarchy, currency, ownership,
 * archive, entitlements, authority, cache, macros, write, …). Centralizing them
 * removes the drift risk (one file trimmed the trailing slash differently) and
 * the duplication. Pure.
 */

/** `encodeURIComponent`, aliased for terse URL construction. */
export const enc = encodeURIComponent;

/** Base URL with any trailing slash trimmed. */
export function baseOf(source: Pick<ContextSource, "baseUrl">): string {
  return source.baseUrl.replace(/\/$/, "");
}

/** Absolute web URL for a Confluence `_links.webui` path (base when absent). */
export function webUrl(source: Pick<ContextSource, "baseUrl">, webui?: string): string {
  return webui ? `${baseOf(source)}${webui}` : baseOf(source);
}
