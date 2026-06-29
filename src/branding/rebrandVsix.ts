/**
 * Rebrand a packaged .vsix directly (white-label). A VSIX is just a ZIP that
 * already contains everything a rebrand needs — the bundled `dist/extension.js`
 * (brand strings are plain literals in it), `package.json`, `package.nls.json`,
 * `media/`, the docs, and the `extension.vsixmanifest`. Transforming the VSIX is
 * far more deterministic for a release engineer than rewriting a source tree and
 * re-running `npm install && npm run package`: one file in, one file out, no
 * toolchain, no build.
 *
 * Pure module (in-memory ZIP via fflate) so the byte-level transform is
 * unit-tested. The VS Code flow (rebrandFlow.ts) picks the input/output files.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { BrandToken, applyBrandTokens } from "./brandTokens";
import {
  BrandConfig,
  rebrandPackageJsonFull,
  rebrandLicense,
  rebrandReadmeTagline,
  replacePhrase,
  SUPPORT_PHRASE,
  SECURITY_PHRASE,
} from "./rebrand";
import { ReleaseManifest } from "./releaseExpiry";
import { exportScaffoldFiles } from "./exportScaffold";
import { ORIGIN_BRAND, OriginBrand, rebrandOriginModule } from "./originBrand";

export interface VsixRebrandOptions {
  /** Brand tokens from buildBrandTokens(deep). */
  tokens: BrandToken[];
  /** New identity (publisher/name/displayName/description). */
  after: BrandConfig;
  /** Chat handle without the @. */
  handle: string;
  /** Release manifest baked into package.json (expiry/channel). */
  release: ReleaseManifest;
  /** Optional first-run provisioning manifest. */
  provisioning?: unknown;
  /** Optional replacement icon (PNG bytes) for extension/media/icon.png. */
  newIcon?: Uint8Array;
}

/** Canonical entry paths inside a vsce-produced VSIX. */
const MANIFEST = "extension.vsixmanifest";
const PKG_JSON = "extension/package.json";
const ICON = "extension/media/icon.png";
/** The full source tree the build bundles into the VSIX (scripts/bundle-source.js). */
const SOURCE_ARCHIVE = "extension/dist/source.zip";
/** Text assets whose brand tokens should be rewritten. The bundle (.js), the
 *  NLS bundle + manifest (.json), docs (.md/.txt), and inline art (.svg/.css/
 *  .html). `[Content_Types].xml` is intentionally excluded (structural OPC). */
const TEXT_RE = /\.(js|json|md|txt|svg|css|html)$/i;

/** XML-escape for element text / attribute values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Replace an attribute's value on a named element (first occurrence). */
export function setManifestAttr(xml: string, element: string, attr: string, value: string): string {
  const re = new RegExp(`(<${element}\\b[^>]*\\b${attr}=")[^"]*(")`);
  if (!re.test(xml)) throw new Error(`vsixmanifest: <${element} ${attr}="…"> not found`);
  return xml.replace(re, (_m, pre: string, post: string) => pre + escapeXml(value) + post);
}

/** Replace the text content of a named element (which may carry attributes). */
export function setManifestElement(xml: string, element: string, value: string): string {
  const re = new RegExp(`(<${element}\\b[^>]*>)[\\s\\S]*?(</${element}>)`);
  if (!re.test(xml)) throw new Error(`vsixmanifest: <${element}>…</${element}> not found`);
  return xml.replace(re, (_m, open: string, close: string) => open + escapeXml(value) + close);
}

/**
 * Rebrand the `extension.vsixmanifest` XML: identity (Id = name, Publisher),
 * DisplayName, and Description. Brand tokens run first to catch any stray brand
 * strings, then the identity fields are set explicitly (the user-supplied
 * description isn't a brand-token rewrite of the old one).
 */
export function rebrandVsixManifest(xml: string, opts: VsixRebrandOptions): string {
  let t = applyBrandTokens(xml, opts.tokens);
  t = setManifestAttr(t, "Identity", "Id", opts.after.name);
  t = setManifestAttr(t, "Identity", "Publisher", opts.after.publisher);
  t = setManifestElement(t, "DisplayName", opts.after.displayName);
  t = setManifestElement(t, "Description", opts.after.description);
  return t;
}

