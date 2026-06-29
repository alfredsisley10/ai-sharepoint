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
  VsixRebrandOptions,
} from "../src/branding/rebrandVsix";
import { buildBrandTokens } from "../src/branding/brandTokens";
import { BrandConfig } from "../src/branding/rebrand";
import { ReleaseManifest } from "../src/branding/releaseExpiry";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0">
  <Metadata>
    <Identity Language="en-US" Id="ai-sharepoint" Version="0.72.0" Publisher="alfredsisley10" />
    <DisplayName>AI SharePoint</DisplayName>
    <Description xml:space="preserve">Govern SharePoint with AI SharePoint.</Description>
    <Tags>sharepoint,copilot</Tags>
  </Metadata>
</PackageManifest>`;

const PKG = JSON.stringify(
  {
    publisher: "alfredsisley10",
    name: "ai-sharepoint",
    displayName: "AI SharePoint",
    version: "0.72.0",
    description: "Govern SharePoint with AI SharePoint.",
    contributes: { chatParticipants: [{ name: "sharepoint", fullName: "SharePoint" }] },
  },
  null,
  2,
);

const BUNDLE = `console.log("AI SharePoint @sharepoint aiSharePoint ai-sharepoint reads a SharePoint site");`;
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // fake PNG bytes

function fixtureVsix(): Uint8Array {
  return zipSync({
    "extension.vsixmanifest": strToU8(MANIFEST),
    "[Content_Types].xml": strToU8("<Types/>"),
    "extension/package.json": strToU8(PKG),
    "extension/dist/extension.js": strToU8(BUNDLE),
    "extension/media/icon.png": ICON,
    "extension/readme.md": strToU8("# AI SharePoint\nUse @sharepoint."),
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

function fixtureSourceZip(): Uint8Array {
  return zipSync({
    "src/extension.ts": strToU8('// AI SharePoint @sharepoint aiSharePoint reads a SharePoint site'),
    "src/branding/brandTokens.ts": strToU8('const FIND = "AI SharePoint"; // @sharepoint aiSharePoint'),
    "test/foo.test.ts": strToU8('assert("AI SharePoint")'),
    "package.json": strToU8(PKG),
    "LICENSE": strToU8("Copyright (c) 2026 AI SharePoint contributors"),
    "media/icon.png": ICON,
  });
}

test("rebrandSourceArchive: rewrites product source, SPARES the engine + tests, rebrands package.json", () => {
  const out = rebrandSourceArchive(fixtureSourceZip(), deepOpts());
  // Product source is token-rewritten (deep rename).
  assert.match(strFromU8(out["src/extension.ts"]), /Contoso Docs @contosodocs contosoDocs/);
  assert.match(strFromU8(out["src/extension.ts"]), /reads a SharePoint site/, "Microsoft 'SharePoint' preserved");
  // The rebrand engine's literal find-tokens MUST survive verbatim.
  assert.match(strFromU8(out["src/branding/brandTokens.ts"]), /"AI SharePoint"/);
  // Tests are emitted but not rewritten (they assert on the old strings).
  assert.equal(strFromU8(out["test/foo.test.ts"]), 'assert("AI SharePoint")');
  // package.json fully rebranded; LICENSE holder updated.
  assert.equal(JSON.parse(strFromU8(out["package.json"])).displayName, "Contoso Docs");
  // Build-ready scaffolding is included.
  assert.ok(".github/workflows/whitelabel-build.yml" in out);
  assert.ok("MAINTAINING.md" in out);
  assert.match(strFromU8(out["MAINTAINING.md"]), /GitHub Enterprise Server/);
  // Binary passes through.
  assert.deepEqual([...out["media/icon.png"]], [...ICON]);
});

test("rebrandSourceArchive licenseHolder rewrites the LICENSE copyright", () => {
  const out = rebrandSourceArchive(fixtureSourceZip(), deepOpts({ after: { ...after, licenseHolder: "Contoso Inc." } }));
  assert.match(strFromU8(out["LICENSE"]), /Copyright \(c\) 2026 Contoso Inc\./);
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
  assert.equal(readVsixPackageJson(fixtureVsix()).name, "ai-sharepoint");
  const notExt = zipSync({ "foo.txt": strToU8("hi") });
  assert.throws(() => readVsixPackageJson(notExt), /not a vs code extension vsix/i);
});
