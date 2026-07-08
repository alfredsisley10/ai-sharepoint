import { test } from "node:test";
import * as assert from "node:assert/strict";
import { CommsClient, ResolvedRecipient } from "../src/comms/commsClient";
import { SharePointAuthProvider } from "../src/auth/types";

const AUTH: SharePointAuthProvider = {
  id: "test",
  displayName: "Test",
  supportsSilentRefresh: false,
  async acquireToken() {
    return { token: "tok", expiresOn: null, account: "me@x" };
  },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

async function withGraph<T>(
  handler: (call: Call) => { status?: number; body: unknown },
  run: (client: CommsClient) => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const call: Call = {
      method: (init?.method as string) ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { result: await run(new CommsClient(AUTH)), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const rcpt = (id: string, address: string): ResolvedRecipient => ({ id, displayName: id, address });

test("resolveRecipient maps the directory user and falls back to the ref", async () => {
  const { result, calls } = await withGraph(
    () => ({ body: { id: "u1", displayName: "J Doe", mail: "jdoe@x" } }),
    (c) => c.resolveRecipient("jdoe@x"),
  );
  assert.match(calls[0].url, /\/users\/jdoe%40x\?\$select=id,displayName,mail,userPrincipalName/);
  assert.deepEqual(result, { id: "u1", displayName: "J Doe", address: "jdoe@x" });

  const { result: fallback } = await withGraph(
    () => ({ body: { id: "u2" } }), // no displayName/mail/upn
    (c) => c.resolveRecipient("bob@x"),
  );
  assert.deepEqual(fallback, { id: "u2", displayName: "bob@x", address: "bob@x" });
});

test("sendTeamsMessage creates a oneOnOne chat with both members, then posts the body", async () => {
  const { calls } = await withGraph(
    (call) => {
      if (call.url.endsWith("/me?$select=id") || /\/me\?\$select=id$/.test(call.url)) return { body: { id: "meId" } };
      if (call.url.endsWith("/chats")) return { body: { id: "chat9" } };
      return { body: {} };
    },
    (c) => c.sendTeamsMessage([rcpt("them", "t@x")], "hello there"),
  );
  const createChat = calls.find((c) => c.url.endsWith("/chats"))!;
  const b = createChat.body as { chatType: string; members: Array<Record<string, unknown>> };
  assert.equal(b.chatType, "oneOnOne");
  assert.equal(b.members.length, 2, "self + recipient");
  assert.ok(JSON.stringify(b.members).includes("meId") && JSON.stringify(b.members).includes("them"));
  const post = calls.find((c) => c.url.includes("/chats/chat9/messages"))!;
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, { body: { contentType: "text", content: "hello there" } });
});

test("sendTeamsMessage uses a group chat for multiple recipients", async () => {
  const { calls } = await withGraph(
    (call) => {
      if (/\/me\?\$select=id$/.test(call.url)) return { body: { id: "meId" } };
      if (call.url.endsWith("/chats")) return { body: { id: "chatG" } };
      return { body: {} };
    },
    (c) => c.sendTeamsMessage([rcpt("a", "a@x"), rcpt("b", "b@x")], "hi team"),
  );
  const createChat = calls.find((c) => c.url.endsWith("/chats"))!;
  assert.equal((createChat.body as { chatType: string }).chatType, "group");
  assert.equal((createChat.body as { members: unknown[] }).members.length, 3);
});

test("createMailDraft posts a draft with recipients and a text body (nothing sent)", async () => {
  const { result, calls } = await withGraph(
    () => ({ body: { id: "draft1", webLink: "https://outlook/draft1" } }),
    (c) => c.createMailDraft([rcpt("x", "x@corp")], "Subject", "Body text"),
  );
  const post = calls[0];
  assert.equal(post.method, "POST");
  assert.match(post.url, /\/me\/messages$/);
  const b = post.body as { subject: string; toRecipients: Array<{ emailAddress: { address: string } }>; attachments?: unknown };
  assert.equal(b.subject, "Subject");
  assert.deepEqual(b.toRecipients, [{ emailAddress: { address: "x@corp" } }]);
  assert.equal(b.attachments, undefined, "no attachments key when none supplied");
  assert.deepEqual(result, { id: "draft1", webLink: "https://outlook/draft1" });
  // No /send call was made — a draft is created, never sent.
  assert.ok(!calls.some((c) => /\/send$/.test(c.url)));
});

test("sendMailDraft hits the message send endpoint", async () => {
  const { calls } = await withGraph(
    () => ({ status: 202, body: undefined }),
    (c) => c.sendMailDraft("msg 1/2"),
  );
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/me\/messages\/msg%201%2F2\/send$/);
});
