"use strict";
/**
 * Build-dependency preflight for the white-label package step. Enterprise
 * registries often WITHHOLD the newest version of a dependency until it clears
 * a security scan, so a build can fail late and cryptically with
 * "no matching version found for <pkg>@<range>". This module:
 *
 *  1. checks every dependency's available versions in the CONFIGURED registry
 *     BEFORE the long install, and
 *  2. reports the version npm will actually pick — adapting to a PRIOR version
 *     when the latest is unavailable (the package.json floors are kept at the
 *     major base so a prior minor/patch still satisfies the range).
 *
 * It also centralizes the npm environment so the registry calls (and the
 * install) trust the OS certificate store — corporate proxies/registries serve
 * internally-issued certs that aren't in Node's bundled roots.
 *
 * Pure helpers (semver subset + version pick) are exported for unit tests; the
 * registry I/O runs only when invoked directly.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// --- pure semver subset (the project only uses `^` and exact ranges) --------

/** Parse "X.Y.Z" (ignoring any prerelease/build) → [X,Y,Z] or null. */
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric compare a vs b: -1 / 0 / 1. */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Does `version` satisfy `range`? Supports exact "X.Y.Z" and caret "^X.Y.Z"
 *  (npm semantics, including the 0.x special case). Other range syntaxes are
 *  treated permissively (return true) so we never block on an unparsed range. */
function satisfies(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const r = range.trim();
  if (/^\d+\.\d+\.\d+$/.test(r)) return compareSemver(version, r) === 0;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (caret) {
    const [, MA, MI, PA] = caret.map(Number);
    if (compareSemver(version, `${MA}.${MI}.${PA}`) < 0) return false; // below floor
    // Upper bound: next major (X>=1), else next minor (0.X), else next patch (0.0.X).
    const upper = MA > 0 ? [MA + 1, 0, 0] : MI > 0 ? [0, MI + 1, 0] : [0, 0, PA + 1];
    return compareSemver(version, upper.join(".")) < 0;
  }
  return true; // unknown range form — don't block
}

/** Highest available version satisfying `range`, or null if none qualifies. */
function pickInstallable(range, available) {
  const ok = available.filter((v) => satisfies(v, range));
  if (ok.length === 0) return null;
  return ok.sort(compareSemver)[ok.length - 1];
}

// --- npm environment (OS trust store) ---------------------------------------

/** True if this Node supports the `--use-system-ca` flag (added in 22.9.0). */
function nodeSupportsSystemCa() {
  const p = parseSemver(process.versions.node);
  if (!p) return false;
  const [maj, min] = p;
  return maj > 22 || (maj === 22 && min >= 9);
}

/**
 * Environment for npm child processes so TLS trusts the OS certificate store
 * (corporate registries/proxies present internally-issued certs). Adds
 * `--use-system-ca` to NODE_OPTIONS when supported, preserves any existing
 * NODE_OPTIONS / NODE_EXTRA_CA_CERTS, and honors REBRAND_CA_FILE as an explicit
 * CA bundle for older Node that lacks the system-store flag.
 */
function npmEnv(base = process.env) {
  const env = { ...base };
  const opts = [env.NODE_OPTIONS].filter(Boolean);
  if (nodeSupportsSystemCa() && !/(^|\s)--use-system-ca(\s|$)/.test(env.NODE_OPTIONS || "")) {
    opts.push("--use-system-ca");
  }
  if (opts.length) env.NODE_OPTIONS = opts.join(" ");
  const caFile = env.REBRAND_CA_FILE && env.REBRAND_CA_FILE.trim();
  if (caFile && !env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = caFile;
  return env;
}

// --- registry preflight (I/O) -----------------------------------------------

/** All versions of `name` in the configured registry (empty array on error). */
function availableVersions(name, env, timeoutMs) {
  const res = spawnSync("npm", ["view", name, "versions", "--json"], {
    encoding: "utf8",
    env,
    shell: true,
    timeout: timeoutMs,
  });
  if (res.status !== 0 || !res.stdout) return { ok: false, versions: [], err: (res.stderr || "").trim() };
  try {
    const parsed = JSON.parse(res.stdout);
    const versions = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, versions: versions.map(String) };
  } catch {
    return { ok: false, versions: [], err: "unparseable npm output" };
  }
}

/** Check every dependency against the registry. Returns a per-dep report. */
function preflight(root, opts = {}) {
  const env = npmEnv();
  const timeoutMs = opts.timeoutMs || 60_000;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const report = [];
  for (const [name, range] of Object.entries(all)) {
    const { ok, versions, err } = availableVersions(name, env, timeoutMs);
    if (!ok) {
      report.push({ name, range, status: "unreachable", detail: err });
      continue;
    }
    const pick = pickInstallable(range, versions);
    const latest = versions.length ? versions.slice().sort(compareSemver)[versions.length - 1] : undefined;
    if (!pick) {
      report.push({ name, range, status: "missing", latest });
    } else {
      report.push({ name, range, status: "ok", pick, adapted: latest !== pick, latest });
    }
  }
  return report;
}

module.exports = {
  parseSemver,
  compareSemver,
  satisfies,
  pickInstallable,
  nodeSupportsSystemCa,
  npmEnv,
  availableVersions,
  preflight,
};

// --- CLI --------------------------------------------------------------------
if (require.main === module) {
  const root = path.join(__dirname, "..");
  const timeoutMs = Number(process.env.REBRAND_PREFLIGHT_TIMEOUT_MS) || 60_000;
  console.log("Pre-scanning the configured npm registry for build dependencies…");
  const report = preflight(root, { timeoutMs });
  let missing = 0;
  let unreachable = 0;
  for (const r of report) {
    if (r.status === "ok") {
      console.log(`  ok        ${r.name}@${r.range} -> ${r.pick}${r.adapted ? `  (adapted; latest ${r.latest} not available)` : ""}`);
    } else if (r.status === "missing") {
      missing++;
      console.error(`  MISSING   ${r.name}@${r.range} — no version in range (latest available: ${r.latest || "none"})`);
    } else {
      unreachable++;
      console.error(`  unreachable ${r.name} — ${r.detail || "registry query failed"}`);
    }
  }
  if (missing > 0) {
    console.error("");
    console.error(`Pre-scan failed: ${missing} dependency(ies) have no installable version in the configured registry.`);
    console.error("Have them mirrored/scanned, or widen the range in package.json, then retry.");
    process.exit(1);
  }
  if (unreachable > 0) {
    console.error("");
    console.error(`Warning: ${unreachable} dependency(ies) could not be checked (registry/proxy/TLS). The install may still work; continuing is up to the caller.`);
    process.exit(2);
  }
  console.log("Pre-scan OK: every dependency has an installable version.");
}
