# ADR-0009 — Lockout-safe authentication-failure handling and backoff

- Status: Accepted
- Date: 2026-06-10

## Context
Several context sources authenticate with passwords/Basic auth (SQL Server, Confluence/Jira Data
Center, Splunk). Naive retry-on-failure can repeatedly submit a wrong password and **lock out a real
account** against the org's lockout policy — a serious operational incident. Failures must be handled
deliberately, not retried blindly.

## Decision
Centralize a **lockout-safe failure handler** in the framework (ADR-0008), applied to every adapter.

- **Track failures per account/credential**, not just per request.
- **Distinguish failure classes:** authentication failures (wrong/expired secret) vs. transient errors
  (network/5xx/timeout). Only transient errors are retried, with **exponential backoff + jitter**.
- **Never auto-retry a known-bad secret.** After an auth failure we stop and require **explicit user
  re-entry** of the credential rather than re-sending the same value.
- **Hard stop below the lockout threshold:** a conservative default cap (e.g. 3 consecutive auth
  failures) with an optional per-source override to sit safely under the known org policy; a per-account
  **circuit breaker** blocks further attempts until reset.
- **Surface state clearly:** show failure counts / cooldown / "credential needs re-entry" in the
  Reference Sources view; log redacted (§6), never the secret.

## Verification model (no test environment assumed)
We do **not** assume users have non-prod instances to test auth against (Decision E): most won't, and
where they do it's a separate credential in a separate auth domain. So protection runs against the
user's real access — a single deliberate **verify-on-connect** read right after credential entry, then
**failed-login tracking throughout active use**. The backoff/circuit-breaker is the safeguard, not a
sandbox.

## Consequences
- Strongly reduces the risk of locking out reference-system accounts, using only the user's real access.
- A wrong credential fails fast and asks the user, instead of silently burning attempts.
- The threshold is a safety floor, not a UX optimization; if an org's policy is stricter, the per-source
  override must be set conservatively. Because we can't pre-test against each org's lockout policy, the
  default sits well below common thresholds.
