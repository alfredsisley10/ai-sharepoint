# ADR-0007 — Read-only reference SharePoint sites via a connection role

- Status: Accepted
- Date: 2026-06-10

## Context
Beyond the actively-managed SharePoint site, users want to reference **other** SharePoint sites in a
read-only way — using their content as context to help manage the active site, the same way Confluence
is used (ADR-0006). We must not version-control or write to these reference sites.

A reference SharePoint site is not a new auth or data-access problem: it's the *same* SharePoint, the
*same* MSAL providers (PLAN §5), and the *same* PnPjs read client we already build. The only new thing
is a guarantee that the sync/Git machinery never touches it.

## Decision
Model read-only reference SharePoint sites as a **role on the existing site connection**, not a
separate subsystem.

- Each SharePoint connection has `role ∈ { managed, reference }` (PLAN §5).
  - **managed** — full sync / Git / push / pull / revert lifecycle (§7).
  - **reference** — read-only context only: read via the existing PnPjs client; **never** serialized,
    snapshotted, committed, pushed, or written to.
- The boundary is enforced **structurally**: the sync/Git subsystems refuse to operate on `reference`
  connections (role guard), so read-only isn't a matter of discipline.
- Reference SharePoint sites and Confluence sources (ADR-0006) share one **Reference Sources** view and
  one **agent read/search tool**, powering cross-source alignment objectives. Fixes target the managed
  site only.

## Consequences
- Near-zero added auth/data surface — reuses §5 providers and the PnPjs read path.
- A single, uniform read-only context concept spans SharePoint and Confluence, so the agent treats all
  reference material the same way.
- The role guard is the load-bearing safety mechanism; it must be covered by tests that assert sync/Git
  operations reject `reference` connections.