/** Transform a single ZIP entry. */
function transformEntry(name: string, data: Uint8Array, opts: VsixRebrandOptions): Uint8Array {
  if (name === ICON && opts.newIcon) return opts.newIcon;
  if (name === PKG_JSON) {
    return strToU8(
      rebrandPackageJsonFull(strFromU8(data), opts.tokens, opts.after, opts.handle, opts.release, opts.provisioning),
    );
  }
  if (name === MANIFEST) {
    return strToU8(rebrandVsixManifest(strFromU8(data), opts));
  }
  if (name === SOURCE_ARCHIVE) {
    // The VSIX embeds the full source tree so a copy can be maintained without
    // the original repo. Rebrand it too — otherwise the white-labeled .vsix
    // would still carry the ORIGINAL source (prior identifiers) inside it.
    return zipSync(rebrandSourceArchive(data, opts), { level: 6 });
  }
  if (!TEXT_RE.test(name)) return data; // binary (icons) + [Content_Types].xml unchanged

  // All other text: brand tokens, plus the non-token doc customizations the
  // source flow applied (LICENSE holder, distributor support/security contacts).
  let text = applyBrandTokens(strFromU8(data), opts.tokens);
  const lower = name.toLowerCase();
  if (/(^|\/)license(\.[a-z0-9]+)?$/.test(lower) && opts.after.licenseHolder) {
    text = rebrandLicense(text, opts.after.licenseHolder);
  }
  if (/(^|\/)readme\.md$/.test(lower)) {
    // The README's tagline restates the description; replace it so the details
    // page doesn't show the new + original descriptions one after the other.
    text = rebrandReadmeTagline(text, opts.after.description);
  }
  if (lower.endsWith("/support.md")) {
    text = replacePhrase(text, SUPPORT_PHRASE, opts.after.supportContact).text;
    text = replacePhrase(text, SECURITY_PHRASE, opts.after.securityContact).text;
  } else if (lower.endsWith("/security.md")) {
    text = replacePhrase(text, SECURITY_PHRASE, opts.after.securityContact).text;
  }
  return strToU8(text);
}

/** Rebrand every entry of a VSIX, returning the full entry map (the same set of
 *  paths as the input — `extension/…`, `extension.vsixmanifest`, etc.). */
export function transformedEntries(
  vsix: Uint8Array,
  opts: VsixRebrandOptions,
): Record<string, Uint8Array> {
  const files = unzipSync(vsix);
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) {
    out[name] = transformEntry(name, data, opts);
  }
  return out;
}

/**
 * Read a VSIX, rebrand every text entry + the manifest, and return the bytes of
 * a new VSIX. The output is a standard deflate ZIP that VS Code installs like
 * any packaged extension.
 */
export function rebrandVsix(vsix: Uint8Array, opts: VsixRebrandOptions): Uint8Array {
  return zipSync(transformedEntries(vsix, opts), { level: 6 });
}

/** Reduce a rebranded package.json to the minimum needed to RE-PACKAGE the
 *  pre-built bundle: vsce only (no esbuild/typescript/etc. — the bundle is
 *  already built), no runtime dependencies (bundled + --no-dependencies), and
 *  no source build step. This is what shrinks the build-team dependency surface
 *  so a withheld/scanning-pending dependency can't break their build. */
