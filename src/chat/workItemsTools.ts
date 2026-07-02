import * as vscode from "vscode";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";
import { WorkItemsStore } from "../context/workItemsStore";
import { WorkItem, WorkItemStatus, workItemIssue, WORK_ITEM_STATUSES } from "../context/workItems";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * Remediation work-inventory chat tools (ADR-0045). Let the assistant record a
 * finding, resolve/track its owner, log each communication + follow-up, resolve
 * it, and export the oversight workbook — all against the event-sourced backlog.
 * The backlog is local operational state, so these are not approval-gated (no
 * external side effects); the actual owner communications still go through the
 * approval-gated comms tools.
 */

type TargetKind = "confluence" | "sharepoint" | "servicenow" | "file" | "other";

function renderItem(i: WorkItem): string {
  const owner = i.owner ? ` · owner: ${i.owner.displayName ?? i.owner.sam ?? "?"}${i.owner.contact ? ` <${i.owner.contact}>` : ""}` : "";
  const due = i.followUpDueAt ? ` · follow-up due ${i.followUpDueAt}` : "";
  return `- [${i.status}] ${i.title} — ${i.target.source}${i.target.ref ? `/${i.target.ref}` : ""}${owner}${due} · id ${i.id}`;
}

export function registerWorkItemsTools(
  store: WorkItemsStore,
  exportInventory: (format: "xlsx" | "csv" | "both", backup: boolean) => Promise<string[]>,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  const guard = <I>(name: string, run: (i: I) => Promise<string>) => ({
    async invoke(options: vscode.LanguageModelToolInvocationOptions<I>) {
      if (releaseExpired()) return text(expiredNotice());
      try {
        return text(await run(options.input));
      } catch (e) {
        errors.capture(name, e);
        return text(`Error: ${redactError(e instanceof Error ? e : new Error(String(e))).message}`);
      }
    },
  });

  return [
    vscode.lm.registerTool<{
      title: string;
      finding: string;
      source: string;
      targetKind?: TargetKind;
      ref?: string;
      url?: string;
      authorityTopic?: string;
      evidence?: string;
      ownerSam?: string;
      ownerContact?: string;
      ownerBasis?: string;
      tags?: string[];
    }>(
      "aisharepoint_track_work_item",
      guard("aisharepoint_track_work_item", async (i) => {
        const issue = workItemIssue({ title: i.title, finding: i.finding, target: { source: i.source, kind: i.targetKind ?? "other" } });
        if (issue) return issue;
        const item = await store.create({
          title: i.title,
          finding: i.finding,
          target: { source: i.source, kind: i.targetKind ?? "other", ...(i.ref ? { ref: i.ref } : {}), ...(i.url ? { url: i.url } : {}) },
          ...(i.authorityTopic ? { authorityTopic: i.authorityTopic } : {}),
          ...(i.evidence ? { evidence: i.evidence } : {}),
          ...(i.ownerSam || i.ownerContact
            ? { owner: { ...(i.ownerSam ? { sam: i.ownerSam } : {}), ...(i.ownerContact ? { contact: i.ownerContact } : {}), ...(i.ownerBasis ? { basis: i.ownerBasis } : {}) } }
            : {}),
          ...(i.tags?.length ? { tags: i.tags } : {}),
        });
        telemetry.record("workItem.create", { kind: item.target.kind });
        return `Tracked work item ${item.id}: "${item.title}" (${item.status}).`;
      }),
    ),

    vscode.lm.registerTool<{
      id: string;
      action: "note" | "owner" | "communication" | "schedule_followup" | "followup_sent" | "status" | "resolve" | "reopen";
      detail?: string;
      ownerSam?: string;
      ownerDisplayName?: string;
      ownerContact?: string;
      ownerBasis?: string;
      channel?: "outlook" | "teams";
      recipient?: string;
      draftId?: string;
      dueAt?: string;
      status?: WorkItemStatus;
    }>(
      "aisharepoint_update_work_item",
      guard("aisharepoint_update_work_item", async (i) => {
        if (!store.get(i.id)) return `No work item with id ${i.id} — list them first.`;
        let updated: WorkItem | undefined;
        switch (i.action) {
          case "note":
            updated = await store.note(i.id, i.detail ?? "", "ai");
            break;
          case "owner":
            updated = await store.recordOwner(
              i.id,
              { ...(i.ownerSam ? { sam: i.ownerSam } : {}), ...(i.ownerDisplayName ? { displayName: i.ownerDisplayName } : {}), ...(i.ownerContact ? { contact: i.ownerContact } : {}), ...(i.ownerBasis ? { basis: i.ownerBasis } : {}) },
              "ai",
            );
            break;
          case "communication":
            updated = await store.recordCommunication(i.id, { channel: i.channel ?? "outlook", recipient: i.recipient, draftId: i.draftId, detail: i.detail, by: "ai" });
            break;
          case "schedule_followup":
            if (!i.dueAt) return "schedule_followup needs dueAt (an ISO date).";
            updated = await store.scheduleFollowUp(i.id, i.dueAt, i.detail, "ai");
            break;
          case "followup_sent":
            updated = await store.recordFollowUpSent(i.id, { channel: i.channel, recipient: i.recipient, draftId: i.draftId, detail: i.detail, by: "ai" });
            break;
          case "status":
            if (!i.status) return `status needs one of: ${WORK_ITEM_STATUSES.join(", ")}.`;
            updated = await store.changeStatus(i.id, i.status, i.detail, "ai");
            break;
          case "resolve":
            updated = await store.resolve(i.id, i.detail, "ai");
            break;
          case "reopen":
            updated = await store.reopen(i.id, i.detail, "ai");
            break;
        }
        return updated ? `Updated ${i.id} (${i.action}) → status ${updated.status}${updated.followUpDueAt ? `, follow-up due ${updated.followUpDueAt}` : ""}.` : `Could not update ${i.id}.`;
      }),
    ),

    vscode.lm.registerTool<{ filter?: "all" | "open" | "due"; status?: WorkItemStatus }>(
      "aisharepoint_list_work_items",
      guard("aisharepoint_list_work_items", async (i) => {
        let items = store.list();
        if (i.filter === "due") items = store.dueFollowUps();
        else if (i.filter === "open") items = items.filter((w) => w.status !== "resolved" && w.status !== "wont_fix");
        if (i.status) items = items.filter((w) => w.status === i.status);
        if (!items.length) return "No matching work items.";
        const counts = store.statusCounts();
        const summary = WORK_ITEM_STATUSES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ");
        return [`# Work items (${items.length} shown; backlog: ${summary || "empty"})`, ...items.map(renderItem)].join("\n");
      }),
    ),

    vscode.lm.registerTool<{ format?: "xlsx" | "csv" | "both"; backup?: boolean }>(
      "aisharepoint_export_work_inventory",
      guard("aisharepoint_export_work_inventory", async (i) => {
        if (!store.list().length) return "The backlog is empty — nothing to export.";
        const paths = await exportInventory(i.format ?? "xlsx", i.backup ?? true);
        telemetry.record("workItem.export", { format: i.format ?? "xlsx" });
        return `Exported the remediation inventory to:\n${paths.map((p) => `- ${p}`).join("\n")}`;
      }),
    ),
  ];
}
