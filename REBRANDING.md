# Rebranding & white-labeling this extension

This build ships **without a fixed publisher identity or repository link**. The `publisher`
field carries a neutral placeholder (`example-publisher`), the marketplace `repository`/`bugs`
links have been removed, the license copyright is held by "AI SharePoint contributors", and the
support/security docs point at "the channel your distributor provides" rather than any specific
account.

A VS Code extension package (`.vsix`) **must** declare a `publisher` and a `name` — those two
fields form the extension's identity (`publisher.name`) and cannot be blank. This guide is the
"where anonymization is not possible" companion: it tells you exactly which fields to set to ship
the extension under your own identity, then repackage.

> You do **not** need to touch any source code to rebrand the publisher. The command,
> walkthrough, and participant wiring derive their IDs from the extension identity at runtime, so
> changing `package.json` is enough.

---

## Quick start (minimum to ship under your own identity)

1. Edit **`package.json`**:
   - `"publisher"`: your Marketplace publisher ID (or any value for private/internal distribution).
   - `"name"` / `"displayName"` / `"description"`: optional — your product naming.
2. Replace the icon **`media/icon.png`** with your own (128×128 PNG recommended).
3. Update the copyright holder in **`LICENSE`**.
4. Repackage:
   ```sh
   npm install
   npm run package      # → ai-sharepoint-<version>.vsix  (vsce package --no-dependencies)
   ```
   The output `.vsix` is the only artifact you distribute.

That's it. Everything below is detail and optional deeper rebranding.

---

## Every identity surface, and how to change it

| Surface | File / location | Default in this build | Action |
| --- | --- | --- | --- |
| **Publisher** (required) | `package.json` → `publisher` | `example-publisher` | Set to your publisher ID. Forms the extension ID `publisher.name`. |
| **Internal name** (required) | `package.json` → `name` | `ai-sharepoint` | Optional. Lowercase, no spaces. Changes the `.vsix` filename. |
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

## Optional: deeper rebrand (product name & internal namespace)

The user-visible product name is **AI SharePoint** and the chat assistant is invoked as
**`@sharepoint`**. These are the *product* brand, not the publisher identity, so the quick-start
rebrand leaves them in place. To change them as well:

- **Chat handle** (`@sharepoint`): `package.json` → `contributes.chatParticipants[0].name`
  (and `fullName` / `description`). The participant `id` (`aiSharePoint.sharepoint`) is internal —
  changing it is optional and has no user-facing effect.
- **"AI SharePoint" display strings**: these appear in the UI (status bar, views, notifications)
  from the compiled bundle. Search the source for `AI SharePoint` and adjust, then recompile.

> **Caveat — internal namespaces.** All 75 command IDs and 24 settings keys use the
> `aiSharePoint.*` namespace, and the language-model tools use `aisharepoint_*`. These are stable
> internal identifiers that users rarely see (settings show their human titles, not the keys).
> Renaming the namespace is a code-wide find-and-replace that also **migrates users' existing
> settings**, so most rebrands keep it as-is. Only change it if a fully namespaced fork is
> required; if you do, update `package.json`, the TypeScript sources, and provide a settings
> migration.

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
