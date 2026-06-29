// Smoke suite executed INSIDE the VS Code extension host (so `require("vscode")`
// resolves to the live API). Hand-rolled runner — no Mocha dependency: the
// host calls run(), and a throw fails the suite.
"use strict";
const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");

async function run() {
  const pkg = require(path.resolve(__dirname, "..", "..", "package.json"));
  const id = `${pkg.publisher}.${pkg.name}`;

  const ext = vscode.extensions.getExtension(id);
  assert.ok(ext, `extension ${id} should be present in the host`);

  await ext.activate();
  assert.ok(ext.isActive, "extension should activate without throwing");

  const commands = await vscode.commands.getCommands(true);
  // The diagnostics export command is registered unconditionally on activation;
  // its internal namespace (aiSharePoint.*) is stable across rebrands.
  assert.ok(
    commands.includes("aiSharePoint.exportDiagnostics"),
    "core command aiSharePoint.exportDiagnostics should be registered after activation",
  );

  // Informational drift signal: how many of the contributed commands actually
  // registered. Not asserted in full because a few are conditionally wired.
  const declared = (pkg.contributes?.commands ?? []).map((c) => c.command);
  const registered = declared.filter((c) => commands.includes(c));
  console.log(
    `✓ integration smoke: ${id} activated; ${registered.length}/${declared.length} contributed commands registered.`,
  );
}

module.exports = { run };
