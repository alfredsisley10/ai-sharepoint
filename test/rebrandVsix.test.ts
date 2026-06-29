import { test } from "node:test";
import * as assert from "node:assert/strict";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  rebrandVsix,
  rebrandVsixManifest,
  setManifestAttr,
  setManifestElement,
  readVsixPackageJson,
  readVsixSourceArchive,
  rebrandSourceArchive,
  minimalBuildComponents,
  minimalPackageJson,
  relaxExportDevDeps,
  VsixRebrandOptions,
} from "../src/branding/rebrandVsix";
import { buildBrandTokens } from "../src/branding/brandTokens";
import { BrandConfig } from "../src/branding/rebrand";
import { ReleaseManifest } from "../src/branding/releaseExpiry";
// Origin-side fixtures come from ORIGIN_BRAND (the single source of truth), so
// these tests hardcode NO prior identifiers and stay correct after export.
import { ORIGIN_BRAND } from "../src/branding/originBrand";

// Every distinctive origin identifier that must NOT survive a white-label export.
// (Bare "SharePoint"/"sharepoint" — Microsoft's product — is deliberately absent.)
const ORIGIN_LITERALS = [
  ORIGIN_BRAND.displayName,
  `@${ORIGIN_BRAND.handle}`,
  ORIGIN_BRAND.namespace,
  ORIGIN_BRAND.namespaceLower,
  ORIGIN_BRAND.kebab,
  ORIGIN_BRAND.publisher,
];

/** Assert no prior identifier survives anywhere in a rebranded file map. */
function assertAnonymized(files: Record<string, Uint8Array>, context = "") {
  for (const [name, bytes] of Object.entries(files)) {
    const body = strFromU8(bytes);
    for (const lit of ORIGIN_LITERALS) {
      assert.ok(!body.includes(lit), `${context}${name} leaks origin identifier "${lit}"`);
    }
  }
}

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0">
  <Metadata>
    <Identity Language="en-US" Id="${ORIGIN_BRAND.kebab}" Version="0.72.0" Publisher="${ORIGIN_BRAND.publisher}" />
    <DisplayName>${ORIGIN_BRAND.displayName}</DisplayName>
    <Description xml:space="preserve">Govern SharePoint with ${ORIGIN_BRAND.displayName}.</Description>
    <Tags>sharepoint,copilot</Tags>
  </Metadata>
</PackageManifest>`;

const PKG = JSON.stringify(
  {
    publisher: ORIGIN_BRAND.publisher,
    name: ORIGIN_BRAND.kebab,
    displayName: ORIGIN_BRAND.displayName,
    version: "0.72.0",
    description: `Govern SharePoint with ${ORIGIN_BRAND.displayName}.`,
    contributes: { chatParticipants: [{ name: ORIGIN_BRAND.handle, fullName: "SharePoint" }] },
  },
  null,
  2,
);

const BUNDLE = `console.log("${ORIGIN_BRAND.displayName} @${ORIGIN_BRAND.handle} ${ORIGIN_BRAND.namespace} ${ORIGIN_BRAND.kebab} reads a SharePoint site");`;
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // fake PNG bytes

function fixtureVsix(): Uint8Array {
  return zipSync({
    "extension.vsixmanifest": strToU8(MANIFEST),
    "[Content_Types].xml": strToU8("<Types/>"),
    "extension/package.json": strToU8(PKG),
    "extension/dist/extension.js": strToU8(BUNDLE),
    "extension/media/icon.png": ICON,
    "extension/readme.md": strToU8(
      `# ${ORIGIN_BRAND.displayName}\n\n**Govern SharePoint with ${ORIGIN_BRAND.displayName}.**\n\nUse @${ORIGIN_BRAND.handle}.`,
    ),
  });
}

const after: BrandConfig = {
  publisher: "contoso",
  name: "contoso-docs",
  displayName: "Contoso Docs",
  description: "Internal docs assistant.",
};
const release: ReleaseManifest = {
  channel: "whitelabel",
  builtAt: "2026-06-29T00:00:00.000Z",
  productName: "Contoso Docs",
};
function deepOpts(extra: Partial<VsixRebrandOptions> = {}): VsixRebrandOptions {
  return {
    tokens: buildBrandTokens({
      displayName: "Contoso Docs",
      handle: "contosodocs",
      renameIdentifiers: true,
      idNamespace: "contosoDocs",
      kebabName: "contoso-docs",
    }),
    after,
    handle: "contosodocs",
    release,
    ...extra,
  };
}

