import * as vscode from "vscode";
import { randomUUID } from "crypto";
import {
  WorkItem,
  WorkItemEvent,
  WorkItemEventKind,
  WorkItemOwner,
  WorkItemStatus,
  NewWorkItem,
  createWorkItem,
  applyEvent,
  workItemEvent,
  buildWorkItemsExport,
  importWorkItems,
  WorkItemsImportResult,
  dueFollowUps,
  statusCounts,
} from "./workItems";

const KEY = "aiSharePoint.workItems";

/**
 * Persists the remediation work inventory (ADR-0045). Global state so a user's
 * cleanup backlog survives folder switches, like memory/projects. All mutation
 * goes through the pure event log in `workItems.ts`; this wrapper adds ids,
 * timestamps, persistence, and export/import.
 */
export class WorkItemsStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): WorkItem[] {
    return this.state.get<WorkItem[]>(KEY) ?? [];
  }

  get(id: string): WorkItem | undefined {
    return this.list().find((i) => i.id === id);
  }

  private async save(next: WorkItem[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  private async put(item: WorkItem): Promise<WorkItem> {
    const others = this.list().filter((i) => i.id !== item.id);
    await this.save([...others, item]);
    return item;
  }

  /** Create a new work item (opens with a `created` event, and an
   *  `owner_resolved` event when an owner is supplied). */
  async create(input: NewWorkItem): Promise<WorkItem> {
    const nowIso = this.now();
    return this.put(createWorkItem(input, randomUUID(), randomUUID(), nowIso));
  }

  /** Append an arbitrary event to an item (the low-level primitive). */
  async append(
    id: string,
    kind: WorkItemEventKind,
    by: "user" | "ai",
    extra: Omit<WorkItemEvent, "id" | "at" | "kind" | "by"> = {},
  ): Promise<WorkItem | undefined> {
    const item = this.get(id);
    if (!item) return undefined;
    return this.put(applyEvent(item, workItemEvent(randomUUID(), this.now(), kind, by, extra)));
  }

  /** Record the resolved owner (from ownership + directory). */
  recordOwner(id: string, owner: WorkItemOwner, by: "user" | "ai" = "ai"): Promise<WorkItem | undefined> {
    const who = owner.displayName ?? owner.sam ?? owner.contact ?? "unknown";
    return this.append(id, "owner_resolved", by, {
      owner,
      detail: `Owner: ${who}${owner.basis ? ` (${owner.basis})` : ""}`,
    });
  }

  /** Record that a communication was prepared/sent to the owner, linking the
   *  outbox draft. Advances an untouched item to `notified`. */
  async recordCommunication(
    id: string,
    args: { channel: "outlook" | "teams"; recipient?: string; draftId?: string; detail?: string; by?: "user" | "ai" },
  ): Promise<WorkItem | undefined> {
    const item = this.get(id);
    if (!item) return undefined;
    const advance = item.status === "open";
    return this.append(id, "communication", args.by ?? "ai", {
      channel: args.channel,
      ...(args.recipient ? { recipient: args.recipient } : {}),
      ...(args.draftId ? { draftId: args.draftId } : {}),
      detail: args.detail ?? `${args.channel === "teams" ? "Teams message" : "Outlook email"} prepared${args.recipient ? ` to ${args.recipient}` : ""}`,
      ...(advance ? { toStatus: "notified" as WorkItemStatus } : {}),
    });
  }

  /** Schedule the next follow-up. */
  scheduleFollowUp(id: string, dueAt: string, detail?: string, by: "user" | "ai" = "user"): Promise<WorkItem | undefined> {
    return this.append(id, "followup_scheduled", by, { dueAt, detail: detail ?? `Follow-up due ${dueAt}` });
  }

  /** Record a follow-up was sent (clears the pending due date). */
  recordFollowUpSent(id: string, args: { channel?: "outlook" | "teams"; recipient?: string; draftId?: string; detail?: string; by?: "user" | "ai" } = {}): Promise<WorkItem | undefined> {
    return this.append(id, "followup_sent", args.by ?? "ai", {
      ...(args.channel ? { channel: args.channel } : {}),
      ...(args.recipient ? { recipient: args.recipient } : {}),
      ...(args.draftId ? { draftId: args.draftId } : {}),
      detail: args.detail ?? "Follow-up reminder sent",
    });
  }

  /** Change status explicitly (open/notified/in_progress). */
  changeStatus(id: string, toStatus: WorkItemStatus, detail?: string, by: "user" | "ai" = "user"): Promise<WorkItem | undefined> {
    return this.append(id, toStatus === "resolved" ? "resolved" : "status_changed", by, {
      toStatus,
      detail: detail ?? `Status → ${toStatus}`,
    });
  }

  /** Mark resolved (clears any pending follow-up). */
  resolve(id: string, detail?: string, by: "user" | "ai" = "user"): Promise<WorkItem | undefined> {
    return this.append(id, "resolved", by, { toStatus: "resolved", detail: detail ?? "Resolved" });
  }

  /** Reopen a resolved item. */
  reopen(id: string, detail?: string, by: "user" | "ai" = "user"): Promise<WorkItem | undefined> {
    return this.append(id, "reopened", by, { toStatus: "open", detail: detail ?? "Reopened" });
  }

  /** Free-text note on the item's history. */
  note(id: string, text: string, by: "user" | "ai" = "user"): Promise<WorkItem | undefined> {
    return this.append(id, "note", by, { detail: text });
  }

  async remove(id: string): Promise<void> {
    await this.save(this.list().filter((i) => i.id !== id));
  }

  /** Follow-ups due as of now. */
  dueFollowUps(): WorkItem[] {
    return dueFollowUps(this.list(), Date.parse(this.now()));
  }

  statusCounts(): Record<WorkItemStatus, number> {
    return statusCounts(this.list());
  }

  /** Serialize the whole backlog for backup. */
  export(): string {
    return JSON.stringify(buildWorkItemsExport(this.list(), this.now()), null, 2);
  }

  /** Restore (replace) or merge a backlog from a prior export. */
  async import(rawJson: string, mode: "replace" | "merge"): Promise<WorkItemsImportResult> {
    const parsed = JSON.parse(rawJson) as unknown;
    const result = importWorkItems(parsed, this.list(), mode);
    await this.save(result.items);
    return result;
  }
}
