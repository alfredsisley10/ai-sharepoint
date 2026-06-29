// Integration-test launcher (SDLC review #26): downloads a real VS Code, loads
// THIS extension into the extension host, and runs the smoke suite against the
// live `vscode` API. This is the only layer that can prove activation, command
// registration, and contribution wiring — things the pure unit tests can't.
//
// Run with `npm run test:integration`. Requires network access to the VS Code
// download CDN (and a display / xvfb on Linux CI). Kept out of the default
// gate because of those external requirements; CI runs it as a soft job.
"use strict";
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "..");
    const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Open an empty, untitled workspace so no user/workspace settings leak in.
      launchArgs: ["--disable-extensions", "--disable-gpu"],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();
