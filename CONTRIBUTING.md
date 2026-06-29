# Contributing to AI SharePoint

Thanks for helping improve AI SharePoint. This guide covers local setup, the
checks CI enforces, and the conventions that keep the codebase shippable.

## Prerequisites

- **Node.js 22** (CI pins 22; the launcher works on Node ≥ 18).
- **VS Code ≥ 1.95** with the **GitHub Copilot** extension to exercise AI
  features, and a Microsoft 365 account to exercise SharePoint features.

## Setup

```bash
npm ci          # install exact, locked dependencies
npm run compile # esbuild bundle → dist/extension.js
```

Press <kbd>F5</kbd> in VS Code to launch the Extension Development Host.

## The checks CI runs (run them before pushing)

CI runs the full gate on an **ubuntu / windows / macOS** matrix. Reproduce locally:

| Command | What it enforces |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — no type errors. |
| `npm run lint` | ESLint, type-aware **correctness** rules (no floating/misused promises). Style is Prettier's job, not the linter's. |
| `npm test` | Node's built-in test runner over the compiled `test/*.test.ts`. |
| `npm run check:native` | **Native-dependency gate (ADR-0016)**: every production dependency must be pure JS — no native modules, so one VSIX runs on every OS. |
| `npm run scan:secrets` | Repo-wide secret scan; fails on anything secret-shaped in tracked files. |
| `npm run check:vsix` | Builds, then asserts the package contains the bundle + assets and **none** of: sources, sourcemaps, tests, build scripts, dotfiles, or secret-shaped files. |

Helpful extras: `npm run coverage` (adds `--experimental-test-coverage`),
`npm run format` (Prettier write), `npm run test:integration`
(`@vscode/test-electron` smoke test — downloads VS Code; needs a display).

## Architectural invariants (don't regress these)

- **Pure JS only in production deps** (ADR-0016). If you need a capability, reach
  for the platform/`fetch`/Node built-ins before any module with a native
  addon. `npm run check:native` is the gate.
- **Read-safety** (ADR-0012): reference/context sources are read-only and
  enforced as such — SQL is guarded (`assertReadOnlySql`), MongoDB operators are
  denylisted, SPL/CQL/JQL/CSV inputs are escaped. Never add a write path to a
  reference source.
- **Secrets live in the OS keychain** (SecretStorage), never in settings,
  workspace files, logs, or diagnostics exports. Wire logging redacts in layers.
- **The AI surface is read-only.** Every write tool is approval-gated (produces a
  preview, acts only on explicit confirmation). The agent loop must never write
  unattended.
- **Telemetry never carries free-form text or PII.** External telemetry is
  opt-in, categorical-only, and self-anonymizing; redacted props only.

## Architecture Decision Records

Significant decisions are recorded under [`docs/adr/`](docs/adr) as
`NNNN-short-title.md`. When you make one:

1. Use the **next free number** (check both the files and `grep -r "ADR-"` in
   `src/` so you don't collide with a number a code comment already reserves).
2. Cite it in the code it governs (`// … (ADR-00NN)`), so the record and the
   implementation stay cross-referenced.

## Commits, branches, and PRs

- Work on a feature branch; don't push to `main` directly.
- Write clear, imperative commit messages that explain the *why*, not just the
  *what*.
- Keep the working tree green: a PR should pass the full gate above. Add or
  update tests for behavior changes — the suite is the safety net for a
  pure-logic-heavy codebase.

## Reporting issues

See [SUPPORT.md](SUPPORT.md). For anything security-sensitive, follow the
process in [docs/SECURITY.md](docs/SECURITY.md) rather than opening a public
issue.