export function minimalPackageJson(pkgText: string): string {
  const pkg = JSON.parse(pkgText) as Record<string, unknown>;
  delete pkg.dependencies; // bundle is pre-built; vsce packages with --no-dependencies
  pkg.devDependencies = { "@vscode/vsce": "^3.0.0" };
  pkg.scripts = {
    package: "vsce package --no-dependencies --no-rewrite-relative-links --allow-missing-repository",
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

const BUILD_VSCODEIGNORE = ["node_modules/**", "BUILD.md", ".vscodeignore", "**/*.map", ""].join("\n");
// So the folder is git-ready for the "merge into a repo manually" path.
const BUILD_GITIGNORE = ["node_modules/", "*.vsix", ""].join("\n");

function buildReadme(displayName: string, name: string): string {
  return [
    `# Building "${displayName}"`,
    "",
    "These are the minimal, **pre-built** components for this white-labeled",
    "extension. The bundle (`dist/extension.js`) is already compiled and",
    "rebranded — you only re-package it into a `.vsix` through your own pipeline.",
    "",
    "## Build",
    "",
    "```",
    "npm install      # installs @vscode/vsce only",
    `npm run package  # produces ${name}-<version>.vsix`,
    "```",
    "",
    "Requires Node 18+ and registry access for `@vscode/vsce`. If your registry",
    "serves internally-issued TLS certs, make sure the OS trust store is used:",
    "Node 22.9+ honors `NODE_OPTIONS=--use-system-ca`; on older Node set",
    "`NODE_EXTRA_CA_CERTS` to your corporate CA bundle.",
    "",
    "No source build is required (no esbuild/TypeScript) — only `@vscode/vsce` is",
    "installed, which keeps the dependency surface (and security-scan exposure)",
    "minimal.",
    "",
  ].join("\n");
}

/**
 * The minimal, hand-offable build components for a separate build team: the
 * rebranded extension payload (bundle + manifest assets) at the repo root, a
 * minimal package.json (vsce-only), a `.vscodeignore`, and a `BUILD.md`. Returns
 * a repo-relative path → bytes map (no `extension/` prefix), ready to write to a
 * folder or push to a repository. Re-packaging these yields the same VSIX.
 */
export function minimalBuildComponents(
  vsix: Uint8Array,
  opts: VsixRebrandOptions,
): Record<string, Uint8Array> {
  const entries = transformedEntries(vsix, opts);
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith("extension/")) continue; // drop vsixmanifest / [Content_Types].xml (vsce regenerates them)
    const rel = name.slice("extension/".length);
    if (rel === "dist/source.zip") continue; // not needed to vsce-package — keeps the build-team handoff minimal
    out[rel] = rel === "package.json" ? strToU8(minimalPackageJson(strFromU8(data))) : data;
  }
  out[".vscodeignore"] = strToU8(BUILD_VSCODEIGNORE);
  out[".gitignore"] = strToU8(BUILD_GITIGNORE);
  out["BUILD.md"] = strToU8(buildReadme(opts.after.displayName, opts.after.name));
  return { ...out, ...exportScaffoldFiles(opts.after, "minimal") };
}

/** Extract the bundled full-source archive (dist/source.zip) from a VSIX, or
 *  undefined if this VSIX predates source bundling. */
export function readVsixSourceArchive(vsix: Uint8Array): Uint8Array | undefined {
  return unzipSync(vsix)["extension/dist/source.zip"];
}

// Emitted verbatim (no token rewrite). Build tooling carries no brand
// identifiers; build artifacts shouldn't be in the archive at all but are
// excluded defensively. NOTE the rebrand engine + tests are deliberately NOT
// here — they ARE token-rewritten so no prior identifiers survive. The engine's
// literal find-tokens live ONLY in src/branding/originBrand.ts, which is
// regenerated for the new brand (so the engine stays correct and clean).
const SOURCE_SKIP_REWRITE = ["scripts/", "node_modules/", "dist/", "out/", "out-test/"];
const SOURCE_TEXT_RE = /\.(ts|js|cjs|mjs|json|md|txt|svg|css|html|ya?ml)$/i;

