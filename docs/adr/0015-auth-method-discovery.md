# ADR-0015 — Authentication-method discovery and workspace persistence

- Status: Accepted
- Date: 2026-06-10
- Resolves: Decision K

## Context
Each source ships **all** of its platform's auth methods (ADR-0008, ADR-0014), but which one a given
user can actually use depends on their environment and entitlements — and we explicitly do **not**
assume a sandbox to test against (Decision E / ADR-0009). Asking users to hand-pick the right method
per source is error-prone and doesn't transfer between teammates.

## Decision
Add **auth-method discovery**: at connect time the framework probes the source's supported methods,
finds the one that works for this user, and **persists the working method** as a **non-secret
descriptor** in the workspace config (PLAN §10) so it is pre-selected on every later use and for anyone
who imports the workspace.

- **Discovery = the verify-on-connect probe (ADR-0009).** It tries methods and records the first that
  succeeds; on success it stops.
- **Lockout-safe ordering is mandatory.** Probe **no-password-risk methods first** — interactive
  browser / SSO / device-code / token paths that don't burn password attempts — before any method that
  submits a user-entered password (Basic). For credential-based methods, **prompt once and try once**;
  **never loop the same credential**. The per-account failure tracking, backoff, and hard stop
  (ADR-0009) bound the whole process, so discovery can never march an account toward lockout.
- **Persist the method, never the secret.** What's saved is the working method's id/descriptor (e.g.
  `confluence-dc-basic`, `splunk-token`, `mssql-sql-auth`) — credentials stay in the keychain (§6). The
  descriptor travels in workspace **export/import**: a teammate importing the workspace gets the
  known-good method **pre-selected**, supplies **their own** credential, and re-verifies on connect.
- **Re-discovery** can be triggered manually or automatically when a previously-working method starts
  failing (e.g. an org disables Basic), re-probing from the safe order.

## Consequences
- **Decision K is resolved** by a capability, not a manual per-source matrix: the system finds what
  works and remembers it.
- Workspaces become a shareable record of known-good methods per source, accelerating teammates while
  keeping every user on their own least-privilege credential.
- The lockout-safe ordering is load-bearing: discovery MUST front-load no-password methods and cap
  password attempts, or it could itself cause the lockouts ADR-0009 exists to prevent.