test("rebrandVsix rewrites package.json identity, participant, release, and the bundle", () => {
  const out = unzipSync(rebrandVsix(fixtureVsix(), deepOpts()));
  const pkg = JSON.parse(strFromU8(out["extension/package.json"]));
  assert.equal(pkg.publisher, "contoso");
  assert.equal(pkg.name, "contoso-docs");
  assert.equal(pkg.displayName, "Contoso Docs");
  assert.equal(pkg.description, "Internal docs assistant.");
  assert.equal(pkg.release.channel, "whitelabel");
  assert.equal(pkg.release.productName, "Contoso Docs");
  assert.equal(pkg.contributes.chatParticipants[0].name, "contosodocs");
  assert.equal(pkg.contributes.chatParticipants[0].fullName, "Contoso Docs");

  // The bundled JS had its brand tokens rewritten (deep rename), but Microsoft's
  // "SharePoint" product term is preserved.
  const bundle = strFromU8(out["extension/dist/extension.js"]);
  assert.match(bundle, /Contoso Docs @contosodocs contosoDocs contoso-docs/);
  assert.match(bundle, /reads a SharePoint site/, "bare 'SharePoint' must NOT be renamed");

  // README tagline is replaced with the new description (no duplicate description).
  const readme = strFromU8(out["extension/readme.md"]);
  assert.match(readme, /\*\*Internal docs assistant\.\*\*/);
  assert.doesNotMatch(readme, /Govern SharePoint/, "original tagline replaced, not duplicated");
});

test("rebrandVsix updates the vsixmanifest identity + display metadata", () => {
  const out = unzipSync(rebrandVsix(fixtureVsix(), deepOpts()));
  const xml = strFromU8(out["extension.vsixmanifest"]);
  assert.match(xml, /<Identity[^>]*\bId="contoso-docs"/);
  assert.match(xml, /<Identity[^>]*\bPublisher="contoso"/);
  assert.match(xml, /<Identity[^>]*\bVersion="0\.72\.0"/, "version is preserved");
  assert.match(xml, /<DisplayName>Contoso Docs<\/DisplayName>/);
  assert.match(xml, /<Description[^>]*>Internal docs assistant\.<\/Description>/);
});

test("binary entries pass through; newIcon replaces the icon; [Content_Types].xml untouched", () => {
  const replacement = new Uint8Array([9, 9, 9]);
  const out = unzipSync(rebrandVsix(fixtureVsix(), deepOpts({ newIcon: replacement })));
  assert.deepEqual([...out["extension/media/icon.png"]], [9, 9, 9]);
  assert.equal(strFromU8(out["[Content_Types].xml"]), "<Types/>");
  // Without newIcon the original bytes survive.
  const out2 = unzipSync(rebrandVsix(fixtureVsix(), deepOpts()));
  assert.deepEqual([...out2["extension/media/icon.png"]], [...ICON]);
});

test("XML helpers escape special characters and find attributes/elements", () => {
  assert.equal(
    setManifestAttr('<Identity Id="x" Publisher="y" />', "Identity", "Publisher", "a&b"),
    '<Identity Id="x" Publisher="a&amp;b" />',
  );
  assert.equal(
    setManifestElement("<DisplayName>old</DisplayName>", "DisplayName", "<New> & Co"),
    "<DisplayName>&lt;New&gt; &amp; Co</DisplayName>",
  );
  assert.throws(() => setManifestAttr("<None/>", "Identity", "Id", "x"), /not found/);
});

test("rebrandVsixManifest is display-only safe (no identifier rename needed)", () => {
  const tokens = buildBrandTokens({
    displayName: "Contoso Docs",
    handle: "contosodocs",
    renameIdentifiers: false,
    kebabName: "contoso-docs",
  });
  const xml = rebrandVsixManifest(MANIFEST, { tokens, after, handle: "contosodocs", release });
  assert.match(xml, /Id="contoso-docs"/);
  assert.match(xml, /<DisplayName>Contoso Docs<\/DisplayName>/);
});

test("minimalBuildComponents: pre-built payload at root, vsce-only package.json, BUILD.md", () => {
  const files = minimalBuildComponents(fixtureVsix(), deepOpts());
  // Repo-relative paths (no extension/ prefix); manifest + content-types dropped.
  assert.ok("package.json" in files);
  assert.ok("dist/extension.js" in files);
  assert.ok("media/icon.png" in files);
  assert.ok(".vscodeignore" in files);
  assert.ok("BUILD.md" in files);
  assert.ok(!("extension.vsixmanifest" in files), "vsce regenerates the manifest");
  assert.ok(!("[Content_Types].xml" in files));

  const pkg = JSON.parse(strFromU8(files["package.json"]));
  assert.equal(pkg.displayName, "Contoso Docs", "still rebranded");
  assert.deepEqual(Object.keys(pkg.devDependencies), ["@vscode/vsce"], "only vsce is needed to package");
  assert.ok(!("dependencies" in pkg), "runtime deps dropped — bundle is pre-built");
  assert.match(pkg.scripts.package, /vsce package/);
  // The pre-built bundle is the rebranded one.
  assert.match(strFromU8(files["dist/extension.js"]), /Contoso Docs/);
  assert.match(strFromU8(files["BUILD.md"]), /Contoso Docs/);
});

