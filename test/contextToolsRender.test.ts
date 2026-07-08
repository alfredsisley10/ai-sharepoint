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
  // Determined WITHOUT verification, framed as a valid result, not a failure,
  // with an actionable path to enable active-employee verification.
  assert.match(out, /WITHOUT active-employee verification/);
  assert.match(out, /Add Context Source/);
});

test("renderOwners renders the audit trail: page probe, per-method outcomes, skipped steps", () => {
  const out = renderOwners({
    resolution: {
      owners: ["jdoe"],
      basis: "page-contributor",
      verification: "directory",
      audit: [
        { step: "owner-label", outcome: "no-result", detail: "the page has no labels" },
        { step: "page-contributors", outcome: "hit", detail: "top ACTIVE recency-weighted contributor of 3: jdoe", considered: [{ sam: "jdoe", count: 4 }] },
        { step: "space-contributors", outcome: "skipped", detail: "not attempted — an earlier method already determined the owner" },
        { step: "space-owners", outcome: "skipped", detail: "not attempted — an earlier method already determined the owner" },
      ],
    } as never,
    labels: [],
    directoryWired: true,
    directoryLabel: "Corp LDAP",
    pageProbe: { ok: true, title: "Runbook", spaceKey: "ENG" },
  });
  assert.match(out, /## How ownership was determined/);
  assert.match(out, /✓ Page lookup: “Runbook” in space ENG/);
  assert.match(out, /· Owner label: the page has no labels/);
  assert.match(out, /✓ Page contribution history: top ACTIVE.*jdoe.*considered: jdoe 4×/);
  assert.match(out, /↷ Space contribution history/);
  assert.doesNotMatch(out, /## Troubleshooting/, "clean run has no troubleshooting section");
});

test("renderOwners surfaces failures with targeted troubleshooting and the not-cached notice", () => {
  const out = renderOwners({
    resolution: {
      owners: [],
      basis: "none",
      note: "Owner resolution was DEGRADED — 1 method(s) failed (Page contribution history) and the remaining methods found no owner.",
      verification: "off",
      audit: [
        { step: "owner-label", outcome: "no-result", detail: "the page has no labels" },
        {
          step: "page-contributors",
          outcome: "failed",
          detail: "could not read the page's version history",
          error: { message: "GET /rest/experimental/content/7/version → Not found (404) at the source.", kind: "graph.notFound" },
        },
        { step: "space-contributors", outcome: "no-result", detail: "the space's version history yielded no contributors" },
        { step: "space-owners", outcome: "skipped", detail: "no space-owner lookup available for this source" },
      ],
    } as never,
    labels: [],
    directoryWired: false,
  });
  assert.match(out, /✗ Page contribution history: FAILED — GET \/rest\/experimental\/content\/7\/version/);
  assert.match(out, /## Troubleshooting/);
  assert.match(out, /NUMERIC content id/);
  assert.match(out, /NOT cached/);
});

test("renderOwners reports a directory outage as a step-down (configured but unavailable)", () => {
  const out = renderOwners({
    resolution: {
      owners: ["jdoe"],
      basis: "page-contributor",
      verification: "unavailable",
      directoryFault: "LDAP connect ECONNREFUSED",
      audit: [{ step: "page-contributors", outcome: "hit", detail: "top recency-weighted contributor of 2: jdoe" }],
      degraded: ["The configured directory failed during active-employee checks (LDAP ECONNREFUSED) — owners in this run are UNVERIFIED."],
    } as never,
    labels: [],
    directoryWired: true,
    directoryLabel: "LDAP (Corp)",
  });
  assert.match(out, /CONFIGURED BUT UNAVAILABLE/);
  assert.match(out, /UNVERIFIED/);
  // The outage's actual REASON renders (troubleshootable, not just announced).
  assert.match(out, /LDAP connect ECONNREFUSED/);
  assert.match(out, /## Troubleshooting/);
  assert.match(out, /Test Connection/);
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
