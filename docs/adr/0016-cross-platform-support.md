# ADR-0016 — Cross-platform support (macOS, Windows x64, Windows ARM)

- Status: Accepted
- Date: 2026-06-10

## Context
The extension must run on **macOS, Windows x64, and Windows ARM** (and ideally Linux). VS Code
extensions run in the Node extension host on every platform, so a pure-JavaScript extension is portable
by default. The thing that breaks portability — especially Windows ARM — is a dependency with a
**native binary** (node-gyp / prebuilt `.node`), or platform-specific code (shell calls, hard-coded
paths, OS-only APIs).

## Decision
Keep the extension **portable by construction**:

- **No native dependencies.** Prefer pure-JS libraries. The Phase 0/1 stack (`@azure/msal-node`) ships
  no native binaries; CI verifies the tree stays clean (`find node_modules -name '*.node'` is empty; no
  `node-gyp`/`prebuild-install` install steps).
- **No OS/CPU pinning** in `package.json` (`os`/`cpu` unset) so the single VSIX targets all platforms.
- **No platform-specific code.** Use VS Code APIs (`env.openExternal`, `SecretStorage`) and Node
  built-ins (`node:http`, `node:path`, global `fetch`); never shell out or hard-code separators/paths.
  The MSAL loopback flow binds `127.0.0.1` and opens the system browser via VS Code — identical on all
  OSes.
- **Secret storage** is delegated to VS Code `SecretStorage`, which maps to each OS keychain (macOS
  Keychain, Windows Credential Manager, Linux libsecret) without per-OS code.

## Consequences
- One VSIX runs on macOS, Windows x64, Windows ARM, and Linux — no per-platform builds.
- **Future-adapter caveat:** some context-source drivers carry native code — notably **`node-oracledb`**
  (needs Oracle Instant Client) and optional native add-ons in some Mongo/SQL stacks. For those (Phase
  6) we must either use a pure-JS/thin mode, ship prebuilt binaries for all three target ABIs, or gate
  the adapter by platform. This constraint is part of each adapter's definition of done.
- Verifying "no `.node`, no gyp" is a CI gate, not a one-time check.
