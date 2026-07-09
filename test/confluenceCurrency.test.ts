import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  extractLinks,
  checkLinks,
  reviewPageCurrency,
} from "../src/context/adapters/confluenceCurrency";
import { DnsPathProbe } from "../src/core/dnsDiagnostics";
import { flagsFor } from "../src/context/spaceDossier";
import { UserRecord } from "../src/context/userDirectory";
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
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("extractLinks pulls distinct href targets, skipping anchors/mailto", () => {
  assert.deepEqual(
    extractLinks('<a href="https://x/a">a</a> <a href="#s">s</a> <a href="https://x/a">dup</a> <a href="/rel">r</a> <a href="mailto:x@y">m</a>'),
    ["https://x/a", "/rel"],
  );
});

test("checkLinks checks only absolute links and reports broken ones", async () => {
  const { result } = await withFetch(
    (url) => (url.includes("bad") ? { status: 404, body: undefined } : { status: 200, body: undefined }),
    () => checkLinks(["https://good/x", "https://bad/y", "/relative"], 30000),
  );
  assert.deepEqual(result, [
    { url: "https://good/x", ok: true, status: 200 },
    { url: "https://bad/y", ok: false, status: 404 },
  ]);
});

test("checkLinks memoizes each distinct url via the shared cache (one check per url)", async () => {
  const cache = new Map();
  const { calls } = await withFetch(
    () => ({ status: 200, body: undefined }),
    async () => {
      await checkLinks(["https://x/a", "https://x/b"], 30000, 6, cache);
      // A second page re-links the same host: only the NEW url hits the network.
      await checkLinks(["https://x/a", "https://x/c"], 30000, 6, cache);
    },
  );
  assert.deepEqual(calls.sort(), ["https://x/a", "https://x/b", "https://x/c"]);
});

test("reviewPageCurrency captures body text + version and uses the link cache", async () => {
  const dir = async (): Promise<UserRecord | undefined> => undefined;
  const cache = new Map();
  const handler = (url: string) => {
    if (url.includes("/rest/api/content/")) {
      return {
        body: {
          id: "55",
          title: "VPN Guide",
          body: { storage: { value: '<p>Body <a href="https://good.example/x">good</a></p>' } },
          version: { when: "2026-06-01T00:00:00Z", number: 7 },
          metadata: { labels: { results: [] } },
          _links: { webui: "/p/55" },
        },
      };
    }
    return { status: 200, body: undefined };
  };
  const { result, calls } = await withFetch(handler, async () => {
    const a = await reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z", cache);
    const b = await reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z", cache);
    return [a, b] as const;
  });
  assert.equal(result[0].version, 7);
  assert.match(result[0].bodyText ?? "", /Body good/);
  // Two page fetches, but the shared link is checked exactly once.
  assert.equal(calls.filter((u) => u.includes("good.example")).length, 1);
});

test("reviewPageCurrency with a WIRED directory flags broken links, inactive owners, and staleness", async () => {
  const dir = async (sam: string): Promise<UserRecord | undefined> =>
    sam === "jdoe"
      ? { sam: "jdoe", active: true, email: "jdoe@x" }
      : sam === "olduser"
        ? { sam: "olduser", active: false }
        : undefined;
  const { result } = await withFetch(
    (url) => {
      if (url.includes("/rest/api/content/")) {
        return {
          body: {
            id: "55",
            title: "VPN Guide",
            body: { storage: { value: '<p>see <a href="https://good.example/x">good</a> and <a href="https://bad.example/y">bad</a></p>' } },
            version: { when: "2024-01-01T00:00:00Z" },
            metadata: { labels: { results: [{ name: "owners|jdoe|olduser" }, { name: "policy" }] } },
            _links: { webui: "/p/55" },
          },
        };
      }
      return url.includes("bad.example") ? { status: 404, body: undefined } : { status: 200, body: undefined };
    },
    () => reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z"),
  );
  assert.equal(result.brokenLinks.length, 1);
  assert.match(result.brokenLinks[0].url, /bad\.example/);
  assert.equal(result.brokenLinks[0].status, 404);
  assert.equal(result.workingLinks, 1);
  assert.deepEqual(result.inactiveOwners, ["olduser"]);
  assert.equal(result.owners.find((o) => o.sam === "jdoe")?.contact, "jdoe@x");
  assert.ok((result.staleDays ?? 0) > 365);
  assert.ok(result.issues.some((i) => /broken link/.test(i)));
  assert.ok(result.issues.some((i) => /inactive owner/.test(i)));
  assert.ok(result.issues.some((i) => /not updated/.test(i)));
});

