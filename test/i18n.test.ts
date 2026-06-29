import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildBrandTokens, applyBrandTokens } from "../src/branding/brandTokens";

const root = path.join(__dirname, "..", "..");
const pkgRaw = fs.readFileSync(path.join(root, "package.json"), "utf8");
const nlsRaw = fs.readFileSync(path.join(root, "package.nls.json"), "utf8");
const pkg = JSON.parse(pkgRaw);
const nls = JSON.parse(nlsRaw) as Record<string, string>;

/** Collect every whole-value "%key%" placeholder in the manifest. */
function collectPlaceholders(o: unknown, out: Set<string>): void {
  if (Array.isArray(o)) {
    for (const v of o) collectPlaceholders(v, out);
  } else if (o && typeof o === "object") {
    for (const v of Object.values(o)) collectPlaceholders(v, out);
  } else if (typeof o === "string") {
    const m = o.match(/^%([\w.-]+)%$/);
    if (m) out.add(m[1]);
  }
}

const used = new Set<string>();
collectPlaceholders(pkg.contributes, used);

test("every %placeholder% in package.json resolves in package.nls.json", () => {
  const missing = [...used].filter((k) => !(k in nls));
  assert.deepEqual(missing, [], `unresolved NLS placeholders would render literally: ${missing.join(", ")}`);
});

test("package.nls.json has no orphan keys (every key is used)", () => {
  const orphan = Object.keys(nls).filter((k) => !used.has(k));
  assert.deepEqual(orphan, [], `unused NLS keys: ${orphan.join(", ")}`);
});

test("every NLS key is in the VS Code-resolvable charset [\\w.-]+", () => {
  // VS Code only substitutes %key% where key is word chars / dots / hyphens;
  // brackets or quotes would leave the literal "%key%" showing in the UI.
  const unsafe = Object.keys(nls).filter((k) => !/^[\w.-]+$/.test(k));
  assert.deepEqual(unsafe, [], `unsafe NLS keys: ${unsafe.join(", ")}`);
});

function placeholdersOf(contributes: unknown): Set<string> {
  const out = new Set<string>();
  collectPlaceholders(contributes, out);
  return out;
}

test("placeholder↔key correspondence survives a DEEP rebrand (identifiers renamed)", () => {
  // rebrandFlow applies brand tokens to package.json text directly and to
  // package.nls.json via the tree pass. The shared "aiSharePoint"→idNamespace
  // token must rename BOTH the placeholders and the keys identically, or the
  // rebranded build would show literal "%key%" in its UI.
  const tokens = buildBrandTokens({
    displayName: "Contoso Docs",
    handle: "contosodocs",
    renameIdentifiers: true,
    idNamespace: "contosoDocs",
    kebabName: "contoso-docs",
  });
  const rebrandedPkg = JSON.parse(applyBrandTokens(pkgRaw, tokens));
  const rebrandedNls = JSON.parse(applyBrandTokens(nlsRaw, tokens)) as Record<string, string>;

  const used = placeholdersOf(rebrandedPkg.contributes);
  const keys = new Set(Object.keys(rebrandedNls));
  const missing = [...used].filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `deep rebrand broke NLS resolution for: ${missing.join(", ")}`);
  // And the externalized brand string itself was actually rebranded.
  assert.equal(rebrandedNls["category"], "Contoso Docs");
});

test("rebrand-managed fields stay literal (not externalized)", () => {
  // The rebrand engine rewrites these by exact match / top-level edit, so they
  // must NOT be %placeholders%.
  assert.doesNotMatch(String(pkg.displayName), /^%.*%$/, "displayName must stay literal");
  assert.doesNotMatch(String(pkg.description), /^%.*%$/, "description must stay literal");
  for (const p of pkg.contributes.chatParticipants ?? []) {
    assert.doesNotMatch(String(p.fullName ?? ""), /^%.*%$/, "participant fullName must stay literal");
    assert.doesNotMatch(String(p.name ?? ""), /^%.*%$/, "participant name must stay literal");
  }
});
