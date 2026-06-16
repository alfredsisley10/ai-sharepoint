# ADR-0041: User directory (active check + contact resolution)

- **Status:** Accepted (2026-06-16)
- **Context:** The ownership construct (ADR-0039) needs to know whether a
  contributor is an **active** user, and the cleanup workflow needs to **notify**
  the resolved owner — both keyed by AD **sAMAccountName**. That requires a
  directory lookup: sam → active? + email/UPN.

## Decision

A small, transport-agnostic `userDirectory.ts` construct:

1. **`UserRecord`** = `{ sam, active, displayName?, email?, upn? }`, with pure
   parsers from either backing directory:
   - **LDAP** — `parseLdapUser` reads `sAMAccountName`, `userAccountControl`
     (active = ACCOUNTDISABLE bit `0x2` clear), `mail`, `displayName`,
     `userPrincipalName`.
   - **Microsoft 365** — `parseGraphUser` reads `onPremisesSamAccountName`,
     `accountEnabled`, `mail`, `userPrincipalName`, `displayName`.
   Unknown account state → assume **active** (never falsely deactivate someone
   on missing data); an *unresolvable* user → **inactive** for ownership (so a
   ghost contributor never becomes the owner).
2. **`UserDirectory`** = `(sam) => Promise<UserRecord | undefined>` — injected,
   so ownership/notification don't bind to a specific directory. Helpers:
   `activeFromDirectory` (the ownership predicate) and `contactOf` (email→UPN
   for notification).
3. Concrete builders: **`m365UserDirectory`** (Graph `$filter=
   onPremisesSamAccountName eq …`, reusing the Microsoft 365 sign-in) and
   **`ldapUserDirectory`** (an injected LDAP search, so the module stays free of
   the ldap transport). `ldapUserFilter` escapes injection chars.

## Consequences

- One identity source of truth feeding **both** the ownership active-check and
  the owner notification — sam in, "active + how to reach them" out.
- Pluggable: a tenant uses LDAP or M365 (or both, with a fallback) without the
  constructs caring. Pure parsers are unit-tested; the concrete lookups reuse
  the shared `fetchJson` / ldap rails.
- This is the last missing primitive before the workflow can run end to end:
  authority sweep → owner (ownership + this directory) → notify (comms to the
  resolved email) → clean up (the owner, or the assistant via the approval-gated
  archive / remove-from-search / write). The **chat tools + participant
  orchestration** that drive that flow are the remaining wiring.
