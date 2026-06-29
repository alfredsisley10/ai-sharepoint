# Rebranding & white-labeling this extension

This build is anonymized everywhere it can be **without breaking existing installs**: the
Marketplace `repository`/`bugs` links are removed, the license copyright is held by "AI SharePoint
contributors", the support/security docs point at "the channel your distributor provides" rather
than any specific account, and Marketplace Q&A is disabled. The one identity field that is **not**
anonymized is the `publisher` — and the section below explains why that is deliberate.

A VS Code extension package (`.vsix`) **must** declare a `publisher` and a `name`. Together they
form the extension's identity, `publisher.name` (here `alfredsisley10.ai-sharepoint`), and they
cannot be blank. This guide is the "where anonymization is not possible" companion: it tells you
exactly which fields to set to ship under your own identity, then repackage.

> ## ⚠️ The extension ID is permanent — do not change it on an existing deployment
>
> VS Code keys **all of an extension's stored data and secrets** — site connectors, context
> sources, projects, bookmarks, and saved credentials — to its identity `publisher.name`. If you
> change the `publisher` (or `name`) and ship that to machines that already have the extension,
> VS Code treats it as a **different extension** and gives it an empty store. Every user's existing
> connectors, projects, and credentials are **stranded** under the old ID (not deleted, but
> invisible to the new build).
>
> For this reason the `publisher` is fixed at **`alfredsisley10`** — the ID your existing
> deployment's data already lives under. **Leave it as-is on any environment that already has
> users.** Only pick a different publisher for a brand-new (greenfield) deployment with no existing
> data, and then keep it stable forever. See **[Migrating an existing deployment](#migrating-an-existing-deployment-to-a-new-id)** if you must change it.

---

## Easiest: the in-app command

Open the **Support & Diagnostics** view (AI SharePoint activity bar) and click
**"Rebrand / White-label…"** — or run **AI SharePoint: Rebrand / White-label This Extension…**
from the Command Palette. It points at the extension's source folder (auto-detected if it's open
in your workspace, otherwise you pick it), prompts for the new identity, applies every edit in
this guide, optionally swaps the icon, warns before changing the extension ID, and offers to
build the package for you. **Repackage now** opens a terminal that prints each step (dependency
install, then packaging) with live progress, and finishes by printing the exact path of the
generated `<name>-<version>.vsix` (written to the source folder) and the `code
--install-extension` command to install it. The manual steps below are the equivalent if you'd
rather edit by hand.

## Repeatable releases: profiles, bake-in & building both VSIXes

The wizard also steps you through **what to bake into the build** and saves it for next time, so
refreshing a release is quick and consistent:

- **Bake-in settings.** After the identity prompts you choose what ships with the build:
  anonymized **telemetry** (Splunk HEC / OTEL endpoints, and — optionally — a HEC token / OTLP
  auth header that is **obfuscated** in the VSIX and moved to the OS keychain on first run; see
  the security note below), **pre-defined connectors** (a snapshot of your current reference
  sources as non-secret descriptors — each user supplies their own credentials on first use),
  **project/memory defaults**, and **custom help** (a User Guide markdown + a first-run welcome
  note). On first launch the build seeds these **once** and never overwrites anything a user
  already has.
- **Baked tokens are obfuscated, not encrypted.** A pre-packaged Splunk HEC token (or OTLP auth
  header) is AES-obfuscated so it is **not** readable in `package.json` and never lands in
  settings, and on install it is moved into the OS keychain (never shown again, never exported).
  But because the de-obfuscation key ships in the build, a determined party with the VSIX can
  recover it — so treat baked tokens as **low-privilege, rotatable, HEC-ingest-only** credentials.
  The saved release profile (`whitelabel.profile.json`) never contains tokens — only endpoints.
