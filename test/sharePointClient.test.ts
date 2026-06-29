import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SharePointClient } from "../src/auth/sharePointClient";
import { SharePointAuthProvider, AccessToken } from "../src/auth/types";

const auth: SharePointAuthProvider = {
  id: "test",
  displayName: "Test",
  supportsSilentRefresh: false,
  async acquireToken(): Promise<AccessToken> {
    return { token: "t", expiresOn: null, account: "me@x" };
  },
};

/** Install a fake Graph backend; returns the captured request URLs + a restore fn. */
function mockGraph(handler: (url: string) => unknown): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    const body = handler(u);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = original) };
}

test("getLists follows @odata.nextLink across pages and concatenates", async () => {
  const { urls, restore } = mockGraph((url) => {
    if (url.includes("page=2")) {
      return { value: [{ id: "L2", displayName: "Two", webUrl: "w2" }] };
    }
    return {
      value: [{ id: "L1", displayName: "One", webUrl: "w1" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/s/lists?page=2",
    };
  });
  try {
    let truncated = false;
    const lists = await new SharePointClient(auth).getLists("s", () => (truncated = true));
    assert.deepEqual(lists.map((l) => l.id), ["L1", "L2"]);
    assert.equal(truncated, false, "exhausted collection is not truncated");
    // The absolute nextLink was passed straight through to fetch.
    assert.ok(urls.some((u) => u === "https://graph.microsoft.com/v1.0/sites/s/lists?page=2"));
  } finally {
    restore();
  }
});

test("getLists hidden lists filtered; first page only when no nextLink", async () => {
  const { urls, restore } = mockGraph(() => ({
    value: [
      { id: "L1", displayName: "Visible", webUrl: "w1" },
      { id: "L2", displayName: "Hidden", webUrl: "w2", list: { hidden: true } },
    ],
  }));
  try {
    const lists = await new SharePointClient(auth).getLists("s");
    assert.deepEqual(lists.map((l) => l.id), ["L1"]);
    assert.equal(urls.length, 1, "single page → single request");
  } finally {
    restore();
  }
});

test("401 triggers one forced-refresh retry, then succeeds with the new token", async () => {
  const silentCalls: Array<{ force: boolean }> = [];
  const refreshingAuth: SharePointAuthProvider = {
    id: "test",
    displayName: "Test",
    supportsSilentRefresh: true,
    async acquireToken(): Promise<AccessToken> {
      return { token: "stale", expiresOn: null, account: "me@x" };
    },
    async acquireTokenSilent(_scopes, opts): Promise<AccessToken | null> {
      silentCalls.push({ force: Boolean(opts?.forceRefresh) });
      return { token: opts?.forceRefresh ? "fresh" : "stale", expiresOn: null, account: "me@x" };
    },
  };

  const seenTokens: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const authz = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    seenTokens.push(authz);
    if (authz.includes("stale")) {
      return new Response("expired", { status: 401, statusText: "Unauthorized" });
    }
    return new Response(JSON.stringify({ id: "s1", webUrl: "https://x.sharepoint.com" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const site = await new SharePointClient(refreshingAuth).getSite("https://x.sharepoint.com/sites/m");
    assert.equal(site.id, "s1");
    // First attempt used the stale token (401); the retry forced a refresh.
    assert.ok(seenTokens.some((t) => t.includes("stale")));
    assert.ok(seenTokens.some((t) => t.includes("fresh")));
    assert.deepEqual(silentCalls, [{ force: true }], "exactly one forced-refresh re-mint");
  } finally {
    globalThis.fetch = original;
  }
});

test("a second 401 is not retried again and surfaces as auth.failed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
  try {
    await assert.rejects(
      () => new SharePointClient(auth).getSite("https://x.sharepoint.com/sites/m"),
      (err: unknown) => (err as { code?: string }).code === "auth.failed",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("getPages reports truncation when the page cap is exceeded", async () => {
  // Every response carries a nextLink, so the cap (MAX_PAGES) is the only exit.
  const { urls, restore } = mockGraph(() => ({
    value: [{ id: "P", title: "T", webUrl: "w" }],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/s/pages/microsoft.graph.sitePage?next",
  }));
  try {
    let truncated = false;
    await new SharePointClient(auth).getPages("s", () => (truncated = true));
    assert.equal(truncated, true, "cap hit ⇒ onTruncated fires");
    // Bounded: the loop stops at the cap rather than running forever.
    assert.ok(urls.length <= 200, `followed ${urls.length} pages (<= cap)`);
    assert.ok(urls.length >= 2, "followed more than one page before capping");
  } finally {
    restore();
  }
});
