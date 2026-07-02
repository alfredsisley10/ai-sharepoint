import { WorkItem, WorkItemEvent, statusCounts, WORK_ITEM_STATUSES } from "./workItems";
import { Sheet } from "./files/sheet";

/**
 * Oversight report (info-sprawl cleanup): render the remediation backlog into a
 * multi-sheet workbook / CSV so a lead has full visibility and can track
 * progress — a Work Items sheet (one row per finding with owner + status), a
 * History sheet (every step: communications, follow-ups, resolution), and a
 * Summary sheet (status tallies). Pure: builds string matrices from work items;
 * `xlsxWrite.buildXlsx` turns them into a workbook, `exportData.rowsToCsv` into
 * CSV. The same field definition drives both so they never diverge.
 */

const lastCommunication = (item: WorkItem): string => {
  const comms = item.events.filter((e) => e.kind === "communication" || e.kind === "followup_sent");
  const last = comms[comms.length - 1];
  return last ? `${last.at} ${last.channel ?? ""}${last.recipient ? ` → ${last.recipient}` : ""}`.trim() : "";
};

interface Field {
  header: string;
  get: (i: WorkItem) => string;
}

const ITEM_FIELDS: Field[] = [
  { header: "ID", get: (i) => i.id },
  { header: "Title", get: (i) => i.title },
  { header: "Status", get: (i) => i.status },
  { header: "Source", get: (i) => i.target.source },
  { header: "Type", get: (i) => i.target.kind },
  { header: "Ref", get: (i) => i.target.ref ?? "" },
  { header: "URL", get: (i) => i.target.url ?? "" },
  { header: "Owner", get: (i) => i.owner?.displayName ?? i.owner?.sam ?? "" },
  { header: "Owner contact", get: (i) => i.owner?.contact ?? "" },
  { header: "Owner basis", get: (i) => i.owner?.basis ?? "" },
  { header: "Authority topic", get: (i) => i.authorityTopic ?? "" },
  { header: "Follow-up due", get: (i) => i.followUpDueAt ?? "" },
  { header: "Created", get: (i) => i.createdAt },
  { header: "Updated", get: (i) => i.updatedAt },
  { header: "Finding", get: (i) => i.finding },
  { header: "Evidence", get: (i) => i.evidence ?? "" },
  { header: "Events", get: (i) => String(i.events.length) },
  { header: "Last communication", get: lastCommunication },
];

const EVENT_FIELDS: Array<{ header: string; get: (item: WorkItem, e: WorkItemEvent) => string }> = [
  { header: "Item ID", get: (item) => item.id },
  { header: "Item title", get: (item) => item.title },
  { header: "When", get: (_i, e) => e.at },
  { header: "Kind", get: (_i, e) => e.kind },
  { header: "By", get: (_i, e) => e.by },
  { header: "Detail", get: (_i, e) => e.detail ?? "" },
  { header: "Channel", get: (_i, e) => e.channel ?? "" },
  { header: "Recipient", get: (_i, e) => e.recipient ?? "" },
  { header: "Draft ID", get: (_i, e) => e.draftId ?? "" },
  { header: "→ Status", get: (_i, e) => e.toStatus ?? "" },
  { header: "Due", get: (_i, e) => e.dueAt ?? "" },
];

/** The Work Items sheet as a row matrix (header first). */
export function workItemRows(items: WorkItem[]): string[][] {
  return [ITEM_FIELDS.map((f) => f.header), ...items.map((i) => ITEM_FIELDS.map((f) => f.get(i)))];
}

/** The full event history (across all items), oldest-first per item. */
export function historyRows(items: WorkItem[]): string[][] {
  const rows: string[][] = [EVENT_FIELDS.map((f) => f.header)];
  for (const item of items) {
    const sorted = [...item.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    for (const e of sorted) rows.push(EVENT_FIELDS.map((f) => f.get(item, e)));
  }
  return rows;
}

/** A status-tally summary. */
export function summaryRows(items: WorkItem[], generatedAt: string): string[][] {
  const counts = statusCounts(items);
  return [
    ["Remediation backlog summary"],
    ["Generated", generatedAt],
    ["Total items", String(items.length)],
    [],
    ["Status", "Count"],
    ...WORK_ITEM_STATUSES.map((s) => [s, String(counts[s])]),
  ];
}

/** The Work Items sheet as record objects (for RFC-4180 CSV via rowsToCsv). */
export function workItemRecords(items: WorkItem[]): Array<Record<string, string>> {
  return items.map((i) => Object.fromEntries(ITEM_FIELDS.map((f) => [f.header, f.get(i)])));
}

/** Full workbook: Summary, Work Items, History. */
export function oversightSheets(items: WorkItem[], generatedAt: string): Sheet[] {
  return [
    { name: "Summary", rows: summaryRows(items, generatedAt) },
    { name: "Work Items", rows: workItemRows(items) },
    { name: "History", rows: historyRows(items) },
  ];
}
