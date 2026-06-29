import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
) as {
  contributes: {
    commands: Array<{ command: string }>;
    menus: { commandPalette?: Array<{ command: string; when?: string }> };
  };
};

const commandIds = new Set(pkg.contributes.commands.map((c) => c.command));
const palette = pkg.contributes.menus.commandPalette ?? [];

// The context keys extension.ts actually sets (syncContext + Copilot state).
// A `when` clause may only reference these (or be the literal `false`), so a
// typo can't silently leave a command ungated or permanently hidden.
const KNOWN_KEYS = new Set([
  "aiSharePoint.hasSites",
  "aiSharePoint.hasSources",
  "aiSharePoint.hasProjects",
  "aiSharePoint.hasBookmarks",
  "aiSharePoint.copilotChatInstalled",
  "aiSharePoint.copilotSignedIn",
]);

test("every commandPalette entry targets a real contributed command", () => {
  for (const entry of palette) {
    assert.ok(
      commandIds.has(entry.command),
      `commandPalette references unknown command ${entry.command}`,
    );
  }
});

test("commandPalette when-clauses reference only known context keys (or false)", () => {
  for (const entry of palette) {
    const when = entry.when ?? "";
    if (when === "" || when === "false" || when === "true") continue;
    const keys = when.match(/aiSharePoint\.[A-Za-z]+/g) ?? [];
    assert.notEqual(keys.length, 0, `"${when}" has no aiSharePoint.* key`);
    for (const k of keys) {
      assert.ok(KNOWN_KEYS.has(k), `commandPalette when "${when}" uses unset context key ${k}`);
    }
  }
});

test("draft item-commands that no-op without a tree item are hidden from the palette", () => {
  // editCommDraft/discardCommDraft/reviewCommDraft require the draft argument
  // and have no picker fallback, so they must be when:false (not shown).
  for (const cmd of [
    "aiSharePoint.reviewCommDraft",
    "aiSharePoint.editCommDraft",
    "aiSharePoint.discardCommDraft",
  ]) {
    const entry = palette.find((e) => e.command === cmd);
    assert.ok(entry, `${cmd} should have a commandPalette entry`);
    assert.equal(entry!.when, "false", `${cmd} should be hidden (when:false) from the palette`);
  }
});
