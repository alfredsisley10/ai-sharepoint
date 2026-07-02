/**
 * Remediation work inventory (info-sprawl cleanup, ADR-0045).
 *
 * A local, exportable backlog of cleanup work: each finding (an inaccurate /
 * inconsistent / stale page, or an authoritative-source fix) becomes a
 * WorkItem whose entire life is an **append-only event log** — creation, owner
 * resolution, every communication drafted/sent, every follow-up scheduled and
 * sent, status changes, and final resolution. The denormalized `status` and
 * `followUpDueAt` are always *derived* from the events (via `applyEvent`), so
 * the history is the source of truth and nothing is lost.
 *
 * Pure by design (IO — ids, timestamps — is injected) so it is fully unit
 * tested; the vscode persistence wrapper is `workItemsStore.ts`. Export/import
 * (schema `work-items/v1`) lets a user back up progress and restart, or merge
 * two people's backlogs by unioning event logs.
 */

export type WorkItemStatus = "open" | "notified" | "in_progress" | "resolved" | "wont_fix";

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "open",
  "notified",
  "in_progress",
  "resolved",
  "wont_fix",
];

export type WorkItemTargetKind = "confluence" | "sharepoint" | "servicenow" | "file" | "other";

export type WorkItemEventKind =
  | "created"
  | "note"
  | "owner_resolved"
  | "communication"
  | "followup_scheduled"
  | "followup_sent"
  | "status_changed"
  | "resolved"
  | "reopened";

export interface WorkItemOwner {
  sam?: string;
  displayName?: string;
  /** Email or UPN — how to reach them (from the user directory, ADR-0041). */
  contact?: string;
  /** How ownership was determined (label / page-contributor / …). */
  basis?: string;
}

export interface WorkItemTarget {
  /** Source alias/displayName the finding lives in. */
  source: string;
  kind: WorkItemTargetKind;
  /** Page id / sys_id / server-relative path — enough to re-locate it. */
  ref?: string;
  url?: string;
}

/** One immutable entry in a work item's history. */
export interface WorkItemEvent {
  id: string;
  /** ISO timestamp — events are ordered and folded by this. */
  at: string;
  kind: WorkItemEventKind;
  by: "user" | "ai";
  /** Human-readable summary of the step. */
  detail?: string;
  /** communication: which channel + who + the linked outbox draft. */
  channel?: "outlook" | "teams";
  recipient?: string;
  draftId?: string;
  /** followup_scheduled: when the next follow-up is due. */
  dueAt?: string;
  /** status_changed / resolved / reopened: the new status. */
  toStatus?: WorkItemStatus;
  /** owner_resolved: the resolved owner. */
  owner?: WorkItemOwner;
}

export interface WorkItem {
  id: string;
  /** Short label of the finding. */
  title: string;
  /** What is wrong / needs correcting. */
  finding: string;
  target: WorkItemTarget;
  /** The authoritative topic this conflicts with, if any. */
  authorityTopic?: string;
  /** Evidence snippet (quote of the offending / conflicting content). */
  evidence?: string;
  owner?: WorkItemOwner;
  /** Derived from events; never set directly. */
  status: WorkItemStatus;
  /** Derived: the pending follow-up due date (undefined once sent/resolved). */
  followUpDueAt?: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  /** Append-only history — the source of truth for status/owner/followUpDueAt. */
  events: WorkItemEvent[];
}

export interface NewWorkItem {
  title: string;
  finding: string;
  target: WorkItemTarget;
  authorityTopic?: string;
  evidence?: string;
  owner?: WorkItemOwner;
  tags?: string[];
}

const TITLE_MAX = 160;
const FINDING_MAX = 4000;