- **Release profile.** At the end, choose **Save profile** to write `whitelabel.profile.json`
  (no secrets) to the source folder. Commit it. Next time you run the wizard it offers to
  **Reuse profile**, pre-filling every prompt — so a refreshed release is a quick, repeatable
  pass, and the **build expiry** (validity window) is re-stamped fresh on each release.
- **Build BOTH the standard and whitelabeled VSIX** (the normal release pass):
  1. On a **clean** source tree, `npm run package` → the standard `ai-sharepoint-<version>.vsix`.
  2. Run **Rebrand / White-label…** and **Reuse profile** → it applies the rebrand and (via
     **Repackage now**) builds the whitelabeled `<name>-<version>.vsix`.
  3. `git checkout .` (and `git clean -fd` if needed) to **revert** the source back to clean.
  Repeat each release. The rebrand only edits tracked source files, so the revert is complete.

## Quick start (manual)

For a **brand-new (greenfield)** deployment you may set your own identity; for an **existing**
deployment leave `publisher`/`name` alone (see the warning above) and rebrand only the cosmetic
fields.

1. Edit **`package.json`**:
   - `"publisher"` / `"name"` — **greenfield only.** Forms the permanent extension ID. Choose once.
   - `"displayName"` / `"description"` — safe to change anytime (cosmetic, not part of the ID).
2. Replace the icon **`media/icon.png`** with your own (128×128 PNG recommended) — safe anytime.
3. Update the copyright holder in **`LICENSE`** — safe anytime.
4. Repackage:
   ```sh
   npm install
   npm run package      # → ai-sharepoint-<version>.vsix
   ```
   Run these as two separate commands. On **Windows PowerShell** don't join them
   with `&&` — PowerShell 5.1 rejects it (`the token '&&' is not a valid statement
   separator`); the in-app **Repackage now** button picks the right syntax for your
   shell automatically. The output `.vsix` is the only artifact you distribute.

That's it. Everything below is detail and optional deeper rebranding.

---

## Every identity surface, and how to change it

| Surface | File / location | Default in this build | Action |
| --- | --- | --- | --- |
| **Publisher** (required) | `package.json` → `publisher` | `alfredsisley10` | **Greenfield only** — forms the permanent extension ID `publisher.name`. Changing it on an existing deployment strands all stored data/secrets (see warning above). |
| **Internal name** (required) | `package.json` → `name` | `ai-sharepoint` | **Greenfield only** — also part of the extension ID; same caveat as Publisher. Changes the `.vsix` filename. |
| **Display name** | `package.json` → `displayName` | `AI SharePoint` | Optional. Shown in the Extensions view. |
| **Description** | `package.json` → `description` | (SharePoint/Copilot blurb) | Optional. |
| **Icon** | `media/icon.png` | bundled icon | Replace with your own PNG. |
| **Gallery banner** | `package.json` → `galleryBanner.color` | `#16243a` | Optional brand color. |
| **Repository / bug links** | `package.json` → `repository`, `bugs` | *removed* | Optional. Add your own URLs if you want Marketplace links. |
| **Marketplace Q&A** | `package.json` → `qna` | `false` (disabled) | Leave disabled, or set `"marketplace"` / a URL. |
| **License holder** | `LICENSE` | `AI SharePoint contributors` | Set to your legal entity. |
| **Support channel** | `SUPPORT.md` | "channel your distributor provides" | Point at your support contact. |
| **Security contact** | `docs/SECURITY.md` | "security contact your distributor provides" | Point at your private reporting channel. |
| **Repo issue config** | `.github/ISSUE_TEMPLATE/config.yml` | placeholder (no URL) | Repo-only (not shipped in the `.vsix`); set if you re-host the source. |

There are **no other** references to the original publisher or repository in the shipped package.
The `github.com` strings that remain in the product are functional — they are the **site-as-code
git sync** feature's default remote-host allowlist (`aiSharePoint.sync.allowedRemoteHosts`) and an
example URL in a prompt, not publisher identity. Leave them.

