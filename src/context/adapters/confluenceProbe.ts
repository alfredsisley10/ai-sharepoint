import { ContextSource, ContextCredential } from "../types";
import { AppError } from "../../core/errors";
import {
  createConfluencePage,
  updateConfluencePage,
  deleteConfluencePage,
  getConfluencePageMeta,
} from "./confluenceWrite";

/**
 * Safe, non-destructive write-access probe for a managed Confluence connector
 * (ADR-0042). The usual failure mode — a 403 only at publish time — is
 * frustrating because reads succeed, so the connector "looks" fine. This
 * exercises the FULL write lifecycle up front (create → update → delete) on a
 * throwaway page and cleans up after itself, so create/edit-permission gaps,
 * read-only spaces, an uncreated personal space, or a proxy/WAF that blocks
 * uploads surface during SETUP with the server's own reason — not weeks later.
 *
 * "Safe" = the probe page is created with an obvious, time-stamped, clearly
 * disposable title and is trashed immediately (Confluence keeps trash
 * recoverable). If any step fails, cleanup of anything already created is still
 * attempted, and the title makes a stray page easy to find and remove.
 */

/** Title of the throwaway probe page — obvious + time-stamped so a stray one
 *  (if cleanup ever fails) is unmistakable and safe to delete. Pure. */
export function buildProbeTitle(nowIso: string): string {
  return `[AI Toolkit] write-access check — safe to delete — ${nowIso}`;
}

/** Probe body. Pure. */
export function probeBody(nowIso: string): string {
  return `<p>Automated, non-destructive write-access check created by the AI Toolkit connector setup at ${nowIso}. It is deleted immediately; if you can see this, it is safe to remove.</p>`;
}

export interface WriteProbeTarget {
  /** Space scope: create the probe page directly in this space. */
  spaceKey?: string;
  /** Page scope: create the probe page as a child of this page (its space is
   *  resolved automatically). */
  parentId?: string;
}

export interface WriteProbeResult {
  ok: boolean;
  /** Capabilities actually confirmed. */
  create: boolean;
  update: boolean;
  remove: boolean;
  /** The space the probe ran in (resolved for a page-scoped target). */
  spaceKey?: string;
  pageId?: string;
  pageUrl?: string;
  /** First failing step, when not ok. */
  failedAt?: "resolve" | "create" | "update" | "delete";
  /** Server's own reason for the failure (already redacted by the http layer). */
  reason?: string;
  /** Whether the throwaway page was successfully removed (false ⇒ a stray page
   *  may remain — pageUrl points at it). */
  cleanedUp: boolean;
}

function reasonOf(err: unknown): string {
  if (err instanceof AppError) return err.userSummary ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Run create → update → delete against a throwaway page. Never throws for a
 *  permission/policy failure — it returns a structured result the setup flow
 *  reports; it only propagates truly unexpected errors via the result.reason. */
export async function probeConfluenceWriteAccess(
  source: ContextSource,
  credential: ContextCredential,
  target: WriteProbeTarget,
  timeoutMs: number,
  nowIso: string,
): Promise<WriteProbeResult> {
  const result: WriteProbeResult = { ok: false, create: false, update: false, remove: false, cleanedUp: false };

  // Resolve a space to test in. A page-scoped target creates a child under the
  // managed page (so the probe stays inside the write boundary).
  let spaceKey = target.spaceKey;
  const parentId = target.parentId;
  if (!spaceKey && parentId) {
    try {
      spaceKey = (await getConfluencePageMeta(source, credential, parentId, timeoutMs)).spaceKey;
    } catch (err) {
      return { ...result, failedAt: "resolve", reason: reasonOf(err) };
    }
  }
  if (!spaceKey) {
    return {
      ...result,
      failedAt: "resolve",
      reason: "This connector has no space/page scope to test (instance-scoped). Re-onboard it pointed at a space or page URL.",
    };
  }
  result.spaceKey = spaceKey;

  const title = buildProbeTitle(nowIso);
  let pageId: string | undefined;
  try {
    const created = await createConfluencePage(
      source,
      credential,
      { spaceKey, title, body: probeBody(nowIso), ...(parentId ? { parentId } : {}) },
      timeoutMs,
    );
    pageId = created.id;
    result.create = true;
    result.pageId = created.id;
    result.pageUrl = created.url;
  } catch (err) {
    return { ...result, failedAt: "create", reason: reasonOf(err) };
  }

  try {
    await updateConfluencePage(
      source,
      credential,
      { id: pageId, title, body: `${probeBody(nowIso)}<p>edit check</p>` },
      timeoutMs,
    );
    result.update = true;
  } catch (err) {
    result.failedAt = "update";
    result.reason = reasonOf(err);
  }

  // Always attempt cleanup, even if update failed — leave nothing behind.
  try {
    await deleteConfluencePage(source, credential, pageId, timeoutMs);
    result.remove = true;
    result.cleanedUp = true;
  } catch (err) {
    result.cleanedUp = false;
    if (!result.failedAt) {
      result.failedAt = "delete";
      result.reason = reasonOf(err);
    }
  }

  result.ok = result.create && result.update && result.remove;
  return result;
}

/** One-line, human-readable verdict for the setup notification. Pure. */
export function summarizeProbe(r: WriteProbeResult): string {
  if (r.ok) {
    return `Write access confirmed in ${r.spaceKey} — create, update and delete all succeeded (the test page was removed).`;
  }
  const step =
    r.failedAt === "resolve"
      ? "couldn't determine a space to test"
      : r.failedAt === "create"
        ? "create was refused"
        : r.failedAt === "update"
          ? "update was refused"
          : "cleanup (delete) was refused";
  const stray =
    r.create && !r.cleanedUp && r.pageUrl
      ? ` A test page may remain — remove it here: ${r.pageUrl}.`
      : "";
  return `Write access is NOT fully available${r.spaceKey ? ` in ${r.spaceKey}` : ""}: ${step}.${r.reason ? ` ${r.reason}` : ""}${stray}`;
}
