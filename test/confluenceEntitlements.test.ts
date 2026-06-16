import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseRestrictions,
  assessPageAccess,
  reviewSpaceManageability,
  prepareAccessRequestNote,
} from "../src/context/adapters/confluenceEntitlements";
import { ContextSource, ContextCredential, DEFAULT_CAPS } from "../src/context/types";

const SRC: ContextSource = {
  id: "c1",
  type: "confluence",
  displayName: "Wiki",
  baseUrl: "https://wiki.example.com",
  deployment: "datacenter",
  authMethod: "pat",
  addedAt: "2026-06-16T00:00:00Z",
};
const CRED: ContextCredential = { method: "pat", secret: "token" };

async function withFetch<T>(
  handler: (url: string) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    const r = handler(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("parseRestrictions reads the nested user/group results", () => {
  assert.deepEqual(
    parseRestrictions({
      read: { restrictions: { user: { results: [{ username: "a" }] }, group: { results: [{ name: "g1" }] } } },
      update: { restrictions: { user: { results: [{ username: "b" }] } } },
    }),
    { read: { users: ["a"], groups: ["g1"] }, update: { users: ["b"], groups: [] } },
  );
});

test("assessPageAccess: no restriction = allowed; active restriction needs the user listed", () => {
  const none = { read: { users: [], groups: [] }, update: { users: [], groups: [] } };
  assert.deepEqual(assessPageAccess(none, "jdoe"), { canRead: true, canWrite: true });
  assert.deepEqual(
    assessPageAccess({ read: { users: [], groups: [] }, update: { users: ["jdoe"], groups: [] } }, "JDoe"),
    { canRead: true, canWrite: true },
  );
  assert.deepEqual(
    assessPageAccess({ read: { users: [], groups: [] }, update: { users: ["other"], groups: [] } }, "jdoe"),
    { canRead: true, canWrite: false },
  );
  assert.deepEqual(
    assessPageAccess({ read: { users: ["other"], groups: [] }, update: { users: [], groups: [] } }, "jdoe"),
    { canRead: false, canWrite: true },
  );
});

test("reviewSpaceManageability collects the pages the user can't manage", async () => {
  const { result } = await withFetch(
    (url) => {
      if (url.includes("spaceKey=DEV")) {
        return { body: { results: [{ id: "1", title: "Open" }, { id: "2", title: "Locked", _links: { webui: "/p/2" } }] } };
      }
      if (url.includes("/content/2/restriction")) {
        return { body: { read: { restrictions: {} }, update: { restrictions: { user: { results: [{ username: "someoneelse" }] } } } } };
      }
      return { body: { read: { restrictions: {} }, update: { restrictions: {} } } }; // page 1: open
    },
    () => reviewSpaceManageability(SRC, CRED, "DEV", "jdoe", DEFAULT_CAPS),
  );
  assert.equal(result.checkedPages, 2);
  assert.equal(result.manageablePages, 1);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].pageId, "2");
  assert.deepEqual(result.gaps[0].missing, ["write"]);
  assert.deepEqual(result.gaps[0].updateRestrictedTo.users, ["someoneelse"]);
});

test("prepareAccessRequestNote summarizes the gaps for admins", () => {
  const note = prepareAccessRequestNote({
    spaceKey: "DEV",
    user: "jdoe",
    checkedPages: 5,
    manageablePages: 4,
    gaps: [
      { pageId: "2", title: "Locked", url: "https://wiki/p/2", missing: ["write"], readRestrictedTo: { users: [], groups: [] }, updateRestrictedTo: { users: ["x"], groups: [] } },
    ],
  });
  assert.match(note, /space DEV/);
  assert.match(note, /jdoe/);
  assert.match(note, /Locked .*missing: write/);
  assert.match(prepareAccessRequestNote({ spaceKey: "DEV", user: "jdoe", checkedPages: 3, manageablePages: 3, gaps: [] }), /can already manage all/);
});
