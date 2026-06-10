# ai-sharepoint

A Visual Studio Code extension that uses **GitHub Copilot** as the AI provider to drive **SharePoint
Online** site development and maintenance, with Git/GitHub as the system of record.

See [`docs/PLAN.md`](docs/PLAN.md) for the full plan and [`docs/adr/`](docs/adr) for the architecture
decisions.

## Status — Phase 0 (spike) + foundations

This is the first vertical slice, proving the two load-bearing constraints from the plan:

1. **Copilot via the VS Code Language Model API** (ADR-0001) — discover entitled models and run
   **metered** requests, with a percentage-of-allowance usage gauge in the status bar (ADR-0003).
2. **SharePoint auth via MSAL public-client interactive** (PLAN §5) — sign in through the system
   browser using the Microsoft Graph PowerShell first-party app, with the token cache stored in the OS
   keychain (ADR-0016 cross-platform: macOS, Windows x64/ARM, Linux).

### Commands

- **AI SharePoint: List Copilot Models** — enumerate models with relative premium-request cost.
- **AI SharePoint: Ask Copilot (metered)** — send a prompt; usage is metered.
- **AI SharePoint: Connect SharePoint Site** — interactive sign-in, resolve a site, store the
  connection (managed or reference role).
- **AI SharePoint: Show Copilot Usage** / **Reset Copilot Usage Meter**.

## Develop

```bash
npm install
npm run compile      # bundle to dist/ (or: npm run watch)
npm run typecheck    # tsc --noEmit
```

Then press <kbd>F5</kbd> in VS Code to launch the Extension Development Host. Requires the GitHub
Copilot extension installed and signed in for the Language Model features.