test("minimalBuildComponents drops the bundled source archive (not needed to vsce-package)", () => {
  const vsix = zipSync({
    "extension.vsixmanifest": strToU8(MANIFEST),
    "extension/package.json": strToU8(PKG),
    "extension/dist/extension.js": strToU8(BUNDLE),
    "extension/dist/source.zip": fixtureSourceZip(),
  });
  const files = minimalBuildComponents(vsix, deepOpts());
  assert.ok(!("dist/source.zip" in files), "source archive omitted from the minimal handoff");
  assert.ok("dist/extension.js" in files, "pre-built bundle kept");
});

test("relaxExportDevDeps moves the formatter/linter to optionalDependencies, keeps the build toolchain", () => {
  const out = JSON.parse(
    relaxExportDevDeps(
      JSON.stringify({
        devDependencies: {
          prettier: "^3.0.0",
          eslint: "^9.0.0",
          "typescript-eslint": "^8.0.0",
          "@eslint/js": "^9.0.0",
          esbuild: "^0.28.0",
          typescript: "^6.0.0",
          "@vscode/vsce": "^3.0.0",
        },
      }),
    ),
  );
  // Build-critical tools stay REQUIRED — a blocked tarball there must still fail loudly.
  assert.ok(out.devDependencies.esbuild && out.devDependencies.typescript && out.devDependencies["@vscode/vsce"]);
  // Formatter/linter become OPTIONAL — npm skips them (warning) if a tarball is withheld,
  // so the VSIX still builds (the cause of "could not find prettier-3.9.3.tgz").
  assert.ok(out.optionalDependencies.prettier && out.optionalDependencies.eslint);
  assert.ok(!("prettier" in out.devDependencies) && !("eslint" in out.devDependencies));
  assert.ok(!("typescript-eslint" in out.devDependencies) && !("@eslint/js" in out.devDependencies));
});

test("minimalPackageJson keeps identity/contributes but strips the build surface", () => {
  const out = JSON.parse(
    minimalPackageJson(JSON.stringify({ name: "x", displayName: "X", main: "./dist/extension.js", contributes: { a: 1 }, dependencies: { pg: "^8" }, devDependencies: { esbuild: "^0.28", prettier: "^3" }, scripts: { "vscode:prepublish": "node esbuild.js" } })),
  );
  assert.equal(out.main, "./dist/extension.js");
  assert.deepEqual(out.contributes, { a: 1 });
  assert.ok(!("dependencies" in out));
  assert.deepEqual(Object.keys(out.devDependencies), ["@vscode/vsce"]);
  assert.ok(!("vscode:prepublish" in out.scripts), "no source build step (bundle is pre-built)");
});

/** A realistic originBrand.ts module the export must regenerate in place. */
function originBrandModuleFixture(): string {
  return [
    "export interface OriginBrand {",
    "  displayName: string;",
    "  handle: string;",
    "  namespace: string;",
    "  namespaceLower: string;",
    "  kebab: string;",
    "  publisher: string;",
    "}",
    "",
    "export const ORIGIN_BRAND: OriginBrand = {",
    `  displayName: ${JSON.stringify(ORIGIN_BRAND.displayName)},`,
    `  handle: ${JSON.stringify(ORIGIN_BRAND.handle)},`,
    `  namespace: ${JSON.stringify(ORIGIN_BRAND.namespace)},`,
    `  namespaceLower: ${JSON.stringify(ORIGIN_BRAND.namespaceLower)},`,
    `  kebab: ${JSON.stringify(ORIGIN_BRAND.kebab)},`,
    `  publisher: ${JSON.stringify(ORIGIN_BRAND.publisher)},`,
    "};",
    "",
  ].join("\n");
}

