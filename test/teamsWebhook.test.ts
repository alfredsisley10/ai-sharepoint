import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  teamsWebhookUrlIssue,
  isKnownWebhookHost,
  buildTeamsWebhookPayload,
  postTeamsWebhook,
} from "../src/comms/teamsWebhook";

test("teamsWebhookUrlIssue requires https + a token-bearing path; known hosts recognized", () => {
  assert.equal(
    teamsWebhookUrlIssue("https://acme.webhook.office.com/webhookb2/abc-def@tenant/IncomingWebhook/xyz/guid"),
    undefined,
  );
  assert.match(teamsWebhookUrlIssue("http://acme.webhook.office.com/x") ?? "", /https/);
  assert.match(teamsWebhookUrlIssue("https://acme.webhook.office.com/") ?? "", /no path/);
  assert.match(teamsWebhookUrlIssue("not a url") ?? "", /full https/);
  assert.equal(isKnownWebhookHost("https://acme.webhook.office.com/webhookb2/x"), true);
  assert.equal(isKnownWebhookHost("https://prod-12.westus.logic.azure.com/workflows/x/triggers/y"), true);
  assert.equal(isKnownWebhookHost("https://evil.example.com/x"), false);
});

test("buildTeamsWebhookPayload makes a MessageCard with recipients/origin as facts", () => {
  const card = buildTeamsWebhookPayload({
    body: "Deploy finished at 14:05.",
    title: "Release 2.1",
    to: ["jdoe@corp.example", "asmith@corp.example"],
    origin: "agent",
  });
  assert.equal(card["@type"], "MessageCard");
  assert.equal(card.title, "Release 2.1");
  const sections = card.sections as Array<{ text: string; facts?: Array<{ name: string; value: string }> }>;
  assert.equal(sections[0].text, "Deploy finished at 14:05.");
  const facts = sections[0].facts ?? [];
  assert.ok(facts.some((f) => f.name === "For" && f.value.includes("jdoe@corp.example")));
  assert.ok(facts.some((f) => f.name === "Prepared by" && /assistant/i.test(f.value)));
  // No recipients/title → a top-level text fallback for minimal clients.
  const plain = buildTeamsWebhookPayload({ body: "hi" });
  assert.equal(plain.text, "hi");
});

function withFetch<T>(responder: (url: string, init?: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => responder(String(url), init)) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("postTeamsWebhook posts JSON; classic '1' body and 200 both succeed", async () => {
  let sent: { url?: string; body?: unknown; ct?: string } = {};
  await withFetch(
    (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)), ct: (init?.headers as Record<string, string>)["Content-Type"] };
      return new Response("1", { status: 200 });
    },
    () => postTeamsWebhook("https://acme.webhook.office.com/webhookb2/tok", buildTeamsWebhookPayload({ body: "x" })),
  );
  assert.match(sent.url ?? "", /webhookb2\/tok$/);
  assert.equal(sent.ct, "application/json");
  assert.equal((sent.body as { "@type": string })["@type"], "MessageCard");
});

test("postTeamsWebhook explains a revoked webhook (404/410) and other failures", async () => {
  await assert.rejects(
    withFetch(() => new Response("Not Found", { status: 404 }), () =>
      postTeamsWebhook("https://acme.webhook.office.com/x", { text: "x" }),
    ),
    (err: Error & { userSummary?: string }) => {
      assert.match(err.message, /rejected the message \(404\)/);
      assert.match(err.userSummary ?? "", /no longer exists|fresh URL/i);
      return true;
    },
  );
  await assert.rejects(
    withFetch(() => {
      throw new Error("ENOTFOUND");
    }, () => postTeamsWebhook("https://acme.webhook.office.com/x", { text: "x" })),
    /unreachable/,
  );
});
