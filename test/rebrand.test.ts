import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  BrandConfig,
  validateBrandConfig,
  extensionId,
  identityChanged,
  rebrandPackageJson,
  rebrandLicense,
  replacePhrase,
  repackageCommand,
  summarizeBrand,
  SUPPORT_PHRASE,
  SECURITY_PHRASE,
} from "../src/branding/rebrand";

const base: BrandConfig = {
  publisher: "contoso",
  name: "ai-sharepoint",
  displayName: "Contoso Docs",
  description: "Internal docs assistant.",
};

test("validateBrandConfig enforces the publisher/name charset and required fields", () => {
  assert.deepEqual(validateBrandConfig(base), []);
  assert.ok(validateBrandConfig({ ...base, publisher: "Contoso Corp" }).length > 0); // spaces/caps
  assert.ok(validateBrandConfig({ ...base, name: "" }).length > 0);
  assert.ok(validateBrandConfig({ ...base, displayName: "  " }).length > 0);
  assert.ok(validateBrandConfig({ ...base, description: "" }).length > 0);
});

test("extensionId / identityChanged track the data-scoping identity", () => {
  assert.equal(extensionId("contoso", "ai-sharepoint"), "contoso.ai-sharepoint");
  assert.ok(identityChanged({ ...base, publisher: "old" }, base));
  assert.ok(identityChanged({ ...base, name: "old-name" }, base));
  assert.ok(!identityChanged(base, { ...base, displayName: "Changed", description: "x" }));
});

test("rebrandPackageJson sets the four fields, preserves formatting, stays valid JSON", () => {
  const raw = [
    "{",
    '  "name": "ai-sharepoint",',
    '  "displayName": "AI SharePoint",',
    '  "description": "Old description with a \\"quote\\".",',
    '  "version": "0.66.2",',
    '  "publisher": "alfredsisley10",',
    '  "contributes": {',
    '    "chatParticipants": [',
    '      { "name": "sharepoint" }',
    "    ]",
    "  }",
    "}",
    "",
  ].join("\n");
  const out = rebrandPackageJson(raw, { ...base, displayName: 'Has "quotes"', description: "New & shiny." });
  const parsed = JSON.parse(out);
  assert.equal(parsed.publisher, "contoso");
  assert.equal(parsed.name, "ai-sharepoint");
  assert.equal(parsed.displayName, 'Has "quotes"');
  assert.equal(parsed.description, "New & shiny.");
  assert.equal(parsed.version, "0.66.2"); // untouched
  // the nested chat participant "name" must NOT have been rewritten
  assert.equal(parsed.contributes.chatParticipants[0].name, "sharepoint");
});

test("rebrandPackageJson throws if a field is missing (caller can fall back)", () => {
  assert.throws(() => rebrandPackageJson('{\n  "name": "x"\n}\n', base), /publisher/);
});

test("rebrandLicense swaps the holder and updates the year", () => {
  const lic = "MIT License\n\nCopyright (c) 2026 AI SharePoint contributors\n\nPermission...";
  assert.match(rebrandLicense(lic, "Contoso Ltd"), /Copyright \(c\) 2026 Contoso Ltd/);
  assert.match(rebrandLicense(lic, "Contoso Ltd", "2027"), /Copyright \(c\) 2027 Contoso Ltd/);
});

test("replacePhrase swaps distributor placeholders and reports change", () => {
  const support = `send the file to ${SUPPORT_PHRASE}.`;
  const r = replacePhrase(support, SUPPORT_PHRASE, "support@contoso.com");
  assert.ok(r.changed);
  assert.equal(r.text, "send the file to support@contoso.com.");
  // missing phrase or empty replacement → unchanged
  assert.deepEqual(replacePhrase("already custom", SECURITY_PHRASE, "x"), { text: "already custom", changed: false });
  assert.equal(replacePhrase(support, SUPPORT_PHRASE, "   ").changed, false);
});

test("repackageCommand uses && on cmd.exe and POSIX shells (and when shell is unknown)", () => {
  const both = "npm install && npm run package";
  for (const shell of [
    "/bin/bash",
    "/bin/zsh",
    "/usr/local/bin/fish",
    "/bin/sh",
    "C:\\WINDOWS\\System32\\cmd.exe",
    "",
    undefined,
  ]) {
    assert.equal(repackageCommand(shell), both);
  }
});

test("repackageCommand avoids && on PowerShell — Windows 5.1 rejects && as a statement separator", () => {
  const guarded = "npm install; if ($LASTEXITCODE -eq 0) { npm run package }";
  for (const shell of [
    "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", // Windows PowerShell 5.1 (default)
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe", // PowerShell 7+
    "powershell.exe",
    "pwsh",
  ]) {
    const cmd = repackageCommand(shell);
    assert.equal(cmd, guarded);
    assert.ok(!cmd.includes("&&"), `must not emit && for PowerShell shell ${shell}`);
  }
});

test("summarizeBrand lists only the changed fields", () => {
  const lines = summarizeBrand(
    { ...base, publisher: "alfredsisley10", displayName: "AI SharePoint" },
    base,
  );
  assert.ok(lines.some((l) => /Publisher: alfredsisley10 → contoso/.test(l)));
  assert.ok(lines.some((l) => /Display name: AI SharePoint → Contoso Docs/.test(l)));
  assert.ok(!lines.some((l) => /Name:/.test(l))); // unchanged
});
