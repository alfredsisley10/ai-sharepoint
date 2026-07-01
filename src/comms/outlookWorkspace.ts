/**
 * Read-only Outlook "workspace" (ADR-0025 extension). The user designates an
 * Outlook folder as a workspace; @sharepoint can then READ mail (and the
 * calendar) using the SAME Microsoft 365 sign-in that sends drafts — no separate
 * connector or credentials. A subject-based mail rule moves replies into the
 * workspace folder so a conversation stays collected.
 *
 * Access is scoped: `workspace` reads only the workspace folder; `mailbox` reads
 * across the whole mailbox. Reads never mutate mail; the only writes are
 * creating the folder and (on request) the move-replies rule — both explicit.
 *
 * Pure types + helpers here (unit-tested); the vscode persistence wrapper is in
 * outlookWorkspaceStore.ts and the Graph calls are in commsClient.ts.
 */

export type OutlookReadScope = "workspace" | "mailbox";

export interface OutlookWorkspace {
  /** The comms connection (cacheHandle) this workspace belongs to. */
  connectionHandle: string;
  /** Graph mailFolder id of the workspace folder. */
  folderId: string;
  folderName: string;
  /** How much mail @sharepoint may read: just the folder, or the whole mailbox. */
  readScope: OutlookReadScope;
  /** Subjects we've set up move-replies rules for (display/dedup only). */
  trackedSubjects: string[];
  createdAt: string;
  updatedAt: string;
}

export const MAIL_READ_DEFAULT_TOP = 25;
export const MAIL_READ_MAX_TOP = 100;
/** Graph messageRule.displayName is bounded; keep our generated names short. */
export const RULE_NAME_MAX = 120;

/** Clamp a requested page size into Graph-friendly bounds. */
export function clampTop(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n < 1) return MAIL_READ_DEFAULT_TOP;
  return Math.min(Math.floor(n), MAIL_READ_MAX_TOP);
}

/** The Graph path for reading recent messages under the active scope. Workspace
 *  scope reads the folder; mailbox scope reads all messages. Newest first. */
export function messagesPath(scope: OutlookReadScope, folderId: string, top: number): string {
  const n = clampTop(top);
  const select = "$select=subject,from,receivedDateTime,isRead,bodyPreview,webLink";
  const order = "$orderby=receivedDateTime desc";
  const base =
    scope === "workspace"
      ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages`
      : "/me/messages";
  return `${base}?${select}&${order}&$top=${n}`;
}

/** A calendar window [now, now+days] as ISO strings for Graph calendarView. */
export function calendarWindow(nowIso: string, days: number): { startIso: string; endIso: string } {
  const start = new Date(nowIso);
  const end = new Date(start.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function calendarViewPath(startIso: string, endIso: string, top: number): string {
  const n = clampTop(top);
  const select = "$select=subject,organizer,start,end,location,isAllDay,webLink";
  const order = "$orderby=start/dateTime";
  return `/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}&${select}&${order}&$top=${n}`;
}

/** Normalize a subject for a rule's match + name (trim, strip Re:/Fwd:, collapse). */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/i, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Graph `messageRule` body that moves any message whose subject contains
 *  `subject` into the workspace folder. Pure — unit-tested. */
export function buildSubjectMoveRule(
  subject: string,
  folderId: string,
  folderName: string,
  sequence: number,
): {
  displayName: string;
  sequence: number;
  isEnabled: true;
  conditions: { subjectContains: string[] };
  actions: { moveToFolder: string; stopProcessingRules: boolean };
} {
  const norm = normalizeSubject(subject) || subject.trim();
  const name = `AI SharePoint → ${folderName}: ${norm}`.slice(0, RULE_NAME_MAX);
  return {
    displayName: name,
    sequence: Math.max(1, Math.floor(sequence) || 1),
    isEnabled: true,
    conditions: { subjectContains: [norm] },
    actions: { moveToFolder: folderId, stopProcessingRules: false },
  };
}

/** Add a tracked subject (normalized, deduped, case-insensitive). */
export function withTrackedSubject(subjects: string[], subject: string): string[] {
  const norm = normalizeSubject(subject);
  if (!norm) return subjects;
  const exists = subjects.some((s) => s.toLowerCase() === norm.toLowerCase());
  return exists ? subjects : [...subjects, norm];
}

export interface MailMessageView {
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  isRead?: boolean;
  bodyPreview?: string;
  webLink?: string;
}

export interface CalendarEventView {
  subject?: string;
  organizer?: { emailAddress?: { name?: string } };
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  isAllDay?: boolean;
  webLink?: string;
}

/** Render a read-only mail digest as Markdown (newest first). Pure. */
export function renderMailDigest(label: string, messages: MailMessageView[]): string {
  if (messages.length === 0) return `# Outlook — ${label}\n\n_No messages._`;
  const rows = messages.map((m) => {
    const who = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown";
    const when = m.receivedDateTime ? m.receivedDateTime.replace("T", " ").slice(0, 16) : "";
    const dot = m.isRead ? "" : "● ";
    const subj = (m.subject || "(no subject)").replace(/\n/g, " ");
    const preview = (m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 140);
    return `- ${dot}**${subj}** — ${who} _(${when})_${preview ? `\n  > ${preview}` : ""}`;
  });
  return [`# Outlook — ${label}`, "", `_${messages.length} message(s), newest first. Read-only._`, "", ...rows].join("\n");
}

/** Render a read-only calendar digest as Markdown. Pure. */
export function renderCalendarDigest(label: string, events: CalendarEventView[]): string {
  if (events.length === 0) return `# Outlook calendar — ${label}\n\n_No events in this window._`;
  const rows = events.map((e) => {
    const when = e.start?.dateTime ? e.start.dateTime.replace("T", " ").slice(0, 16) : "";
    const subj = (e.subject || "(no title)").replace(/\n/g, " ");
    const org = e.organizer?.emailAddress?.name ? ` — ${e.organizer.emailAddress.name}` : "";
    const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
    return `- **${subj}** _(${when}${e.isAllDay ? ", all day" : ""})_${org}${loc}`;
  });
  return [`# Outlook calendar — ${label}`, "", `_${events.length} event(s). Read-only._`, "", ...rows].join("\n");
}
