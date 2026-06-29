import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { zipSync, strFromU8 } from "fflate";
import { rebrandSourceArchive } from "../src/branding/rebrandVsix";
import { buildBrandTokens } from "../src/branding/brandTokens";
import { ORIGIN_BRAND, rebrandOriginModule } from "../src/branding/originBrand";

// CommonJS build script; path is relative to the COMPILED test (out-test/test/…).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundler = require("../../scripts/bundle-source") as {
  collectSourceFiles(root: string): Record<string, Uint8Array>;
};
const repoRoot = path.join(__dirname, "..", "..");

// Every distinctive origin identifier that must NOT survive a white-label
// export. Bare "SharePoint"/"sharepoint" (Microsoft's product) is intentionally
// absent — it is preserved on purpose.
const ORIGIN_LITERALS = [
  ORIGIN_BRAND.displayName, // "AI SharePoint"
  `@${ORIGIN_BRAND.handle}`, // "@sharepoint"
  ORIGIN_BRAND.namespace, // "aiSharePoint"
  ORIGIN_BRAND.namespaceLower, // "aisharepoint"
  ORIGIN_BRAND.kebab, // "ai-sharepoint"
  ORIGIN_BRAND.publisher, // "alfredsisley10"
];

const opts = {
  tokens: buildBrandTokens({
    displayName: "Northwind Portal",
    handle: "northwind",
    renameIdentifiers: true,
    idNamespace: "northwindPortal",
    kebabName: "northwind-portal",
  }),
  after: {
    publisher: "northwind",
    name: "northwind-portal",
    displayName: "Northwind Portal",
    description: "Internal knowledge portal.",
    licenseHolder: "Northwind Traders, Inc.",
  },
  handle: "northwind",
  release: { channel: "whitelabel" as const, builtAt: "2026-06-29T00:00:00.000Z", productName: "Northwind Portal" },
};

test("white-label export of the REAL source leaves no prior identifiers or commit history", () => {
  const source = bundler.collectSourceFiles(repoRoot);

  // Commit history / VCS metadata is never even bundled (allowlist).
  assert.ok(
    !Object.keys(source).some((n) => n === ".git" || n.startsWith(".git/")),
    "no .git metadata in the bundled source",
  );

  const out = rebrandSourceArchive(zipSync(source), opts);

  // The export carries no VCS metadata either.
  assert.ok(!Object.keys(out).some((n) => n === ".git" || n.startsWith(".git/")), "no .git in the export");

  // The exhaustive guarantee: scan EVERY exported file for EVERY origin
  // identifier. Skip-listed build tooling, token-rewritten product/engine/tests,
  // the regenerated originBrand.ts, and the dropped/refreshed docs must all be
  // clean. (If a future change reintroduces a literal in a skip-listed path,
  // this fails and names the file + token.)
  const offenders: string[] = [];
  for (const [name, bytes] of Object.entries(out)) {
    const body = strFromU8(bytes);
    for (const lit of ORIGIN_LITERALS) {
      if (body.includes(lit)) offenders.push(`${name} :: "${lit}"`);
    }
  }
  assert.deepEqual(offenders, [], `exported source leaks origin identifiers:\n${offenders.join("\n")}`);

  // Spot-check the new identity actually landed.
  assert.match(strFromU8(out["package.json"]), /"publisher": "northwind"/);
  assert.match(strFromU8(out["src/branding/originBrand.ts"]), /displayName: "Northwind Portal"/);
});

test("exported source keeps package.json %placeholders% resolvable in package.nls.json (any rebrand)", () => {
  const out = rebrandSourceArchive(zipSync(bundler.collectSourceFiles(repoRoot)), opts);
  // The NLS bundle must ship, or VS Code shows raw "%view.…%" for every contribution.
  assert.ok(out["package.nls.json"], "package.nls.json is included in the export");
  const pkg = strFromU8(out["package.json"]);
  const nls = JSON.parse(strFromU8(out["package.nls.json"])) as Record<string, string>;
  // Every %key% in the rebranded package.json must resolve in the rebranded NLS bundle.
  const placeholders = [...new Set((pkg.match(/%[A-Za-z0-9._-]+%/g) ?? []).map((s) => s.slice(1, -1)))];
  assert.ok(placeholders.length > 50, "sanity: package.json has many NLS placeholders");
  const missing = placeholders.filter((k) => !(k in nls));
  assert.deepEqual(missing, [], `unresolved NLS placeholders after rebrand: ${missing.join(", ")}`);
});

test("rebrandOriginModule rewrites only ORIGIN_BRAND values, preserving structure", () => {
  // Mirror the real module's shape.
  const src = [
    "export const ORIGIN_BRAND: OriginBrand = {",
    `  displayName: ${JSON.stringify(ORIGIN_BRAND.displayName)},`,
    `  handle: ${JSON.stringify(ORIGIN_BRAND.handle)},`,
    `  namespace: ${JSON.stringify(ORIGIN_BRAND.namespace)},`,
    `  namespaceLower: ${JSON.stringify(ORIGIN_BRAND.namespaceLower)},`,
    `  kebab: ${JSON.stringify(ORIGIN_BRAND.kebab)},`,
    `  publisher: ${JSON.stringify(ORIGIN_BRAND.publisher)},`,
    "};",
    "export function noop() { return 1; }", // unrelated code preserved
  ].join("\n");
  const out = rebrandOriginModule(src, {
    displayName: "Northwind Portal",
    handle: "northwind",
    namespace: "northwindPortal",
    namespaceLower: "northwindportal",
    kebab: "northwind-portal",
    publisher: "northwind",
  });
  assert.match(out, /displayName: "Northwind Portal"/);
  assert.match(out, /publisher: "northwind"/);
  assert.match(out, /export function noop\(\) \{ return 1; \}/, "unrelated code preserved");
  for (const lit of ORIGIN_LITERALS) assert.ok(!out.includes(lit), `regenerated module still has "${lit}"`);
});

test("a `$` in a brand value can't corrupt the regenerated module", () => {
  const out = rebrandOriginModule(`export const ORIGIN_BRAND = {\n  displayName: "AI SharePoint",\n};\n`, {
    displayName: 'Cost $5 (50% off) $& $1',
    handle: "x",
    namespace: "x",
    namespaceLower: "x",
    kebab: "x",
    publisher: "x",
  });
  assert.match(out, /displayName: "Cost \$5 \(50% off\) \$& \$1"/);
});
