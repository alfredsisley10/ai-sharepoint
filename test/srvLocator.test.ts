import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseLdapTarget,
  srvLocatorUrl,
  isSrvLocator,
  candidateUrls,
  rankSrv,
  gcSrvName,
  dcSrvName,
} from "../src/context/ldap/srvLocator";

test("locator URLs encode the SRV record itself, not a server", () => {
  assert.equal(srvLocatorUrl("corp.example", "gc"), "ldaps+srv://_gc._tcp.corp.example");
  assert.equal(
    srvLocatorUrl("corp.example", "dc"),
    "ldaps+srv://_ldap._tcp.dc._msdcs.corp.example",
  );
  assert.equal(gcSrvName("x.y"), "_gc._tcp.x.y");
  assert.equal(dcSrvName("x.y"), "_ldap._tcp.dc._msdcs.x.y");
});

test("parseLdapTarget distinguishes srv locators from static URLs", () => {
  assert.deepEqual(parseLdapTarget("ldaps+srv://_gc._tcp.corp.example"), {
    kind: "srv",
    srvName: "_gc._tcp.corp.example",
    secure: true,
  });
  assert.deepEqual(parseLdapTarget("ldap+srv://_ldap._tcp.dc._msdcs.corp.example"), {
    kind: "srv",
    srvName: "_ldap._tcp.dc._msdcs.corp.example",
    secure: false,
  });
  assert.deepEqual(parseLdapTarget("ldaps://dc01.corp.example:636"), {
    kind: "static",
    url: "ldaps://dc01.corp.example:636",
  });
  assert.ok(isSrvLocator("LDAPS+SRV://_gc._tcp.x"));
  assert.ok(!isSrvLocator("ldaps://host"));
});

test("candidate URLs are ranked (priority, then weight), deduped, capped, secure-port mapped", () => {
  const target = parseLdapTarget("ldaps+srv://_gc._tcp.corp.example");
  const urls = candidateUrls(
    target,
    [
      { name: "gc3.corp.example.", port: 3268, priority: 10, weight: 100 },
      { name: "gc1.corp.example", port: 3268, priority: 0, weight: 50 },
      { name: "gc2.corp.example", port: 3268, priority: 0, weight: 100 },
      { name: "gc2.corp.example", port: 3268, priority: 0, weight: 100 }, // dup
      { name: "gc4.corp.example", port: 3268, priority: 20, weight: 0 },
    ],
    3,
  );
  assert.deepEqual(urls, [
    "ldaps://gc2.corp.example:3269", // weight 100 before 50 at same priority
    "ldaps://gc1.corp.example:3269",
    "ldaps://gc3.corp.example:3269", // trailing dot stripped; cap at 3
  ]);
});

test("dc locator maps to 636; non-secure locator keeps the SRV-advertised port", () => {
  const dc = candidateUrls(parseLdapTarget("ldaps+srv://_ldap._tcp.dc._msdcs.x"), [
    { name: "dc1.x", port: 389, priority: 0, weight: 0 },
  ]);
  assert.deepEqual(dc, ["ldaps://dc1.x:636"]);
  const plain = candidateUrls(parseLdapTarget("ldap+srv://_gc._tcp.x"), [
    { name: "gc1.x", port: 3268, priority: 0, weight: 0 },
  ]);
  assert.deepEqual(plain, ["ldap://gc1.x:3268"]);
});

test("static targets resolve to themselves; rankSrv is exported and stable", () => {
  assert.deepEqual(candidateUrls(parseLdapTarget("ldaps://h:636"), []), ["ldaps://h:636"]);
  const ranked = rankSrv([
    { name: "b", port: 1, priority: 1, weight: 0 },
    { name: "a", port: 1, priority: 0, weight: 0 },
  ]);
  assert.equal(ranked[0].name, "a");
});