---

## Full product rename (display name, handle, and identifiers)

The product name **AI SharePoint** and the chat handle **`@sharepoint`** are the *product* brand
(distinct from the publisher identity). The **in-app command renames them entirely** — it rewrites
every brand token across the source tree (package.json, the compiled TS strings, docs) and offers
to recompile. It asks two things beyond the cosmetic fields:

- **Product display name** — replaces `AI SharePoint` everywhere it appears.
- **Chat handle** — replaces `@sharepoint` (and the participant `name`/`fullName`).

Microsoft's product name **"SharePoint"** (as in "SharePoint Online", "your SharePoint sites") is
*never* touched — only the distinctive brand tokens (`AI SharePoint`, `@sharepoint`, and the
identifier prefixes below) are replaced.

### Internal identifier namespaces — greenfield only

The command also offers **"Also rename internal identifiers"**, which rewrites the
`aiSharePoint.*` command/setting/view IDs (605+ refs), the `aisharepoint_*` tool names, and the
`ai-sharepoint` schema/ids into a namespace derived from your new `name` (e.g. `contosoDocs.*`).
This produces a fully namespaced fork that still compiles and bundles — **but it also changes the
settings keys and stored-data keys**, so it carries the same greenfield-only warning as the
extension ID: existing installs lose their settings and data. The command warns and requires
confirmation before doing it. After a deep rename, update/skip the unit tests (they assert the old
identifiers) and recompile.

> If you only want to rename the product to users, choose **"Product name & handle only"** — it is
> safe on any deployment and leaves all identifiers (and therefore all stored data and settings)
> intact.

---

## Migrating an existing deployment to a new ID

If you must change the `publisher`/`name` on machines that already run the extension (e.g. to fully
anonymize the publisher), the extension ID changes and the new build starts with an empty store.
Plan a one-time migration; **secrets cannot be moved** and must be re-authenticated.

1. **Before upgrading**, on each machine still running the old build, run
   **AI SharePoint: Export Reference Config** — this writes a non-secret file containing your
   context sources, bookmarks, and projects (with goals/instructions/AI memory).
2. Install the new-ID build.
3. Run **AI SharePoint: Import Reference Config** and select that file to restore sources,
   bookmarks, and projects.
4. **Re-add SharePoint site connectors and sign in again.** Site connections and all stored
   credentials live in per-ID secret storage and do not transfer; re-authentication is interactive
   (browser / device-code), so this restores access without data loss.

The old ID's data remains on disk untouched, so you can roll back by reinstalling the old-ID build
if needed.

---

## Repackaging

```sh
npm install
npm run typecheck        # optional sanity check
npm test                 # optional: full unit suite
npm run package          # vsce package --no-dependencies → <name>-<version>.vsix
```

Expected, harmless warnings from `vsce package`:
- *"A 'repository' field is missing"* — intentional (links removed for anonymization). Add a
  `repository` if you want it gone.
- *publisher not found on the Marketplace* — only relevant if you later `vsce publish`; packaging
  still succeeds for private/sideloaded distribution.

Install the result with **Extensions: Install from VSIX…** in VS Code, or distribute it through
your own channel / private gallery.

---

## Verifying the package is clean

After packaging, confirm no stale identity leaked into the `.vsix` (it's a zip):

```sh
npm run package
unzip -o *.vsix -d /tmp/vsix-check >/dev/null
# Confirm your new publisher is in the manifest:
grep -i '"publisher"' /tmp/vsix-check/extension/package.json
# And that no PREVIOUS publisher/owner string survives (substitute the old value you replaced):
grep -rni "<previous-publisher>" /tmp/vsix-check || echo "clean: no original publisher reference"
```

The bundled code (`dist/extension.js`) is included; the source maps (`*.map`), `src/`, tests, and
internal `docs/` (ADRs, research, plans) are excluded by `.vscodeignore` and never ship.
