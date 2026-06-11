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

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
