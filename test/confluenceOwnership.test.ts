import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildOwnerLabel,
  parseOwnerLabel,
  findOwnerLabel,
  tallyContributors,
  tallyContributorsWeighted,
  resolveOwners,
  getConfluencePageLabels,
  getConfluencePageContributors,
  getConfluenceSpaceContributorsWeighted,
  setConfluencePageOwners,
  clearVersionPrefixMemo,
  ContributorTally,
} from "../src/context/adapters/confluenceOwnership";
import { ContextSource, ContextCredential } from "../src/context/types";
import { AppError } from "../src/core/errors";

const SRC: ContextSource = {
  id: "c1",
  type: "confluence",
  displayName: "Wiki",
  baseUrl: "https://wiki.example.com",
  deployment: "datacenter",
  authMethod: "pat",
  addedAt: "2026-06-15T00:00:00Z",
};
const CRED: ContextCredential = { method: "pat", secret: "token" };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = handler(String(url), init ?? {});
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const ranked = (...pairs: Array<[string, number]>): ContributorTally[] =>
  pairs.map(([sam, count]) => ({ sam, count }));

test("owner label build/parse/find (pipe-delimited sams, lowercased)", () => {
  assert.equal(buildOwnerLabel(["JDoe", " asmith ", "jdoe"]), "owners|jdoe|asmith");
  assert.deepEqual(parseOwnerLabel("owners|jdoe|asmith"), ["jdoe", "asmith"]);
  assert.equal(parseOwnerLabel("just-a-tag"), undefined);
  assert.equal(parseOwnerLabel("owners"), undefined); // marker with no sams
  assert.deepEqual(findOwnerLabel(["topic", "owners|bwong"]), ["bwong"]);
  assert.equal(findOwnerLabel(["topic", "draft"]), undefined);
});

test("tallyContributors counts case-insensitively and ranks most-prolific first", () => {
  assert.deepEqual(tallyContributors(["a", "b", "a", "A", "c"]), [
    { sam: "a", count: 3 },
    { sam: "b", count: 1 },
    { sam: "c", count: 1 },
  ]);
});

test("resolveOwners: explicit owner label is authoritative (flags inactive)", async () => {
  const isActive = async (s: string) => s !== "asmith";
  const res = await resolveOwners({
    pageLabels: ["owners|jdoe|asmith", "policy"],
    pageContributors: ranked(["bwong", 9]),
    spaceContributors: async () => ranked(["x", 1]),
    isActive,
  });
  assert.deepEqual(res.owners, ["jdoe", "asmith"]);
  assert.equal(res.basis, "label");
  assert.match(res.note ?? "", /inactive.*asmith/);
});

test("resolveOwners: most prolific ACTIVE page contributor (skips inactive)", async () => {
  const isActive = async (s: string) => s === "jdoe";
  const res = await resolveOwners({
    pageLabels: ["policy"],
    pageContributors: ranked(["bwong", 12], ["jdoe", 5]), // bwong most prolific but inactive
    spaceContributors: async () => ranked(["nope", 99]),
    isActive,
  });
  assert.deepEqual(res.owners, ["jdoe"]);
  assert.equal(res.basis, "page-contributor");
});

test("resolveOwners: falls back to space contributor, then none", async () => {
  const space = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["inactivea", 4]),
    spaceContributors: async () => ranked(["csmith", 20], ["inactiveb", 30]),
    isActive: async (s) => s === "csmith",
  });
  assert.deepEqual(space.owners, ["csmith"]);
  assert.equal(space.basis, "space-contributor");

  const none = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["a", 1]),
    spaceContributors: async () => ranked(["b", 1]),
    isActive: async () => false,
  });
  assert.equal(none.basis, "none");
  assert.deepEqual(none.owners, []);
});

test("getConfluencePageLabels reads label names", async () => {
  const { result } = await withFetch(
    () => ({ body: { results: [{ name: "owners|jdoe" }, { name: "policy" }] } }),
    () => getConfluencePageLabels(SRC, CRED, "1", 30000),
  );
  assert.deepEqual(result, ["owners|jdoe", "policy"]);
});

