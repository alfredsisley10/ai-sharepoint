# ADR-0019 — Git-backed site code: local controls and governed push to GitHub.com / GitHub Enterprise Server

- Status: Accepted
- Date: 2026-06-11

## Context

Phase 2 (PLAN §7) lands the serialized site in a **local Git repository** and pushes it to a
remote that, in enterprises, is either **github.com** (often EMU) or a **corporate GitHub
Enterprise Server (GHES)** instance behind the firewall. Pilot direction: the mechanism must
ship with explicit controls and best practices for both the local repo and the push path —
site serializations can contain organizationally sensitive content, so "git push anywhere"
is not acceptable.

## Decision

**1. Git operations go through the VS Code Git extension API** (`vscode.git`, API v1) — not a
bundled git library and not direct shell-outs. Consequences we want: (a) authentication is the
user's existing git credential setup (credential manager, SSH agent, enterprise SSO/PATs), so
GHES auth works with zero extension-held secrets; (b) no new dependency and no native code
(ADR-0016 holds); (c) every operation is visible in VS Code's own Source Control UI and git
output log. The extension never stores or handles git credentials.

**2. Remote host allowlist (machine-scoped).** A sync remote may only be configured if its host
is in `aiSharePoint.sync.allowedRemoteHosts` (default `["github.com"]`; admins append their GHES
host, e.g. `github.corp.example`). Validation covers HTTPS and SSH (`git@host:org/repo`,
`ssh://git@host/…`) URL forms and runs at configuration time *and* before every push. This is
the data-egress control: serialized site content cannot be pushed to an unapproved host even by
accident. Workspace settings cannot override it (machine scope, untrusted-workspace restricted).

**3. Review gate per connection (ADR-0004 realized).** Each managed connection's sync config
carries `reviewGate: "pr" | "direct"` (default from `aiSharePoint.sync.defaultReviewGate`,
shipped default **pr**). With `pr`, pushes go to a `sharepoint-sync/<UTC-stamp>` branch and the
extension opens the host's compare/PR URL (the `…/compare/<base>...<branch>` path works
identically on github.com and GHES); `direct` pushes the configured branch. The extension never
force-pushes, never rewrites history, and never deletes remote branches.

**4. Local repo hygiene by construction.** On configure, the extension writes into the site
repo: `.gitattributes` (`* text=auto eol=lf` + JSON treated as text) so serialization is
byte-stable across Windows/macOS/Linux (the PLAN §7 no-diff invariant survives checkout);
a scoped `.gitignore` (`.aisharepoint/cache/`, OS noise); and a README identifying the source
site and warning that the content is generated. Commits use structured messages
(`SharePoint pull: <site> — +a ~u -r files`). Pull always precedes push conceptually: applying
a pull is the only way the working tree changes, and pushes operate on committed state only.

**5. Pre-commit content gates.** Before serialized files are written/committed, every file
passes (a) the shared secret leak-scan (`scanForLeaks` — JWTs/PEM/credentials embedded in page
content block the operation), and (b) GitHub size guards: warn ≥ 50 MB, block ≥ 100 MB per file
(PLAN §7). Findings are shown in the preview; blocked operations write nothing.

**6. Preview → approve → apply → commit.** No silent writes: `pullSite` first shows the change
report (added/updated/removed files) and applies only on confirmation, then commits. Dry-run is
the same path without apply.

## Consequences

- Enterprise GHES works the day a host is allowlisted — auth, PR flow, compare URLs all reuse
  GitHub-compatible behavior; nothing github.com-specific is assumed.
- Requires the VS Code Git extension (present in every standard build) and git on PATH — both
  already prerequisites of normal VS Code workflows; documented in the user guide.
- The serializer (not git) carries the burden of determinism; `.gitattributes` guards the
  remaining platform variable (EOL).
- Branch protection / required reviews are enforced server-side by the org; the extension's PR
  gate complements but cannot replace them — admin guide documents the recommended setup
  (protect `main`, require PR + review, disallow force pushes).
- Phase 3 (3-way merge, revert-to-commit) builds on this layer unchanged: it adds a base
  snapshot and merge UX, not new push mechanics.
