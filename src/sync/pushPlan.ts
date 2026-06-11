/**
 * Push planner (ADR-0021 §4): artifact-level diff between the repo's desired
 * state and the live site's current snapshot, producing an ordered, reviewable
 * operation list. Conservative by construction:
 *  - matching is by identity (list displayName / page name), case-insensitive;
 *  - deletions are collected separately and only included on explicit opt-in;
 *  - system lists (non-genericList templates) are never deletable;
 *  - lookup/calculated columns become warnings, not operations;
 *  - renames are out of scope (a renamed artifact appears as create + orphan).
 * Pure module — heavily unit-tested.
 */

import { SiteSnapshotInput } from "./serializer";
import { sanitizeForSnapshot, stableStringify } from "./snapshotSanitize";
import { DesiredState, DesiredColumn, DesiredList } from "./desiredState";

export type PushOp =
  | { kind: "createList"; displayName: string; description: string; template: string }
  | { kind: "updateList"; listId: string; displayName: string; description: string }
  | { kind: "addColumn"; listId: string; listName: string; column: DesiredColumn }
  | { kind: "updateColumn"; listId: string; listName: string; columnId: string; column: DesiredColumn }
  | { kind: "createPage"; name: string; title: string; pageLayout: string; canvasLayout: unknown | null }
  | { kind: "updatePage"; pageId: string; name: string; title: string; canvasLayout: unknown | null }
  | { kind: "deleteList"; listId: string; displayName: string }
  | { kind: "deletePage"; pageId: string; name: string };

export interface PushPlan {
  /** Ordered non-destructive operations. */
  ops: PushOp[];
  /** Destructive operations — applied only with explicit opt-in. */
  deletions: PushOp[];
  warnings: string[];
  unchanged: { lists: number; pages: number };
}

/** Column facet keys Graph accepts on creation; read-only props are dropped. */
const CREATABLE_COLUMN_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "required",
  "indexed",
  "enforceUniqueValues",
  "hidden",
  "text",
  "choice",
  "number",
  "currency",
  "dateTime",
  "boolean",
  "personOrGroup",
  "hyperlinkOrPicture",
  "term",
  "thumbnail",
  "geolocation",
  "defaultValue",
]);

const COMPLEX_FACETS = ["lookup", "calculated"];

