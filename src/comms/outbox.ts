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
