// Remove the compiled test output BEFORE recompiling. `tsc` recompiles changed
// sources but never prunes orphans, so a deleted `*.test.ts` would otherwise
// leave its stale `*.test.js` behind and keep running — silently producing
// false-green results (a deleted test's count never drops). Wiping out-test/
// first makes every `npm test` a clean build.
"use strict";
const { rmSync } = require("node:fs");
const path = require("node:path");
rmSync(path.join(__dirname, "..", "out-test"), { recursive: true, force: true });
