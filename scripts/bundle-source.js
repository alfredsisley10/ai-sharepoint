"use strict";
/**
 * Bundle the full source tree into dist/source.zip so it ships INSIDE the .vsix.
 *
 * The white-label "Full source" export reads this archive straight out of the
 * packaged extension, so an enterprise can stand up its own maintained copy
 * WITHOUT access to the original source repository (which may be unreachable).
 * node_modules is excluded — standard npm dependencies are restored from the
 * enterprise registry with `npm install`.
 *
 * Allowlist-based (safer than a denylist): only known source dirs + root files
 * are included, so build artifacts / secrets / VCS metadata can never leak in.
 */
const fs = require("node:fs");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");

const SOURCE_DIRS = ["src", "test", "test-integration", "scripts", "media", "docs", ".github"];
const SOURCE_ROOT_FILES = [
  "package.json",
  // REQUIRED: VS Code resolves package.json %key% placeholders (view names,
  // command titles, walkthroughs) from this NLS bundle. Omitting it makes every
  // contributed label render as a raw "%key%" in a built white-label VSIX.
  "package.nls.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "esbuild.js",
  "eslint.config.mjs",
  ".vscodeignore",
  ".gitignore",
  ".prettierrc.json",
  ".prettierignore",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "REBRANDING.md",
  "CONTRIBUTING.md",
  "SUPPORT.md",
];

/** Collect repo-relative path → bytes for the full source archive. */
function collectSourceFiles(root) {
  const out = {};
  const add = (abs, rel) => {
    out[rel] = new Uint8Array(fs.readFileSync(abs));
  };
  const walk = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) add(abs, rel);
    }
  };
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs)) walk(abs, dir);
  }
  for (const f of SOURCE_ROOT_FILES) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) out[f] = new Uint8Array(fs.readFileSync(abs));
  }
  // Locale NLS bundles (package.nls.<locale>.json), if any — same role as
  // package.nls.json: VS Code resolves package.json %key% placeholders from them.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /^package\.nls\.[\w-]+\.json$/.test(entry.name) && !(entry.name in out)) {
      out[entry.name] = new Uint8Array(fs.readFileSync(path.join(root, entry.name)));
    }
  }
  return out;
}

/** Write dist/source.zip under `root`. Returns the byte length written. */
function bundleSource(root) {
  const files = collectSourceFiles(root);
  // A small manifest so the archive is self-describing.
  files["SOURCE_BUNDLE.txt"] = strToU8(
    "Full source for this extension, bundled into the VSIX so it can be maintained\n" +
      "without the original repository. Restore dependencies with `npm install`\n" +
      "(node_modules is intentionally not included), then build per BUILD/CONTRIBUTING docs.\n",
  );
  const zipped = zipSync(files, { level: 6 });
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "source.zip"), zipped);
  return zipped.length;
}

module.exports = { collectSourceFiles, bundleSource, SOURCE_DIRS, SOURCE_ROOT_FILES };

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const bytes = bundleSource(root);
  console.log(`dist/source.zip written (${Math.round(bytes / 1024)} KB, ${Object.keys(collectSourceFiles(root)).length + 1} files).`);
}
