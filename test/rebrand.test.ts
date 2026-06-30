import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  BrandConfig,
  validateBrandConfig,
  extensionId,
  identityChanged,
  rebrandPackageJson,
  rebrandLicense,
  rebrandReadmeTagline,
  rebrandChatParticipant,
  setReleaseManifest,
  setProvisioningManifest,
  replacePhrase,
  repackageCommand,
  summarizeBrand,
  SUPPORT_PHRASE,
  SECURITY_PHRASE,
} from "../src/branding/rebrand";
// Origin-side fixtures come from ORIGIN_BRAND so these tests hardcode no prior
// identifiers (and stay correct after a white-label export regenerates it).
import { ORIGIN_BRAND } from "../src/branding/originBrand";

test("rebrandReadmeTagline replaces the post-H1 bold description, once, leaving the body", () => {
  const readme = [
    "# Contoso Docs",
    "",
    "**Govern and explore SharePoint Online — with metered usage,",
    "budget guardrails, and privacy-first diagnostics.**",
    "",
    "Body paragraph with **bold** that must NOT be touched.",
    "",
  ].join("\n");
  const out = rebrandReadmeTagline(readme, "Contoso's internal docs assistant.");
  assert.match(out, /^# Contoso Docs\n\n\*\*Contoso's internal docs assistant\.\*\*/);
  assert.doesNotMatch(out, /Govern and explore/, "original tagline gone");
  assert.match(out, /Body paragraph with \*\*bold\*\* that must NOT be touched\./, "body untouched");
});

test("rebrandReadmeTagline is a no-op when there's no tagline (and safe with $ in the description)", () => {
  assert.equal(rebrandReadmeTagline("# Title\n\nJust prose, no bold tagline.\n", "x"), "# Title\n\nJust prose, no bold tagline.\n");
  const out = rebrandReadmeTagline("# T\n\n**old**\n", "Cost is $5 (50% off) $& $1");
  assert.match(out, /\*\*Cost is \$5 \(50% off\) \$& \$1\*\*/);
});

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
    `  "name": "${ORIGIN_BRAND.kebab}",`,
    `  "displayName": "${ORIGIN_BRAND.displayName}",`,
    '  "description": "Old description with a \\"quote\\".",',
    '  "version": "0.66.2",',
    `  "publisher": "${ORIGIN_BRAND.publisher}",`,
    '  "contributes": {',
    '    "chatParticipants": [',
    `      { "name": "${ORIGIN_BRAND.handle}" }`,
    "    ]",
    "  }",
    "}",
    "",
  ].join("\n");
  const out = rebrandPackageJson(raw, { ...base, name: "contoso-docs", displayName: 'Has "quotes"', description: "New & shiny." });
  const parsed = JSON.parse(out);
  assert.equal(parsed.publisher, "contoso");
  assert.equal(parsed.name, "contoso-docs");
  assert.equal(parsed.displayName, 'Has "quotes"');
  assert.equal(parsed.description, "New & shiny.");
  assert.equal(parsed.version, "0.66.2"); // untouched
  // the nested chat participant "name" must NOT have been rewritten
  assert.equal(parsed.contributes.chatParticipants[0].name, ORIGIN_BRAND.handle);
});

test("rebrandPackageJson throws if a field is missing (caller can fall back)", () => {
  assert.throws(() => rebrandPackageJson('{\n  "name": "x"\n}\n', base), /publisher/);
});

test("rebrandLicense swaps the holder and updates the year", () => {
  const lic = `MIT License\n\nCopyright (c) 2026 ${ORIGIN_BRAND.displayName} contributors\n\nPermission...`;
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

test("repackageCommand { verbose } adds --verbose to the install on each shell family", () => {
  // POSIX / cmd.exe → && form.
  assert.equal(repackageCommand("/bin/bash", { verbose: true }), "npm install --verbose && npm run package");
  // PowerShell → guarded ;-form, still --verbose, never &&.
  const pwsh = repackageCommand("pwsh", { verbose: true });
  assert.equal(pwsh, "npm install --verbose; if ($LASTEXITCODE -eq 0) { npm run package }");
  assert.ok(!pwsh.includes("&&"));
});

test("rebrandChatParticipant renames the handle keyed off ORIGIN_BRAND.handle (white-label safe), and the fullName", () => {
  // Fixture uses ORIGIN_BRAND.handle (NOT a hardcoded 'sharepoint') so this stays
  // correct after a white-label export regenerates ORIGIN_BRAND — the exact case
  // that broke when the rename searched for a literal "sharepoint".
  const pkg = `{
  "contributes": {
    "chatParticipants": [
      { "name": ${JSON.stringify(ORIGIN_BRAND.handle)}, "fullName": "SharePoint" }
    ]
  }
}`;
  const out = rebrandChatParticipant(pkg, "contosodocs", "Contoso Docs");
  assert.match(out, /"name": "contosodocs"/);
  assert.match(out, /"fullName": "Contoso Docs"/);
  assert.doesNotMatch(out, new RegExp(`"name": ${JSON.stringify(ORIGIN_BRAND.handle)}`), "old handle gone");
  // A participant whose name isn't the origin handle is left alone (scoped rename).
  const other = rebrandChatParticipant('{ "name": "somethingelse" }', "contosodocs", "Contoso Docs");
  assert.match(other, /"name": "somethingelse"/);
});

test("setReleaseManifest / setProvisioningManifest insert on a CRLF package.json (Windows autocrlf)", () => {
  const lf = '{\n  "name": "x",\n  "version": "1.0.0",\n  "description": "d"\n}\n';
  const crlf = lf.replace(/\n/g, "\r\n");
  for (const [label, raw] of [["LF", lf], ["CRLF", crlf]] as const) {
    const withRel = setReleaseManifest(raw, { channel: "whitelabel", builtAt: "t", productName: "P" });
    assert.match(withRel, /"release":/, `${label}: release inserted`);
    const withBoth = setProvisioningManifest(withRel, { id: "b1", settings: { a: 1 } });
    assert.match(withBoth, /"provisioning":/, `${label}: provisioning inserted`);
    // The inserted JSON is valid regardless of the surrounding line endings.
    const parsed = JSON.parse(withBoth);
    assert.equal(parsed.release.channel, "whitelabel");
    assert.equal(parsed.provisioning.id, "b1");
  }
});

test("summarizeBrand lists only the changed fields", () => {
  const lines = summarizeBrand(
    { ...base, publisher: ORIGIN_BRAND.publisher, displayName: ORIGIN_BRAND.displayName },
    base,
  );
  assert.ok(lines.some((l) => l.includes(`Publisher: ${ORIGIN_BRAND.publisher} → contoso`)));
  assert.ok(lines.some((l) => l.includes(`Display name: ${ORIGIN_BRAND.displayName} → Contoso Docs`)));
  assert.ok(!lines.some((l) => /Name:/.test(l))); // unchanged
});
