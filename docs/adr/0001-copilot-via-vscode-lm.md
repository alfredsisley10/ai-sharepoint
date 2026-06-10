# ADR-0001 — Consume Copilot exclusively through the VS Code Language Model API

- Status: Accepted
- Date: 2026-06-10

## Context
The extension's premise is "GitHub Copilot as the AI provider." We need a way to call Copilot models
from extension code that is supported and within GitHub's terms of service.

GitHub Copilot does **not** publish a general-purpose, API-key-addressable endpoint for arbitrary
applications to consume a user's Copilot entitlement. The supported integration surface for a VS Code
extension is the **VS Code Language Model API** (`vscode.lm`):

- `vscode.lm.selectChatModels()` — enumerate models the signed-in user is entitled to.
- `model.sendRequest()` — issue a chat request on the user's entitlement.
- `model.countTokens()` — token accounting.
- Chat + Language Model Tools APIs — expose our agent as a `@sharepoint` chat participant that calls
  our SharePoint/Git tools in an agentic loop.

A direct Copilot/GitHub Models HTTP endpoint with a service key would either not exist for the
Copilot-entitlement path or fall outside ToS.

## Decision
Standardize **all** model access on `vscode.lm`. Do not implement any direct Copilot/GitHub Models
HTTP path for consuming the user's Copilot entitlement.

## Consequences
- Runs on the user's own Copilot sign-in and entitlement; no key management for the model provider.
- We get token counts, **not** dollars or remaining balance (drives ADR-0003).
- We inherit the model set the user is entitled to — discovery is dynamic, not hard-coded.
- If GitHub later exposes a usage/billing read, it can be layered in without changing this decision.
