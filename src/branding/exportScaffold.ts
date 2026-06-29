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

/** GHES / SaaS best-practice guidance for the exported repository. */
export function maintainingGuide(after: BrandConfig, kind: ExportKind): string {
  const buildSteps =
    kind === "source"
      ? "    npm install\n    npm run typecheck\n    npm test\n    npm run package"
      : "    npm install      # installs @vscode/vsce only\n    npm run package";
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
    "```",
    buildSteps,
    "```",
    "",
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
    "If the registry/proxy serves internally-issued certificates, trust the OS store on",
    "the runner (Node 22.9+ honors `NODE_OPTIONS=--use-system-ca`) or set",
    "`NODE_EXTRA_CA_CERTS` to your corporate CA bundle. Dependency floors are kept at the",
    "major base (`^X.0.0`) so a prior version still resolves when the newest is withheld",
    "pending a security scan.",
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