function fixtureSourceZip(): Uint8Array {
  return zipSync({
    "src/extension.ts": strToU8(
      `// ${ORIGIN_BRAND.displayName} @${ORIGIN_BRAND.handle} ${ORIGIN_BRAND.namespace} reads a SharePoint site`,
    ),
    // The engine's single source of truth — must be regenerated to the new brand.
    "src/branding/originBrand.ts": strToU8(originBrandModuleFixture()),
    // A non-source-of-truth engine file — its comments must be token-rewritten.
    "src/branding/brandTokens.ts": strToU8(
      `// rebrand engine for ${ORIGIN_BRAND.displayName}; finds @${ORIGIN_BRAND.handle} and ${ORIGIN_BRAND.namespace}`,
    ),
    // A test file — must be token-rewritten (it ships into the maintained copy).
    "test/foo.test.ts": strToU8(`assert(id.startsWith("${ORIGIN_BRAND.namespace}"))`),
    // Build tooling — emitted verbatim (carries no brand identifiers).
    "scripts/build.js": strToU8("// build helper — no brand here"),
    "package.json": strToU8(PKG),
    // Pins exact newest versions — dropped so a quarantining registry can resolve N-1.
    "package-lock.json": strToU8(JSON.stringify({ name: ORIGIN_BRAND.kebab, lockfileVersion: 3 })),
    // Origin-coupled docs/CI — dropped or replaced.
    "CHANGELOG.md": strToU8(`# Changelog\n\n## 0.1.0\n- ${ORIGIN_BRAND.displayName} by ${ORIGIN_BRAND.publisher}\n`),
    "REBRANDING.md": strToU8(`# Rebranding\n\nPublisher fixed at ${ORIGIN_BRAND.publisher}.\n`),
    ".github/workflows/ci.yml": strToU8(`name: CI for ${ORIGIN_BRAND.kebab}\n`),
    LICENSE: strToU8(`Copyright (c) 2026 ${ORIGIN_BRAND.displayName} contributors`),
    "media/icon.png": ICON,
  });
}

test("rebrandSourceArchive: anonymizes product/engine/tests, regenerates originBrand.ts, drops origin-coupled files", () => {
  const out = rebrandSourceArchive(fixtureSourceZip(), deepOpts());
  const text = (p: string) => strFromU8(out[p]);

  // Product source token-rewritten (deep rename); Microsoft 'SharePoint' preserved.
  assert.match(text("src/extension.ts"), /Contoso Docs @contosodocs contosoDocs/);
  assert.match(text("src/extension.ts"), /reads a SharePoint site/, "Microsoft 'SharePoint' preserved");

  // The engine's single source of truth is regenerated to the NEW brand…
  const origin = text("src/branding/originBrand.ts");
  assert.match(origin, /displayName: "Contoso Docs"/);
  assert.match(origin, /handle: "contosodocs"/);
  assert.match(origin, /namespace: "contosoDocs"/);
  assert.match(origin, /kebab: "contoso-docs"/);
  assert.match(origin, /publisher: "contoso"/);

  // …and the engine + tests no longer mention the original brand.
  assert.match(text("src/branding/brandTokens.ts"), /Contoso Docs.*@contosodocs.*contosoDocs/);
  assert.match(text("test/foo.test.ts"), /startsWith\("contosoDocs"\)/);

  // package.json fully rebranded; build tooling emitted verbatim; binary passes through.
  assert.equal(JSON.parse(text("package.json")).displayName, "Contoso Docs");
  assert.equal(text("scripts/build.js"), "// build helper — no brand here");
  assert.deepEqual([...out["media/icon.png"]], [...ICON]);

  // CHANGELOG replaced with a fresh one (no original history); REBRANDING + origin .github dropped.
  assert.match(text("CHANGELOG.md"), /Initial white-label build of Contoso Docs/);
  assert.doesNotMatch(text("CHANGELOG.md"), /0\.1\.0/, "original release history gone");
  assert.ok(!("REBRANDING.md" in out), "origin-coupled rebranding doc dropped");
  assert.ok(!(".github/workflows/ci.yml" in out), "origin CI dropped");
  assert.ok(!("package-lock.json" in out), "lockfile dropped so a quarantining registry can resolve N-1");

  // Build-ready scaffolding added.
  assert.ok(".github/workflows/whitelabel-build.yml" in out);
  assert.ok("MAINTAINING.md" in out);
  assert.match(text("MAINTAINING.md"), /GitHub Enterprise Server/);

  // THE GUARANTEE: no prior identifier survives anywhere in the exported source.
  assertAnonymized(out);
});

test("rebrandSourceArchive replaces the publisher/owner even though it isn't a brand token", () => {
  const out = rebrandSourceArchive(
    zipSync({ "docs/notes.md": strToU8(`Maintained by ${ORIGIN_BRAND.publisher}. See @${ORIGIN_BRAND.handle}.`) }),
    deepOpts(),
  );
  assert.match(strFromU8(out["docs/notes.md"]), /Maintained by contoso\. See @contosodocs\./);
});

