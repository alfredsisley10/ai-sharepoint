# ADR-0006 — Confluence as a read-only context source

- Status: Accepted
- Date: 2026-06-10

## Context
We want the agent to use Confluence content as **context** for managing SharePoint — e.g. *"Ensure all
of the information on the Confluence site is aligned with the SharePoint product information site."* We
explicitly do **not** want to version-control Confluence or write changes back to it. Confluence comes
in two deployments with different auth surfaces:

- **Confluence Cloud** — API token (Basic: email + API token), OAuth 2.0 (3LO), scoped API tokens.
- **Confluence Data Center / Server** — Personal Access Token (Bearer) and Basic auth
  (username/password). Basic auth is **known-good** against the target Enterprise Confluence (validated
  via the `atlassian-python-api` Python module), so it is treated as a first-class, fully supported
  method here — not a deprecated fallback.

## Decision
Add Confluence as a **strictly read-only context source**, reusing the patterns we already have:

- **Pluggable auth** mirroring the SharePoint provider abstraction (PLAN §5): one
  `ConfluenceAuthProvider` interface, all supported methods behind it, **read-only scopes only**.
  **Decision F: support both Cloud and Data Center/Server.** Recommended defaults are the Cloud **API
  token (Basic)** and the DC **Personal Access Token (Bearer)**; OAuth 3LO (Cloud) and **DC Basic auth**
  are first-class alternatives — DC Basic auth specifically is a proven, known-good path for the target
  Enterprise Confluence. Because both deployments are in scope, the default provider is chosen **per
  connection**.
- **Secrets** go through the same keychain-backed Secret Store (PLAN §6); nothing in the repo.
- **Read access** via the official Confluence REST API (spaces, pages, labels, attachment metadata,
  CQL search). No write/delete scopes are ever requested.
- **No Git, no serialization, no merge, no write tool.** Confluence is not a managed artifact; it never
  enters the sync engine.
- The agent gets a **read/search tool** only; cross-source objectives may propose changes to SharePoint
  (the managed side), never to Confluence.

## Consequences
- Cheap to build relative to the SharePoint pillar: no sync/conflict/Git machinery — auth + read client
  + one agent tool.
- The read-only guarantee is enforced at three layers: scopes requested, absence of any write code, and
  exclusion from the sync engine.
- Supports the alignment/governance use case (compare Confluence ↔ SharePoint, report drift) without
  taking on responsibility for Confluence's content lifecycle.
