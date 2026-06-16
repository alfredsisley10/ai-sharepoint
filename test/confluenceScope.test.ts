import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseConfluenceUrl,
  isPersonalSpaceKey,
  writeScopeFromParsed,
  describeWriteScope,
  checkWriteScope,
} from "../src/context/adapters/confluenceScope";

// --- parseConfluenceUrl: instance base + scope -----------------------------

test("DC host root → instance scope, base is the origin", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net");
  assert.deepEqual(p, { baseUrl: "https://confluence.corp.net", scope: { kind: "instance" } });
});

test("DC root with a trailing slash is normalized", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/");
  assert.equal(p?.baseUrl, "https://confluence.corp.net");
  assert.equal(p?.scope.kind, "instance");
});

test("DC with a context path (no app marker) keeps the context path in the base", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/confluence");
  assert.equal(p?.baseUrl, "https://confluence.corp.net/confluence");
  assert.equal(p?.scope.kind, "instance");
});

test("DC context path + /display/<KEY> → base strips the app route, scope is the space", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/confluence/display/ENG");
  assert.equal(p?.baseUrl, "https://confluence.corp.net/confluence");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "ENG" });
});

test("DC /display/<KEY> shared space", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/display/ENG");
  assert.equal(p?.baseUrl, "https://confluence.corp.net");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "ENG" });
});

test("DC /display/~user PERSONAL space", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/display/~jdoe");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "~jdoe" });
  assert.ok(isPersonalSpaceKey(p?.scope.spaceKey));
});

test("DC /spaces/~user PERSONAL space (the path the user cited)", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/spaces/~userid");
  assert.equal(p?.baseUrl, "https://confluence.corp.net");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "~userid" });
});

test("percent-encoded tilde (%7E) decodes to a personal key", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/spaces/%7Ejdoe");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "~jdoe" });
  assert.ok(isPersonalSpaceKey(p?.scope.spaceKey));
});

test("DC /display/<KEY>/<Title> → page by title (no id), space known", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/display/ENG/Release+Notes");
  assert.deepEqual(p?.scope, { kind: "page", spaceKey: "ENG", pageTitle: "Release Notes" });
});

test("DC /pages/viewpage.action?pageId=… → page by id", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/pages/viewpage.action?pageId=123456&spaceKey=ENG");
  assert.deepEqual(p?.scope, { kind: "page", pageId: "123456", spaceKey: "ENG" });
});

test("newer DC /spaces/<KEY>/pages/<id>/<Title> → page by id in space", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/spaces/ENG/pages/789/Onboarding");
  assert.deepEqual(p?.scope, { kind: "page", spaceKey: "ENG", pageId: "789" });
});

test("/spaces/viewspace.action?key=ENG → space", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/spaces/viewspace.action?key=ENG");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "ENG" });
});

test("Cloud /wiki root keeps the /wiki context path", () => {
  const p = parseConfluenceUrl("https://acme.atlassian.net/wiki");
  assert.equal(p?.baseUrl, "https://acme.atlassian.net/wiki");
  assert.equal(p?.scope.kind, "instance");
});

test("Cloud /wiki/spaces/<KEY> space, base keeps /wiki", () => {
  const p = parseConfluenceUrl("https://acme.atlassian.net/wiki/spaces/ENG/overview");
  assert.equal(p?.baseUrl, "https://acme.atlassian.net/wiki");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "ENG" });
});

test("Cloud /wiki/spaces/<KEY>/pages/<id>/<Title> page", () => {
  const p = parseConfluenceUrl("https://acme.atlassian.net/wiki/spaces/ENG/pages/456/Title");
  assert.equal(p?.baseUrl, "https://acme.atlassian.net/wiki");
  assert.deepEqual(p?.scope, { kind: "page", spaceKey: "ENG", pageId: "456" });
});

test("Cloud personal space key with an encoded colon round-trips", () => {
  const p = parseConfluenceUrl("https://acme.atlassian.net/wiki/spaces/~712020%3Aabc-def/overview");
  assert.deepEqual(p?.scope, { kind: "space", spaceKey: "~712020:abc-def" });
  assert.ok(isPersonalSpaceKey(p?.scope.spaceKey));
  // and re-encoding for a REST path preserves the tilde, encodes the colon
  assert.equal(encodeURIComponent(p!.scope.spaceKey!), "~712020%3Aabc-def");
});

