# ADR-0002 — Use PnPjs in-process for SharePoint operations

- Status: Accepted
- Date: 2026-06-10

## Context
The extension must read site structure/content and provision/modify artifacts (lists, content types,
site columns, navigation, theme, modern pages). Two realistic engines:

1. **PnPjs** (`@pnp/sp`, `@pnp/graph`) — TypeScript libraries running inside the extension process.
2. **PnP PowerShell** — a more mature provisioning engine, but requires PowerShell and the
   `PnP.PowerShell` module installed on every host, invoked via child process.

## Decision
Use **PnPjs in-process** as the single engine. No PowerShell dependency on the host.

## Consequences
- Clean install/packaging; no external runtime prerequisites; one language across the codebase.
- Authentication integrates directly: PnPjs is configured with bearer tokens from the MSAL provider
  (ADR not yet written — auth provider abstraction in PLAN §5).
- Risk: a small number of provisioning operations may round-trip less cleanly than PnP PowerShell. If
  one proves un-round-trippable, we revisit an **optional, isolated** PnP-PowerShell bridge for just
  that operation — not as the default path. This is a deferred, contained fallback, not a commitment.
- Serialization (PLAN §7) is built on PnP provisioning templates plus per-page web-part JSON, all
  produced/consumed via PnPjs.
