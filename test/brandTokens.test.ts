import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  DeepBrandConfig,
  camelize,
  validateDeepBrand,
  buildBrandTokens,
  applyBrandTokens,
  countTokenHits,
} from "../src/branding/brandTokens";
// Origin-side fixtures come from ORIGIN_BRAND (the single source of truth), so
// the engine tests hardcode NO prior identifiers and stay correct after a
// white-label export regenerates that module for the new brand.
import { ORIGIN_BRAND } from "../src/branding/originBrand";

const display: DeepBrandConfig = {
  displayName: "Contoso Docs",
  handle: "contosodocs",
  renameIdentifiers: false,
  kebabName: "contoso-docs",
};
const deep: DeepBrandConfig = { ...display, renameIdentifiers: true };

test("camelize handles kebab and spaced names", () => {
  assert.equal(camelize("contoso-docs"), "contosoDocs");
  assert.equal(camelize("Contoso Docs"), "contosoDocs");
  assert.equal(camelize("acme"), "acme");
});

test("validateDeepBrand enforces handle/namespace shapes", () => {
  assert.deepEqual(validateDeepBrand(display), []);
  assert.ok(validateDeepBrand({ ...display, handle: "Contoso Docs" }).length > 0);
  assert.ok(validateDeepBrand({ ...display, displayName: " " }).length > 0);
  assert.ok(validateDeepBrand({ ...deep, kebabName: "Bad_Name" }).length > 0);
});

test("display-only rebrand renames the product and handle, NOT Microsoft SharePoint", () => {
  const tokens = buildBrandTokens(display);
  const src = [
    `${ORIGIN_BRAND.displayName} connects to SharePoint Online.`,
    `Ask @${ORIGIN_BRAND.handle} about your SharePoint sites.`,
    `const x = vscode.getConfiguration('${ORIGIN_BRAND.namespace}');`,
    `registerTool('${ORIGIN_BRAND.namespaceLower}_search')`,
  ].join("\n");
  const out = applyBrandTokens(src, tokens);
  // our brand renamed:
  assert.match(out, /Contoso Docs connects to SharePoint Online\./); // product name only
  assert.match(out, /Ask @contosodocs about your SharePoint sites\./); // handle changed, MS name kept
  // Microsoft "SharePoint" preserved everywhere it stands alone:
  assert.ok(out.includes("SharePoint Online"));
  assert.ok(out.includes("your SharePoint sites"));
  // identifiers untouched in display-only mode:
  assert.ok(out.includes(ORIGIN_BRAND.namespace));
  assert.ok(out.includes(`${ORIGIN_BRAND.namespaceLower}_search`));
});

test("deep rebrand also renames internal identifier namespaces consistently", () => {
  const tokens = buildBrandTokens(deep);
  const src = [
    `vscode.getConfiguration('${ORIGIN_BRAND.namespace}')`,
    `register('${ORIGIN_BRAND.namespace}.connectSite')`,
    `registerTool('${ORIGIN_BRAND.namespaceLower}_search')`,
    `schema id ${ORIGIN_BRAND.kebab}/site-snapshot and folder .${ORIGIN_BRAND.namespaceLower}/site.json`,
    "SharePoint Online stays intact",
  ].join("\n");
  const out = applyBrandTokens(src, tokens);
  assert.match(out, /getConfiguration\('contosoDocs'\)/);
  assert.match(out, /register\('contosoDocs\.connectSite'\)/);
  assert.match(out, /registerTool\('contosodocs_search'\)/);
  assert.ok(out.includes("contoso-docs/site-snapshot")); // kebab schema id renamed
  assert.ok(out.includes(".contosodocs/site.json")); // dot-folder prefix renamed
  // Microsoft product name still preserved even in deep mode:
  assert.ok(out.includes("SharePoint Online stays intact"));
});

test("no token is mangled by another; replacement is single-pass", () => {
  const tokens = buildBrandTokens(deep);
  // the camelCase namespace must not be corrupted by the lowercase-prefix rule (or vice versa)
  const out = applyBrandTokens(`${ORIGIN_BRAND.namespace} ${ORIGIN_BRAND.namespaceLower} ${ORIGIN_BRAND.kebab}`, tokens);
  assert.equal(out, "contosoDocs contosodocs contoso-docs");
});

test("countTokenHits reports occurrences for dry-run reporting", () => {
  const tokens = buildBrandTokens(display);
  assert.equal(
    countTokenHits(`${ORIGIN_BRAND.displayName} and ${ORIGIN_BRAND.displayName} and @${ORIGIN_BRAND.handle}`, tokens),
    3,
  );
  assert.equal(countTokenHits("nothing here", tokens), 0);
});