test("tiny /x/ link is opaque → instance scope (must paste a full URL)", () => {
  const p = parseConfluenceUrl("https://confluence.corp.net/x/AbCdEf");
  assert.equal(p?.scope.kind, "instance");
});

test("non-URL input returns undefined", () => {
  assert.equal(parseConfluenceUrl("not a url"), undefined);
  assert.equal(parseConfluenceUrl("ftp://confluence.corp.net/display/ENG"), undefined);
});

// --- isPersonalSpaceKey ----------------------------------------------------

test("isPersonalSpaceKey only for ~-prefixed keys", () => {
  assert.ok(isPersonalSpaceKey("~jdoe"));
  assert.ok(!isPersonalSpaceKey("ENG"));
  assert.ok(!isPersonalSpaceKey(undefined));
  assert.ok(!isPersonalSpaceKey(""));
});

// --- writeScopeFromParsed --------------------------------------------------

test("writeScopeFromParsed: page with id keeps page scope", () => {
  const p = parseConfluenceUrl("https://c.net/spaces/ENG/pages/9/Title")!;
  assert.deepEqual(writeScopeFromParsed(p, "u"), { kind: "page", pageId: "9", spaceKey: "ENG", url: "u" });
});

test("writeScopeFromParsed: page known only by title falls back to its space", () => {
  const p = parseConfluenceUrl("https://c.net/display/ENG/Some+Page")!;
  assert.deepEqual(writeScopeFromParsed(p, "u"), { kind: "space", spaceKey: "ENG", url: "u" });
});

test("writeScopeFromParsed: personal space scope", () => {
  const p = parseConfluenceUrl("https://c.net/spaces/~jdoe")!;
  assert.deepEqual(writeScopeFromParsed(p, "u"), { kind: "space", spaceKey: "~jdoe", url: "u" });
});

test("writeScopeFromParsed: instance root → instance scope", () => {
  const p = parseConfluenceUrl("https://c.net")!;
  assert.deepEqual(writeScopeFromParsed(p, "u"), { kind: "instance", url: "u" });
});

// --- describeWriteScope ----------------------------------------------------

test("describeWriteScope wording", () => {
  assert.match(describeWriteScope(undefined), /entire Confluence instance/);
  assert.match(describeWriteScope({ kind: "instance" }), /entire Confluence instance/);
  assert.match(describeWriteScope({ kind: "space", spaceKey: "ENG" }), /"ENG".*space/);
  assert.match(describeWriteScope({ kind: "space", spaceKey: "~jdoe" }), /personal/);
  assert.match(describeWriteScope({ kind: "page", pageId: "9", spaceKey: "ENG" }), /page 9 in "ENG"/);
});

// --- checkWriteScope -------------------------------------------------------

test("no scope / instance scope allows any write", () => {
  assert.deepEqual(checkWriteScope(undefined, { action: "create", spaceKey: "ANY" }), { allowed: true });
  assert.deepEqual(checkWriteScope({ kind: "instance" }, { action: "update", pageId: "1" }), { allowed: true });
});

test("space scope allows in-space writes, refuses out-of-space (case-insensitive)", () => {
  const scope = { kind: "space" as const, spaceKey: "ENG" };
  assert.equal(checkWriteScope(scope, { action: "create", spaceKey: "eng" }).allowed, true);
  assert.equal(checkWriteScope(scope, { action: "update", pageId: "1", spaceKey: "ENG" }).allowed, true);
  const denied = checkWriteScope(scope, { action: "create", spaceKey: "HR" });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason!, /outside the managed "ENG" space/);
});

test("personal space scope works the same", () => {
  const scope = { kind: "space" as const, spaceKey: "~jdoe" };
  assert.equal(checkWriteScope(scope, { action: "update", pageId: "1", spaceKey: "~jdoe" }).allowed, true);
  assert.equal(checkWriteScope(scope, { action: "update", pageId: "1", spaceKey: "~other" }).allowed, false);
});

test("page scope allows the page itself and direct children, refuses others", () => {
  const scope = { kind: "page" as const, pageId: "100" };
  assert.equal(checkWriteScope(scope, { action: "update", pageId: "100" }).allowed, true);
  assert.equal(checkWriteScope(scope, { action: "create", parentId: "100" }).allowed, true);
  assert.equal(checkWriteScope(scope, { action: "update", pageId: "999" }).allowed, false);
  assert.equal(checkWriteScope(scope, { action: "create", parentId: "999" }).allowed, false);
});
