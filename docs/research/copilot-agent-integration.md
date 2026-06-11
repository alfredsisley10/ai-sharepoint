# Research — Exposing the extension & its data sources to GitHub Copilot (agents, tools, MCP)

- Date: 2026-06-10
- Question: How should this plugin and all its related data sources be accessed via GitHub Copilot
  agents, skills, tools, and MCP endpoints?

## TL;DR / recommendation

Expose every capability through **two surfaces backed by one shared core**:

1. **VS Code Language Model Tools** (`vscode.lm.registerTool` + `contributes.languageModelTools`) — for
   the in-editor **Copilot agent mode** experience. Agent mode auto-invokes these; users can also
   `#`-reference them in chat. Best fit for the live, local, keychain-authenticated capabilities.
2. **A local MCP server** (Model Context Protocol, stdio) exposing the same capabilities + all read-only
   data sources — the **reusable** layer. Contributed to VS Code via
   `vscode.lm.registerMcpServerDefinitionProvider`, and usable by any **local** MCP client.

**Scope decision: local only — the cloud-hosted GitHub coding agent is OUT OF SCOPE** (user direction,
and it conflicts with our local-secrets model — see below). We target VS Code Copilot **agent mode** on
the developer's machine; no remote/hosted MCP, no per-repo cloud MCP config, no cloud-stored secrets.

**Do NOT build a GitHub-App-based Copilot Extension (skillset/agent).** GitHub **sunset** that platform
on **2025-11-10** and now points everyone to **MCP** instead. MCP is the strategic standard for local
agent mode: build once, reuse across VS Code (and, if ever wanted, other local IDE agent modes and
non-Copilot MCP clients).

## The surfaces, in detail

### 1. VS Code Language Model Tools API (in-editor agent mode)
- Register a tool in `package.json` under `contributes.languageModelTools` (name, `displayName`,
  `modelDescription`, `inputSchema`, `tags`, `toolReferenceName`) and bind logic with
  `vscode.lm.registerTool`. ([VS Code: Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools))
- Tools are **automatically invoked by agents** in chat and can be referenced with `#`; availability is
  gated by `when` clauses (e.g. only when a managed site is connected, or only for `reference`-role
  reads). ([VS Code: Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model))
- This is the natural home for our `@sharepoint` capabilities (PLAN §8): SharePoint read/QA/authoring,
  sync ops, and read-only context-source queries/bookmarks (PLAN §9).

### 2. MCP — the cross-surface standard
- **VS Code lets an extension publish MCP servers**: declare `contributes.mcpServerDefinitionProviders`
  and call `vscode.lm.registerMcpServerDefinitionProvider`; `provideMcpServerDefinitions` returns the
  servers and the optional **`resolveMcpServerDefinition`** runs setup (e.g. **authentication**) before
  launch. Servers can be lazily started based on activation criteria. ([VS Code: MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp), [Add & manage MCP servers in VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers))
