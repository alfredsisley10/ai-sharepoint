import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";

// CommonJS build script; path is relative to the COMPILED test (out-test/test/…).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundler = require("../../scripts/bundle-source") as {
  collectSourceFiles(root: string): Record<string, Uint8Array>;
};

const repoRoot = path.join(__dirname, "..", "..");

test("collectSourceFiles includes the buildable source, excludes node_modules/dist/.git", () => {
  const files = bundler.collectSourceFiles(repoRoot);
  const names = Object.keys(files);
  // Source + the files needed to build it.
  assert.ok(names.includes("src/extension.ts"), "TS source");
  assert.ok(names.includes("package.json"));
  assert.ok(names.includes("package-lock.json"), "lockfile for reproducible installs");
  assert.ok(names.includes("esbuild.js"));
  assert.ok(names.includes("tsconfig.json"));
  // The rebrand engine must travel so the exported source can itself rebrand.
  assert.ok(names.includes("src/branding/rebrandVsix.ts"));
  // Never bundle restored deps, build output, or VCS metadata.
  assert.ok(!names.some((n) => n.startsWith("node_modules")), "no node_modules");
  assert.ok(!names.some((n) => n.startsWith("dist/")), "no build output");
  assert.ok(!names.some((n) => n.startsWith(".git/")), "no VCS metadata");
});
