# ADR-0004 — Review gate is configurable per site connection

- Status: Accepted
- Date: 2026-06-10

## Context
SharePoint-affecting changes (sync pushes and agent-applied edits) flow into Enterprise GitHub.
Different sites warrant different rigor: a production customer-facing site wants review; a personal
sandbox wants speed. A single global policy serves neither well.

## Decision
Make the review gate a **per-site-connection setting** with two modes:

- **PR-gated** — every SharePoint-affecting change opens a pull request on Enterprise GitHub for review
  before merge. Default for sites tagged production.
- **Direct-push** — commit straight to a working branch; review via Git history.

## Consequences
- The Sites connection model gains a `reviewGate` property and supporting UI.
- The sync/agent apply pipeline branches on the per-site setting when committing/pushing.
- Slightly more configuration surface than a global toggle, in exchange for fitting real workflows.
- Pairs with the preview→approve→apply→commit flow (PLAN §8): approval is local; the gate governs how
  the committed change reaches the shared remote.
