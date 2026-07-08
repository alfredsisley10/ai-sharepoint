import { test } from "node:test";
import * as assert from "node:assert/strict";
import { probeDnsPaths, classifyDnsOutcome, DnsPathProbe } from "../src/core/dnsDiagnostics";

/** Fake resolver helpers. */
const returns = (addrs: string[]) => async () => addrs;
const throwsCode = (code: string, msg = code) => async (): Promise<string[]> => {
  throw Object.assign(new Error(msg), { code });
};

test("probeDnsPaths: both paths resolve to the SAME addresses → resolvable, addressesAgree", async () => {
  const probe = await probeDnsPaths("wiki.corp.example", {
    lookup: returns(["10.1.2.3"]),
    resolve: returns(["10.1.2.3", "10.1.2.4"]),
  });
  assert.deepEqual(probe, { osPath: true, directPath: true, addressesAgree: true });
  const { verdict, note } = classifyDnsOutcome(probe);
  assert.equal(verdict, "resolvable");
  assert.match(note, /resolves consistently/);
});

test("probeDnsPaths: both resolve but to DISJOINT addresses → split-dns (split-horizon)", async () => {
  const probe = await probeDnsPaths("wiki.corp.example", {
    lookup: returns(["10.0.0.5"]), // NRPT/VPN answer
    resolve: returns(["203.0.113.9"]), // public answer
  });
  assert.deepEqual(probe, { osPath: true, directPath: true, addressesAgree: false });
  const { verdict, note } = classifyDnsOutcome(probe);
  assert.equal(verdict, "split-dns");
  assert.match(note, /split-horizon/i);
});

test("probeDnsPaths: OS path resolves, direct query NXDOMAINs → os-path-only (VPN-routed name)", async () => {
  const probe = await probeDnsPaths("wiki.corp.example", {
    lookup: returns(["10.0.0.5"]),
    resolve: throwsCode("ENOTFOUND", "queryA ENOTFOUND wiki.corp.example"),
  });
  assert.equal(probe.addressesAgree, undefined); // only meaningful when both resolve
  assert.deepEqual(probe, { osPath: true, directPath: false });
  const { verdict, note } = classifyDnsOutcome(probe);
  assert.equal(verdict, "os-path-only");
  assert.match(note, /NRPT\/VPN path/);
  assert.match(note, /depends on the VPN tunnel/);
});

test("probeDnsPaths: direct query resolves, OS path NXDOMAINs → direct-only (NRPT misconfiguration)", async () => {
  const probe = await probeDnsPaths("wiki.corp.example", {
    lookup: throwsCode("ENOTFOUND", "getaddrinfo ENOTFOUND wiki.corp.example"),
    resolve: returns(["10.0.0.5"]),
  });
  assert.deepEqual(probe, { osPath: false, directPath: true });
  const { verdict, note } = classifyDnsOutcome(probe);
  assert.equal(verdict, "direct-only");
  assert.match(note, /NOT via the OS resolver/);
  assert.match(note, /misconfiguration/);
});

test("probeDnsPaths: neither path resolves → unresolvable (intranet-only or dead host)", async () => {
  const probe = await probeDnsPaths("gone.corp.example", {
    lookup: throwsCode("ENOTFOUND"),
    resolve: throwsCode("ENODATA"), // "name has no data" is a real answer → false
  });
  assert.deepEqual(probe, { osPath: false, directPath: false });
  const { verdict, note } = classifyDnsOutcome(probe);
  assert.equal(verdict, "unresolvable");
  assert.match(note, /either path/);
  assert.match(note, /needs the VPN|genuinely dead/);
});

test("probeDnsPaths: transport failures are 'error' (no verdict on the name), not false", async () => {
  const probe = await probeDnsPaths("wiki.corp.example", {
    lookup: returns(["10.0.0.5"]),
    resolve: throwsCode("ETIMEOUT", "queryA ETIMEOUT wiki.corp.example"),
  });
  assert.equal(probe.osPath, true);
  assert.equal(probe.directPath, "error");
  // An erroring direct path with a resolving OS path still reads os-path-only.
  assert.equal(classifyDnsOutcome(probe).verdict, "os-path-only");

  const both = await probeDnsPaths("wiki.corp.example", {
    lookup: throwsCode("EAI_AGAIN", "getaddrinfo EAI_AGAIN wiki.corp.example"),
    resolve: throwsCode("ECONNREFUSED"),
  });
  assert.equal(both.osPath, "error");
  assert.equal(both.directPath, "error");
  assert.equal(classifyDnsOutcome(both).verdict, "unresolvable");
});

test("probeDnsPaths: an EMPTY address list is 'name has no address' (false), not an error", async () => {
  const probe = await probeDnsPaths("empty.corp.example", {
    lookup: returns([]),
    resolve: returns(["10.0.0.5"]),
  });
  assert.deepEqual(probe, { osPath: false, directPath: true });
  assert.equal(classifyDnsOutcome(probe).verdict, "direct-only");
});

test("classifyDnsOutcome: agreement unknown (one probe defaulted) still reads resolvable", () => {
  // Callers may construct probes without address comparison; absence of
  // addressesAgree must not be treated as disagreement.
  const probe: DnsPathProbe = { osPath: true, directPath: true };
  assert.equal(classifyDnsOutcome(probe).verdict, "resolvable");
});
