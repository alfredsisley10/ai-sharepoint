# ADR-0017 — Expose capabilities via Language Model Tools + a local MCP server (local-only)

- Status: Accepted
- Date: 2026-06-10
- Research: [`docs/research/copilot-agent-integration.md`](../research/copilot-agent-integration.md)

## Context
The extension and all its data sources should be usable from GitHub Copilot's agentic surfaces. The
landscape (researched 2026-06-10):

- **VS Code Language Model Tools API** — extensions register tools (`vscode.lm.registerTool` +
  `contributes.languageModelTools`) that **Copilot agent mode auto-invokes** and users `#`-reference;
  gated by `when` clauses.
- **MCP** — the cross-tool standard. VS Code extensions can publish MCP servers
  (`vscode.lm.registerMcpServerDefinitionProvider` + `contributes.mcpServerDefinitionProviders`), with
  `resolveMcpServerDefinition` for auth setup. Agent mode consumes MCP servers.
- **GitHub-App Copilot Extensions (skillsets/agents)** were **sunset 2025-11-10**; GitHub now directs
  integrators to **MCP**. So that path is dead.
- The **cloud coding agent** supports *remote* MCP — but the user has directed that the **cloud-hosted
  GitHub agent is out of scope**, and it conflicts with our local-secrets model anyway.

## Decision
Expose every capability through **two local surfaces over one shared core**, and nothing in the cloud:

1. **VS Code Language Model Tools** for the in-editor agent-mode experience — SharePoint read/QA/
   authoring, sync ops, and read-only context-source queries/bookmarks, each `when`-gated by connection
   role and state.
2. **A local (stdio) MCP server** exposing the same capabilities + all §9 read-only data sources,
   contributed to VS Code via `registerMcpServerDefinitionProvider`; `resolveMcpServerDefinition` wires
   in keychain-backed auth before launch.

Both are thin adapters over **one capability core** (SharePoint client, sync engine, context-source
framework, bookmarks) — implement once, expose twice.

**Explicitly NOT building:** a GitHub-App Copilot Extension/skillset (deprecated); any remote/hosted MCP
endpoint; per-repo cloud MCP config; `COPILOT_MCP_` cloud secrets; any path that sends local
credentials to the cloud-hosted coding agent.

## Consequences
- Works in VS Code Copilot **agent mode** today, and the MCP server is reusable by other **local** MCP
  clients without extra work.
- Security model is preserved end-to-end: read-only role guards, read-only scopes, standard-user auth,
  lockout-safe backoff, and keychain-only secrets all hold over the local MCP boundary
  (ADR-0007/0009/0012/0014/0015). No secret ever leaves the machine.
- We forgo cloud-coding-agent automation by choice — acceptable, since most sources (on-prem DBs, DC
  Confluence/Jira, SQL Server) aren't cloud-reachable and our secrets are deliberately local.
- Some near-term churn: the agent tool layer (PLAN §8) must be factored as a shared core so the LM-tool
  and MCP adapters don't diverge.