test("getConfluencePageContributors tallies version authors (by.username)", async () => {
  clearVersionPrefixMemo();
  const { result, calls } = await withFetch(
    () => ({
      body: {
        results: [
          { by: { username: "jdoe" } },
          { by: { username: "asmith" } },
          { by: { username: "jdoe" } },
        ],
      },
    }),
    () => getConfluencePageContributors(SRC, CRED, "7", 30000),
  );
  // Data Center serves the versions LIST under /rest/experimental (its
  // /rest/api tree has no version list — a 404 that looks like a missing page).
  assert.match(calls[0].url, /\/rest\/experimental\/content\/7\/version/);
  assert.deepEqual(result, [
    { sam: "jdoe", count: 2 },
    { sam: "asmith", count: 1 },
  ]);
});

test("version endpoint: cloud goes to /rest/api first; a mislabeled deployment falls back on 404 and is memoized", async () => {
  clearVersionPrefixMemo();
  const CLOUD: ContextSource = { ...SRC, id: "c2", baseUrl: "https://x.atlassian.net/wiki", deployment: "cloud" };
  const cloud = await withFetch(
    () => ({ body: { results: [{ by: { username: "jdoe" } }] } }),
    () => getConfluencePageContributors(CLOUD, CRED, "5", 30000),
  );
  assert.match(cloud.calls[0].url, /\/rest\/api\/content\/5\/version/);

  // A source labeled datacenter that actually speaks the cloud shape:
  // /rest/experimental 404s → fall back to /rest/api and remember it.
  clearVersionPrefixMemo();
  const mislabeled = await withFetch(
    (url) =>
      url.includes("/rest/experimental/")
        ? { status: 404, body: { message: "no such resource" } }
        : { body: { results: [{ by: { username: "jdoe" } }] } },
    async () => {
      await getConfluencePageContributors(SRC, CRED, "7", 30000);
      return getConfluencePageContributors(SRC, CRED, "8", 30000);
    },
  );
  const urls = mislabeled.calls.map((c) => c.url);
  assert.ok(urls[0].includes("/rest/experimental/"), "tries the deployment's home path first");
  assert.ok(urls[1].includes("/rest/api/"), "falls back to the other deployment's path on 404");
  // Second page skips the probe: memoized straight to the working prefix.
  assert.ok(urls[2].includes("/rest/api/content/8/version"), "memoized prefix reused");
  assert.equal(urls.length, 3);
});

test("version endpoint: both paths 404 → one diagnosable error naming both endpoints + troubleshooting", async () => {
  clearVersionPrefixMemo();
  await assert.rejects(
    withFetch(
      () => ({ status: 404, body: { message: "nope" } }),
      () => getConfluencePageContributors(SRC, CRED, "99", 30000),
    ),
    (err: Error & { code?: string; userSummary?: string }) => {
      assert.match(err.message, /rest\/experimental\/content\/99\/version/);
      assert.match(err.message, /rest\/api\/content\/99\/version/);
      assert.equal(err.code, "graph.notFound");
      assert.match(err.userSummary ?? "", /NUMERIC content id/i);
      assert.match(err.userSummary ?? "", /context path/i);
      assert.match(err.userSummary ?? "", /deployment/i);
      return true;
    },
  );
});

test("version endpoint: a non-404 failure surfaces immediately WITH the endpoint (no cross-path retry)", async () => {
  clearVersionPrefixMemo();
  const { result: outcome, calls } = await withFetch(
    () => ({ status: 429, body: { message: "slow down" } }),
    async () => {
      try {
        await getConfluencePageContributors(SRC, CRED, "7", 30000);
        return undefined;
      } catch (err) {
        return err as Error;
      }
    },
  );
  assert.equal(calls.length, 1, "throttle must not trigger the fallback probe");
  assert.match(outcome!.message, /GET \/rest\/experimental\/content\/7\/version/);
  assert.match(outcome!.message, /throttling/i);
});

test("getConfluencePageLabels failures carry the endpoint for the audit trail", async () => {
  await assert.rejects(
    withFetch(() => ({ status: 404, body: {} }), () => getConfluencePageLabels(SRC, CRED, "3", 30000)),
    /GET \/rest\/api\/content\/3\/label → .*404/,
  );
});

test("space sweep: EVERY page failing surfaces as a failure, not an empty tally", async () => {
  clearVersionPrefixMemo();
  await assert.rejects(
    withFetch(
      (url) =>
        url.includes("/version")
          ? { status: 404, body: {} }
          : { body: { results: [{ id: "1" }, { id: "2" }] } },
      () => getConfluenceSpaceContributorsWeighted(SRC, CRED, "ENG", 30000, Date.UTC(2026, 6, 1)),
    ),
    /any of the 2 sampled page\(s\) in space ENG/,
  );
});

