import { SiteSnapshotInput, serializeSite, FileMap } from "./serializer";
import { PushPlan, PushOp } from "./pushPlan";
import { DesiredColumn } from "./desiredState";
import { AppError } from "../core/errors";

/**
 * Write-apply stage of the push pipeline (ADR-0021 §5). The command owns the
 * UX (preview, confirm, safety snapshot, closing re-pull via git); this module
 * owns the freshness gate and the sequential, stop-on-first-error apply.
 * Deliberately vscode-free (injected callbacks + duck-typed writer) so the
 * apply semantics are unit-tested with a fake writer.
 */

/** The write surface this engine needs — implemented by SharePointWriteClient. */
export interface PushWriter {
  createList(
    siteId: string,
    list: { displayName: string; description: string; template: string },
  ): Promise<{ id: string }>;
  updateList(siteId: string, listId: string, patch: { description: string }): Promise<void>;
  createColumn(siteId: string, listId: string, column: DesiredColumn): Promise<void>;
  updateColumn(
    siteId: string,
    listId: string,
    columnId: string,
    column: DesiredColumn,
  ): Promise<void>;
  createPage(
    siteId: string,
    page: { name: string; title: string; pageLayout: string; canvasLayout: unknown | null },
  ): Promise<{ id: string }>;
  updatePage(
    siteId: string,
    pageId: string,
    patch: { title?: string; canvasLayout?: unknown },
  ): Promise<void>;
  publishPage(siteId: string, pageId: string): Promise<void>;
  deleteList(siteId: string, listId: string): Promise<void>;
  deletePage(siteId: string, pageId: string): Promise<void>;
}

export interface PushOutcome {
  applied: string[];
  /** Set when apply stopped early; everything before it succeeded. */
  failedAt?: { op: string; error: string };
}

export function fileMapsEqual(a: FileMap, b: FileMap): boolean {
  if (a.size !== b.size) return false;
  for (const [path, content] of a) {
    if (b.get(path) !== content) return false;
  }
  return true;
}

export function describeOp(op: PushOp): string {
  switch (op.kind) {
    case "createList":
      return `create list "${op.displayName}"`;
    case "updateList":
      return `update list "${op.displayName}"`;
    case "addColumn":
      return `add column "${op.column.name}" to "${op.listName}"`;
    case "updateColumn":
      return `update column "${op.column.name}" on "${op.listName}"`;
    case "createPage":
      return `create page "${op.name}"`;
    case "updatePage":
      return `update page "${op.name}"`;
    case "deleteList":
      return `delete list "${op.displayName}"`;
    case "deletePage":
      return `delete page "${op.name}"`;
  }
}

/**
 * PLAN §7 push-with-freshness-check: the live site is re-read and must
 * serialize byte-identically to the snapshot the plan was built from —
 * otherwise someone changed SharePoint since the preview and we refuse to
 * write over their work.
 */
export async function assertFresh(
  gather: () => Promise<SiteSnapshotInput>,
  planBase: FileMap,
): Promise<void> {
  const liveNow = serializeSite(await gather());
  if (!fileMapsEqual(planBase, liveNow)) {
    throw new AppError(
      "The live site changed since this plan was previewed (freshness check). Pull the site, review the new state, and run write-back again.",
      "config",
      "Site changed since preview — pull and re-review.",
    );
  }
}

/** Apply ops in order; stop on the first failure (ADR-0021 §5). */
export async function applyPushPlan(
  writer: PushWriter,
  siteId: string,
  plan: PushPlan,
  includeDeletions: boolean,
  hooks?: { progress?: (msg: string) => void; log?: (msg: string) => void },
): Promise<PushOutcome> {
  const queue: PushOp[] = [...plan.ops, ...(includeDeletions ? plan.deletions : [])];
  const outcome: PushOutcome = { applied: [] };
  /** displayName → real listId for columns targeting just-created lists. */
  const createdLists = new Map<string, string>();

  for (const op of queue) {
    const label = describeOp(op);
    hooks?.progress?.(label);
    try {
      switch (op.kind) {
        case "createList": {
          const created = await writer.createList(siteId, op);
          createdLists.set(op.displayName.toLowerCase(), created.id);
          break;
        }
        case "updateList":
          await writer.updateList(siteId, op.listId, { description: op.description });
          break;
        case "addColumn": {
          let listId = op.listId;
          if (listId.startsWith("new:")) {
            const resolved = createdLists.get(listId.slice(4).toLowerCase());
            if (!resolved) {
              throw new AppError(
                `Internal ordering error: list "${op.listName}" was not created before its columns.`,
                "unknown",
              );
            }
            listId = resolved;
          }
          await writer.createColumn(siteId, listId, op.column);
          break;
        }
        case "updateColumn":
          await writer.updateColumn(siteId, op.listId, op.columnId, op.column);
          break;
        case "createPage": {
          const created = await writer.createPage(siteId, op);
          await writer.publishPage(siteId, created.id);
          break;
        }
        case "updatePage":
          await writer.updatePage(siteId, op.pageId, {
            title: op.title,
            ...(op.canvasLayout ? { canvasLayout: op.canvasLayout } : {}),
          });
          await writer.publishPage(siteId, op.pageId);
          break;
        case "deleteList":
          await writer.deleteList(siteId, op.listId);
          break;
        case "deletePage":
          await writer.deletePage(siteId, op.pageId);
          break;
      }
      outcome.applied.push(label);
      hooks?.log?.(`write-back: ${label} ✓`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hooks?.log?.(`write-back stopped at "${label}": ${message}`);
      outcome.failedAt = { op: label, error: message };
      return outcome;
    }
  }
  return outcome;
}