test("rebrandSourceArchive licenseHolder rewrites the LICENSE copyright", () => {
  const out = rebrandSourceArchive(fixtureSourceZip(), deepOpts({ after: { ...after, licenseHolder: "Contoso Inc." } }));
  assert.match(strFromU8(out["LICENSE"]), /Copyright \(c\) 2026 Contoso Inc\./);
});

test("exported build guides: cross-platform, --verbose, OS trust store, strict-ssl fallback, withheld-version + Windows cleanup notes", () => {
  const maintaining = strFromU8(rebrandSourceArchive(fixtureSourceZip(), deepOpts())["MAINTAINING.md"]);
  // Diagnostics + cross-platform.
  assert.match(maintaining, /npm install --verbose/, "verbose install diagnostics");
  assert.match(maintaining, /\$env:NODE_OPTIONS/, "Windows PowerShell env syntax");
  assert.match(maintaining, /cmd\.exe/, "cmd.exe variant");
  // TLS escalation: OS store → CA bundle → strict-ssl last resort (with risk warning).
  assert.match(maintaining, /--use-system-ca/, "OS trust store (Node 22.9+)");
  assert.match(maintaining, /NODE_EXTRA_CA_CERTS/, "CA bundle for older Node / self-signed");
  assert.match(maintaining, /--strict-ssl=false/, "documented SSL-ignore last resort");
  assert.match(maintaining, /security risk/i, "strict-ssl carries a security warning");
  // Withheld/quarantined newer versions (the prettier-3.9.3 failure).
  assert.match(maintaining, /prettier-3\.9\.3\.tgz/, "names the concrete withheld-version failure");
  assert.match(maintaining, /no `package-lock\.json`/, "explains the dropped lockfile");
  // Benign install warnings (deprecations + Windows cleanup) are explained.
  assert.match(maintaining, /warnings, not errors/i, "reassures the warnings are non-fatal");
  assert.match(maintaining, /npm warn deprecated/, "explains benign transitive deprecation warnings");
  assert.match(maintaining, /keytar/, "notes keytar is optional (vsce package doesn't need it)");
  assert.match(maintaining, /npm warn cleanup/, "explains the benign Windows cleanup warning");
  assert.match(maintaining, /readable-stream/, "names the deduped-nested-folder cleanup case");

  const build = strFromU8(minimalBuildComponents(fixtureVsix(), deepOpts())["BUILD.md"]);
  assert.match(build, /npm install --verbose/);
  assert.match(build, /--use-system-ca/);
  assert.match(build, /--strict-ssl=false/, "SSL-ignore last resort in BUILD.md too");
  assert.match(build, /\$env:NODE_OPTIONS/, "Windows PowerShell trust-store syntax");
  assert.match(build, /npm warn cleanup/, "Windows cleanup note in BUILD.md");
});

test("rebrandVsix rebrands the source tree embedded in the .vsix (no prior identifiers inside)", () => {
  const vsix = zipSync({
    "extension.vsixmanifest": strToU8(MANIFEST),
    "[Content_Types].xml": strToU8("<Types/>"),
    "extension/package.json": strToU8(PKG),
    "extension/dist/extension.js": strToU8(BUNDLE),
    "extension/dist/source.zip": fixtureSourceZip(),
  });
  const out = unzipSync(rebrandVsix(vsix, deepOpts()));
  // The embedded archive is still a valid zip and was itself rebranded.
  const inner = unzipSync(out["extension/dist/source.zip"]);
  assert.match(strFromU8(inner["src/extension.ts"]), /Contoso Docs @contosodocs/);
  assertAnonymized(inner, "embedded source: ");
});

test("readVsixSourceArchive returns the bundled source, or undefined when absent", () => {
  const withSource = zipSync({
    "extension/package.json": strToU8(PKG),
    "extension/dist/source.zip": fixtureSourceZip(),
  });
  assert.ok(readVsixSourceArchive(withSource));
  const without = zipSync({ "extension/package.json": strToU8(PKG) });
  assert.equal(readVsixSourceArchive(without), undefined);
});

test("readVsixPackageJson reads the manifest; rejects a non-extension zip", () => {
  assert.equal(readVsixPackageJson(fixtureVsix()).name, ORIGIN_BRAND.kebab);
  const notExt = zipSync({ "foo.txt": strToU8("hi") });
  assert.throws(() => readVsixPackageJson(notExt), /not a vs code extension vsix/i);
});
