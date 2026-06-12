/**
 * Communication Channels (ADR-0025): drafts for Microsoft Teams chat and
 * Outlook email are PREPARED — by the user or by the assistant — into a
 * local outbox, and NOTHING is sent until the user explicitly approves a
 * specific draft in a dialog that shows channel, recipients, and body.
 * Pure model + validation; persistence and Graph calls live elsewhere.
 */

export type CommChannel = "teams" | "outlook";

export interface CommDraft {
  id: string;
  channel: CommChannel;
  /** Recipient emails/UPNs — resolved against the directory at send time. */
  to: string[];
  /** Outlook only (required there). */
  subject?: string;
  /** Plain text. */
  body: string;
  createdAt: string;
  /** Who prepared it — the assistant can only ever prepare. */
  origin: "user" | "agent";
  /** Agent's one-line rationale, shown during approval. */
  reason?: string;
}

export const MAX_RECIPIENTS = 10;
export const MAX_BODY_CHARS = 10_000;
export const MAX_SUBJECT_CHARS = 200;

const RECIPIENT_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** Split a human-entered recipient list (",", ";", whitespace), dedupe
 *  case-insensitively, preserve first-seen casing. */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const r = part.trim().replace(/^<|>$/g, "");
    if (!r) continue;
    const key = r.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function recipientIssue(recipients: string[]): string | undefined {
  if (recipients.length === 0) return "Add at least one recipient (email/UPN).";
  if (recipients.length > MAX_RECIPIENTS) {
    return `At most ${MAX_RECIPIENTS} recipients — communications are aimed at individuals, not broadcasts.`;
  }
  const bad = recipients.find((r) => !RECIPIENT_RE.test(r));
  if (bad) return `"${bad}" doesn't look like an email/UPN.`;
  return undefined;
}

/** Validate a draft-to-be. Returns a human-readable problem or undefined. */
export function draftIssue(
  draft: Pick<CommDraft, "channel" | "to" | "subject" | "body">,
): string | undefined {
  const recipientProblem = recipientIssue(draft.to);
  if (recipientProblem) return recipientProblem;
  if (!draft.body.trim()) return "The message body is empty.";
  if (draft.body.length > MAX_BODY_CHARS) {
    return `Body too long (${draft.body.length} > ${MAX_BODY_CHARS} characters).`;
  }
  if (draft.channel === "outlook" && !draft.subject?.trim()) {
    return "Email drafts need a subject.";
  }
  if ((draft.subject?.length ?? 0) > MAX_SUBJECT_CHARS) {
    return `Subject too long (max ${MAX_SUBJECT_CHARS} characters).`;
  }
  return undefined;
}

/** One-line outbox label: subject, or the body's first words. */
export function draftLabel(draft: Pick<CommDraft, "subject" | "body">): string {
  const text = draft.subject?.trim() || draft.body.trim().replace(/\s+/g, " ");
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Translate raw Graph/MSAL failures from the Communications flow into the
 *  three actionable enterprise causes (pilot: "can't connect to Outlook"). */
export function explainCommsError(message: string): string | undefined {
  if (/AADSTS65001|AADSTS650057|consent_required|invalid_grant.*consent|AADSTS90008|access_denied.*consent/i.test(message)) {
    return "Your Microsoft 365 app registration has not been granted the Communications permissions. An admin must add delegated Mail.ReadWrite + Mail.Send (and Chat.ReadWrite for Teams) to the app and grant consent — Admin Guide §4 has the exact steps.";
  }
  if (/MailboxNotEnabledForRESTAPI|mailbox is (either )?inactive|REST API is not yet supported for this mailbox|ErrorAccessDenied.*mailbox/i.test(message)) {
    return "This account has no Exchange Online mailbox reachable via Microsoft Graph — it may lack an Exchange Online license, or the mailbox is on-premises (hybrid). Drafts can only be created in cloud mailboxes.";
  }
  if (/AADSTS53003|conditional access|AADSTS50105|blocked by .*policy/i.test(message)) {
    return "A tenant policy (conditional access / app assignment) is blocking this sign-in app from using mail scopes. Ask your admin to allow the app for Exchange/Graph mail, or register a dedicated app (Admin Guide §4).";
  }
  if (/graph request failed \(403/i.test(message)) {
    return "Microsoft Graph returned 403 for the mailbox — usually missing Mail.ReadWrite/Mail.Send consent on the app registration (Admin Guide §4), or an Exchange application access policy.";
  }
  return undefined;
}
