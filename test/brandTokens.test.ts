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
    "AI SharePoint connects to SharePoint Online.",
    "Ask @sharepoint about your SharePoint sites.",
    "const x = vscode.getConfiguration('aiSharePoint');",
    "registerTool('aisharepoint_search')",
  ].join("\n");
  const out = applyBrandTokens(src, tokens);
  // our brand renamed:
  assert.match(out, /Contoso Docs connects to SharePoint Online\./); // product name only
  assert.match(out, /Ask @contosodocs about your SharePoint sites\./); // handle changed, MS name kept
  // Microsoft "SharePoint" preserved everywhere it stands alone:
  assert.ok(out.includes("SharePoint Online"));
  assert.ok(out.includes("your SharePoint sites"));
  // identifiers untouched in display-only mode:
  assert.ok(out.includes("aiSharePoint"));
  assert.ok(out.includes("aisharepoint_search"));
});

test("deep rebrand also renames internal identifier namespaces consistently", () => {
  const tokens = buildBrandTokens(deep);
  const src = [
    "vscode.getConfiguration('aiSharePoint')",
    "register('aiSharePoint.connectSite')",
    "registerTool('aisharepoint_search')",
    "schema id ai-sharepoint/site-snapshot and folder .aisharepoint/site.json",
    "SharePoint Online stays intact",
  ].join("\n");
  const out = applyBrandTokens(src, tokens);
  assert.match(out, /getConfiguration\('contosoDocs'\)/);
  assert.match(out, /register\('contosoDocs\.connectSite'\)/);
  assert.match(out, /registerTool\('contosodocs_search'\)/);
  assert.ok(out.includes("contoso-docs/site-snapshot")); // kebab schema id renamed
  assert.ok(out.includes(".contosodocs/site.json")); // .aisharepoint folder renamed
  // Microsoft product name still preserved even in deep mode:
  assert.ok(out.includes("SharePoint Online stays intact"));
});

test("no token is mangled by another; replacement is single-pass", () => {
  const tokens = buildBrandTokens(deep);
  // "aiSharePoint" must not be corrupted by the "aisharepoint" rule and vice versa
  const out = applyBrandTokens("aiSharePoint aisharepoint ai-sharepoint", tokens);
  assert.equal(out, "contosoDocs contosodocs contoso-docs");
});

test("countTokenHits reports occurrences for dry-run reporting", () => {
  const tokens = buildBrandTokens(display);
  assert.equal(countTokenHits("AI SharePoint and AI SharePoint and @sharepoint", tokens), 3);
  assert.equal(countTokenHits("nothing here", tokens), 0);
});
