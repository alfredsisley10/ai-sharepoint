import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SharePointWriteClient, writeScopesFor } from "../src/auth/sharePointWriteClient";
import { AppError } from "../src/core/errors";
import { SharePointAuthProvider, AccessToken } from "../src/auth/types";

test("writeScopesFor maps modes to delegated Graph scopes", () => {
  assert.deepEqual(writeScopesFor("selected"), ["https://graph.microsoft.com/Sites.Selected"]);
  assert.deepEqual(writeScopesFor("all"), [
    "https://graph.microsoft.com/Sites.ReadWrite.All",
    "https://graph.microsoft.com/Sites.Manage.All",
  ]);
});

function fakeAuth(capture: { scopes?: string[] }): SharePointAuthProvider {
  return {
    id: "fake",
    displayName: "fake",
    supportsSilentRefresh: true,
    async acquireToken(scopes: string[]): Promise<AccessToken> {
      capture.scopes = scopes;
      return { token: "tok", expiresOn: null, account: "me" };
    },
  };
}

async function withFetch<T>(status: number, body: unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("selected mode requests Sites.Selected and explains a 403 (missing per-site grant)", async () => {
  const cap: { scopes?: string[] } = {};
  const client = new SharePointWriteClient(fakeAuth(cap), "selected");
  await assert.rejects(
    () => withFetch(403, { error: { message: "Access denied" } }, () => client.publishPage("site1", "page1")),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "graph.forbidden");
      assert.match(err.userSummary ?? "", /Sites\.Selected/);
      assert.match(err.userSummary ?? "", /grant/i);
      return true;
    },
  );
  assert.deepEqual(cap.scopes, ["https://graph.microsoft.com/Sites.Selected"]);
});

test("all mode requests the tenant-wide write scopes", async () => {
  const cap: { scopes?: string[] } = {};
  const client = new SharePointWriteClient(fakeAuth(cap), "all");
  const created = await withFetch(200, { id: "new" }, () =>
    client.createPage("site1", { name: "n", title: "t", pageLayout: "Article", canvasLayout: null }),
  );
  assert.deepEqual(created, { id: "new" });
  assert.deepEqual(cap.scopes, [
    "https://graph.microsoft.com/Sites.ReadWrite.All",
    "https://graph.microsoft.com/Sites.Manage.All",
  ]);
});

test("a 403 in all mode is NOT rewritten with Sites.Selected guidance", async () => {
  const client = new SharePointWriteClient(fakeAuth({}), "all");
  await assert.rejects(
    () => withFetch(403, { error: { message: "denied" } }, () => client.deletePage("s", "p")),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "graph.forbidden");
      assert.equal(err.userSummary, undefined);
      return true;
    },
  );
});
