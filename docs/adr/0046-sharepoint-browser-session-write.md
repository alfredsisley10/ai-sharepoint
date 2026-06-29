# ADR-0046: SharePoint write via the user's own browser session (no-admin path)

- **Status:** Accepted (2026-06-27)
- **Note (numbering):** the decision shipped in `sharePointRestSession.ts` /
  `sharePointSessionStore.ts` / `sharePointSessionTools.ts` and is cited there as
  "ADR-0046"; the record file was missing and is reconstructed here from the
  shipped behavior.
- **Context:** Every OAuth path to a SharePoint **write** — Graph
  `Sites.ReadWrite.All` / `Sites.Manage.All`, the per-site `Sites.Selected`,
  even SharePoint REST `AllSites.Write` — requires **tenant-admin consent**, so a
  user's real Web-UI permissions never reach the app's token. The old
  site-owner-grantable escape hatch (Azure ACS app-only via appregnew/appinv) was
  fully retired on 2026-04-02. For organizations that will not grant app consent,
  there was no way for a user to write content they are *already* allowed to edit
  in the browser.

## Decision

1. **Replay the user's existing signed-in session.** With the user's consent, the
   extension uses their `FedAuth`/`rtFa` cookies to authenticate against the
   SharePoint REST API (`/_api/web/...`) and a form digest from
   `/_api/contextinfo` to authorize the write — the user's OWN authorized session
   is what authenticates. This is interoperability, **not** privilege escalation:
   it can do exactly what the user can already do in the Web UI, nothing more.
2. **Reuse the proven ServiceNow session pattern.** The generic cookie utilities
   (`cleanCookieString` / `cookieNames`, ADR-0028 family) are shared; a
   browser-compatible User-Agent is sent because SSO/WAF front-ends drop
   non-browser clients even with valid cookies.
3. **Cookies are secrets, in the keychain.** Session connections store the cookie
   string in the OS keychain (never settings/logs); wire logging redacts cookie
   values to names only. The module is mostly pure and unit-tested with a fetch
   mock.
4. **Still human-approved.** Writes through this path remain previewed and
   user-confirmed exactly like the Graph write-back (ADR-0021); the AI surface
   gets no unattended write capability.

## Consequences

- Users in tenants that withhold app consent can still perform SharePoint writes
  they are entitled to, without an admin grant.
- Session cookies expire; the tooling diagnoses a rejected/expired session
  (missing `FedAuth`/`rtFa`) and asks the user to re-capture, rather than failing
  opaquely.
- This is a deliberate, scoped interoperability path; it neither widens the
  user's permissions nor exposes cookies outside the keychain.