test("setConfluencePageOwners removes the old owner label and POSTs the new one", async () => {
  const { result, calls } = await withFetch(
    (_url, init) => {
      if ((init as { method?: string }).method === "GET") {
        return { body: { results: [{ name: "owners|olduser" }, { name: "keepme" }] } }; // GET labels
      }
      return { status: 200, body: undefined }; // DELETE + POST
    },
    () => setConfluencePageOwners(SRC, CRED, "9", ["JDoe", "asmith"], 30000),
  );
  const del = calls.find((c) => (c.init as { method?: string }).method === "DELETE");
  const post = calls.find((c) => (c.init as { method?: string }).method === "POST");
  assert.ok(del, "old owner label deleted");
  assert.match(del!.url, /name=owners%7Colduser/); // only the owner label removed, not "keepme"
  assert.ok(post, "new owner label added");
  assert.equal(JSON.parse(String((post!.init as { body?: string }).body))[0].name, "owners|jdoe|asmith");
  assert.equal(result, "owners|jdoe|asmith");
});

const DAY = 86_400_000;

test("tallyContributorsWeighted: recent activity outranks a long-departed prolific editor", () => {
  const now = Date.UTC(2026, 6, 1);
  const authors = [
    // 'oldpro' edited 10× two years ago; 'recent' edited 3× this month.
    ...Array.from({ length: 10 }, () => ({ sam: "oldpro", whenMs: now - 730 * DAY })),
    ...Array.from({ length: 3 }, () => ({ sam: "recent", whenMs: now - 5 * DAY })),
  ];
  const out = tallyContributorsWeighted(authors, { nowMs: now, halfLifeDays: 180 });
  assert.equal(out[0].sam, "recent"); // recency beats raw volume
  assert.equal(out.find((r) => r.sam === "oldpro")?.count, 10); // raw count still exposed
  assert.ok((out[0].score ?? 0) > (out[1].score ?? 0));
});

test("tallyContributorsWeighted: undated contributions rank below any dated one", () => {
  const now = Date.UTC(2026, 6, 1);
  const out = tallyContributorsWeighted(
    [{ sam: "dated", whenMs: now - 1000 * DAY }, { sam: "undated" }],
    { nowMs: now },
  );
  assert.equal(out[0].sam, "dated");
});

test("resolveOwners: falls back to configured space owners (basis space-owner) when contributors are inactive", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: [{ sam: "ghost", count: 5 }],
    spaceContributors: async () => [{ sam: "alsoghost", count: 3 }],
    spaceOwners: async () => ["SpaceAdmin"],
    isActive: async (sam) => sam === "spaceadmin", // only the configured owner is active
  });
  assert.equal(res.basis, "space-owner");
  assert.deepEqual(res.owners, ["spaceadmin"]);
  assert.match(res.note ?? "", /administratively assigned|may not be the effective/i);
});

test("resolveOwners: prefers an active recent page contributor over the space-owner fallback", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: [{ sam: "jdoe", count: 2, score: 1.5 }],
    spaceContributors: async () => [],
    spaceOwners: async () => ["spaceadmin"],
    isActive: async () => true,
  });
  assert.equal(res.basis, "page-contributor");
  assert.deepEqual(res.owners, ["jdoe"]);
});

// --- hardened, audited resolution ------------------------------------------

test("audit: a label hit records the decision and marks later methods skipped", async () => {
  const res = await resolveOwners({
    pageLabels: ["owners|jdoe"],
    pageContributors: ranked(["x", 1]),
    spaceContributors: async () => [],
    isActive: async () => true,
    directoryWired: true,
  });
  assert.equal(res.basis, "label");
  assert.equal(res.verification, "directory");
  const byStep = new Map(res.audit!.map((a) => [a.step, a]));
  assert.equal(byStep.get("owner-label")?.outcome, "hit");
  assert.equal(byStep.get("page-contributors")?.outcome, "skipped");
  assert.equal(byStep.get("space-contributors")?.outcome, "skipped");
  assert.equal(byStep.get("space-owners")?.outcome, "skipped");
});

