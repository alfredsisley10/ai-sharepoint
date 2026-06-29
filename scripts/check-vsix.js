// VSIX-content gate (SDLC review #26): assert the package that ships contains
// exactly what it should — the bundled extension + assets — and NONE of the
// things that must never leave the build: TypeScript sources, sourcemaps,
// tests, build scripts, dotfiles, or anything secret-shaped. Uses `vsce ls`
// (the same file set `vsce package` would zip) so it is fully cross-platform
// and needs no unzip tool. Run after a build so dist/extension.js exists.
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.join(__dirname, "..");

if (!fs.existsSync(path.join(root, "dist", "extension.js"))) {
  console.error("dist/extension.js is missing — run `npm run compile` first.");
  process.exit(1);
}

// Resolve the vsce CLI entry from node_modules and run it with this Node —
// no reliance on npx, PATH, or a shell (works identically on Win/macOS/Linux).
const vscePkgJson = require.resolve("@vscode/vsce/package.json");
const vscePkg = require(vscePkgJson);
const binField = vscePkg.bin;
const binRel = typeof binField === "string" ? binField : binField.vsce;
const vsceBin = path.join(path.dirname(vscePkgJson), binRel);

const res = spawnSync(process.execPath, [vsceBin, "ls", "--no-dependencies"], {
  cwd: root,
  encoding: "utf8",
});
if (res.status !== 0) {
  console.error("`vsce ls` failed:\n" + (res.stderr || res.stdout || "(no output)"));
  process.exit(1);
}

const files = res.stdout
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  // vsce prints paths with forward slashes already; normalize just in case.
  .map((f) => f.replace(/\\/g, "/"));

const required = ["package.json", "dist/extension.js", "media/icon.png"];
const forbidden = [
  /^src\//,
  /^test\//,
  /^scripts\//,
  /^out-test\//,
  /\.ts$/,
  /\.map$/,
  /^node_modules\//,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.claude\//,
  /^tsconfig.*\.json$/,
  /^esbuild\.js$/,
  /^eslint\.config\./,
  /\.vsix$/,
];

const errors = [];
for (const r of required) {
  if (!files.includes(r)) errors.push(`missing required file: ${r}`);
}
if (!files.some((f) => /^readme(\.md)?$/i.test(f))) {
  errors.push("missing required file: README");
}
for (const f of files) {
  for (const re of forbidden) {
    if (re.test(f)) errors.push(`file must NOT be packaged: ${f}`);
  }
}

if (errors.length) {
  console.error(`✗ VSIX content validation failed (${files.length} files listed):`);
  for (const e of [...new Set(errors)]) console.error("  - " + e);
  process.exit(1);
}
console.log(
  `✓ VSIX content validation passed: ${files.length} files, bundle present, no sources/maps/secrets.`,
);