const TAGGED_PAGE = {
  id: "55",
  title: "VPN Guide",
  body: { storage: { value: "<p>plain</p>" } },
  version: { when: "2026-06-01T00:00:00Z", number: 3 },
  metadata: { labels: { results: [{ name: "owners|jdoe|olduser" }] } },
  _links: { webui: "/p/55" },
};

test("reviewPageCurrency with NO directory treats labeled owners as active (unverified) — no inactive issue", async () => {
  // The regression this locks: with no LDAP directory configured, a fully
  // tagged healthy space must NOT flag every owner inactive/ownerless (which
  // opened a work item per page and drafted outreach for everyone). Matching
  // resolveOwners, everyone is treated active when nothing can verify them.
  const { result } = await withFetch(
    (url) => (url.includes("/rest/api/content/") ? { body: TAGGED_PAGE } : { status: 200, body: undefined }),
    () => reviewPageCurrency(SRC, CRED, "55", undefined, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z"),
  );
  assert.equal(result.hasOwnerLabel, true);
  assert.deepEqual(
    result.owners.map((o) => ({ sam: o.sam, active: o.active })),
    [
      { sam: "jdoe", active: true },
      { sam: "olduser", active: true },
    ],
  );
  assert.deepEqual(result.inactiveOwners, []);
  assert.ok(!result.issues.some((i) => /inactive owner/.test(i)), `no inactive-owner issue: ${result.issues}`);
  // No directory ⇒ no contact enrichment either.
  assert.ok(result.owners.every((o) => o.contact === undefined));
});

// --- DNS-vantage handling (Entra-joined workstation over a VPN, NRPT) --------

/** The error shape Node's fetch throws on a DNS miss: a generic "fetch failed"
 *  with the errno buried in the cause chain. */
const dnsFailure = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND wiki.corp.example"), { code: "ENOTFOUND" }),
  });

/** Fetch mock whose handler may THROW (withFetch above always answers). */
async function withThrowingFetch<T>(
  handler: (url: string) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return handler(String(url));
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Injected DNS probe returning a fixed answer, counting hosts probed. */
function fakeProbe(probe: DnsPathProbe): { fn: (host: string) => Promise<DnsPathProbe>; hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    fn: async (host: string) => {
      hosts.push(host);
      return probe;
    },
  };
}

test("checkLinks: a DNS-failing link on an unresolvable name is UNVERIFIABLE, not broken", async () => {
  const probe = fakeProbe({ osPath: false, directPath: false });
  const { result, calls } = await withThrowingFetch(
    () => {
      throw dnsFailure();
    },
    () => checkLinks(["https://wiki.corp.example/page"], 30000, 6, undefined, probe.fn),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].unverifiable, true);
  assert.match(result[0].dnsNote ?? "", /either path/);
  assert.deepEqual(probe.hosts, ["wiki.corp.example"]);
  assert.equal(calls.length, 1, "no retry when the OS path cannot resolve the name");
});

test("checkLinks: OS-path-resolvable name gets ONE retry, and a success clears the link", async () => {
  const probe = fakeProbe({ osPath: true, directPath: false }); // NRPT/VPN-routed name
  let attempts = 0;
  const { result, calls } = await withThrowingFetch(
    () => {
      attempts += 1;
      if (attempts === 1) throw dnsFailure(); // transient resolver hiccup
      return new Response(undefined, { status: 200 });
    },
    () => checkLinks(["https://wiki.corp.example/page"], 30000, 6, undefined, probe.fn),
  );
  assert.deepEqual(result, [{ url: "https://wiki.corp.example/page", ok: true, status: 200 }]);
  assert.equal(calls.length, 2, "exactly one retry");
  assert.deepEqual(probe.hosts, ["wiki.corp.example"]);
});

test("checkLinks: OS-path-resolvable name whose retry ALSO fails is unverifiable with the VPN note", async () => {
  const probe = fakeProbe({ osPath: true, directPath: false });
  const { result, calls } = await withThrowingFetch(
    () => {
      throw dnsFailure();
    },
    () => checkLinks(["https://wiki.corp.example/page"], 30000, 6, undefined, probe.fn),
  );
  assert.equal(result[0].ok, false);
  assert.equal(result[0].unverifiable, true);
  assert.match(result[0].dnsNote ?? "", /NRPT\/VPN path/);
  assert.equal(calls.length, 2, "retried once, then classified");
});

test("checkLinks: direct-only (NRPT hiding the name from apps) is unverifiable WITHOUT a retry", async () => {
  const probe = fakeProbe({ osPath: false, directPath: true });
  const { result, calls } = await withThrowingFetch(
    () => {
      throw dnsFailure();
    },
    () => checkLinks(["https://wiki.corp.example/page"], 30000, 6, undefined, probe.fn),
  );
  assert.equal(result[0].unverifiable, true);
  assert.match(result[0].dnsNote ?? "", /misconfiguration/);
  assert.equal(calls.length, 1, "retry is pointless when the OS resolver can't see the name");
});

