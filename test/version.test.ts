import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXTENSION_VERSION } from "../src/core/version";

test("the compiled version constant matches package.json (torn-install detector stays honest)", () => {
  // Compiled tests run from out-test/test — the manifest lives two levels up.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  ) as { version?: string };
  assert.equal(
    EXTENSION_VERSION,
    manifest.version,
    "bump src/core/version.ts together with package.json — the runtime/manifest comparison depends on it",
  );
});
