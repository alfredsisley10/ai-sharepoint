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
        const start = Number(new URL(url).searchParams.get("start") ?? "0");
        return { body: { results: start === 0 ? [{ id: "1", title: "Open" }, { id: "2", title: "Locked", _links: { webui: "/p/2" } }] : [] } };
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
  assert.equal(result.checkFailures, undefined, "no failures → no incomplete flag");
});

test("reviewSpaceManageability PAGINATES the space listing instead of one limit=N call", async () => {
  // Two listing batches (the server signals continuation via _links.next),
  // 7 pages total — every one of them must get a restriction check even
  // though the old single-call listing would only have seen the first batch.
  const { result, calls } = await withFetch(
    (url) => {
      if (url.includes("spaceKey=DEV")) {
        const start = Number(new URL(url).searchParams.get("start") ?? "0");
        return start === 0
          ? {
              body: {
                results: Array.from({ length: 4 }, (_, k) => ({ id: String(k + 1), title: `P${k + 1}` })),
                _links: { next: "/rest/api/content?spaceKey=DEV&start=4" },
              },
            }
          : {
              body: {
                results: Array.from({ length: 3 }, (_, k) => ({ id: String(start + k + 1), title: `P${start + k + 1}` })),
                _links: {},
              },
            };
      }
      return { body: { read: { restrictions: {} }, update: { restrictions: {} } } };
    },
    () => reviewSpaceManageability(SRC, CRED, "DEV", "jdoe", DEFAULT_CAPS),
  );
  assert.equal(result.checkedPages, 7);
  assert.equal(result.manageablePages, 7);
  assert.equal(calls.filter((c) => c.includes("spaceKey=DEV")).length, 2, "followed the listing pagination");
  assert.equal(calls.filter((c) => c.includes("/restriction/")).length, 7, "checked every listed page");
});

test("reviewSpaceManageability: failing restriction reads are counted — never a false all-clear", async () => {
  // EVERY restriction read fails (e.g. the endpoint is blocked): the report
  // must say the audit is incomplete, not gaps:[] = "you can manage everything".
  const { result } = await withFetch(
    (url) => {
      if (url.includes("/restriction/")) return { status: 404, body: { message: "blocked for someone@corp.example.com" } };
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      return { body: { results: start === 0 ? [{ id: "1", title: "A" }, { id: "2", title: "B" }] : [] } };
    },
    () => reviewSpaceManageability(SRC, CRED, "DEV", "jdoe", DEFAULT_CAPS),
  );
  assert.equal(result.gaps.length, 0);
  assert.equal(result.checkFailures, 2);
  assert.ok(result.checkFailureSample, "keeps one sample error");
  assert.doesNotMatch(result.checkFailureSample ?? "", /someone@corp\.example\.com/, "sample is redacted");
  assert.equal(result.manageablePages, 0, "unchecked pages are not claimed manageable");
  const note = prepareAccessRequestNote(result);
  assert.match(note, /INCOMPLETE/);
  assert.doesNotMatch(note, /can already manage all/);
});

test("reviewSpaceManageability rethrows immediately on an auth failure (no sweep on a dead credential)", async () => {
  let restrictionCalls = 0;
  await assert.rejects(
    withFetch(
      (url) => {
        if (url.includes("/restriction/")) {
          restrictionCalls += 1;
          return { status: 401, body: { message: "credential revoked" } };
        }
        const start = Number(new URL(url).searchParams.get("start") ?? "0");
        return {
          body: { results: start === 0 ? Array.from({ length: 12 }, (_, k) => ({ id: String(k + 1), title: `P${k + 1}` })) : [] },
        };
      },
      () => reviewSpaceManageability(SRC, CRED, "DEV", "jdoe", DEFAULT_CAPS),
    ),
    /401|Authentication/,
  );
  assert.ok(restrictionCalls <= 5, `aborted after the first batch (made ${restrictionCalls} calls, not 12)`);
});

test("reviewSpaceManageability rethrows immediately when the source throttles", async () => {
  await assert.rejects(
    withFetch(
      (url) => {
        if (url.includes("/restriction/")) return { status: 429, body: { message: "slow down" } };
        const start = Number(new URL(url).searchParams.get("start") ?? "0");
        return { body: { results: start === 0 ? [{ id: "1", title: "A" }] : [] } };
      },
      () => reviewSpaceManageability(SRC, CRED, "DEV", "jdoe", DEFAULT_CAPS),
    ),
    /throttling|429/i,
  );
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
  assert.doesNotMatch(note, /INCOMPLETE/, "a clean audit carries no incomplete warning");
  assert.match(prepareAccessRequestNote({ spaceKey: "DEV", user: "jdoe", checkedPages: 3, manageablePages: 3, gaps: [] }), /can already manage all/);
});

test("prepareAccessRequestNote flags an INCOMPLETE audit alongside confirmed gaps", () => {
  const note = prepareAccessRequestNote({
    spaceKey: "DEV",
    user: "jdoe",
    checkedPages: 5,
    manageablePages: 2,
    gaps: [
      { pageId: "2", title: "Locked", url: "https://wiki/p/2", missing: ["write"], readRestrictedTo: { users: [], groups: [] }, updateRestrictedTo: { users: ["x"], groups: [] } },
    ],
    checkFailures: 2,
    checkFailureSample: "Not found (404) at the source.",
  });
  assert.match(note, /Locked .*missing: write/, "confirmed gaps still listed");
  assert.match(note, /INCOMPLETE/);
  assert.match(note, /2 of 5 page\(s\)/);
  assert.match(note, /Not found \(404\)/);
});
