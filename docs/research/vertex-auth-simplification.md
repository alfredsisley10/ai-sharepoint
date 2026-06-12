# Research: simpler Vertex AI Search auth for normal end users (2026-06-12)

Pilot problem: the Vertex AI Search connector keeps failing and the setup (gcloud CLI or a
pasted ~1 h OAuth token) is beyond most users. This report ranks what a VS Code extension can
realistically offer **normal workforce users** (no admin rights, no gcloud, no Console
knowledge), verified against primary Google documentation. Five research angles were
fan-out-searched and adversarially cross-checked; citations inline.

## Why connections fail today (independent of UX)

1. **Quota project missing.** Calling `discoveryengine.googleapis.com` with *end-user*
   credentials requires a quota project; without it Google answers 403 even when the user has
   the right role. The fix is the `x-goog-user-project` header, and the caller needs
   `serviceusage.services.use` (role `roles/serviceusage.serviceUsageConsumer`) on that
   project. *Shipped in 0.24.1: the extension now sends the app's own project automatically.*
   — [cloud.google.com/docs/authentication/rest](https://cloud.google.com/docs/authentication/rest),
   [troubleshoot-adc](https://cloud.google.com/docs/authentication/troubleshoot-adc)
2. **Missing IAM role.** Direct `servingConfigs:search/:answer` needs
   `discoveryengine.servingConfigs.search/answer`, least-privilege via
   **`roles/discoveryengine.viewer` granted at the project** — users who only ever used the
   hosted web app may not have it.
   — [generative-ai-app-builder/docs/access-control](https://cloud.google.com/generative-ai-app-builder/docs/access-control)
3. Other documented 403s: Discovery Engine API not enabled; wrong
   project/location/engine path (same "Permission denied on resource" text); VPC-SC
   perimeters. *0.24.1 now triages all of these into actionable messages.*

## Options evaluated (verified)

| Option | Verdict | Key facts |
|---|---|---|
| **Google device-code flow** | ❌ impossible | Allowed scopes are ONLY openid/email/profile, drive.appdata, drive.file, youtube, youtube.readonly — `cloud-platform` is not permitted ([limited-input-device#allowedscopes](https://developers.google.com/identity/protocols/oauth2/limited-input-device#allowedscopes)) |
| **API keys** | ❌ for enterprise corpora | `:search` rejects API keys ("API keys are not supported… expects OAuth2"); only `:searchLite` takes keys and **only for public-website data stores**; `:answer` has no key variant ([authentication](https://cloud.google.com/generative-ai-app-builder/docs/authentication), [searchLite](https://cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.collections.engines.servingConfigs/searchLite)) |
| **Browser-session/cookie reuse** | ❌ unsupported | "With the exception of API keys, Google APIs do not support credentials directly" — cookies are not API credentials ([docs/authentication](https://cloud.google.com/docs/authentication)) |
| **Search widget** | ❌ for native apps | Web-only: mandatory domain allowlisting (localhost "for testing"), JWT/OAuth widget modes need an org-run token backend ([add-widget](https://cloud.google.com/generative-ai-app-builder/docs/add-widget)) |
| **OAuth desktop client (PKCE + loopback)** | ✅ best fit | Loopback stays supported for desktop clients; installed-app secrets are by design non-confidential ([native-app](https://developers.google.com/identity/protocols/oauth2/native-app), [loopback-migration](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)) |
| **gcloud CLI (status quo)** | ✅ keep as fallback | Google's own recommendation for user-credential scripts; and the ONLY interactive option for **Workforce Identity Federation** orgs — WIF identities cannot use standard OAuth clients at all ([workforce-log-in-gcloud](https://cloud.google.com/iam/docs/workforce-log-in-gcloud), [workforce-obtaining-short-lived-credentials](https://cloud.google.com/iam/docs/workforce-obtaining-short-lived-credentials)) |
| **Agentspace / Gemini Enterprise web app** | ✅ but not an API path | Google's own zero-setup end-user surface ("turn on the app and share the URL"); needs the Gemini Enterprise/Agentspace user role + license; doesn't help the extension call the API ([configure-identity-provider](https://cloud.google.com/agentspace/docs/configure-identity-provider)) |

### The OAuth desktop client, in detail

- One **"Desktop app" OAuth client ID** can serve users in any org once the consent screen is
  External + **In production** ([support.google.com/cloud/answer/15549945](https://support.google.com/cloud/answer/15549945)).
- `cloud-platform` is a **sensitive** (not restricted) scope → Google verification required to
  publish; before verification: unverified-app warning + **lifetime 100-user cap**; "Testing"
  status revokes refresh tokens after 7 days
  ([sensitive-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification),
  [7454865](https://support.google.com/cloud/answer/7454865)).
- **Workspace admins can block or trust the client ID org-wide in one action** (app access
  control) ([7281227](https://support.google.com/a/answer/7281227)).
- Verified-app refresh tokens persist; orgs with **Google Cloud session control** force
  re-auth every 1–24 h (default 16 h) for ANY app using the cloud-platform scope — admins can
  exempt trusted apps ([session-controls](https://docs.cloud.google.com/access-context-manager/docs/session-controls-for-reauthentication)).
- **Two deployment flavors:**
  - **(a) Org-internal client (recommended):** the customer's admin creates ONE Desktop OAuth
    client in their own tenant ("Internal" user type → **no Google verification, no 100-user
    cap, no unverified screen**) and distributes the client ID via the existing machine-scoped
    settings pattern (like `aiSharePoint.servicenow.oauthClientId`). One-time, org-wide,
    ~10 minutes of admin work; users then get a plain "Sign in with Google" browser flow.
  - **(b) Publisher-shipped client:** zero org setup, but requires Google's sensitive-scope
    verification of the publisher app, and cautious orgs may block unknown client IDs anyway.

## Ranked recommendation

1. **Ship the 403/quota fixes (done, 0.24.1)** — they remove failures that hit *every* auth
   method and turn the rest into named, fixable asks for the app owner.
2. **Implement PKCE + loopback "Sign in with Google"** reusing the ServiceNow snow-oauth
   loopback pattern, keyed by a new machine-scoped `aiSharePoint.vertex.oauthClientId`
   (flavor *a*). Refresh token in the OS keychain → no gcloud, no hourly re-paste, ordinary
   browser SSO. If marketplace reach later justifies it, add flavor *b* behind the same code
   path.
3. **Keep gcloud-sso** as the documented path for Workforce Identity Federation orgs (no
   OAuth-client alternative exists for them) and for users who already have the CLI.
4. **Document the admin one-pager**: grant group-level `roles/discoveryengine.viewer` +
   `roles/serviceusage.serviceUsageConsumer` on the app's project, create the internal
   Desktop OAuth client, push the client ID via settings policy. For pure "just let people
   search" needs (no chat integration), point orgs at the Agentspace/Gemini Enterprise web
   app — that's Google's own normal-user surface.

Dead ends to stop considering: device-code flow (scope list excludes Cloud), API keys
(non-public corpora), widget reuse (web-only + domain allowlists), browser-cookie replay
(unsupported by design).
