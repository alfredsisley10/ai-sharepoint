import { ContextSource, ContextCredential } from "../types";
import { fetchJson } from "../http";
import { AppError } from "../../core/errors";
import {
  getConfluencePageMeta,
  createConfluencePage,
  updateConfluencePage,
  ConfluenceWriteResult,
  CONFLUENCE_WRITE_HEADERS,
} from "./confluenceWrite";

/**
 * Confluence content-lifecycle constructs (ADR-0039) — the compliance-friendly
 * cleanup escalation (pages are NEVER deleted):
 *
 *  - **Archive a page** = move it underneath a page named **"archive"** at the
 *    ROOT of its space (matched **case-insensitively**, created if absent),
 *    using Confluence's content-safe move endpoint (no body round-trip).
 *  - **Remove a page from search** = replace the page's **current** content with
 *    a blank page. The page and all prior versions stay in history (compliance
 *    retention), but the live page is empty, so it drops out of search and
 *    navigation. Typically done only after archiving, when a page is still not
 *    needed.
 *
 * Both authenticate with the source's own API token, and pair with ownership
 * (notify the resolved owner before archiving / removing).
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
    CONFLUENCE_WRITE_HEADERS,
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

/** Confluence storage value for a "blank" page. Empty body = nothing for search
 *  to index; prior versions retain the original content for compliance. */
export const BLANK_PAGE_BODY = "";

/**
 * Remove a page from search by blanking its CURRENT content (the page is never
 * deleted — Confluence keeps every prior version, so the original content is
 * retained for compliance, while the live page is empty and drops out of search
 * and navigation). The title is preserved; only the body is blanked.
 */
export async function removeConfluencePageFromSearch(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<ConfluenceWriteResult> {
  const meta = await getConfluencePageMeta(source, credential, pageId, timeoutMs);
  return updateConfluencePage(
    source,
    credential,
    { id: meta.id, title: meta.title, body: BLANK_PAGE_BODY },
    timeoutMs,
  );
}
