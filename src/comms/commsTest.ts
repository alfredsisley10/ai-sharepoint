/**
 * Communications verification (ADR-0025 amendment): a delivery method is
 * proven END-TO-END before it's offered. The test sends a real message
 * containing a one-time code; the user reads it where it landed and types
 * the code back, confirming the whole path works (auth/consent/webhook,
 * delivery, the right destination). Methods stay gated until verified.
 *
 * Pure helpers; the send + persistence live in the extension layer.
 */

export type CommsMethodKind = "outlook" | "teams-graph" | "teams-webhook";

/** Stable verification key per method. Webhooks verify individually (by
 *  name) — each is a distinct destination. */
export function verificationKey(kind: CommsMethodKind, name?: string): string {
  return kind === "teams-webhook" ? `teams-webhook:${(name ?? "").toLowerCase()}` : kind;
}

/** Unambiguous code: no 0/O/1/I/5/S confusion, grouped for readability. */
export function generateVerificationCode(rand: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
  let raw = "";
  for (let i = 0; i < 6; i++) raw += alphabet[Math.floor(rand() * alphabet.length)];
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

/** Lenient compare: case-insensitive, ignores spaces/dashes, maps the few
 *  look-alikes a reader might mistype back to the alphabet. */
export function codeMatches(entered: string, expected: string): boolean {
  const norm = (s: string) =>
    s
      .toUpperCase()
      .replace(/[\s-]/g, "")
      .replace(/0/g, "O")
      .replace(/1/g, "I")
      .replace(/5/g, "S");
  const e = norm(entered);
  return e.length > 0 && e === norm(expected);
}

export interface TestMessage {
  subject: string;
  body: string;
}

/** The self-test email/message body. The code is prominent and also in the
 *  subject so it's visible in a notification/preview without opening. */
export function buildTestMessage(code: string, channelLabel: string): TestMessage {
  return {
    subject: `AI SharePoint ${channelLabel} test — code ${code}`,
    body: [
      `This is an automated end-to-end test from the AI SharePoint extension.`,
      ``,
      `Verification code: ${code}`,
      ``,
      `If you received this, ${channelLabel} delivery works. Return to VS Code and enter the code to finish enabling this method. You can delete this message.`,
    ].join("\n"),
  };
}

/** Friendly "last verified" suffix for menus, or an un-verified note. */
export function verifiedLabel(verifiedAtIso: string | undefined): string {
  return verifiedAtIso ? `verified ${verifiedAtIso.slice(0, 10)}` : "not verified yet";
}
