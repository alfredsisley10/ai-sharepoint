# ADR-0022 — Database context adapters: read-only by layered construction

- Status: Accepted
- Date: 2026-06-11
- Realizes PLAN §9.2 database rows (SQL Server, PostgreSQL, MySQL, MongoDB)

## Context
Pilot direction: extend the reference-source matrix with the database wave. Databases are the
highest-blast-radius read sources in the plan — a careless query can lock production tables or
mutate data — and the §9.2 matrix prescribes per-engine read-safety (MSSQL `NOLOCK`/
`READ UNCOMMITTED`/`ApplicationIntent=ReadOnly`, MVCC read-only sessions elsewhere, caps,
timeouts). Oracle was listed in the plan but its driver (`node-oracledb`) requires native
binaries — irreconcilable with the one-VSIX-everywhere rule (ADR-0016) — so it is **excluded**
until a pure-JS path exists.

## Decision
Four adapters behind the existing framework (lockout breaker, TTL cache, caps, keychain
credentials, view/tools/export), drivers all pure-JS (`tedious`, `pg`, `mysql2`, `mongodb`;
their optional native probes are esbuild-externalized and never installed):

1. **Read-only by layered construction.**
   - A strict **SQL guard** (comments/strings/bracket-identifiers stripped; single statement;
     must start `SELECT`/`WITH`; INSERT/UPDATE/DELETE/MERGE/DDL/EXEC/`SELECT INTO`/`WAITFOR`/
     `sp_`/`xp_` blocked at word boundaries) runs before every SQL statement. **For SQL Server
     this validator IS the write-guard** — T-SQL has no read-only session switch — so it fails
     closed and is adversarially unit-tested.
   - Server-side enforcement where the engine offers it: PostgreSQL
     `default_transaction_read_only=on` + `statement_timeout`; MySQL
     `SESSION TRANSACTION READ ONLY` + `max_execution_time`; MSSQL
     `READ UNCOMMITTED` (reads never block writers) + `readOnlyIntent` (AG replica routing);
     MongoDB `readPreference=secondaryPreferred` + `maxTimeMS`, reads restricted to
     `find` via a JSON spec (`{collection, filter, projection, limit}`).
   - **Client-side row caps** (`context.maxResults`) and connect/request timeouts everywhere.
     We deliberately do not rewrite user SQL to inject TOP/LIMIT — wrapping arbitrary
     statements is fragile; the cap bounds result size and the browse-generated sample queries
     include TOP/LIMIT.
2. **Least privilege encouraged, not assumed** (ADR-0014): the credential prompt recommends a
   read-only account; the standard-user path works regardless. Auth rejections (ELOGIN, 28P01,
   ER_ACCESS_DENIED 1045, Mongo code 18/SCRAM) classify `auth.failed` and feed the ADR-0009
   breaker.
3. **TLS** trusts the OS store / pinned PEM exactly like LDAP (raw sockets bypass VS Code's
   fetch): `loadTrustedCAs` feeds tedious `cryptoCredentialsDetails`, pg/mysql2 `ssl.ca`, and
   the Mongo client; the shared pinned bundle is `aiSharePoint.ldap.caCertificatesFile`
   (documented as applying to all non-HTTP sources). `mongodb+srv://` URLs give Mongo the same
   durable DNS-locator property as our LDAP sources.
4. **Connection descriptors** are URLs (`mssql://host:1433/db`, `postgresql://…`, `mysql://…`,
   `mongodb(+srv)://…/db`) — non-secret, exportable in reference configs; credentials stay in
   the keychain.
5. **Browse & Bookmark** lists tables (INFORMATION_SCHEMA) / collections and generates capped
   sample-row queries, so the guided bookmark flow works for databases too. `getItem` is
   unsupported by design (no stable item identity) with guidance toward search.

## Consequences
- The §9.2 database row ships minus Oracle (explicitly excluded, revisit on a pure-JS driver).
- Bundle grows ~250 KB; native gate stays green (101 pure-JS packages).
- The SQL guard is conservative: legitimate exotic read syntax (e.g. `EXEC` of a read-only
  proc) is rejected — accepted trade-off; the error explains the policy.
- Live validation against real engines remains a pilot task (same posture as every adapter);
  the guard, mappers, and spec parser are fully unit-tested.

## Amendment — 2026-06-11 (pilot feedback)
SQL Server connections gained SSMS parity: **dual authentication** — SQL Server Authentication
and Windows Authentication via tedious's pure-JS **NTLM** (`DOMAIN\\user`/UPN + password;
Windows-shaped accounts under SQL auth are safely inferred to NTLM since SQL logins cannot
contain `\\`; passwordless SSPI/Kerberos stays excluded per ADR-0016) — **named instances**
(`?instance=NAME`, port resolved via SQL Browser, mutually exclusive with an explicit port),
and an explicit per-source **`?trustServerCertificate=true`** opt-in (the SSMS checkbox) for
self-signed or FQDN-mismatched certificates, surfaced as a wizard step. ELOGIN mapping now
preserves the server's reason and distinguishes "cannot open database" (config) from credential
rejection (lockout-counting), with SSMS-versus-connector triage in the advice. Separately, all
wizard dialogs set `ignoreFocusOut` so copy/paste from other applications no longer dismisses
the flow.