/** Validate a new work item; returns a message or undefined. */
export function workItemIssue(input: Partial<NewWorkItem>): string | undefined {
  if (!input.title || !input.title.trim()) return "A work item needs a title.";
  if (input.title.length > TITLE_MAX) return `Title must be ≤ ${TITLE_MAX} characters.`;
  if (!input.finding || !input.finding.trim()) return "A work item needs a description of what's wrong.";
  if (input.finding.length > FINDING_MAX) return `The finding must be ≤ ${FINDING_MAX} characters.`;
  if (!input.target || !input.target.source || !input.target.source.trim()) {
    return "A work item needs a target source (where the content lives).";
  }
  return undefined;
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Build an event (pure — id/timestamp injected). */
export function workItemEvent(
  id: string,
  at: string,
  kind: WorkItemEventKind,
  by: "user" | "ai",
  extra: Omit<WorkItemEvent, "id" | "at" | "kind" | "by"> = {},
): WorkItemEvent {
  return clean({ id, at, kind, by, ...extra });
}

/**
 * Fold one event onto an item: append it to history, bump updatedAt, and
 * re-derive the denormalized status / owner / followUpDueAt. The ONLY way an
 * item changes — so the event log always fully explains the current state.
 */
export function applyEvent(item: WorkItem, event: WorkItemEvent): WorkItem {
  const next: WorkItem = {
    ...item,
    events: [...item.events, event],
    updatedAt: event.at >= item.updatedAt ? event.at : item.updatedAt,
  };
  if (event.toStatus) next.status = event.toStatus;
  if (event.kind === "owner_resolved" && event.owner) next.owner = event.owner;
  if (event.kind === "followup_scheduled" && event.dueAt) {
    next.followUpDueAt = event.dueAt;
  } else if (event.kind === "followup_sent" || event.kind === "resolved") {
    delete next.followUpDueAt;
  }
  return next;
}

/** Create a work item with its opening `created` event. */
export function createWorkItem(input: NewWorkItem, id: string, eventId: string, nowIso: string): WorkItem {
  const base: WorkItem = clean({
    id,
    title: input.title.trim(),
    finding: input.finding.trim(),
    target: clean({ ...input.target, source: input.target.source.trim() }),
    authorityTopic: input.authorityTopic?.trim() || undefined,
    evidence: input.evidence?.trim() || undefined,
    owner: input.owner,
    status: "open" as WorkItemStatus,
    createdAt: nowIso,
    updatedAt: nowIso,
    tags: input.tags?.length ? input.tags : undefined,
    events: [],
  });
  const created = workItemEvent(eventId, nowIso, "created", "user", { detail: `Created: ${base.title}` });
  const withCreated = applyEvent(base, created);
  return input.owner
    ? applyEvent(
        withCreated,
        workItemEvent(`${eventId}-o`, nowIso, "owner_resolved", "user", {
          owner: input.owner,
          detail: ownerSummary(input.owner),
        }),
      )
    : withCreated;
}

function ownerSummary(owner: WorkItemOwner): string {
  const who = owner.displayName ?? owner.sam ?? owner.contact ?? "unknown";
  return `Owner: ${who}${owner.basis ? ` (${owner.basis})` : ""}`;
}

/** Recompute an item's derived fields purely from its event log (used when
 *  merging two backlogs, or to repair a persisted item). Events are re-sorted
 *  by timestamp then id for a stable, deterministic fold. */
export function rebuildWorkItem(item: WorkItem): WorkItem {
  const sorted = [...item.events].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id),
  );
  let acc: WorkItem = { ...item, status: "open", events: [] };
  delete acc.owner;
  delete acc.followUpDueAt;
  acc.updatedAt = item.createdAt;
  for (const e of sorted) acc = applyEvent(acc, e);
  return acc;
}

/** Is a follow-up due (scheduled and past due) as of nowMs? */
export function isFollowUpDue(item: WorkItem, nowMs: number): boolean {
  if (!item.followUpDueAt) return false;
  if (item.status === "resolved" || item.status === "wont_fix") return false;
  return Date.parse(item.followUpDueAt) <= nowMs;
}

/** All open items whose follow-up is due, soonest first. */
export function dueFollowUps(items: WorkItem[], nowMs: number): WorkItem[] {
  return items
    .filter((i) => isFollowUpDue(i, nowMs))
    .sort((a, b) => Date.parse(a.followUpDueAt!) - Date.parse(b.followUpDueAt!));
}

