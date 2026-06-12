import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseRecipients,
  recipientIssue,
  draftIssue,
  draftLabel,
  MAX_RECIPIENTS,
  MAX_BODY_CHARS,
} from "../src/comms/outbox";

test("parseRecipients splits on commas/semicolons/whitespace, dedupes case-insensitively", () => {
  assert.deepEqual(
    parseRecipients("jdoe@corp.example, ASmith@corp.example; jdoe@CORP.example  <x@y.example>"),
    ["jdoe@corp.example", "ASmith@corp.example", "x@y.example"],
  );
  assert.deepEqual(parseRecipients("  "), []);
});

test("recipientIssue enforces presence, the individuals cap, and email shape", () => {
  assert.match(recipientIssue([]) ?? "", /at least one/);
  assert.equal(recipientIssue(["a@b.example"]), undefined);
  assert.match(recipientIssue(["not-an-email"]) ?? "", /doesn't look like/);
  const tooMany = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.example`);
  assert.match(recipientIssue(tooMany) ?? "", /individuals, not broadcasts/);
});

test("draftIssue: outlook requires a subject; bodies are required and capped", () => {
  const base = { channel: "teams" as const, to: ["a@b.example"], body: "hi" };
  assert.equal(draftIssue(base), undefined);
  assert.match(draftIssue({ ...base, body: "  " }) ?? "", /body is empty/);
  assert.match(draftIssue({ ...base, body: "x".repeat(MAX_BODY_CHARS + 1) }) ?? "", /too long/i);
  assert.match(
    draftIssue({ channel: "outlook", to: ["a@b.example"], body: "hi" }) ?? "",
    /need a subject/,
  );
  assert.equal(
    draftIssue({ channel: "outlook", to: ["a@b.example"], subject: "Update", body: "hi" }),
    undefined,
  );
});

test("draftLabel prefers the subject and truncates long bodies", () => {
  assert.equal(draftLabel({ subject: "Q3 update", body: "..." }), "Q3 update");
  const label = draftLabel({ body: "word ".repeat(40) });
  assert.ok(label.length <= 60);
  assert.ok(label.endsWith("…"));
});

test("explainCommsError names the three enterprise causes; unknown errors pass through", async () => {
  const { explainCommsError } = await import("../src/comms/outbox");
  assert.match(
    explainCommsError("AADSTS65001: The user or administrator has not consented") ?? "",
    /Mail\.ReadWrite \+ Mail\.Send/,
  );
  assert.match(
    explainCommsError("MailboxNotEnabledForRESTAPI: REST API is not yet supported for this mailbox") ?? "",
    /Exchange Online (license|mailbox)/i,
  );
  assert.match(explainCommsError("AADSTS53003: Access blocked by Conditional Access") ?? "", /tenant policy/i);
  assert.match(explainCommsError("Graph request failed (403 Forbidden): x") ?? "", /Mail\.ReadWrite/);
  assert.equal(explainCommsError("ETIMEDOUT"), undefined);
});
