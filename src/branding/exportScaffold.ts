/**
 * Generated scaffolding added to a white-label export (minimal components or
 * full source) so the receiving GitHub repo is build-ready and follows
 * enterprise best practice: a working GitHub Actions workflow plus a
 * MAINTAINING.md with GitHub Enterprise Server / SaaS recommendations.
 *
 * Pure string builders. GitHub `${{ … }}` expressions are kept as literal
 * single-quoted lines (never template-interpolated) so they reach the workflow
 * verbatim.
 */
import { strToU8 } from "fflate";
import { BrandConfig } from "./rebrand";

export type ExportKind = "minimal" | "source";

/** A build+package+release GitHub Actions workflow appropriate to the export. */
export function buildWorkflowYaml(kind: ExportKind): string {
  const verify =
    kind === "source"
      ? [
          "      - name: Typecheck",
          "        run: npm run typecheck",
          "      - name: Test",
          "        run: npm test",
        ]
      : [];
  return [
    "# Build and package the extension into a .vsix.",
    "# GHES note: change `runs-on` to your self-hosted runner label if GitHub-",
    "# hosted runners cannot reach your npm registry. See MAINTAINING.md.",
    "name: Build VSIX",
    "on:",
    "  push:",
    "    branches: [ main ]",
    "    tags: [ 'v*' ]",
    "  pull_request:",
    "permissions:",
    "  contents: write   # needed only by the tag-triggered release step",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "      # If your npm registry/proxy uses internally-issued TLS certs, trust the",
    "      # OS store on the runner (Node 22.9+: NODE_OPTIONS=--use-system-ca) or set",
    "      # NODE_EXTRA_CA_CERTS. For a private registry, add an .npmrc using the",
    "      # NPM_TOKEN secret (see MAINTAINING.md).",
    "      - name: Install dependencies",
    "        run: npm install --no-audit --no-fund",
    ...verify,
    "      - name: Package VSIX",
    "        run: npm run package",
    "      - name: Upload VSIX artifact",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: vsix",
    "          path: '*.vsix'",
    "          if-no-files-found: error",
    "      - name: Publish release (on tag)",
    "        if: startsWith(github.ref, 'refs/tags/')",
    "        run: gh release create \"${{ github.ref_name }}\" *.vsix --notes \"Automated white-label build\"",
    "        env:",
    "          GH_TOKEN: ${{ github.token }}",
    "",
  ].join("\n");
}

/**
 * Shared build-environment troubleshooting for the exported guides: corporate
 * TLS (OS trust store + verbose first, a specific CA bundle next, `--strict-ssl`
 * bypass only as a flagged last resort) and the benign Windows `npm warn cleanup`
 * / "operation not permitted, rmdir" warnings. Cross-platform throughout
 * (bash/zsh · PowerShell · cmd.exe).
 */
