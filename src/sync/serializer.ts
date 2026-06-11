import * as crypto from "node:crypto";
import {
  sanitizeForSnapshot,
  stableStringify,
  slugify,
} from "./snapshotSanitize";

/**
 * Site → files serializer (PLAN §7 slice 1; layout fixed by ADR-0019).
 * Pure: takes already-fetched plain objects, returns a path→content map.
 *
 *   .aisharepoint/site.json   site metadata + manifest (schema version)
 *   lists/<slug>.json         list schema (template, columns)
 *   pages/<slug>.json         page metadata + canvas layout (when available)
 *
 * Determinism: collections sorted by stable identity, volatile fields
 * stripped, stable JSON encoding — re-serializing an unchanged site yields
 * byte-identical content (unit-tested invariant).
 */

export const SNAPSHOT_SCHEMA = "ai-sharepoint/site-snapshot/v1";

export interface SiteSnapshotInput {
  site: { id: string; displayName: string; webUrl: string; description?: string };
  lists: Array<{
    id: string;
    displayName: string;
    template?: string;
    description?: string;
    columns?: unknown[];
  }>;
  pages: Array<{
    id: string;
    title: string;
    name?: string;
    pageLayout?: string;
    canvasLayout?: unknown;
  }>;
  /** True when the tenant blocked the Pages API (recorded in the manifest). */
  pagesUnavailable?: boolean;
}

export type FileMap = Map<string, string>;

function uniqueSlug(name: string, id: string, taken: Set<string>): string {
  let slug = slugify(name);
  if (taken.has(slug)) {
    const hash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 6);
    slug = `${slug}-${hash}`;
  }
  taken.add(slug);
  return slug;
}

export function serializeSite(input: SiteSnapshotInput): FileMap {
  const files: FileMap = new Map();

  const lists = [...input.lists].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
  );
  const pages = [...input.pages].sort(
    (a, b) => (a.name ?? a.title).localeCompare(b.name ?? b.title) || a.id.localeCompare(b.id),
  );

  const listSlugs = new Set<string>();
  const listIndex: Array<{ file: string; displayName: string }> = [];
  for (const list of lists) {
    const slug = uniqueSlug(list.displayName, list.id, listSlugs);
    const path = `lists/${slug}.json`;
    listIndex.push({ file: path, displayName: list.displayName });
    files.set(
      path,
      stableStringify(
        sanitizeForSnapshot({
          displayName: list.displayName,
          description: list.description ?? "",
          template: list.template ?? "genericList",
          columns: list.columns ?? [],
        }),
      ),
    );
  }

  const pageSlugs = new Set<string>();
  const pageIndex: Array<{ file: string; title: string }> = [];
  for (const page of pages) {
    const slug = uniqueSlug(page.name ?? page.title, page.id, pageSlugs);
    const path = `pages/${slug}.json`;
    pageIndex.push({ file: path, title: page.title });
    files.set(
      path,
      stableStringify(
        sanitizeForSnapshot({
          title: page.title,
          name: page.name ?? "",
          pageLayout: page.pageLayout ?? "article",
          canvasLayout: page.canvasLayout ?? null,
        }),
      ),
    );
  }

  files.set(
    ".aisharepoint/site.json",
    stableStringify({
      $schema: SNAPSHOT_SCHEMA,
      site: sanitizeForSnapshot({
        displayName: input.site.displayName,
        webUrl: input.site.webUrl,
        description: input.site.description ?? "",
      }),
      contents: {
        lists: listIndex,
        pages: pageIndex,
        pagesUnavailable: Boolean(input.pagesUnavailable),
      },
      notSynced: ["navigation", "theme", "list items / documents", "permissions"],
    }),
  );

  return files;
}

/** Paths the serializer owns inside a site repo (deletion scope for sync). */
export const MANAGED_PATH = /^(\.aisharepoint\/site\.json$|lists\/[^/]+\.json$|pages\/[^/]+\.json$)/;
