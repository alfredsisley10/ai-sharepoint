# ADR-0008 — Read-only context sources as a pluggable adapter framework

- Status: Accepted
- Date: 2026-06-10

## Context
The read-only context need grew from two sources (reference SharePoint, Confluence) to seven, adding
**Jira** (Cloud/DC), **Splunk Cloud**, **Microsoft Intune**, **Azure Databricks**, and **Microsoft SQL
Server**. Each must support all of its platform's auth methods and is strictly read-only. Implementing
each as a bespoke integration would duplicate auth, failure-handling, caching, and safety logic.

## Decision
Build a **context-source framework**: source-specific **adapters** plug into one set of shared services.

- One `ContextSourceAuthProvider` contract; each adapter ships every auth method its platform supports
  (see PLAN §9.2 matrix). Microsoft sources (reference SharePoint, Intune, AAD-auth'd Databricks/Azure
  SQL) reuse the §5 MSAL stack; Atlassian sources (Confluence, Jira) share Atlassian providers.
- Shared services every adapter inherits: lockout-safe auth-failure handling (ADR-0009), bookmarks
  (ADR-0010), TTL caching (ADR-0011), read-safe query policy (ADR-0012), the connection `role` guard
  (ADR-0007), and one Reference Sources view + agent read tool.
- Read-only is structural: reference connections are rejected by the sync/Git subsystems and adapters
  expose no write path.

## Consequences
- Adding a future source = writing one adapter (auth methods + read/query + read-safety rules); all
  cross-cutting behavior comes for free.
- Uniform agent surface: the agent reads any source — and any saved bookmark — through one tool.
- Phasing: framework + first adapters (reference SharePoint, Confluence, Jira) land in Phase 4;
  Splunk/Intune/Databricks/SQL Server follow in Phase 6.
