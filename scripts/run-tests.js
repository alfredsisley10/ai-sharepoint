// Cross-version test launcher: `node --test <glob>` only works on Node 21+,
// and directory arguments behave differently across versions, so CI (Node 20)
// and local dev (Node 22) diverged. Enumerating the compiled files explicitly
// is deterministic on every Node ≥ 18 and every OS.
"use strict";
const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const dir = path.join(__dirname, "..", "out-test", "test");
let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(dir, f));
} catch {
  console.error(`No compiled tests at ${dir} — run tsc -p tsconfig.test.json first.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No *.test.js files in ${dir}.`);
  process.exit(1);
}

// Opt-in coverage (`npm run coverage` / COVERAGE=1): node's built-in test
// coverage needs no extra dependency. Kept off the default `test` run so the
// fast feedback loop stays uncluttered.
const coverage =
  process.argv.includes("--coverage") || process.env.COVERAGE === "1";
const nodeArgs = ["--test"];
if (coverage) {
  nodeArgs.push("--experimental-test-coverage");
}
nodeArgs.push(...files);

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