- **Copilot agent mode consumes MCP servers** for external resources/tools without leaving the editor.
  ([GitHub: Enhancing agent mode with MCP](https://docs.github.com/en/copilot/tutorials/enhance-agent-mode-with-mcp))
- **Copilot coding agent (cloud) supports remote MCP servers** (since 2025-07-09), per-repo config with
  `COPILOT_MCP_` secrets — but this is **out of scope** for us (local-only; see below). Documented here
  only to explain what we are deliberately *not* using. ([GitHub Changelog: coding agent + remote MCP](https://github.blog/changelog/2025-07-09-copilot-coding-agent-now-supports-remote-mcp-servers/), [MCP & the coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/mcp-and-coding-agent))
- Agent mode + MCP is also available in **JetBrains, Eclipse, Xcode** — so an MCP server reaches those
  IDEs too. ([GitHub Changelog: agent mode + MCP in more IDEs](https://github.blog/changelog/2025-05-19-agent-mode-and-mcp-support-for-copilot-in-jetbrains-eclipse-and-xcode-now-in-public-preview/))

### 3. GitHub Copilot Extensions (skillsets vs agents) — deprecated, avoid
- The old Copilot Extensibility Platform had **skillsets** (lightweight; you expose a few API endpoints
  and GitHub handles routing/prompting) and **agents** (full control, custom logic).
  ([GitHub: Setting up Copilot Extensions](https://docs.github.com/en/copilot/how-tos/use-copilot-extensions/set-up-copilot-extensions?tool=skillsets))
- **GitHub App-based Copilot Extensions were sunset 2025-11-10**, replaced by MCP servers; new ones were
  blocked from 2025-09-24. There is now a **GitHub MCP Registry** for discovery. This is a *replacement*,
  not a migration — so we should target MCP directly and not invest in the deprecated path.
  ([GitHub Changelog: sunset notice](https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/))

## Recommended architecture for ai-sharepoint

```
            ┌──────────────────── Shared capability core ────────────────────┐
            │  SharePoint client · Sync engine · Context-source framework     │
            │  (§9 adapters) · Bookmarks · auth (keychain) · role/read guards │
            └───────────────┬───────────────────────────────┬────────────────┘
                            │                                │
              thin adapter  │                                │  thin adapter
                            ▼                                ▼
        ┌───────────────────────────┐        ┌──────────────────────────────────┐
        │ VS Code Language Model     │        │ ai-sharepoint MCP server (LOCAL)  │
        │ Tools (registerTool +      │        │ stdio · tools + resources         │
        │ contributes.languageModel- │        │  → VS Code agent mode +           │
        │ Tools); when-gated         │        │    other local MCP clients        │
        └─────────────┬──────────────┘        └──────────────────────────────────┘
                      │                        contributes.mcpServerDefinitionProviders
                      ▼                        + resolveMcpServerDefinition (keychain auth setup)
            VS Code Copilot agent mode         [cloud coding agent: OUT OF SCOPE]
```

- **One core, two adapters.** Implement each capability once; expose it as a Language Model Tool *and*
  as a local MCP tool. Avoid divergence.
- **Local MCP server is the endpoint** for "all related data sources" — the 19 read-only adapters,
  bookmarks, SharePoint reads — usable from VS Code agent mode and other **local** MCP clients.
- **`resolveMcpServerDefinition` wires our keychain auth** into the locally-launched MCP server, so the
  standard-user / lockout-safe / read-only guarantees (ADR-0009/0012/0014/0015) hold over MCP too.

## Why local-only (cloud coding agent is out of scope)

Per user direction, the **cloud-hosted GitHub coding agent is out of scope** — and it's the right call
on the merits. Our whole auth model keeps **secrets on the local machine** (§6, ADR-0013/0014), which
fits **local MCP (stdio) + VS Code agent mode** perfectly. The cloud coding agent would instead require
a **remote/hosted** MCP server and **cloud-stored `COPILOT_MCP_` secrets** — conflicting with "secrets
never leave the machine" — and most of our sources (SQL Server, on-prem databases, Data Center
Confluence/Jira) aren't reachable from the cloud anyway.

**Therefore:** the *only* integration we build is **local** — VS Code Copilot agent mode via LM tools +
a local stdio MCP server. We never push local credentials to the cloud, and we ship no remote/hosted
MCP endpoint or per-repo cloud MCP config.

## Security posture over MCP
- **Read-only stays read-only:** reference sources expose only read tools; the role guard (ADR-0007) and
  read-only scopes apply identically over MCP. No write tools are bound to `reference` connections.
- **Per-tool gating:** LM tools use `when` clauses; the local MCP server exposes only the read/managed
  tools intended for each connection role.
- **No secret values cross any boundary:** the local MCP server resolves auth via the keychain at launch
  (`resolveMcpServerDefinition`); nothing is sent to the cloud (no `COPILOT_MCP_`/hosted path exists).
- **Cost governance still applies:** when our tools call Copilot models they go through the metered
  `vscode.lm` path (ADR-0001/0003); MCP tool *execution* itself doesn't consume Copilot premium
  requests, but the agent's reasoning around them does.

## Sources
- VS Code: [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools) ·
  [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) ·
  [MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp) ·
  [Add & manage MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- GitHub: [Enhancing agent mode with MCP](https://docs.github.com/en/copilot/tutorials/enhance-agent-mode-with-mcp) ·
  [MCP & the coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/mcp-and-coding-agent) ·
  [coding agent + remote MCP (changelog)](https://github.blog/changelog/2025-07-09-copilot-coding-agent-now-supports-remote-mcp-servers/) ·
  [Configure MCP servers for your repository](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers) ·
  [Set up the GitHub MCP server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server) ·
  [Skillsets vs agents](https://docs.github.com/en/copilot/how-tos/use-copilot-extensions/set-up-copilot-extensions?tool=skillsets) ·
  [Sunset of GitHub-App Copilot Extensions](https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/) ·
  [Agent mode + MCP in JetBrains/Eclipse/Xcode](https://github.blog/changelog/2025-05-19-agent-mode-and-mcp-support-for-copilot-in-jetbrains-eclipse-and-xcode-now-in-public-preview/)
