import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  domainToBaseDn,
  collectDomainSignals,
  guessBindUpn,
  discoverForDomain,
  discover,
  HostSignals,
  SrvRecord,
} from "../src/context/ldap/discovery";
import {
  escapeFilterValue,
  buildFilter,
  isProbablyDn,
  normalizeAttr,
  rdnValue,
  entryToHit,
  entryToItem,
  RawEntry,
} from "../src/context/ldap/ldapShape";

// --- discovery (pure) --------------------------------------------------------

test("domainToBaseDn builds DC components", () => {
  assert.equal(domainToBaseDn("corp.example.com"), "DC=corp,DC=example,DC=com");
  assert.equal(domainToBaseDn("Contoso.LOCAL"), "DC=Contoso,DC=LOCAL");
});

test("domain signals prefer USERDNSDOMAIN, then FQDN, then resolv.conf", () => {
  const signals: HostSignals = {
    env: { USERDNSDOMAIN: "CORP.EXAMPLE.COM" },
    hostname: "ws1.corp.example.com",
    resolvConf: "search ad.example.com other.example.com\nnameserver 10.0.0.1",
  };
  const domains = collectDomainSignals(signals).map((d) => d.domain);
  assert.equal(domains[0], "corp.example.com"); // USERDNSDOMAIN wins, lowercased
  assert.ok(domains.includes("ad.example.com")); // resolv.conf search picked up
  // dedup: corp.example.com appears once even though FQDN also yields it
  assert.equal(domains.filter((d) => d === "corp.example.com").length, 1);
});

test("no usable signals → empty list", () => {
  assert.deepEqual(
    collectDomainSignals({ env: {}, hostname: "vm" }),
    [],
  );
});

test("guessBindUpn appends domain unless already qualified", () => {
  assert.equal(guessBindUpn({ env: {}, hostname: "h", username: "jdoe" }, "corp.example"), "jdoe@corp.example");
  assert.equal(guessBindUpn({ env: {}, hostname: "h", username: "CORP\\jdoe" }, "corp.example"), "CORP\\jdoe");
  assert.equal(guessBindUpn({ env: {}, hostname: "h" }, "corp.example"), undefined);
});

function resolverFrom(map: Record<string, SrvRecord[]>) {
  return {
    resolveSrv: async (name: string) => {
      if (map[name]) return map[name];
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
  };
}

test("discoverForDomain ranks by priority then weight, GC before DC, secure ports", async () => {
  const resolver = resolverFrom({
    "_gc._tcp.corp.example": [
      { name: "gc2.corp.example", port: 3268, priority: 0, weight: 50 },
      { name: "gc1.corp.example", port: 3268, priority: 0, weight: 100 },
    ],
    "_ldap._tcp.dc._msdcs.corp.example": [
      { name: "dc1.corp.example", port: 389, priority: 0, weight: 100 },
    ],
  });
  const candidates = await discoverForDomain(resolver, "corp.example");
  assert.equal(candidates[0].host, "gc1.corp.example"); // higher weight first
  assert.equal(candidates[0].kind, "gc");
  assert.equal(candidates[0].port, 3269); // secure GC port
  assert.equal(candidates[0].url, "ldaps://gc1.corp.example:3269");
  assert.equal(candidates[2].kind, "dc"); // DCs after GCs
  assert.equal(candidates[2].port, 636);
});

test("discover falls through domains and throws a helpful error when no SRV", async () => {
  const resolver = resolverFrom({}); // nothing resolves
  await assert.rejects(
    discover(resolver, { env: { USERDNSDOMAIN: "corp.example" }, hostname: "h" }),
    /No Active Directory SRV records/,
  );
});

test("discover returns the first domain that yields candidates", async () => {
  const resolver = resolverFrom({
    "_gc._tcp.ad.example.com": [{ name: "dc.ad.example.com", port: 3268, priority: 0, weight: 0 }],
  });
  const result = await discover(resolver, {
    env: { USERDNSDOMAIN: "corp.example" }, // no records → skipped
    hostname: "ws.ad.example.com", // FQDN yields ad.example.com → resolves
  });
  assert.equal(result.domain, "ad.example.com");
  assert.equal(result.baseDn, "DC=ad,DC=example,DC=com");
  assert.equal(result.candidates.length, 1);
});

// --- ldap shape (pure) -------------------------------------------------------

test("filter escaping neutralizes RFC 4515 metacharacters", () => {
  assert.equal(escapeFilterValue("a*b(c)\\d"), "a\\2ab\\28c\\29\\5cd");
});

test("buildFilter: raw filter passthrough, free text → ANR (spaces kept, metachars escaped)", () => {
  assert.equal(buildFilter("(mail=jane@corp.com)"), "(mail=jane@corp.com)");
  assert.equal(buildFilter("Jane Doe"), "(anr=Jane Doe)"); // spaces are legal in filter values
  assert.equal(buildFilter("a*b(c)"), "(anr=a\\2ab\\28c\\29)"); // injection-safe
});

test("isProbablyDn recognizes DNs, rejects plain text", () => {
  assert.ok(isProbablyDn("CN=Jane,OU=Users,DC=corp,DC=example"));
  assert.ok(!isProbablyDn("Jane Doe"));
  assert.ok(!isProbablyDn("jane@corp.example"));
});

test("normalizeAttr coerces scalars/arrays and drops binary", () => {
  assert.deepEqual(normalizeAttr("x"), ["x"]);
  assert.deepEqual(normalizeAttr(["a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeAttr(Buffer.from("bin")), []);
  assert.deepEqual(normalizeAttr(undefined), []);
});

test("rdnValue extracts the first RDN", () => {
  assert.equal(rdnValue("CN=Jane Doe,OU=Users,DC=corp"), "Jane Doe");
});

const ENTRY: RawEntry = {
  dn: "CN=Jane Doe,OU=Users,DC=corp,DC=example",
  displayName: "Jane Doe",
  cn: "Jane Doe",
  mail: "jane@corp.example",
  sAMAccountName: "jdoe",
  title: "Engineer",
  department: "R&D",
  objectClass: ["top", "person", "organizationalPerson", "user"],
  memberOf: ["CN=Eng,OU=Groups,DC=corp", "CN=All,OU=Groups,DC=corp"],
  userPassword: Buffer.from("nope"),
};

test("entryToHit produces compact, credential-free metadata", () => {
  const hit = entryToHit(ENTRY);
  assert.equal(hit.title, "Jane Doe");
  assert.equal(hit.meta?.mail, "jane@corp.example");
  assert.equal(hit.meta?.login, "jdoe");
  assert.equal(hit.meta?.kind, "user");
  assert.equal(hit.meta?.dn, ENTRY.dn);
  assert.match(hit.url, /^ldap:\/\/\//);
  // binary attribute must never surface
  assert.ok(!JSON.stringify(hit).includes("nope"));
});

test("entryToItem renders a readable body, caps multivalue, drops binary", () => {
  const item = entryToItem(ENTRY, 8000, 1);
  assert.equal(item.title, "Jane Doe");
  assert.match(item.body, /dn: CN=Jane Doe/);
  assert.match(item.body, /memberOf \(2\):/);
  assert.match(item.body, /…and 1 more/); // maxMultivalue=1
  assert.ok(!item.body.includes("nope")); // userPassword buffer dropped
  assert.equal(item.meta?.mail, "jane@corp.example");
});

test("entryToItem truncates an over-long body", () => {
  const big: RawEntry = { dn: "CN=x", description: "y".repeat(50) };
  const item = entryToItem(big, 20);
  assert.ok(item.body.length <= 21);
  assert.ok(item.body.endsWith("…"));
});
