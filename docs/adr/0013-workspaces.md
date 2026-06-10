# ADR-0013 — Workspaces: scoped, shareable profiles with secret-free export/import

- Status: Accepted
- Date: 2026-06-10

## Context
The extension supports many parallel work efforts, each with its own set of read-only reference sources
(§9), bookmarks (ADR-0010), and localization. Users need to switch between efforts cleanly and to
**share a setup with teammates** — without ever sharing secrets, since repos and shared files may be
public.

## Decision
Introduce **workspaces**: named profiles that scope reference sources, bookmarks, and localization,
with **secret-free export and import**.

- **A workspace holds non-secret config only:** source descriptors (type, base URL/host, chosen auth
  *method*, scopes, role), bookmarks (locators), localization (locale, formats, time zone, units), and
  optional per-workspace settings. **Credentials are never part of a workspace** — they stay in the
  keychain (§6), referenced only by handle.
- **Local switching:** an active-workspace selector swaps the visible sources/bookmarks/localization;
  multiple workspaces persist locally.
- **Export is secret-free by construction:** the exporter reads only the non-secret config store and
  has **no code path to the keychain**, so no token/password/cache/API key can be emitted; a
  **pre-export scan** asserts the artifact is clean (defense in depth with §6 scanning).
- **Import reconstitutes a shared workspace:** importing an exported definition pre-populates its
  sources, bookmarks, and localization, then **prompts the recipient for their own credentials** (stored
  in their own keychain), running a connection test per source. Import validates schema/version and
  flags anything that can't be resolved in the recipient's environment.

## Consequences
- Teams can standardize and share reference setups (e.g. "the Product-Management workspace") safely,
  because exports carry locators and descriptors, never secrets.
- Each importer supplies their own least-privilege credentials, preserving per-user access control.
- Workspace files are safe to commit/share even in a public repo, though we still recommend treating
  them as internal config.
- Requires a small versioned schema for export/import compatibility as adapters evolve.
