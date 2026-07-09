import { test } from "node:test";
import * as assert from "node:assert/strict";
import { baseOf, webUrl, enc } from "../src/context/adapters/confluenceCommon";

test("baseOf trims trailing slashes: none, one, and many", () => {
  assert.equal(baseOf({ baseUrl: "https://wiki.example.com" }), "https://wiki.example.com");
  assert.equal(baseOf({ baseUrl: "https://wiki.example.com/" }), "https://wiki.example.com");
  // A doubled trailing slash must not survive — it would double the slash in
  // EVERY REST URL built on the base (`https://x///rest/api/...`).
  assert.equal(baseOf({ baseUrl: "https://wiki.example.com//" }), "https://wiki.example.com");
  assert.equal(baseOf({ baseUrl: "https://wiki.example.com/confluence///" }), "https://wiki.example.com/confluence");
});

test("baseOf only trims TRAILING slashes (context paths survive)", () => {
  assert.equal(baseOf({ baseUrl: "https://host/wiki" }), "https://host/wiki");
});

test("webUrl joins a webui path to the trimmed base", () => {
  assert.equal(webUrl({ baseUrl: "https://wiki.example.com/" }, "/pages/123"), "https://wiki.example.com/pages/123");
  assert.equal(webUrl({ baseUrl: "https://wiki.example.com//" }, "/pages/123"), "https://wiki.example.com/pages/123");
});

test("webUrl falls back to the base when there is no webui link", () => {
  assert.equal(webUrl({ baseUrl: "https://wiki.example.com/" }), "https://wiki.example.com");
  assert.equal(webUrl({ baseUrl: "https://wiki.example.com/" }, undefined), "https://wiki.example.com");
});

test("enc is encodeURIComponent", () => {
  assert.equal(enc("A B/C"), "A%20B%2FC");
});
