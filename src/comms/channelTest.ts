/**
 * Outlook channel test (ADR-0025 amendment). Verifying that drafts really
 * reach the user's mailbox is a SELF-CONTAINED transaction: create a draft
 * addressed to the user THEMSELVES carrying a short code, have them confirm
 * it from their Drafts folder, remove the draft, report the outcome — and
 * stop. It must never flow into composing a real message; that is a separate,
 * user-initiated flow (pilot: a recipient prompt appearing right after the
 * code was verified read as one chained send transaction).
 */

export const CHANNEL_TEST_CODE_LENGTH = 6;

/** Digits from injected random bytes — pure so tests stay deterministic. */
export function channelTestCode(bytes: Uint8Array): string {
  if (bytes.length < CHANNEL_TEST_CODE_LENGTH) {
    throw new Error(`channelTestCode needs ${CHANNEL_TEST_CODE_LENGTH} random bytes`);
  }
  return Array.from(bytes.subarray(0, CHANNEL_TEST_CODE_LENGTH), (b) => String(b % 10)).join("");
}

/** The test draft's content — self-explanatory inside the mailbox. */
export function channelTestEmail(code: string): { subject: string; body: string } {
  return {
    subject: "AI SharePoint — Outlook channel test (draft only, never sent)",
    body: [
      "This draft was created by the AI SharePoint VS Code extension to verify its Outlook channel.",
      "",
      `Verification code: ${code}`,
      "",
      "It is addressed to you alone and is removed automatically when you finish the test in VS Code.",
      "If you did not run “Test Outlook Channel”, you can delete it — nothing was or will be sent.",
    ].join("\n"),
  };
}

/** Lenient match — users retype codes with stray spaces or hyphens. */
export function channelTestCodeMatches(expected: string, entered: string): boolean {
  const normalized = entered.replace(/[\s-]/g, "");
  return normalized.length > 0 && normalized === expected;
}
