# ADR-0037: Configurable write-back permission — Sites.Selected (least privilege)

- **Status:** Accepted (2026-06-15)
- **Context:** The managed write-back (ADR-0021) requests delegated
  `Sites.ReadWrite.All` + `Sites.Manage.All`. These are **tenant-wide** (the app
  can write to *every* site the user can reach), and `Sites.Manage.All` is
  especially sensitive — so enterprise admins routinely **refuse** the consent.
  A pilot hit exactly this: the first apply popped an admin-approval prompt that
  is unlikely to be granted, blocking write-back entirely.

## Decision

1. **Make the requested write scope a setting**,
   `aiSharePoint.sync.writePermissionMode`, default **`selected`**:
   - **`selected`** → request **`Sites.Selected`**. The app gets **no** site
     access until an admin grants it a **specific site** with a `write`/`manage`
     role (`Grant-PnPAzureADAppSitePermission`, or `POST /sites/{id}/permissions`).
     Far more likely to be approved — the ask becomes "write to *only this site*,
     nothing else" — and a per-site `manage` grant covers both pages
     (`write`) and list/column schema (`manage`).
   - **`all`** → the previous tenant-wide `Sites.ReadWrite.All` +
     `Sites.Manage.All` (kept for tenants that prefer it).
2. **Scope selection lives in the write client only** (`SharePointWriteClient`,
   constructed with the mode), never on read paths — consent stays incremental.
   `writeScopesFor(mode)` is a pure, unit-tested mapping.
3. **A Sites.Selected 403 explains the fix.** When `selected` is active and a
   write returns 403 (the app hasn't been granted *this* site), the error
   carries the remediation — the exact `Grant-PnPAzureADAppSitePermission` /
   `/sites/{id}/permissions` step, and the `"all"` fallback — instead of a bare
   "forbidden".

## Consequences

- **Default flips to least privilege.** Existing managed users who relied on the
  broad scopes must either have an admin run the one-time per-site grant, or set
  `writePermissionMode: "all"` to restore the old behavior. The 403 message makes
  this self-explanatory, and the change is the right security posture (and the
  only one many tenants will approve).
- Pairs naturally with a **custom app registration** (`aiSharePoint.auth.clientId`):
  the admin consents `Sites.Selected` once (it grants nothing on its own) and
  grants the pilot site — a clean, auditable, least-privilege deployment.
- Reads are unchanged (`Sites.Read.All`). The zero-consent fallback (pull →
  author-as-files → a site owner applies the plan) remains available when even
  Sites.Selected can't be arranged.
