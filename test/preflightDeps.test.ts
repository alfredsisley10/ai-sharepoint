import { test } from "node:test";
import * as assert from "node:assert/strict";

// The build preflight is a CommonJS build script (not part of the bundle); load
// it directly. Path is relative to the COMPILED test (out-test/test/…).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pf = require("../../scripts/preflight-deps") as {
  satisfies(v: string, range: string): boolean;
  pickInstallable(range: string, available: string[]): string | null;
  compareSemver(a: string, b: string): number;
  npmEnv(base?: Record<string, string | undefined>): Record<string, string | undefined>;
  nodeSupportsSystemCa(): boolean;
};

test("satisfies: caret floor excludes lower, includes within major, excludes next major", () => {
  assert.equal(pf.satisfies("3.8.0", "^3.9.3"), false, "below the floor");
  assert.equal(pf.satisfies("3.9.3", "^3.9.3"), true);
  assert.equal(pf.satisfies("3.10.0", "^3.9.3"), true);
  assert.equal(pf.satisfies("4.0.0", "^3.9.3"), false, "next major");
});

test("satisfies: 0.x caret is minor-locked; exact is exact", () => {
  assert.equal(pf.satisfies("0.28.5", "^0.28.0"), true);
  assert.equal(pf.satisfies("0.29.0", "^0.28.0"), false, "0.x caret locks the minor");
  assert.equal(pf.satisfies("1.2.3", "1.2.3"), true);
  assert.equal(pf.satisfies("1.2.4", "1.2.3"), false);
});

test("pickInstallable: highest in range; null when the floor excludes all available", () => {
  // The enterprise scenario: latest (3.9.3) withheld pending scan, only priors mirrored.
  assert.equal(pf.pickInstallable("^3.9.3", ["3.7.0", "3.8.0"]), null, "tight floor → nothing installable");
  // Relaxed floor adapts to the available PRIOR version.
  assert.equal(pf.pickInstallable("^3.0.0", ["3.7.0", "3.8.0"]), "3.8.0");
  // When the latest IS available, it's chosen.
  assert.equal(pf.pickInstallable("^3.0.0", ["3.7.0", "3.8.0", "3.9.3"]), "3.9.3");
});

test("npmEnv enables the OS trust store and preserves existing CA settings", () => {
  const env = pf.npmEnv({});
  if (pf.nodeSupportsSystemCa()) {
    assert.match(env.NODE_OPTIONS ?? "", /--use-system-ca/);
  }
  // Existing NODE_OPTIONS is preserved, not clobbered.
  const env2 = pf.npmEnv({ NODE_OPTIONS: "--max-old-space-size=2048" });
  assert.match(env2.NODE_OPTIONS ?? "", /--max-old-space-size=2048/);
  // REBRAND_CA_FILE becomes NODE_EXTRA_CA_CERTS for older Node.
  const env3 = pf.npmEnv({ REBRAND_CA_FILE: "/etc/pki/corp-root.pem" });
  assert.equal(env3.NODE_EXTRA_CA_CERTS, "/etc/pki/corp-root.pem");
});
