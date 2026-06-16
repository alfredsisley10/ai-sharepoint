# ADR-0044: Confluence space "manageability" entitlement review

- **Status:** Accepted (2026-06-16)
- **Context:** Before driving cleanup across a space, we need to know the
  signed-in user can actually **read and write every page**. The usual reason
  they can't is **page-level restrictions** that exclude them. We want to audit
  that and prepare an access request to the space admins for the gaps.

## Decision

`confluenceEntitlements.ts`:
1. **`getPageRestrictions`** reads a page's `/restriction/byOperation`
   (read + update), parsed by the pure `parseRestrictions` into user/group sets.
2. **`assessPageAccess`** (pure) — a restriction is "active" when it lists any
   users/groups; an active restriction that doesn't explicitly list the user
   blocks them. Group membership isn't resolved, so a page restricted to a group
   the user is in is **conservatively** reported as a gap (the groups are
   included for an admin to verify).
3. **`reviewSpaceManageability`** audits every page in a space → a report of the
   pages the user can't fully manage (read+write) with what's missing and the
   restriction sets.
4. **`prepareAccessRequestNote`** (pure) turns the report into an access-request
   message for the space admins.

## Consequences

- Surfaces exactly which pages would block a cleanup pass, and produces the
  admin ask to unblock them (sent via comms, like owner notifications).
- **Conservative on groups** (read-only, no group resolution): possible
  false-positive gaps for group-granted access — flagged with the group names so
  an admin can confirm. Resolving effective group membership (LDAP/M365) is a
  future refinement.
- Pairs with ownership/currency: a manageability sweep tells you what you *can*
  fix; ownership/currency tell you what *needs* fixing.
- **Next (staged):** chat tool exposing the audit + drafting the admin request.
