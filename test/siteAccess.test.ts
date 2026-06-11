import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SiteAccess } from "../src/auth/siteAccess";
import type { SiteConnection } from "../src/auth/sitesStore";

function conn(over: Partial<SiteConnection>): SiteConnection {
  return {
    siteUrl: "https://contoso.sharepoint.com/sites/Marketing",
    displayName: "Marketing",
    role: "managed",
    authProviderId: "msal-public-interactive",
    cacheHandle: "msal-cache:tenant:contoso.sharepoint.com",
    tenantHost: "contoso.sharepoint.com",
    ...over,
  };
}

function access(connections: SiteConnection[]): SiteAccess {
  const registry = {
    create: () => {
      throw new Error("not needed in these tests");
    },
  };
  return new SiteAccess({ list: () => connections }, registry as never);
}

const MARKETING = conn({});
const HR = conn({
  siteUrl: "https://contoso.sharepoint.com/sites/HR",
  displayName: "Human Resources",
});

test("no reference + exactly one connection resolves to it", () => {
  assert.equal(access([MARKETING]).resolve(undefined), MARKETING);
  assert.equal(access([MARKETING]).resolve("  "), MARKETING);
});

test("no reference + multiple connections resolves to nothing", () => {
  assert.equal(access([MARKETING, HR]).resolve(undefined), undefined);
});

test("exact URL match (case/trailing-slash insensitive)", () => {
  const a = access([MARKETING, HR]);
  assert.equal(a.resolve("HTTPS://contoso.sharepoint.com/sites/marketing/"), MARKETING);
});

test("URL-prefix match: a page URL resolves to its site", () => {
  const a = access([MARKETING, HR]);
  assert.equal(
    a.resolve("https://contoso.sharepoint.com/sites/HR/SitePages/Onboarding.aspx"),
    HR,
  );
});

test("display-name match: exact, then substring", () => {
  const a = access([MARKETING, HR]);
  assert.equal(a.resolve("human resources"), HR);
  assert.equal(a.resolve("marketing"), MARKETING);
  assert.equal(a.resolve("resources"), HR);
});

test("unmatchable references resolve to nothing", () => {
  assert.equal(access([MARKETING, HR]).resolve("finance"), undefined);
});

test("extractSiteUrl finds SharePoint URLs across clouds and ignores others", () => {
  const a = access([]);
  assert.equal(
    a.extractSiteUrl("see https://contoso.sharepoint.com/sites/X and https://example.com"),
    "https://contoso.sharepoint.com/sites/X",
  );
  assert.equal(
    a.extractSiteUrl("gov: https://agency.sharepoint.us/sites/Y."),
    "https://agency.sharepoint.us/sites/Y",
  );
  assert.equal(a.extractSiteUrl("no links here"), undefined);
});
