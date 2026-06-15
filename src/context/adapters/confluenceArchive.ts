import { ContextSource, ContextCredential } from "../types";
import { fetchJson } from "../http";
import { AppError } from "../../core/errors";
import { getConfluencePageMeta, createConfluencePage } from "./confluenceWrite";

/**
 * Confluence archiving construct (ADR-0039): "archive a page" = move it
 * underneath a page named **"archive"** at the ROOT of its space. The archive
 * root is matched **case-insensitively** ("Archive" / "ARCHIVE" / "archive"),
 * and created if it doesn't exist yet. The move uses Confluence's content-safe
 * move endpoint (no body round-trip), authenticated with the source's own API
 * token. Pairs with ownership: notify the owner before archiving.
 */

const enc = encodeURIComponent;
const baseOf = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/$/, "");

export const ARCHIVE_ROOT_TITLE = "Archive";

/** Find the root-level page titled "archive" (case-insensitive) in a space. */
export async function findRootArchivePage(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  timeoutMs: number,
): Promise<{ id: string; title: string } | undefined> {
  const res = await fetchJson<{
    results?: Array<{ id?: string; title?: string }>;
    page?: { results?: Array<{ id?: string; title?: string }> };
  }>(
    `${baseOf(source)}/rest/api/space/${enc(spaceKey)}/content/page?depth=root&limit=200`,
    credential,
    timeoutMs,
  );
  const roots = res.results ?? res.page?.results ?? [];
  const match = roots.find((p) => (p.title ?? "").trim().toLowerCase() === "archive");
  return match?.id ? { id: String(match.id), title: String(match.title ?? ARCHIVE_ROOT_TITLE) } : undefined;
}

/** Move a page to be a child of `parentId` (Confluence content-safe move). */
export async function moveConfluencePageUnder(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  parentId: string,
  timeoutMs: number,
): Promise<void> {
  await fetchJson<unknown>(
    `${baseOf(source)}/rest/api/content/${enc(pageId)}/move/append/${enc(parentId)}`,
    credential,
    timeoutMs,
    undefined,
    { method: "PUT" },
  );
}

export interface ArchiveResult {
  pageId: string;
  archiveRootId: string;
  archiveRootTitle: string;
  /** True when the space had no Archive root and one was created. */
  createdArchiveRoot: boolean;
}

/**
 * Archive a page: ensure a root "Archive" page exists in the page's space
 * (case-insensitive; created if absent), then move the page under it. Refuses
 * to archive the Archive root itself.
 */
export async function archiveConfluencePage(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<ArchiveResult> {
  const meta = await getConfluencePageMeta(source, credential, pageId, timeoutMs);
  if (!meta.spaceKey) {
    throw new AppError("Could not determine the page's space — cannot locate the Archive root.", "config");
  }
  if (meta.title.trim().toLowerCase() === "archive") {
    throw new AppError("That page is the space's Archive root — refusing to archive it under itself.", "config");
  }

  let archive = await findRootArchivePage(source, credential, meta.spaceKey, timeoutMs);
  let created = false;
  if (!archive) {
    const root = await createConfluencePage(
      source,
      credential,
      { spaceKey: meta.spaceKey, title: ARCHIVE_ROOT_TITLE, body: "<p>Archived pages.</p>" },
      timeoutMs,
    );
    archive = { id: root.id, title: root.title };
    created = true;
  }
  if (archive.id === meta.id) {
    throw new AppError("That page is already the Archive root.", "config");
  }

  await moveConfluencePageUnder(source, credential, meta.id, archive.id, timeoutMs);
  return {
    pageId: meta.id,
    archiveRootId: archive.id,
    archiveRootTitle: archive.title,
    createdArchiveRoot: created,
  };
}