// Origin-coupled files that must NOT ship in an anonymized copy. CHANGELOG.md
// (the original release narrative) is replaced with a fresh one; REBRANDING.md
// (names the origin and documents the origin's white-label mechanism) and the
// origin's own .github (CI / issue templates) are dropped — the export supplies
// its own build workflow + MAINTAINING.md via exportScaffoldFiles().
const SOURCE_DROP = [/^REBRANDING\.md$/i, /^\.github\//];
const ORIGIN_MODULE = "src/branding/originBrand.ts";
const SOURCE_CHANGELOG = "CHANGELOG.md";

/** The new brand expressed as an OriginBrand, for regenerating originBrand.ts in
 *  the exported source. Identifier fields run through the tokens (so display-only
 *  rebrands correctly leave the aiSharePoint/ai-sharepoint identifiers intact),
 *  while displayName/handle/publisher come straight from the chosen identity. */
function deriveExportBrand(opts: VsixRebrandOptions): OriginBrand {
  const t = opts.tokens;
  return {
    displayName: opts.after.displayName,
    handle: opts.handle,
    namespace: applyBrandTokens(ORIGIN_BRAND.namespace, t),
    namespaceLower: applyBrandTokens(ORIGIN_BRAND.namespaceLower, t),
    kebab: applyBrandTokens(ORIGIN_BRAND.kebab, t),
    publisher: opts.after.publisher,
  };
}

/** A clean changelog for the white-labeled copy (the original release history is
 *  the origin's, and naming/dating it would leak lineage). */
function freshChangelog(after: BrandConfig): string {
  return [
    "# Changelog",
    "",
    `All notable changes to ${after.displayName} are documented here.`,
    "",
    "## Unreleased",
    "",
    `- Initial white-label build of ${after.displayName}.`,
    "",
  ].join("\n");
}

/**
 * Rebrand a full-source archive (the VSIX's dist/source.zip) into a complete,
 * buildable, FULLY ANONYMIZED source tree (repo-relative path → bytes): brand
 * tokens across product source/docs/tests, identity + release + provisioning
 * into package.json, LICENSE-holder and support/security contacts, and the
 * publisher/owner replaced everywhere it appears. The rebrand engine is rewritten
 * too — its literal find-tokens live ONLY in src/branding/originBrand.ts, which
 * is regenerated for the NEW brand, so no prior identifiers remain and the copy's
 * own rebrand engine targets its new brand. Origin-coupled files are dropped
 * (REBRANDING.md, the origin's .github) or replaced (a fresh CHANGELOG), and a
 * build-ready GitHub Actions workflow + MAINTAINING.md are added.
 */
export function rebrandSourceArchive(sourceZip: Uint8Array, opts: VsixRebrandOptions): Record<string, Uint8Array> {
  const files = unzipSync(sourceZip);
  const exportBrand = deriveExportBrand(opts);
  /** The publisher/owner is not a brand token; replace it explicitly in any
   *  rewritten text so no prior owner string survives. */
  const dropOwner = (text: string): string => text.split(ORIGIN_BRAND.publisher).join(opts.after.publisher);
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) {
    if (SOURCE_DROP.some((re) => re.test(name))) continue; // origin-coupled — not shipped
    if (name === ORIGIN_MODULE) {
      // Regenerate the engine's single source of truth → the NEW brand: the copy
      // carries no prior identifiers and rebrands FROM its own brand.
      out[name] = strToU8(rebrandOriginModule(strFromU8(data), exportBrand));
      continue;
    }
    if (name === SOURCE_CHANGELOG) {
      out[name] = strToU8(freshChangelog(opts.after));
      continue;
    }
    if (SOURCE_SKIP_REWRITE.some((p) => name.startsWith(p))) {
      out[name] = data; // verbatim (no brand identifiers)
      continue;
    }
    if (name === "package.json") {
      out[name] = strToU8(
        dropOwner(rebrandPackageJsonFull(strFromU8(data), opts.tokens, opts.after, opts.handle, opts.release, opts.provisioning)),
      );
      continue;
    }
    // Extensionless docs (LICENSE, README, …) are text too — without this they
    // fall through as "binary" and the LICENSE holder is never rewritten.
    const isText = SOURCE_TEXT_RE.test(name) || /(^|\/)(license|readme|changelog|notice|authors|contributors)$/i.test(name);
    if (!isText) {
      out[name] = data; // binary (icons, etc.)
      continue;
    }
    let text = dropOwner(applyBrandTokens(strFromU8(data), opts.tokens));
    const lower = name.toLowerCase();
    if (/(^|\/)license(\.[a-z0-9]+)?$/.test(lower) && opts.after.licenseHolder) {
      text = rebrandLicense(text, opts.after.licenseHolder);
    }
    if (/(^|\/)readme\.md$/.test(lower)) {
      text = rebrandReadmeTagline(text, opts.after.description);
    }
    if (lower.endsWith("support.md")) {
      text = replacePhrase(text, SUPPORT_PHRASE, opts.after.supportContact).text;
      text = replacePhrase(text, SECURITY_PHRASE, opts.after.securityContact).text;
    } else if (lower.endsWith("security.md")) {
      text = replacePhrase(text, SECURITY_PHRASE, opts.after.securityContact).text;
    }
    out[name] = strToU8(text);
  }
  return { ...out, ...exportScaffoldFiles(opts.after, "source") };
}

/** Read just `extension/package.json` from a VSIX (for the pre-fill / "before"
 *  identity), without fully transforming the archive. */
export function readVsixPackageJson(vsix: Uint8Array): Record<string, unknown> {
  const files = unzipSync(vsix);
  const entry = files[PKG_JSON];
  if (!entry) throw new Error("Not a VS Code extension VSIX (no extension/package.json).");
  return JSON.parse(strFromU8(entry)) as Record<string, unknown>;
}
