# ADR-0014 — Prefer standard-user authentication over privileged API integrations

- Status: Accepted
- Date: 2026-06-10

## Context
Many users of this extension will have only **standard user access** to the reference systems (§9) —
not the ability to register an Entra ID app, create a service account, mint an API client/secret, or be
granted managed identity. Requiring formal API integrations would put most read-only context sources
out of reach. But those same users *can* log in as themselves: through a browser SSO/OAuth prompt, or
with a username and password.

This is the same principle already chosen for SharePoint in §5: MSAL interactive against the Microsoft
Graph PowerShell **first-party app** needs no app registration — the user just authenticates as
themselves and we cache the token.

## Decision
Every adapter **prioritizes auth methods a standard user already has**, and treats privileged API
integrations as optional:

- **Interactive browser login with token caching** — drive a documented OAuth / SSO browser flow
  (including the §5 MSAL first-party-app pattern, OAuth 3LO, device code, or a source's session-login
  endpoint), then cache the resulting token/session in the keychain (§6) and refresh silently where
  possible.
- **Basic auth (username/password)** — first-class where the platform supports it (e.g. Confluence/Jira
  DC, SQL Server, Grafana, AppDynamics, Splunk session login).
- **Privileged methods** (app registration, service principal, API client/secret, managed identity)
  remain **available but not required**; the adapter's *default* is the most-accessible working method,
  not the most "official" one.
- We stay within each platform's **documented** flows — no scraping or cookie exfiltration; "cache a
  browser token" means capturing the token a legitimate OAuth/SSO/login flow returns.

These standard-user paths (especially Basic) are exactly the ones most prone to account lockout, so they
are always paired with ADR-0009's verify-on-connect + failed-login tracking + backoff.

## Consequences
- The extension is usable by normal users without IT provisioning — the common case, not the exception.
- "Recommended" in the §9.2 matrix means most-robust; the runtime default is most-accessible. The two
  can differ per source.
- Token-cache flows depend on the source offering a real interactive flow; where it only offers Basic,
  Basic is the path — making lockout safety (ADR-0009) load-bearing.
- Which standard-user method actually works per source is **discovered at runtime** and persisted
  (ADR-0015), not confirmed up front — since no sandbox is assumed (Decision E).
