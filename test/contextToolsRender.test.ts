import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  renderCapabilities,
  renderValidation,
  renderOwners,
  renderManageability,
  renderHierarchy,
  renderCurrency,
} from "../src/chat/contextToolsRender";

test("renderCapabilities lists in-use elements and the authorable vocabulary with the storage-format warning", () => {
  const out = renderCapabilities({
    pagesSampled: 3,
    apps: ["Draw.io"],
    used: [{ name: "toc", count: 2, spec: { label: "Table of contents" }, app: undefined } as never],
  } as never);
  assert.match(out, /# Confluence content capabilities/);
  assert.match(out, /Sampled 3 page/);
  assert.match(out, /Apps detected.*Draw\.io/);
  assert.match(out, /`toc` ×2 — Table of contents/);
  assert.match(out, /Authorable vocabulary/);
  assert.match(out, /NEVER wiki\/markdown shorthand/);
});

test("renderValidation flags leaked shorthand, else confirms clean render", () => {
  const leaked = renderValidation({
    title: "Guide",
    url: "https://wiki/1",
    leaks: [{ markup: "[TOC]", macro: "toc" }],
    rendered: [{ name: "toc", count: 1 }],
    textLength: 100,
  } as never);
  assert.match(leaked, /Leaked markup/);
  assert.match(leaked, /`\[TOC\]` rendered as literal text/);

  const clean = renderValidation({ title: "G", url: "u", leaks: [], rendered: [], textLength: 5 } as never);
  assert.match(clean, /No leaked wiki\/markdown shorthand/);
  assert.match(clean, /none detected — a plain-text page/);
});

test("renderOwners shows the unverified-directory note when no directory is wired", () => {
  const out = renderOwners({
    resolution: { owners: ["jdoe"], basis: "owner label", considered: [] } as never,
    labels: ["owners|jdoe"],
    directoryWired: false,
  });
  assert.match(out, /# Page owner\(s\)/);
  assert.match(out, /Owner\(s\): jdoe/);
  assert.match(out, /no LDAP\/M365 directory is configured/);
});

test("renderOwners marks inactive contacts and reports directory-on validation", () => {
  const out = renderOwners({
    resolution: { owners: ["jdoe"], basis: "top contributor", considered: [{ sam: "jdoe", count: 4, score: 0.8 }] } as never,
    labels: [],
    directoryWired: true,
    directoryLabel: "Corp LDAP",
    ownerContacts: [{ sam: "jdoe", displayName: "J Doe", contact: "j@x", active: false }],
  });
  assert.match(out, /J Doe \(jdoe\) <j@x> — ⚠️ inactive/);
  assert.match(out, /Active-employee validation: ON via Corp LDAP/);
  assert.match(out, /Top recent contributors: jdoe \(4×, score 0\.80\)/);
});

test("renderManageability lists gaps + access request, or a clean check", () => {
  const gaps = renderManageability({
    report: { spaceKey: "ENG", user: "me", checkedPages: 5, manageablePages: 4, gaps: [{ title: "P", missing: ["update"], url: "u" }] } as never,
    note: "Please grant update on P.",
  });
  assert.match(gaps, /can't fully manage \(1\)/);
  assert.match(gaps, /P — missing \*\*update\*\* — u/);
  assert.match(gaps, /Access request/);

  const clean = renderManageability({
    report: { spaceKey: "ENG", user: "me", checkedPages: 5, manageablePages: 5, gaps: [] } as never,
    note: "All pages manageable.",
  });
  assert.match(clean, /✅ All pages manageable\./);
});

test("renderHierarchy renders each view kind", () => {
  assert.match(
    renderHierarchy({ kind: "roots", spaceKey: "ENG", roots: [{ id: "1", title: "Home", url: "u" }] } as never),
    /# Space ENG — 1 root page/,
  );
  assert.match(
    renderHierarchy({ kind: "children", page: { id: "1", title: "Home", url: "u" }, children: [] } as never),
    /# Children of “Home” \(id 1\) — 0/,
  );
  assert.match(
    renderHierarchy({ kind: "subtree", root: { id: "1", title: "Home", url: "u" }, count: 0, tree: { id: "1", title: "Home", url: "u", children: [] } } as never),
    /# Subtree of “Home” \(id 1\) — 0 descendant/,
  );
});

test("renderCurrency reports broken links, ownership, and staleness", () => {
  const out = renderCurrency({
    title: "VPN",
    url: "https://wiki/1",
    brokenLinks: [{ url: "https://dead/x", status: 404 }],
    workingLinks: 2,
    uncheckedRelativeLinks: 1,
    hasOwnerLabel: true,
    owners: [{ sam: "jdoe", active: true }],
    staleDays: 400,
  } as never);
  assert.match(out, /❌ https:\/\/dead\/x \(404\)/);
  assert.match(out, /1 relative link\(s\) not checked/);
  assert.match(out, /Owner tag: jdoe/);
  assert.match(out, /Last updated 400 day\(s\) ago — \*\*stale\*\*/);
});