/** Count items by status (for a backlog summary). */
export function statusCounts(items: WorkItem[]): Record<WorkItemStatus, number> {
  const out: Record<WorkItemStatus, number> = {
    open: 0,
    notified: 0,
    in_progress: 0,
    resolved: 0,
    wont_fix: 0,
  };
  for (const i of items) out[i.status] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Export / import — back up progress and restart, or merge two backlogs.
// ---------------------------------------------------------------------------

export const WORK_ITEMS_SCHEMA = "work-items/v1";

export interface WorkItemsExport {
  schema: typeof WORK_ITEMS_SCHEMA;
  exportedAt: string;
  items: WorkItem[];
}

export function buildWorkItemsExport(items: WorkItem[], exportedAt: string): WorkItemsExport {
  return { schema: WORK_ITEMS_SCHEMA, exportedAt, items };
}

export function isWorkItemsExport(x: unknown): x is WorkItemsExport {
  return (
    !!x &&
    typeof x === "object" &&
    (x as WorkItemsExport).schema === WORK_ITEMS_SCHEMA &&
    Array.isArray((x as WorkItemsExport).items)
  );
}

/** Coerce an unknown into a WorkItem, or undefined if unusable. Rebuilds the
 *  derived fields from the events so an import is always internally consistent. */
export function coerceWorkItem(raw: unknown): WorkItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<WorkItem>;
  if (!r.id || !r.title || !r.target?.source || !Array.isArray(r.events)) return undefined;
  const item: WorkItem = {
    id: String(r.id),
    title: String(r.title),
    finding: String(r.finding ?? ""),
    target: { source: String(r.target.source), kind: (r.target.kind ?? "other") as WorkItemTargetKind, ...clean({ ref: r.target.ref, url: r.target.url }) },
    status: "open",
    createdAt: String(r.createdAt ?? r.events[0]?.at ?? new Date(0).toISOString()),
    updatedAt: String(r.updatedAt ?? r.createdAt ?? ""),
    events: r.events.filter((e): e is WorkItemEvent => Boolean(e && (e as WorkItemEvent).id && (e as WorkItemEvent).at)),
    ...clean({ authorityTopic: r.authorityTopic, evidence: r.evidence, tags: r.tags?.length ? r.tags : undefined }),
  };
  // If there were no usable events, keep a minimal record consistent.
  return item.events.length ? rebuildWorkItem(item) : { ...item, updatedAt: item.createdAt };
}

export interface WorkItemsImportResult {
  items: WorkItem[];
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Import a backlog. `replace` = restore-from-backup (imported set wins
 * wholesale). `merge` = combine with the existing backlog by id, **unioning
 * event logs** (dedup by event id) and rebuilding — so two people who worked
 * the same items don't clobber each other's history.
 */
export function importWorkItems(
  raw: unknown,
  existing: WorkItem[],
  mode: "replace" | "merge",
): WorkItemsImportResult {
  if (!isWorkItemsExport(raw)) {
    throw new Error(`Not a ${WORK_ITEMS_SCHEMA} export.`);
  }
  const incoming = raw.items.map(coerceWorkItem).filter((x): x is WorkItem => Boolean(x));
  if (mode === "replace") {
    return { items: incoming, added: incoming.length, updated: 0, skipped: raw.items.length - incoming.length };
  }
  const byId = new Map(existing.map((i) => [i.id, i]));
  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    const cur = byId.get(inc.id);
    if (!cur) {
      byId.set(inc.id, inc);
      added += 1;
      continue;
    }
    const seen = new Set(cur.events.map((e) => e.id));
    const merged = [...cur.events, ...inc.events.filter((e) => !seen.has(e.id))];
    if (merged.length !== cur.events.length) {
      byId.set(inc.id, rebuildWorkItem({ ...cur, events: merged }));
      updated += 1;
    }
  }
  return { items: [...byId.values()], added, updated, skipped: raw.items.length - incoming.length };
}
