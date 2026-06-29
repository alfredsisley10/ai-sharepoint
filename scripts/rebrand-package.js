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
const { npmEnv, preflight } = require("./preflight-deps");

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

/** Run one build step, streaming its output; abort the whole build if it fails.
 *  opts.env supplies the child environment (OS trust store); opts.timeoutMs caps
 *  the run so a registry/proxy stall can never hang the build silently. */
function step(label, command, opts = {}) {
  console.log("");
  console.log("==> " + label);
  console.log("    $ " + command);
  const started = Date.now();
  // shell:true lets the OS shell resolve `npm` -> `npm.cmd` on Windows; each call
  // is a single command, so there is no cross-shell chaining operator involved.
  const res = spawnSync(command, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: opts.env || process.env,
    timeout: opts.timeoutMs || undefined,
  });
  if ((res.error && res.error.code === "ETIMEDOUT") || (res.signal && opts.timeoutMs)) {
    fail(
      label +
        " timed out after " +
        Math.round((opts.timeoutMs || 0) / 1000) +
        "s and was terminated. The registry/proxy is likely unreachable or stalling on TLS. " +
        "Confirm the corporate registry/proxy is reachable and that the OS certificate store trusts it " +
        "(this driver enables Node's --use-system-ca where supported; set NODE_EXTRA_CA_CERTS or REBRAND_CA_FILE for older Node). " +
        "Raise the limit with REBRAND_INSTALL_TIMEOUT_MS if the install is just slow.",
    );
  }
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
console.log("Three steps run below: pre-scan dependencies, install, then package.");
console.log("A first install can take a few minutes; live progress prints as it goes.");

// npm child env trusts the OS certificate store (corporate registries/proxies
// serve internally-issued certs not in Node's bundled roots).
const env = npmEnv();
const installTimeoutMs = Number(process.env.REBRAND_INSTALL_TIMEOUT_MS) || 600000; // 10 min default
const preflightTimeoutMs = Number(process.env.REBRAND_PREFLIGHT_TIMEOUT_MS) || 60000;

// Step 1: pre-scan the configured registry so a withheld/unavailable dependency
// (e.g. a newest version still pending security scan) fails FAST and clearly,
// and so prior-version adaptations are reported before the long install.
console.log("");
console.log("==> Step 1/3  Pre-scanning build dependencies in the configured registry");
let report = [];
try {
  report = preflight(root, { timeoutMs: preflightTimeoutMs });
} catch (e) {
  console.log("    warn   pre-scan could not run (" + e.message + "); continuing to install.");
}
const missing = report.filter((r) => r.status === "missing");
const adapted = report.filter((r) => r.status === "ok" && r.adapted);
const unreachable = report.filter((r) => r.status === "unreachable");
for (const r of adapted) {
  console.log("    adapt  " + r.name + " -> " + r.pick + " (latest " + r.latest + " not in this registry)");
}
if (unreachable.length) {
  console.log("    warn   could not pre-check " + unreachable.length + " dependency(ies) (registry/proxy/TLS); continuing.");
}
if (missing.length) {
  fail(
    "Pre-scan: no installable version for " +
      missing.map((r) => r.name + "@" + r.range).join(", ") +
      ". Have these mirrored/scanned into your registry, or widen the range in package.json, then retry.",
  );
}
console.log("OK  pre-scan (" + report.filter((r) => r.status === "ok").length + " dependency(ies) resolvable)");

step(
  "Step 2/3  Installing dependencies (npm install, verbose)",
  "npm install --loglevel verbose --no-audit --no-fund",
  { env, timeoutMs: installTimeoutMs },
);
step("Step 3/3  Packaging extension (vsce package)", 'npm run package -- --out "' + outPath + '"', { env });

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