test("audit: a failing labels read is recorded and the pipeline STEPS DOWN to contributors", async () => {
  const res = await resolveOwners({
    pageLabels: () => Promise.reject(new Error("GET /rest/api/content/7/label → Not found (404) at the source.")),
    pageContributors: ranked(["jdoe", 3]),
    spaceContributors: async () => [],
    isActive: async () => true,
  });
  assert.equal(res.basis, "page-contributor");
  assert.deepEqual(res.owners, ["jdoe"]);
  const label = res.audit!.find((a) => a.step === "owner-label");
  assert.equal(label?.outcome, "failed");
  assert.match(label?.error?.message ?? "", /404/);
  assert.equal(label?.error?.kind, "graph.notFound");
  assert.ok(res.degraded?.some((d) => /Owner label/.test(d)), "step-down notice present");
});

test("audit: a failing page-history read steps down to the space sweep", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: () => Promise.reject(new Error("GET /rest/experimental/content/7/version → Not found (404) at the source.")),
    spaceContributors: async () => ranked(["asmith", 9]),
    isActive: async () => true,
  });
  assert.equal(res.basis, "space-contributor");
  assert.deepEqual(res.owners, ["asmith"]);
  assert.equal(res.audit!.find((a) => a.step === "page-contributors")?.outcome, "failed");
  assert.equal(res.audit!.find((a) => a.step === "space-contributors")?.outcome, "hit");
});

test("audit: a directory OUTAGE degrades to unverified (verification 'unavailable') instead of failing", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["jdoe", 4], ["asmith", 2]),
    spaceContributors: async () => [],
    isActive: async () => {
      throw new Error("LDAP connect ECONNREFUSED");
    },
    directoryWired: true,
  });
  assert.deepEqual(res.owners, ["jdoe"], "top contributor still resolved, unverified");
  assert.equal(res.basis, "page-contributor");
  assert.equal(res.verification, "unavailable");
  assert.ok(res.degraded?.some((d) => /UNVERIFIED/.test(d) && /ECONNREFUSED/.test(d)));
});

test("audit: every method failing yields basis none with a DEGRADED note (not a throw), and the expensive space sweep is SKIPPED as systemic", async () => {
  const boom = () => Promise.reject(new Error("kaboom"));
  let swept = false;
  const res = await resolveOwners({
    pageLabels: boom,
    pageContributors: boom,
    spaceContributors: () => {
      swept = true;
      return Promise.reject(new Error("kaboom"));
    },
    spaceOwners: boom,
    isActive: async () => true,
  });
  assert.equal(res.basis, "none");
  assert.deepEqual(res.owners, []);
  assert.match(res.note ?? "", /DEGRADED/);
  // Both page-level reads failed → sweeping N pages with the same failing
  // reads is futile; the audit records an honest skip instead.
  assert.equal(swept, false, "space sweep must not run when both page-level reads failed");
  const space = res.audit!.find((a) => a.step === "space-contributors");
  assert.equal(space?.outcome, "skipped");
  assert.match(space?.detail ?? "", /systemic/);
  assert.equal(res.audit!.filter((a) => a.outcome === "failed").length, 3);
});

test("abort kinds: a rejected credential or throttle THROWS (feeds the auth-lockout breaker) instead of stepping down", async () => {
  await assert.rejects(
    resolveOwners({
      pageLabels: () => Promise.reject(new AppError("Authentication rejected (401).", "auth.failed")),
      pageContributors: ranked(["jdoe", 3]),
      spaceContributors: async () => [],
      isActive: async () => true,
    }),
    /Authentication rejected/,
  );
  await assert.rejects(
    resolveOwners({
      pageLabels: [],
      pageContributors: () => Promise.reject(new Error("Source is throttling requests (429).")),
      spaceContributors: async () => [],
      isActive: async () => true,
    }),
    /throttling/,
  );
});

test("audit: a directory fault MID-walk falls back to the deterministic top contributor", async () => {
  // jdoe (top) is verified inactive, then the directory dies on asmith: the
  // pick must be the plain top contributor (same answer as a full outage),
  // not whichever candidate the fault happened to land on.
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["jdoe", 9], ["asmith", 2]),
    spaceContributors: async () => [],
    isActive: async (sam) => {
      if (sam === "jdoe") return false;
      throw new Error("LDAP connection lost");
    },
    directoryWired: true,
  });
  assert.deepEqual(res.owners, ["jdoe"]);
  assert.equal(res.verification, "unavailable");
  assert.match(res.directoryFault ?? "", /LDAP connection lost/);
  const page = res.audit!.find((a) => a.step === "page-contributors");
  assert.match(page?.detail ?? "", /unverified — the directory failed/);
});