/** Strip read-only/server-assigned properties from a pulled column. */
export function columnToCreatable(column: DesiredColumn): DesiredColumn {
  const out: DesiredColumn = { name: column.name };
  for (const [key, value] of Object.entries(column)) {
    if (CREATABLE_COLUMN_KEYS.has(key) && value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Canonical canvas comparison: volatile fields stripped, stable encoding. */
export function canvasEquals(a: unknown, b: unknown): boolean {
  return (
    stableStringify(sanitizeForSnapshot(a ?? null)) ===
    stableStringify(sanitizeForSnapshot(b ?? null))
  );
}

interface CurrentColumn {
  name?: string;
  id?: string;
  displayName?: string;
  description?: string;
  required?: boolean;
  readOnly?: boolean;
  [k: string]: unknown;
}

function columnNeedsUpdate(desired: DesiredColumn, current: CurrentColumn): boolean {
  const fields: Array<keyof DesiredColumn & string> = ["displayName", "description", "required"];
  return fields.some(
    (f) => desired[f] !== undefined && desired[f] !== (current as DesiredColumn)[f],
  );
}

export function buildPushPlan(
  desired: DesiredState,
  current: SiteSnapshotInput,
): PushPlan {
  const plan: PushPlan = {
    ops: [],
    deletions: [],
    warnings: [...desired.warnings],
    unchanged: { lists: 0, pages: 0 },
  };

  // ---- lists ---------------------------------------------------------------
  const liveLists = new Map(current.lists.map((l) => [norm(l.displayName), l]));
  const desiredListNames = new Set(desired.lists.map((l) => norm(l.displayName)));

  for (const want of desired.lists) {
    const live = liveLists.get(norm(want.displayName));
    if (!live) {
      plan.ops.push({
        kind: "createList",
        displayName: want.displayName,
        description: want.description,
        template: want.template,
      });
      // Columns for a new list are created after the list itself; lookups flagged.
      for (const col of want.columns) {
        queueColumnForNewList(plan, want, col);
      }
      continue;
    }

    let listChanged = 0;
    const liveDesc = (live as { description?: string }).description ?? "";
    if (want.description !== liveDesc) {
      plan.ops.push({
        kind: "updateList",
        listId: live.id,
        displayName: want.displayName,
        description: want.description,
      });
      listChanged++;
    }

    const liveCols = new Map(
      ((live.columns ?? []) as CurrentColumn[])
        .filter((c) => typeof c.name === "string")
        .map((c) => [norm(c.name as string), c]),
    );
    for (const col of want.columns) {
      const complex = COMPLEX_FACETS.find((f) => col[f] !== undefined);
      const liveCol = liveCols.get(norm(col.name));
      if (!liveCol) {
        if (complex) {
          plan.warnings.push(
            `${want.displayName}: column "${col.name}" is a ${complex} column — create it manually (cross-list references are not auto-created).`,
          );
        } else {
          plan.ops.push({
            kind: "addColumn",
            listId: live.id,
            listName: want.displayName,
            column: columnToCreatable(col),
          });
          listChanged++;
        }
      } else if (!liveCol.readOnly && columnNeedsUpdate(col, liveCol)) {
        plan.ops.push({
          kind: "updateColumn",
          listId: live.id,
          listName: want.displayName,
          columnId: String(liveCol.id ?? liveCol.name),
          column: {
            name: col.name,
            ...(col.displayName !== undefined ? { displayName: col.displayName } : {}),
            ...(col.description !== undefined ? { description: col.description } : {}),
            ...(col.required !== undefined ? { required: col.required } : {}),
          },
        });
        listChanged++;
      }
    }
    if (listChanged === 0) plan.unchanged.lists++;
  }

  for (const live of current.lists) {
    if (!desiredListNames.has(norm(live.displayName))) {
      if ((live.template ?? "genericList") === "genericList") {
        plan.deletions.push({
          kind: "deleteList",
          listId: live.id,
          displayName: live.displayName,
        });
      } else {
        plan.warnings.push(
          `List "${live.displayName}" (${live.template}) exists in SharePoint but not in the repo — system/library lists are never deleted by push.`,
        );
      }
    }
  }

  // ---- pages ---------------------------------------------------------------
  const pageKey = (name: string | undefined, title: string) => norm(name || title);
  const livePages = new Map(current.pages.map((p) => [pageKey(p.name, p.title), p]));
  const desiredPageNames = new Set(desired.pages.map((p) => pageKey(p.name, p.title)));

  for (const want of desired.pages) {
    const live = livePages.get(pageKey(want.name, want.title));
    if (!live) {
      plan.ops.push({
        kind: "createPage",
        name: want.name,
        title: want.title,
        pageLayout: want.pageLayout,
        canvasLayout: want.canvasLayout,
      });
      continue;
    }
    const titleChanged = want.title !== live.title;
    const canvasChanged =
      want.canvasLayout !== null && !canvasEquals(want.canvasLayout, live.canvasLayout ?? null);
    if (titleChanged || canvasChanged) {
      plan.ops.push({
        kind: "updatePage",
        pageId: live.id,
        name: want.name,
        title: want.title,
        canvasLayout: canvasChanged ? want.canvasLayout : null,
      });
    } else {
      plan.unchanged.pages++;
    }
  }

  for (const live of current.pages) {
    if (!desiredPageNames.has(pageKey(live.name, live.title))) {
      plan.deletions.push({
        kind: "deletePage",
        pageId: live.id,
        name: live.name ?? live.title,
      });
    }
  }

  if (current.pagesUnavailable && desired.pages.length > 0) {
    plan.warnings.push(
      "The tenant blocks the Pages API for this account — page operations were planned blind and may fail.",
    );
  }
  return plan;
}

function queueColumnForNewList(plan: PushPlan, list: DesiredList, col: DesiredColumn): void {
  const complex = COMPLEX_FACETS.find((f) => col[f] !== undefined);
  if (complex) {
    plan.warnings.push(
      `${list.displayName}: column "${col.name}" is a ${complex} column — create it manually after the list exists.`,
    );
    return;
  }
  // listId is unknown until the list is created; the engine resolves the
  // placeholder by displayName after createList succeeds.
  plan.ops.push({
    kind: "addColumn",
    listId: `new:${list.displayName}`,
    listName: list.displayName,
    column: columnToCreatable(col),
  });
}

export function hasWork(plan: PushPlan, includeDeletions: boolean): boolean {
  return plan.ops.length > 0 || (includeDeletions && plan.deletions.length > 0);
}

/** Human preview for the confirmation document. */
export function renderPushPlan(
  siteName: string,
  plan: PushPlan,
  includeDeletions: boolean,
): string {
  const label = (op: PushOp): string => {
    switch (op.kind) {
      case "createList":
        return `create list **${op.displayName}** (${op.template})`;
      case "updateList":
        return `update list **${op.displayName}** (description)`;
      case "addColumn":
        return `add column \`${op.column.name}\` to **${op.listName}**`;
      case "updateColumn":
        return `update column \`${op.column.name}\` on **${op.listName}**`;
      case "createPage":
        return `create page **${op.name}**${op.canvasLayout ? " (with canvas)" : ""}`;
      case "updatePage":
        return `update page **${op.name}**${op.canvasLayout ? " (canvas)" : " (title)"}`;
      case "deleteList":
        return `DELETE list **${op.displayName}**`;
      case "deletePage":
        return `DELETE page **${op.name}**`;
    }
  };
  return [
    `# Write-back preview — ${siteName}`,
    "",
    "> Nothing has been applied. Confirm in the dialog to write these changes to SharePoint.",
    "> A safety snapshot (pull + commit) is taken first, and the site is re-checked for drift.",
    "",
    `**Operations (${plan.ops.length}):**`,
    ...(plan.ops.length ? plan.ops.map((o) => `- ${label(o)}`) : ["- _none_"]),
    "",
    `**Deletions (${plan.deletions.length}) — ${includeDeletions ? "WILL be applied" : "skipped (not opted in)"}:**`,
    ...(plan.deletions.length ? plan.deletions.map((o) => `- ${label(o)}`) : ["- _none_"]),
    "",
    ...(plan.warnings.length
      ? [`**Warnings (${plan.warnings.length}):**`, ...plan.warnings.map((w) => `- ⚠️ ${w}`), ""]
      : []),
    `${plan.unchanged.lists} list(s) and ${plan.unchanged.pages} page(s) already match.`,
    "",
    "_Out of scope for write-back: navigation, theme, renames, column deletion/retyping, list items/documents, permissions._",
  ].join("\n");
}
