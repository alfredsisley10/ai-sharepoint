// ADR-0016 CI gate: the production dependency tree must stay pure-JS so one
// VSIX serves macOS / Windows x64 / Windows ARM / Linux. Fails when any
// production dependency ships a native binary (.node) or a gyp build step.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const prodDeps = Object.keys(pkg.dependencies ?? {});

const visited = new Set();
const problems = [];

function visit(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const dir = path.join(root, "node_modules", ...name.split("/"));
  if (!fs.existsSync(dir)) {
    problems.push(`${name}: not installed (run npm ci first)`);
    return;
  }
  scanDir(dir, name);
  const depPkgPath = path.join(dir, "package.json");
  try {
    const depPkg = JSON.parse(fs.readFileSync(depPkgPath, "utf8"));
    if (depPkg.gypfile) problems.push(`${name}: declares gypfile (node-gyp build)`);
    const scripts = depPkg.scripts ?? {};
    for (const phase of ["install", "preinstall", "postinstall"]) {
      if (scripts[phase] && /node-gyp|prebuild-install|node-pre-gyp/.test(scripts[phase])) {
        problems.push(`${name}: ${phase} script runs a native build (${scripts[phase]})`);
      }
    }
    for (const dep of Object.keys(depPkg.dependencies ?? {})) {
      visit(dep);
    }
  } catch {
    problems.push(`${name}: unreadable package.json`);
  }
}

function scanDir(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue; // handled via visit()
      scanDir(p, name);
    } else if (entry.name.endsWith(".node") || entry.name === "binding.gyp") {
      problems.push(`${name}: native artifact ${path.relative(dir, p)}`);
    }
  }
}

prodDeps.forEach(visit);

if (problems.length > 0) {
  console.error("✗ Native-dependency gate FAILED (ADR-0016):");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `✓ Native-dependency gate passed: ${visited.size} production package(s) are pure JS.`,
);