test("audit: no space sweep available renders an honest skip with the caller's reason", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: [],
    spaceSkippedReason: "the page lookup failed, so the page's space is unknown",
    isActive: async () => true,
  });
  const space = res.audit!.find((a) => a.step === "space-contributors");
  assert.equal(space?.outcome, "skipped");
  assert.match(space?.detail ?? "", /space is unknown/);
  assert.equal(res.basis, "none");
});

test("audit: directory-vetoed configured space owners produce the active-check note, not 'no history'", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: [],
    spaceContributors: async () => [],
    spaceOwners: async () => ["ghost"],
    isActive: async () => false,
    directoryWired: true,
  });
  assert.equal(res.basis, "none");
  assert.match(res.note ?? "", /none passed the active-employee check/);
  assert.doesNotMatch(res.note ?? "", /No contributor history/);
});

test("audit messages are redacted (no emails/PII from server bodies)", async () => {
  const res = await resolveOwners({
    pageLabels: () => Promise.reject(new Error("boom body mentions dave@corp.example.com somewhere")),
    pageContributors: ranked(["jdoe", 1]),
    spaceContributors: async () => [],
    isActive: async () => true,
  });
  const label = res.audit!.find((a) => a.step === "owner-label");
  assert.doesNotMatch(label?.error?.message ?? "", /dave@corp\.example\.com/);
});

test("version endpoint: a 403 on the deployment's home path falls back to the other prefix (WAF path-blocking)", async () => {
  clearVersionPrefixMemo();
  const { result, calls } = await withFetch(
    (url) =>
      url.includes("/rest/experimental/")
        ? { status: 403, body: { message: "insufficient permissions" } }
        : { body: { results: [{ by: { username: "jdoe" } }] } },
    () => getConfluencePageContributors(SRC, CRED, "7", 30000),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(result, [{ sam: "jdoe", count: 1 }]);

  // A GENUINE permission problem 403s on both — the FIRST error surfaces
  // with its endpoint, not a misleading "not found".
  clearVersionPrefixMemo();
  await assert.rejects(
    withFetch(() => ({ status: 403, body: { message: "no permission" } }), () =>
      getConfluencePageContributors(SRC, CRED, "7", 30000),
    ),
    /GET \/rest\/experimental\/content\/7\/version → .*Forbidden/,
  );
});

test("version endpoint: a mid-pagination 404 keeps the partial tally instead of a misleading 'not found'", async () => {
  clearVersionPrefixMemo();
  const full = Array.from({ length: 100 }, () => ({ by: { username: "jdoe" }, when: "2026-01-01T00:00:00Z" }));
  const { result } = await withFetch(
    (url) => (url.includes("start=0") ? { body: { results: full } } : { status: 404, body: {} }),
    () => getConfluencePageContributors(SRC, CRED, "7", 30000),
  );
  assert.deepEqual(result, [{ sam: "jdoe", count: 100 }]);
});

test("space sweep: bails out after 3 consecutive opening failures instead of crawling every page", async () => {
  clearVersionPrefixMemo();
  const ids = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1) }));
  let versionCalls = 0;
  await assert.rejects(
    withFetch(
      (url) => {
        if (!url.includes("/version")) return { body: { results: ids } };
        versionCalls += 1;
        return { status: 404, body: {} };
      },
      () => getConfluenceSpaceContributorsWeighted(SRC, CRED, "ENG", 30000, Date.UTC(2026, 6, 1)),
    ),
    /any of the first 3 of 10 sampled page\(s\) in space ENG/,
  );
  // 3 pages × 2 prefixes — not 10 × 2.
  assert.equal(versionCalls, 6);
});

test("audit: contributors found but all inactive is reported as a directory answer, not missing history", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["ghost", 5]),
    spaceContributors: async () => ranked(["alsoghost", 2]),
    isActive: async () => false,
    directoryWired: true,
  });
  assert.equal(res.basis, "none");
  assert.match(res.note ?? "", /none passed the active-employee check/);
  const page = res.audit!.find((a) => a.step === "page-contributors");
  assert.equal(page?.outcome, "no-result");
  assert.deepEqual(page?.considered?.map((c) => c.sam), ["ghost"]);
});