test("checkLinks: non-DNS failures never trigger a probe and stay plain errors", async () => {
  const probe = fakeProbe({ osPath: true, directPath: true, addressesAgree: true });
  const { result } = await withThrowingFetch(
    () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED" }),
      });
    },
    () => checkLinks(["https://wiki.corp.example/page"], 30000, 6, undefined, probe.fn),
  );
  assert.equal(result[0].ok, false);
  assert.equal(result[0].unverifiable, undefined);
  assert.equal(result[0].dnsNote, undefined);
  assert.deepEqual(probe.hosts, [], "DNS probe only runs on DNS-shaped failures");
});

test("checkLinks: probes are memoized per HOST (many links, one probe)", async () => {
  const probe = fakeProbe({ osPath: false, directPath: false });
  const { result } = await withThrowingFetch(
    () => {
      throw dnsFailure();
    },
    () =>
      checkLinks(
        ["https://wiki.corp.example/a", "https://wiki.corp.example/b", "https://other.corp.example/c"],
        30000,
        6,
        undefined,
        probe.fn,
      ),
  );
  assert.equal(result.filter((r) => r.unverifiable).length, 3);
  assert.deepEqual(probe.hosts.sort(), ["other.corp.example", "wiki.corp.example"]);
});

test("reviewPageCurrency: DNS-unverifiable links are not broken, raise no issue, and do NOT flag the page", async () => {
  const dir = async (sam: string): Promise<UserRecord | undefined> =>
    sam === "jdoe" ? { sam: "jdoe", active: true } : undefined;
  const probe = fakeProbe({ osPath: false, directPath: false }); // scanned off-VPN
  const { result } = await withThrowingFetch(
    (url) => {
      if (url.includes("/rest/api/content/")) {
        return new Response(
          JSON.stringify({
            id: "55",
            title: "VPN Guide",
            body: {
              storage: {
                value:
                  '<p><a href="https://wiki.corp.example/runbook">intranet</a> and <a href="https://good.example/x">public</a></p>',
              },
            },
            version: { when: "2026-06-01T00:00:00Z", number: 2 },
            metadata: { labels: { results: [{ name: "owners|jdoe" }] } },
            _links: { webui: "/p/55" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("corp.example")) throw dnsFailure();
      return new Response(undefined, { status: 200 });
    },
    () => reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z", undefined, probe.fn),
  );
  assert.deepEqual(result.brokenLinks, [], "a DNS-vantage failure is not evidence the link is broken");
  assert.equal(result.unverifiableLinks.length, 1);
  assert.match(result.unverifiableLinks[0].url, /corp\.example/);
  assert.match(result.unverifiableLinks[0].dnsNote ?? "", /either path/);
  assert.equal(result.unverifiableNote, "1 link(s) unverifiable from this network vantage (DNS)");
  assert.equal(result.workingLinks, 1, "only the genuinely reachable link counts as working");
  assert.deepEqual(result.issues, [], "no broken-link (or any) issue from an unverifiable link");
  // The dossier row built from this report (as contextService builds it) must
  // carry NO data-quality flag — the off-VPN false-flagging this fixes.
  const flags = flagsFor({
    id: result.pageId,
    title: result.title,
    url: result.url,
    owners: result.owners,
    hasOwnerLabel: result.hasOwnerLabel,
    ...(result.staleDays !== undefined ? { staleDays: result.staleDays } : {}),
    brokenLinks: result.brokenLinks.length,
    issues: result.issues,
  });
  assert.equal(flags.dataQuality, false);
  assert.equal(flags.flagged, false);
});

test("reviewPageCurrency degrades a FAULTING directory to active-unverified instead of failing or flagging", async () => {
  // Mirrors resolveOwners' checkActive step-down: a flaky/locked-out LDAP must
  // turn the activity check into a less-reliable answer, not an error and not
  // a false "inactive owner(s)" flag.
  const dir = async (): Promise<UserRecord | undefined> => {
    throw new Error("Authentication rejected (401) — LDAP circuit open");
  };
  const { result } = await withFetch(
    (url) => (url.includes("/rest/api/content/") ? { body: TAGGED_PAGE } : { status: 200, body: undefined }),
    () => reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z"),
  );
  assert.deepEqual(result.inactiveOwners, []);
  assert.ok(result.owners.every((o) => o.active));
  assert.ok(!result.issues.some((i) => /inactive owner/.test(i)));
});
