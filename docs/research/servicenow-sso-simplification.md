# Research: SSO-based ServiceNow connection for standard users (2026-07-01)

Pilot problem: the ServiceNow connector (ADR-0028) still fails for the people we most want to
serve — **standard workforce users who have no service account, no API key, and no admin rights**,
who log into ServiceNow only through their org's SSO (Entra ID / Okta / ADFS). The four auth
paths shipped today either need an admin/service account or lean on the fragile cookie-replay
path. This report ranks every SSO-compatible strategy a VS Code extension can realistically use,
verified against ServiceNow primary documentation and the platform-security community. Five
research angles were fan-out-searched and cross-checked; citations inline.

## What we ship today, and why it misses the "standard SSO user"

| Path (`method`) | Needs | Verdict for a standard SSO user |
|---|---|---|
| **Basic** (`basic`) | username + password of an **integration/service account** | ❌ Not a standard user; usually admin-provisioned. SSO users often have **no local password at all**. |
| **OAuth bearer token** (`pat`) | user pastes an **already-minted** access token | ❌ Punts the hard part — the user has no supported way to mint one without an OAuth client. |
| **Browser OAuth PKCE** (`snow-oauth`) | admin-created **OAuth client** in Application Registry (`aiSharePoint.servicenow.oauthClientId`) | ⚠️ **Already uses SSO** (see below) but blocked behind a one-time admin registration. |
| **Cookie-session replay** (`snow-session`) | user pastes the browser `Cookie` header (+ optional `g_ck`) | ⚠️ Only true zero-admin path, but the pilot's failures live here. |

The honest framing: **two of the four paths already authenticate via the user's SSO.** The pain
isn't "we lack an SSO flow" — it's that the good SSO flow needs a one-time ServiceNow-admin
setup, and the zero-admin flow (cookie replay) is inherently brittle. This report attacks both.

## Why cookie-session replay is fragile (root cause, independent of UX)

The `snow-session` diagnostics in `servicenowAuth.ts`/`http.ts` already name these; research
confirms each is a real ServiceNow/WAF behavior, not a paste mistake:

1. **CSRF token required for API calls.** ServiceNow protects `/api/now/*` against CSRF with a
   per-session token (`g_ck`), sent as `X-UserToken`. `JSESSIONID` authenticates but is *not*
   sufficient — without `X-UserToken` many instances answer **"User Not Authenticated"** even with
   perfectly fresh cookies. `g_ck` is not a cookie; it's a page global that must be scraped from a
   signed-in tab (`DevTools → Console → g_ck`) and it **rotates with the session**. This is exactly
   the optional field the wizard asks for — but it's manual and expires.
   — [community: use X-UserToken instead of credentials](https://www.servicenow.com/community/developer-forum/use-x-usertoken-instead-of-credentials-in-rest-api-calls/m-p/1895982),
   [KB0693221 ServiceNow Cookies](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0693221)
2. **SSO/WAF front-ends drop non-browser traffic.** An SSO gateway (Entra/Okta/F5) or WAF in front
   of the instance intercepts the API call and 302s it to a login page, or blocks non-browser
   User-Agents outright — which is why *freshly captured* cookies fail within seconds. Our
   browser-compatible `User-Agent` and full-`Cookie`-header capture (incl. `BIGipServer*`) mitigate
   but cannot guarantee it.
3. **Short, opaque session lifetime.** The GUI session is tuned for interactive use and can expire
   or be invalidated well before the user expects; there is no refresh token, so every expiry is a
   full manual re-capture.

Conclusion: cookie replay can be *hardened* (below) but will never be as durable as a real token
flow. It should remain the last-resort zero-admin path, not the default we push standard users to.

## The strategic insight this codebase uniquely enables

This is **`ai-sharepoint`** — it already owns a **Microsoft Entra ID (Azure AD) identity via MSAL**
for SharePoint/Graph. If the org uses **Entra ID as the SSO IdP for ServiceNow too** (the single
most common enterprise topology, and the modal case for our users), then ServiceNow's
**third-party OIDC inbound authentication** lets us present an **Entra-issued JWT the extension can
already obtain silently** — no ServiceNow service account, no per-user OAuth client, tokens that
**auto-refresh through MSAL**, and real per-user ACLs. That reuse is the highest-leverage move
available to us and is not obvious from the ServiceNow docs alone.

## Options evaluated (verified)

| Option | Verdict | Key facts |
|---|---|---|
| **Third-party OIDC inbound / Federated Token Auth** | ✅ **best fit for Entra/Okta shops** | ServiceNow trusts JWT ID tokens from a registered external IdP, maps a token claim (e.g. `preferred_username`/`upn`) to a `sys_user`, and applies that user's ACLs. Client just sends `Authorization: Bearer <idp-token>`. **One-time** admin step (register an OIDC provider in Application Registry), then **every** SSO user works with **no** ServiceNow credential. — [ServiceNow: Federated Token Authentication (inbound)](https://www.servicenow.com/community/platform-privacy-security-blog/federated-token-authentication-for-servicenow-api-access-inbound/ba-p/3367827), [docs: Configure an OIDC provider to accept third-party tokens](https://www.servicenow.com/docs/r/washingtondc/platform-security/authentication/add-OIDC-entity.html), [KB0720547](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0720547) |
| **OAuth Authorization-Code + PKCE (already shipped)** | ✅ keep, lower the barrier | `oauth_auth.do` **already delegates login to the org SSO** — the standard user signs in with SSO in the browser and we exchange the code for tokens over the loopback. The *only* friction is the one-time admin OAuth client (Application Registry, redirect `http://localhost:51725/callback`). No global/default client with an arbitrary redirect exists, so this admin step is unavoidable for OAuth. — [community: OAuth 2.0 auth-code for REST](https://www.servicenow.com/community/developer-forum/oauth-2-0-setup-for-authorization-code-for-rest-api-call/td-p/3549667), [KB0778194: instance as OAuth client](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0778194) |
| **OAuth SAML 2.0 bearer assertion** | ⚠️ niche (SAML-only shops) | For orgs on SAML (not OIDC), a user's SAML assertion can be exchanged for a ServiceNow token via `grant_type=urn:ietf:params:oauth:grant-type:saml2-bearer`. Problem: **programmatically obtaining the raw SAML assertion** from a browser SSO flow is hard from a VS Code extension, and it still needs an OAuth client. Lower priority than OIDC. — [community: OAuth 2.0 SAML bearer assertion](https://www.servicenow.com/community/developer-forum/oauth-2-0-saml-bearer-assertion-flow/m-p/1405054), [IETF draft-ietf-oauth-saml2-bearer](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-saml2-bearer-23) |
| **Harden cookie + `g_ck` replay** | ✅ keep as zero-admin fallback | Only path needing **zero** ServiceNow-side setup. Make it durable: auto-scrape `g_ck`, verify cookie completeness, and (below) capture via an embedded auth window instead of manual paste. — [jessems: session-token auth](https://jessems.com/posts/2023-08-25-authenticating-against-the-servicenow-api-with-session-tokens/) |
| **Embedded SSO capture (VS Code webview / loopback)** | ✅ UX multiplier for the two paths above | Instead of asking the user to paste cookies or `g_ck`, host the instance login in a VS Code **Webview**/external browser, let them complete SSO, then harvest the session (cookies + `g_ck`) or drive the PKCE code exchange automatically. Removes the #1 source of paste errors. |
| **Password / Basic auth for SSO users** | ❌ dead end | SSO-only users frequently have **no local ServiceNow password**; even where they do, Basic bypasses SSO/MFA policy and is being deprecated by many orgs. Not a standard-user path. |
| **Client-credentials / JWT service account** | ❌ not a "standard user" path | Authenticates as a *service account*, not the human — no per-user ACLs, needs admin provisioning. Out of scope for this request. |

### Recommended primary: Third-party OIDC inbound, reusing the Entra token

Why it wins for our users:

- **Standard user, real ACLs.** ServiceNow maps the JWT's user claim to the matching `sys_user`
  and enforces *that person's* roles/ACLs — exactly the "can see what I can already see" posture we
  hold for SharePoint (ADR-0046). No service account, no elevation.
- **We already have the token.** For Entra-IdP orgs, MSAL in this extension can silently acquire an
  ID/access token for an audience ServiceNow trusts (`aud` = the App Registration's Application ID
  URI, e.g. `api://<client-id>`). No new interactive step, and **MSAL refreshes it automatically** —
  no expiry re-capture, unlike cookies.
- **One-time, org-wide admin setup** (not per user): register the OIDC provider in Application
  Registry (template picker includes Azure AD/Okta/Google/Auth0/ADFS), set the User Claim → User
  Field mapping, and optionally scope it with a REST API Access Policy.
  — [docs: add-OIDC-entity](https://www.servicenow.com/docs/r/washingtondc/platform-security/authentication/add-OIDC-entity.html)

Known caveats to design around:

- **Audience/JWKS correctness.** The token's `aud` must equal the value registered in ServiceNow,
  and ServiceNow must be able to reach the IdP's JWKS. The common failure ("Key ID not found in
  JWKS" / "User Authentication Error") is a misconfigured `aud`/claim, not a code bug — surface it
  explicitly. — [community: AAD JWT not accepted / JWKS](https://www.servicenow.com/community/now-assist-forum/azure-ad-jwt-token-not-accepted-by-servicenow-mcp-server-quot/m-p/3523389), [KB0719167](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0719167)
- **User-claim match.** The claim we send (e.g. `upn`/`email`) must match the ServiceNow `user_name`
  (or whichever field the admin maps). Mirrors the SAML SSO mapping requirement.
- **Not universal.** Orgs whose ServiceNow SSO is SAML-only, or that won't register an OIDC
  provider, fall back to PKCE (still one-time admin) or hardened cookie replay (zero admin).

### The OAuth PKCE path, in detail (already shipped — make it turnkey)

`snow-oauth` already does the right thing: `buildSnowAuthUrl` → `oauth_auth.do`, which on an
SSO instance **redirects the user to their IdP**, so the human authenticates with SSO and we never
see a password. The gap is purely operational:

- Ship a **copy-paste admin recipe** (Application Registry → New → OAuth API endpoint for external
  clients; redirect `http://localhost:51725/callback`; PKCE/public client so **no client secret**).
  A public+PKCE client means the "client secret" prompt can default to empty.
- Because the client is *public*, one registration can be **shared org-wide** (the `oauthClientId`
  setting), so the admin touches ServiceNow once and every user signs in with their own SSO.
- Prefer this over cookie replay wherever an admin will do the one-time step; it yields refresh
  tokens (already handled by `refreshSnowTokens`) and avoids the CSRF/WAF fragility entirely.

### Hardening cookie replay (zero-admin fallback), concretely

Keep it, but shrink its failure surface:

1. **Eliminate the manual `g_ck` step.** Capture it programmatically at session-harvest time (it's
   exposed as the `g_ck` page global / via the `sn_devstudio_/v1/get_publish_info` processor) so the
   `X-UserToken` is always present and correct. Today it's an optional manual paste that users skip
   and then hit "User Not Authenticated."
   — [community: X-UserToken](https://www.servicenow.com/community/developer-forum/use-x-usertoken-instead-of-credentials-in-rest-api-calls/m-p/1895982)
2. **Session keep-alive.** A lightweight periodic read to keep the GUI session warm, with a clear
   "session expired — re-capture" prompt when it lapses (no refresh token exists).
3. **Completeness gate before verify.** We already warn on missing `JSESSIONID`/`glide_*`; extend to
   detect an off-host redirect during verify and label it "SSO gateway intercepted" precisely.

### Embedded SSO capture — the UX lever for both fallback and PKCE

The paste step is where standard users fail. Two supported ways to remove it:

- **PKCE loopback (already built):** we open the browser, the user does SSO, ServiceNow redirects to
  `localhost:51725/callback`, we exchange the code — **no paste at all.** This already exists; the
  only blocker is the OAuth client. This is the strongest argument for investing in the one-time
  admin registration.
- **Webview cookie/`g_ck` harvest:** host the instance login in a VS Code Webview (or Simple
  Browser), let the user complete SSO, then read the session cookies + `g_ck` directly instead of
  asking for a paste. Turns the zero-admin path from "open DevTools, copy the Cookie header, then
  find `g_ck` in the console" into "sign in, done."

## Recommendation matrix (by org SSO topology)

| Org topology | Primary | Fallback |
|---|---|---|
| **ServiceNow SSO = Entra ID** (our modal user) | **Third-party OIDC inbound, reuse MSAL Entra token** | PKCE (one-time OAuth client) → hardened cookie replay |
| **ServiceNow SSO = Okta / other OIDC** | **Third-party OIDC inbound** (interactive OIDC token) | PKCE → cookie replay |
| **ServiceNow SSO = SAML-only** | **PKCE auth-code** (delegates to SAML SSO in browser) | SAML bearer assertion (if an OAuth client exists) → cookie replay |
| **No admin will touch ServiceNow at all** | **Hardened cookie + auto-`g_ck` replay** via embedded capture | — |

## Suggested implementation increment (smallest first)

1. **Auto-capture `g_ck`** in the session path and always send `X-UserToken` — removes the most
   common "fresh cookies still rejected" failure with no admin dependency. (Hardens what we ship.)
2. **Ship the admin one-liner + settings** for the PKCE OAuth client so the already-built
   `snow-oauth` path is turnkey; default the client-secret prompt to empty (public+PKCE).
3. **Add `snow-oidc`**: accept an org OIDC/Entra token (reuse the MSAL token when the IdP matches)
   and send it as `Authorization: Bearer` to `/api/now/*`; add an ADR amendment. This is the
   durable, refresh-free-of-charge, real-ACL path and the strategic end state.
4. **Optional:** embedded Webview capture to delete the manual paste from the cookie path.

## Update (2026-07-01): complete inbound-auth catalog + two new testable methods shipped

Follow-up research enumerated **every** ServiceNow REST inbound authentication mechanism, so nothing
is left unexplored, and two of the previously-recommended options were shipped for the pilot to test
against a live instance.

### The full ServiceNow inbound-auth catalog (what the platform accepts on `/api/now/*`)

| Mechanism | In this extension | Fit for a "standard SSO user, no service account" |
|---|---|---|
| **Basic** (user + password) | ✅ `basic` | ❌ needs a password/service account; SSO-only users often have none |
| **OAuth — authorization code (PKCE)** | ✅ `snow-oauth` | ✅ delegates to SSO in the browser; needs a one-time admin OAuth client |
| **OAuth — client credentials** | — | ❌ authenticates as an app, not the human (no per-user ACLs) |
| **OAuth — ROPC (password grant)** | — | ❌ needs an OAuth client AND the user's password; bypasses SSO |
| **OAuth — JWT bearer grant** | — | ❌ service-to-service; needs a shared key/cert + OAuth client |
| **OAuth — SAML 2.0 bearer assertion** | — (documented) | ⚠️ SAML-only orgs; hard to harvest the assertion from an extension |
| **Third-party OIDC / JWT ID token** | ✅ **`snow-oidc` (new)** | ✅ reuse the org IdP (Entra/Okta) token; one-time admin OIDC registration |
| **Inbound REST API Key (`x-sn-apikey`)** | ✅ **`snow-apikey` (new)** | ✅ admin-issued key tied to a user (ACLs apply); no OAuth client/password/expiry |
| **HMAC token** | — | ❌ request-signing; heavy, integration-oriented |
| **Mutual TLS (client certificate)** | — | ❌ needs a provisioned client cert + instance mTLS config |
| **Browser session cookies + `g_ck`** | ✅ `snow-session` | ⚠️ zero-admin but fragile (CSRF token, WAF, short session) |

Sources: [REST API auth requirements KB0793963](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0793963),
[API Key & HMAC for REST APIs (Xanadu docs)](https://www.servicenow.com/docs/bundle/xanadu-platform-security/page/integrate/authentication/concept/api-key-and-hmac-rest-apis.html),
[Inbound REST API Keys (dev blog)](https://www.servicenow.com/community/developer-advocate-blog/inbound-rest-api-keys/ba-p/2854924),
[Configure an API key (Zurich docs)](https://www.servicenow.com/docs/bundle/zurich-platform-security/page/integrate/authentication/task/configure-api-key.html).

### Shipped this increment — two live-testable methods (neither needs a password or service account)

1. **`snow-apikey` — Inbound REST API Key** (`x-sn-apikey` header). An admin creates a REST API Key
   under *System Web Services → API Access Policies → REST API Key*, associates it with a user (so
   **that user's ACLs apply**), and adds an Inbound Authentication Profile that reads the
   `x-sn-apikey` header. The user pastes the key; the extension sends it in that header. No OAuth
   client, no password, no token expiry — the simplest thing that can work against a locked-down
   instance, and the fastest to try live.
2. **`snow-oidc` — third-party OIDC / SSO token** (`Authorization: Bearer <IdP JWT>`). The user pastes
   an ID/access token from their identity provider (Entra ID, Okta, …); the instance validates it
   against a **registered OIDC provider** and maps a token claim to a ServiceNow user. This is the
   strategic SSO path — the user authenticates with the org IdP they already use, no ServiceNow
   credential at all. The extension decodes the token's `exp` to fail fast on an expired paste and
   gives audience/JWKS/user-claim-specific guidance on a 401.

Both route through the shared `fetchJson`, so the ADR-0009 lockout breaker, caps/caching, and
secret-masked wire logging apply unchanged; the key/token lives only in the OS keychain.

### Still recommended next (not yet shipped)

- **Reuse the extension's Microsoft (Entra) token for `snow-oidc`.** Today the OIDC token is pasted;
  the durable end state is to acquire it silently through the existing MSAL/`aad-sso` machinery for a
  configurable ServiceNow audience (`aud` = the app registration's Application ID URI), so it
  auto-refreshes and needs no paste. Requires a settings-driven resource/scope and provider plumbing.
- **Auto-capture `g_ck`** in the cookie path, and **the turnkey PKCE admin recipe** (from the
  original increment list) remain open.

## Open questions for the pilot org

- Is ServiceNow's SSO IdP **Entra ID** (lets us reuse the extension's existing token) or SAML/Okta?
- Will an admin do a **one-time** Application Registry registration (OIDC provider *or* public PKCE
  OAuth client)? If yes, we skip the fragile cookie path entirely.
- What user claim does their ServiceNow map identities on (`user_name` = `upn`/`email`)? Needed for
  the OIDC claim mapping.

---

Sources (primary/authoritative):
- [ServiceNow — Federated Token Authentication for API access (inbound)](https://www.servicenow.com/community/platform-privacy-security-blog/federated-token-authentication-for-servicenow-api-access-inbound/ba-p/3367827)
- [ServiceNow Docs — Configure an OAuth OIDC provider for accepting third-party token](https://www.servicenow.com/docs/r/washingtondc/platform-security/authentication/add-OIDC-entity.html)
- [ServiceNow Docs — OIDC as an SSO identity provider (overview)](https://www.servicenow.com/docs/r/platform-security/authentication/OIDC-SSO-overview.html)
- [ServiceNow KB0720547 — Configure external ID token authentication (OIDC) for REST APIs](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0720547)
- [ServiceNow KB0719167 — User Authentication Error with third-party OIDC token](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0719167)
- [ServiceNow KB0778194 — Set up your instance as an OAuth client](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0778194)
- [ServiceNow KB0693221 — ServiceNow Cookies](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0693221)
- [ServiceNow community — X-UserToken (g_ck) for REST calls](https://www.servicenow.com/community/developer-forum/use-x-usertoken-instead-of-credentials-in-rest-api-calls/m-p/1895982)
- [ServiceNow community — OAuth 2.0 auth-code for REST API](https://www.servicenow.com/community/developer-forum/oauth-2-0-setup-for-authorization-code-for-rest-api-call/td-p/3549667)
- [ServiceNow community — OAuth 2.0 SAML bearer assertion flow](https://www.servicenow.com/community/developer-forum/oauth-2-0-saml-bearer-assertion-flow/m-p/1405054)
- [ServiceNow community — Azure AD JWT not accepted (JWKS)](https://www.servicenow.com/community/now-assist-forum/azure-ad-jwt-token-not-accepted-by-servicenow-mcp-server-quot/m-p/3523389)
- [jessems — Authenticating against the ServiceNow API with session tokens](https://jessems.com/posts/2023-08-25-authenticating-against-the-servicenow-api-with-session-tokens/)
- [IETF draft-ietf-oauth-saml2-bearer — SAML 2.0 profile for OAuth 2.0](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-saml2-bearer-23)