export function buildEnvironmentNotes(kind: ExportKind): string {
  const lines = [
    "## Behind a corporate proxy or private registry (internal TLS certs)",
    "",
    "Don't blanket-disable TLS — work through these **in order**, keeping `--verbose`",
    "so you can see exactly which host and which dependency is involved:",
    "",
    "1. **Trust the OS certificate store** (recommended; Node 22.9+). Set `--use-system-ca`",
    "   before installing:",
    "   - bash/zsh: `export NODE_OPTIONS=--use-system-ca`",
    "   - PowerShell: `$env:NODE_OPTIONS = '--use-system-ca'`",
    "   - cmd.exe: `set NODE_OPTIONS=--use-system-ca`",
    "",
    "   then `npm install --verbose --no-audit --no-fund`.",
    "",
    "2. **Add the specific CA bundle.** If a dependency still fails on a self-signed CA the",
    "   OS store doesn't have (or you're on older Node), point `NODE_EXTRA_CA_CERTS` at your",
    "   corporate CA `.pem` and re-run:",
    "   - bash/zsh: `export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`",
    "   - PowerShell: `$env:NODE_EXTRA_CA_CERTS = 'C:\\path\\to\\corp-ca.pem'`",
    "   - cmd.exe: `set NODE_EXTRA_CA_CERTS=C:\\path\\to\\corp-ca.pem`",
    "",
    "3. **Last resort — ignore TLS errors** (⚠️ **security risk**). `--strict-ssl=false`",
    "   disables certificate verification, exposing the install to man-in-the-middle",
    "   tampering. Only on a **trusted** network, for a single install, then re-enable:",
    "",
    "   ```",
    "   npm install --strict-ssl=false --verbose",
    "   npm config set strict-ssl true   # re-enable immediately afterward",
    "   ```",
    "",
  ];
  if (kind === "source") {
    lines.push(
      "## Withheld / quarantined newer versions",
      "",
      "Enterprise registries often quarantine a just-released version until it clears a",
      "security scan, so its tarball 404s (e.g. `could not find prettier-3.9.3.tgz`). This",
      "export therefore ships **no `package-lock.json`** and keeps dependency ranges at the",
      "major base (`^X.0.0`), so `npm install` resolves the newest version your registry",
      "*actually has* — automatically falling back to the prior (N-1) release when the latest",
      "is withheld. After a clean install, **commit the generated `package-lock.json`** to your",
      "repo for reproducible builds. If a build later fails on a missing tarball, delete",
      "`package-lock.json` and re-run `npm install` to re-resolve against your registry.",
      "",
    );
  }
  lines.push('## Windows: `npm warn cleanup` / "operation not permitted, rmdir"', "");
  if (kind === "source") {
    lines.push(
      "These are **warnings, not errors — the install still succeeds.** npm fetches the",
      "platform-specific binaries for several OSes (esbuild ships one per platform) and",
      "prunes the ones this machine doesn't need; on Windows, antivirus, Explorer, or",
      "OneDrive frequently hold those folders open, so the cleanup `rmdir` is denied and",
      "npm logs `npm warn cleanup`. Confirm the build is fine by running `npm run package` —",
      "it still produces the `.vsix`.",
      "",
      "To minimize the noise: build in a **local, non-synced** folder (not OneDrive or a",
      "synced Desktop), add it to your antivirus exclusions, and close editors/Explorer",
      "windows on `node_modules`. For a clean retry: PowerShell",
      "`Remove-Item -Recurse -Force node_modules` (cmd `rmdir /s /q node_modules`), then",
      "`npm install --verbose`. Use `npm install` (not `npm ci`) so npm resolves this",
      "platform's binaries.",
    );
  } else {
    lines.push(
      "If npm logs `npm warn cleanup` with \"operation not permitted, rmdir\", these are",
      "**warnings, not errors** — npm couldn't delete a temporary folder (antivirus/Explorer/",
      "OneDrive held it open) but the install still succeeds. Confirm with `npm run package`.",
      "Building in a local, non-synced folder and excluding it from antivirus avoids the noise.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** GHES / SaaS best-practice guidance for the exported repository. */
export function maintainingGuide(after: BrandConfig, kind: ExportKind): string {
  const buildSteps =
    kind === "source"
      ? "npm install --verbose\nnpm run typecheck\nnpm test\nnpm run package"
      : "npm install --verbose   # installs only @vscode/vsce (the VS Code extension packager)\nnpm run package";
  return [
    `# Maintaining "${after.displayName}"`,
    "",
    kind === "source"
      ? "This repository holds the **full source** of the white-labeled extension. It"
      : "This repository holds the **pre-built, rebranded build components**. It",
    kind === "source"
      ? "builds the VSIX from scratch; only standard npm dependencies are needed from"
      : "re-packages the existing bundle; only `@vscode/vsce` is needed from your",
    kind === "source" ? "your registry (no access to the original repo is required)." : "registry.",
    "",
    "## Build locally",
    "",
    "The **same commands on macOS, Linux, and Windows** (npm is cross-platform).",
    "`--verbose` gives full install diagnostics behind a proxy or private registry.",
    "",
    "```",
    buildSteps,
    "```",
    "",
    buildEnvironmentNotes(kind),
    "## GitHub Actions (build, package, release)",
    "",
    "A workflow is included at `.github/workflows/whitelabel-build.yml`. It builds and",
    "packages on every push/PR to `main`, uploads the `.vsix` as an artifact, and — on a",
    "`v*` tag — publishes a GitHub Release with the `.vsix` attached. Tag a release with:",
    "",
    "```",
    "git tag v" + "<version>   # e.g. v1.0.0",
    "git push origin v<version>",
    "```",
    "",
    "## Recommendations — GitHub Enterprise Server & SaaS",
    "",
    "**Runners.** On SaaS, GitHub-hosted runners work out of the box. On GHES (or an",
    "air-gapped/locked-down network), use **self-hosted runners** in a runner group that",
    "can reach your npm registry, and set the workflow's `runs-on` to that label.",
    "",
    "**Private/internal npm registry + TLS.** If you publish/restore packages through an",
    "internal registry: add a repo `.npmrc` pointing at it and authenticate with an",
    "Actions secret (e.g. `NPM_TOKEN`) — never commit the token:",
    "",
    "```",
    "registry=https://registry.corp.example/",
    "//registry.corp.example/:_authToken=${NPM_TOKEN}",
    "```",
    "",
    "The same OS-trust-store / CA settings from **Behind a corporate proxy** above apply on",
    "the runner — set them in the workflow `env:` or your runner image. Installs adapt to the",
    "versions your registry has (no committed lockfile; `^X.0.0` ranges) — see **Withheld /",
    "quarantined newer versions** above.",
    "",
    "**Branch protection.** Protect `main`: require the *Build VSIX* check to pass,",
    "require pull-request review, and restrict who can push tags (releases trigger on",
    "tags). Enable a linear history if your team prefers it.",
    "",
    "**Secrets to configure.** `NPM_TOKEN` (only for a private registry). The release",
    "step uses the built-in `GITHUB_TOKEN` — no extra secret needed.",
    "",
    "**Dependency hygiene.** Enable Dependabot (SaaS) or your GHES dependency scanning,",
    "and run `npm audit` in CI. Review and mirror new dependency versions through your",
    "security pipeline before bumping ranges.",
    "",
    "**Distribution.** Install the produced `.vsix` with `code --install-extension <file>`,",
    "or host it in a **private extension gallery** so updates flow to users normally.",
    "Consider artifact signing / build provenance per your supply-chain policy.",
    "",
  ].join("\n");
}

/** The scaffold files (MAINTAINING.md + the Actions workflow) for an export. */
export function exportScaffoldFiles(after: BrandConfig, kind: ExportKind): Record<string, Uint8Array> {
  return {
    "MAINTAINING.md": strToU8(maintainingGuide(after, kind)),
    ".github/workflows/whitelabel-build.yml": strToU8(buildWorkflowYaml(kind)),
  };
}
