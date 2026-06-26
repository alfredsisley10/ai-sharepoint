"use strict";
/**
 * Cross-platform build driver for the rebrand / white-label "Repackage now" step
 * (src/branding/rebrandFlow.ts) and for repackaging by hand.
 *
 * It runs the two build steps — `npm install`, then `npm run package` — with
 * clear, incremental status so a long install or a build failure is never a
 * silent hang, streams each tool's output live, fails fast with the exit code,
 * and prints the ABSOLUTE PATH of the `.vsix` it produces.
 *
 * Why a Node driver instead of a shell one-liner:
 *  - Invoked as a single token (`node scripts/rebrand-package.js`), so it needs
 *    no `&&`/`;` chaining — the Windows PowerShell 5.1 "`&&` is not a valid
 *    statement separator" error cannot recur regardless of the user's shell.
 *  - `npm run package` is passed `--out <path>` so the output location is known
 *    up front and reported precisely. The `package` script also carries
 *    `--allow-missing-repository`, so `vsce` never blocks on its interactive
 *    "a 'repository' field is missing — continue? [y/N]" prompt (the usual cause
 *    of an apparent hang in an interactive terminal).
 *
 * Output is intentionally ASCII-only so it renders cleanly in every terminal,
 * including legacy Windows cmd.exe code pages.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const RULE = "============================================================";

function fail(message, code) {
  console.error("");
  console.error("ERROR: " + message);
  process.exit(code && code !== 0 ? code : 1);
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch (e) {
    return fail("Could not read package.json in " + root + " (" + e.message + ").");
  }
}

/** Run one build step, streaming its output; abort the whole build if it fails. */
function step(label, command) {
  console.log("");
  console.log("==> " + label);
  console.log("    $ " + command);
  const started = Date.now();
  // shell:true lets the OS shell resolve `npm` -> `npm.cmd` on Windows; each call
  // is a single command, so there is no cross-shell chaining operator involved.
  const res = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (res.error) fail(label + " could not start: " + res.error.message);
  if (res.status !== 0) {
    fail(label + " failed (exit code " + res.status + "). See the output above for the cause.", res.status);
  }
  console.log("OK  " + label + " (" + Math.round((Date.now() - started) / 1000) + "s)");
}

const pkg = readManifest();
const name = pkg.name || "extension";
const version = pkg.version || "0.0.0";
const vsixName = name + "-" + version + ".vsix";
const outPath = path.join(root, vsixName);

console.log(RULE);
console.log(" Building white-labeled VSIX: " + (pkg.displayName || name));
console.log("   source folder  : " + root);
console.log("   output package : " + outPath);
console.log(RULE);
console.log("Two steps run below: dependency install, then packaging.");
console.log("A first install can take a few minutes; live progress prints as it goes.");

step("Step 1/2  Installing dependencies (npm install)", "npm install");
step("Step 2/2  Packaging extension (vsce package)", 'npm run package -- --out "' + outPath + '"');

if (!fs.existsSync(outPath)) {
  fail("Packaging reported success but " + vsixName + " was not found in " + root + ".");
}
const sizeKb = Math.round(fs.statSync(outPath).size / 1024);

console.log("");
console.log(RULE);
console.log("SUCCESS - your white-labeled extension is ready:");
console.log("   " + outPath + "  (" + sizeKb + " KB)");
console.log("");
console.log("Install it with:");
console.log('   code --install-extension "' + outPath + '"');
console.log("or in VS Code: Extensions view -> ... -> Install from VSIX...");
console.log(RULE);
