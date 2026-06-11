# ADR-0020 — Read-only LDAP / Active Directory context connector with DNS auto-discovery

- Status: Accepted
- Date: 2026-06-11

## Context
Pilot request: reference Active Directory data (users, groups, OUs) as read-only context, with
**endpoint auto-discovery from the workstation** and **DNS** rather than hand-configured server
addresses. AD is the canonical standard-user, high-lockout-risk source — a perfect fit for the
§9 context framework (ADR-0009 lockout safety, ADR-0011 cache, ADR-0012 read-safety,
ADR-0014 standard-user auth).

## Decision
Ship LDAP as a new **context source type** reusing the entire framework (sources store, keychain
credentials, lockout tracker, TTL cache, Reference Sources view, agent tools). New pieces:

**1. Library: `ldapts` (pure-JS).** Verified native-free (ADR-0016 gate passes) and esbuild-
bundlable. LDAP is raw TCP/TLS (`net`/`tls`), so — unlike the HTTP adapters — it does **not**
traverse VS Code's proxy; AD DCs are reached directly on the internal network (documented).

**2. DNS-based auto-discovery (the headline).** Pure, injectable, unit-tested:
- **Workstation signals** (priority order): `USERDNSDOMAIN` (gold signal on domain-joined
  Windows), `LOGONSERVER` (the exact DC the user authenticated to), host FQDN, POSIX
  `/etc/resolv.conf` `search`/`domain`. `os.userInfo().username` + domain seed the bind UPN.
- **SRV lookups** via `node:dns` `resolveSrv`: `_ldap._tcp.dc._msdcs.<domain>` (domain
  controllers) and `_gc._tcp.<domain>` (global catalog — forest-wide reads), ranked by SRV
  priority then weight. Global Catalog is preferred for breadth (3268/3269).
- **Base DN** derived from the domain (`corp.example.com` → `DC=corp,DC=example,DC=com`).
- The user confirms/overrides discovered candidates; manual entry is always available.

**3. Auth: simple bind, standard user (ADR-0014).** UPN (`user@corp.example`), `DOMAIN\\user`,
or full DN + password, stored only in the keychain. **Lockout safety is load-bearing here**
(ADR-0009): an LDAP `invalidCredentials` (result 49) is classified as an auth failure, never
auto-retried, and trips the circuit breaker (hard stop at 3) **before** the AD account lockout
threshold. Network/connection errors never count.

**4. Read-safety (ADR-0012).** Every search carries a server-side `sizeLimit` (= the result
cap) and `timeLimit`; scope defaults to subtree but is bounded by the size cap; paging is off;
connection + operation timeouts apply; no write operation is exposed (bind + search only).
Free-text queries use AD **ANR** (`(anr=<text>)`) so "find Jane Doe" matches
cn/displayName/sAMAccountName/mail; raw LDAP filters pass through. A curated, non-sensitive
attribute set is returned by default (name, mail, title, department, telephone, memberOf…);
secrets/credentials attributes are never requested.

**5. TLS posture.** LDAPS (636/3269) or StartTLS on 389 is preferred; `ldap.tlsRejectUnauthorized`
(default **true**) and an optional StartTLS toggle are provided. Internal-CA LDAPS validation
caveats (Node's bundled CAs ≠ OS trust store) are documented for admins; a lab opt-out exists
but defaults secure.

## Consequences
- AD becomes queryable by the agent (`#spSearchContext` / `#spContextItem`) with zero
  hand-typed server addresses on a domain-joined machine.
- Adds one runtime dependency (`ldapts`), still pure-JS; the native gate keeps it honest.
- Discovery and filter/DN logic are pure and unit-tested; live bind/search needs pilot
  validation against a real DC (same posture as the Confluence/Jira adapters).
- The framework generalizes from "HTTP adapters" to "typed adapters"; future non-HTTP sources
  (databases, etc.) follow this seam.

## Amendment — 2026-06-11 (pilot feedback)

**1. Durable SRV locators instead of pinned servers.** Discovery no longer offers individual
server names as connection targets: when endpoints come from DNS SRV, the source stores the
lookup itself as the base URL — `ldaps+srv://_gc._tcp.<domain>` (Global Catalog) or
`ldaps+srv://_ldap._tcp.dc._msdcs.<domain>` (DCs) — re-resolved on **every connection** with
priority/weight ranking and bounded failover across the servers DNS returns. Connections stay
valid as domain controllers are added, renamed, or retired (the Windows DC-locator model).
Failover applies to **network errors only**: an authentication rejection never retries against
another DC (it would fail identically and multiply lockout exposure — ADR-0009). Manually
entered static `ldap(s)://host` URLs remain supported and are labeled as pinned. The durable
locator also travels in reference-config exports, so shared configs survive infrastructure
changes too.

**2. OS trust store for LDAPS.** Confirmed in pilot: raw TLS bypasses VS Code's networking and
fails against internal-CA certificates ("unable to get local issuer certificate"). LDAPS/StartTLS
contexts now build their CA set as Node's bundled roots **plus**: the OS trust store via
`tls.getCACertificates("system")` (Node ≥ 22.15, feature-detected), well-known Linux CA bundle
files, `NODE_EXTRA_CA_CERTS`, and an admin-pinned PEM bundle
(`aiSharePoint.ldap.caCertificatesFile`, machine-scoped) for runtimes without the OS-store API.
Certificate-validation failures now classify distinctly with remediation pointing at these
options. `tlsRejectUnauthorized` remains default-true.
