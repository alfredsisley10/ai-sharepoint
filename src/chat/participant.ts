import * as vscode from "vscode";
import { SitesStore } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { SiteOverview } from "../auth/sharePointClient";
import { CopilotService } from "../copilot/copilotService";
import { UsageMeter } from "../copilot/meter";
import { ContextSourcesStore } from "../context/sourcesStore";
import { BookmarksStore } from "../context/bookmarksStore";
import { SchemaStore } from "../context/schemaStore";
import { ProjectsStore } from "../context/projectsStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { AppError, adviceFor } from "../core/errors";
import { Logger } from "../core/log";
import { wireEnabled, emitWire, capDetail, safeJson } from "../core/wireLog";
import { describeToolCall, describeToolResult } from "./toolStatus";

export const PARTICIPANT_ID = "aiSharePoint.sharepoint";

const INSTRUCTIONS = [
  "You are the AI SharePoint assistant inside Visual Studio Code.",
  "You help users with SharePoint Online sites AND the read-only reference sources they have",
  "connected (Confluence, Jira, LDAP/Active Directory). You have TOOLS — use them instead of",
  "guessing: search_context queries a reference source (free text, or raw CQL/JQL/LDAP filter),",
  "get_context_item fetches one page/issue/directory entry, list_sources and list_bookmarks show",
  "what is available, run_bookmark executes a saved query by name, and site_overview/list_pages",
  "read SharePoint sites. Sources may carry a short ALIAS (e.g. \"CMDB\") and a description of",
  "their contents — when the user names a source (\"…in the CMDB database\"), pass that alias as",
  "the tool's source argument and trust the description when choosing where to look.",
  "A Microsoft 365 Copilot source grounds on the same content Copilot does — documents, and (when",
  "enabled) email, calendar, Teams messages, and people; query it in plain language via",
  "search_context, or pass {\"query\": \"…\", \"filter\": \"<KQL e.g. path/SiteID/Author/FileType/",
  "LastModifiedTime>\"} to scope it.",
  "You can also MANAGE Confluence pages: write_confluence_page creates or updates a page in a",
  "Confluence space using that source's own API token — no SharePoint/Graph admin consent needed,",
  "so it's the writable target when SharePoint write-back is blocked. It is APPROVAL-GATED: propose",
  "the page (source, spaceKey + title + markdown to create; source + pageId + title + markdown to",
  "update) and the user confirms before anything is written. Find a page's id via search_context",
  "first when updating. Only write changes the user explicitly asked for.",
  "For free-form DATABASE questions ('records owned by X'), call db_schema with a topic first:",
  "it returns the tables/columns whose semantic tags match (e.g. group_cio tagged ownership),",
  "then write a SELECT against exactly those columns and run it with search_context. db_schema",
  "also lists PROBED JOIN PATHS when an ER model exists — use those for multi-table queries.",
  "When the user supplies a JOIN (SQL syntax or table.column = table.column) or asks whether",
  "two columns join, call test_join: it validates against the ER model or probes the live join",
  "rate; call it again with save=true ONLY when the user wants the ER diagram extended (they",
  "approve in chat). User-defined joins persist even below the automatic rate thresholds.",
  "For research tasks (e.g. aggregating content about a topic), run one or",
  "more searches, synthesize the findings with links, and — when a query looks reusable — call",
  "suggest_bookmark to propose saving it; the user approves in a confirmation dialog.",
  "When the user wants the DATA ITSELF (a dataset, 'all rows', anything beyond the capped",
  "search hits), call export_context_results: it runs the query with export bounds and writes",
  "every row to a file in the workspace, returning only the path + count — never paste large",
  "result sets into chat, and don't read the exported file back unless asked about a slice.",
  "When the user teaches you durable, project-specific behavior (a preference, a rule, where to",
  "look), and a project is active, you may call remember_project_context to save it (they",
  "approve) — it persists in the project's AI-managed context, separate from their own goals/",
  "instructions, across sessions. Use it sparingly for lasting guidance, not per-turn detail.",
  "When the user wants findings SHARED with someone, use draft_communication to prepare a Teams",
  "message or Outlook email. Before drafting a message that should reflect what was already said",
  "or decided (a status update, reply, or summary), GROUND it first: search the relevant",
  "sources — especially a Microsoft 365 Copilot source, which can read Teams messages, email, and",
  "documents — then write the draft from that context. draft_communication only QUEUES a draft",
  "the user must approve in the Communications view; nothing sends until they do. Teams has no",
  "draft folder reachable by API, so the queued draft IS the draft — never imply anything was",
  "saved into Teams or already sent. To verify a delivery method end-to-end, point the user to",
  "the “AI SharePoint: Test Communication Method” command in the Communications view.",
  "For ARCHITECTURE / tech-stack questions about ANY connected site — reference (read-only)",
  "connections included — call inspect_site: it enumerates every list with its columns, all",
  "pages, and (with page: \"<title>\") a page's full section/web-part breakdown. Reading never",
  "requires a managed connection — NEVER tell the user a site must be onboarded as managed (or",
  "pulled) just to analyze it; managed exists only for CHANGING sites.",
  "To REVIEW or AUDIT the actual CONTENT of a whole site — 'review the entire contents of",
  "<site>', find DUPLICATIVE / OUT-OF-DATE / CONFUSING pages, or any content-cleanup ask —",
  "call scan_site_content: it returns EVERY page's rendered text, headings, link targets",
  "(Quick Links, Hero tiles, in-text links) and embedded list views. Compare ACROSS the",
  "returned pages, cite page titles + urls in every finding, and recommend concrete cleanup",
  "(merge, archive, update, delete). These reviews are legitimately LONG-RUNNING and",
  "MULTI-STEP — take as many tool rounds as the task needs rather than answering prematurely.",
  "For CROSS-SOURCE reviews — e.g. 'using the authoritative <site>, find content in Confluence",
  "that conflicts with or misleads users, and recommend cleanup' — treat the named SharePoint",
  "site as the source of truth: FIRST establish its content (scan_site_content for the whole",
  "site, or inspect_site/site_overview for a part), THEN search_context the other source for",
  "the same topics, compare them point by point, and recommend which side to fix (usually the",
  "non-authoritative one) with specific edits.",
  "You are also a capable SharePoint DEVELOPER: when the user asks you to design or change a",
  "managed site, IMPLEMENT it yourself end-to-end instead of handing the user manual steps —",
  "(1) optionally pull_site for a fresh baseline, (2) write the lists/*.json and pages/*.json",
  "spec files into the repo with write_site_files (mirror the structure of pulled files),",
  "(3) launch apply_site. Every step is user-approved: tool confirmations in chat, and apply",
  "opens a PREVIEW DOCUMENT (a markdown editor tab listing every operation) plus a MODAL",
  "confirmation — describe exactly those two things; there is NO element called a 'preview",
  "dialog', so never send the user looking for one. apply_site's result states what actually",
  "happened (blocked / cancelled / applied N ops / failed at op) — relay it truthfully, and",
  "NEVER claim the site changed until it succeeded; verify with site_overview after. Deletions",
  "stay opt-in. List CONTENT (items/documents) is not in the pipeline yet — say so when asked.",
  "Prefer SharePoint's no-code, out-of-the-box features so sites stay maintainable. Be concise.",
].join(" ");

/** Cap on tool-calling rounds per turn (each round is its own request).
 *  Deep, multi-step asks — scan a whole site's content, then cross-reference it
 *  against a reference source like Confluence — legitimately need several
 *  rounds, so the cap is generous; usage stays visible in Copilot Activity. */
const MAX_TOOL_ROUNDS = 8;

interface ChatDeps {
  ctx: vscode.ExtensionContext;
  sites: SitesStore;
  access: SiteAccess;
  sources: ContextSourcesStore;
  bookmarks: BookmarksStore;
  schemas: SchemaStore;
  projects: ProjectsStore;
  copilot: CopilotService;
  meter: UsageMeter;
  telemetry: TelemetryService;
  errors: ErrorReportStore;
  log: Logger;
  now: () => string;
}

export function registerChatParticipant(deps: ChatDeps): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (
    request,
    context,
    stream,
    token,
  ) => {
    deps.telemetry.record("chat.request", {
      command: request.command ?? "none",
    });
    try {
      switch (request.command) {
        case "help":
          renderHelp(stream);
          return {};
        case "usage":
          renderUsage(deps, stream);
          return {};
        case "sites":
          renderSites(deps, stream);
          return {};
        case "site":
          await renderSiteOverview(deps, request, stream);
          return {};
        default:
          return await answerWithModel(deps, request, context, stream, token);
      }
    } catch (err) {
      const code = deps.errors.capture("chat", err);
      const safe = redactError(err);
      // An error that knows its own remediation (e.g. "your Splunk session
      // expired — re-capture the cookie") beats the generic per-code advice.
      const advice = (err instanceof AppError ? err.userSummary : undefined) ?? adviceFor(code);
      stream.markdown(
        `⚠️ **Something went wrong:** ${safe.message}${advice ? `\n\n${advice}` : ""}`,
      );
      return { errorDetails: { message: safe.message } };
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(
    deps.ctx.extensionUri,
    "media",
    "icon.png",
  );
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: "What lists and pages does my site have?", label: "Explore my site" },
        { prompt: "Suggest a structure for a product-management site", label: "Plan a site" },
        { prompt: "/usage", label: "Check Copilot activity" },
      ];
    },
  };
  return participant;
}

function renderHelp(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    [
      "**@sharepoint** — your SharePoint Online assistant (read-only in this release).",
      "",
      "| Command | What it does |",
      "|---|---|",
      "| `/sites` | List your configured site connections |",
      "| `/site <url or name>` | Live overview of a connected site (lists, pages) |",
      "| `/usage` | This extension's Copilot request activity (local counts) |",
      "| `/help` | This help |",
      "",
      "Ask anything else in natural language — I can **search your reference sources too**:",
      "_“search Confluence for content about AI automation and summarize it”_,",
      "_“find information about application X in the CMDB database”_ (sources answer to their",
      "**alias** — set one via right-click → *Edit Alias & Description*),",
      "_“what's in the IT Help queue?”_ (runs your bookmarks), or",
      "_“draft a landing-page outline for our product catalog”_. When a search proves useful,",
      "I can propose saving it as a **bookmark** — you approve before anything persists.",
      "The same tools are `#`-referenceable in Copilot **agent mode** (`#spSearchContext`, …).",
      "",
      "> Every model request uses your Copilot subscription — your GitHub billing page is the authoritative usage source.",
    ].join("\n"),
  );
}

function renderUsage(deps: ChatDeps, stream: vscode.ChatResponseStream): void {
  const nowIso = deps.now();
  const byModel = deps.meter.byModelThisMonth(nowIso).slice(0, 5);
  const failures = deps.meter.failuresThisMonth(nowIso);
  const lines = [
    `**Copilot activity (this extension's local request counts):**`,
    "",
    `- This month: **${deps.meter.requestsThisMonth(nowIso)}** request(s)${failures > 0 ? ` (${failures} failed)` : ""}`,
    `- Today: **${deps.meter.requestsToday(nowIso)}** request(s)`,
    `- Premium-request consumption is **not tracked** — there is no authoritative local source; check your GitHub billing/plan page.`,
  ];
  if (byModel.length > 0) {
    lines.push("", "| Model | Requests | Tokens in/out |", "|---|---|---|");
    for (const m of byModel) {
      lines.push(`| ${m.key} | ${m.requests} | ${m.inputTokens.toLocaleString()}/${m.outputTokens.toLocaleString()} |`);
    }
  }
  stream.markdown(lines.join("\n"));
  stream.button({
    command: "aiSharePoint.showUsage",
    title: "Open activity dashboard",
  });
}

function renderSites(deps: ChatDeps, stream: vscode.ChatResponseStream): void {
  const all = deps.sites.list();
  if (all.length === 0) {
    stream.markdown(
      "No SharePoint sites connected yet. Connect one to give me something to work with:",
    );
    stream.button({
      command: "aiSharePoint.connectSite",
      title: "Connect SharePoint Site",
    });
    return;
  }
  const lines = [
    `**Connected sites (${all.length}):**`,
    "",
    "| Site | Role | URL |",
    "|---|---|---|",
  ];
  for (const c of all) {
    lines.push(`| ${c.displayName} | ${c.role} | ${c.siteUrl} |`);
  }
  stream.markdown(lines.join("\n"));
}

async function renderSiteOverview(
  deps: ChatDeps,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const ref =
    deps.access.extractSiteUrl(request.prompt) ?? request.prompt.trim();
  const conn = deps.access.resolve(ref || undefined);
  if (!conn) {
    renderSites(deps, stream);
    if (deps.sites.list().length > 0) {
      stream.markdown(
        "\nTell me which one: `/site <url or name>`.",
      );
    }
    return;
  }
  stream.progress(`Reading ${conn.displayName}…`);
  const overview = await deps.access
    .clientFor(conn, { silent: true })
    .getSiteOverview(conn.siteUrl);
  stream.markdown(formatOverview(overview, conn.role));
}

function formatOverview(o: SiteOverview, role: string): string {
  const lines = [
    `### ${o.site.displayName}  \`${role}\``,
    "",
    o.site.description ? `> ${o.site.description}\n` : "",
    `**Lists & libraries (${o.lists.length}):**`,
    ...o.lists
      .slice(0, 25)
      .map((l) => `- [${l.displayName}](${l.webUrl})${l.template ? ` _(${l.template})_` : ""}`),
  ];
  if (o.pages) {
    lines.push("", `**Pages (${o.pages.length}):**`);
    lines.push(
      ...o.pages.slice(0, 25).map((p) => `- [${p.title}](${p.webUrl})`),
    );
  } else {
    lines.push("", "_Pages unavailable (the tenant restricts the Pages API for this account)._");
  }
  return lines.filter((l) => l !== "").join("\n");
}

async function answerWithModel(
  deps: ChatDeps,
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const model = request.model ?? (await deps.copilot.pickDefaultModel());
  const modelKey = model.family || model.id;

  const contextBlock = await buildSiteContext(deps, request, stream);
  const history = formatHistory(context);
  const activeProject = deps.projects.active();
  // Project context: USER-DEFINED (goals + instructions) and AI-MANAGED
  // (learned across sessions) are presented as separate, clearly-labeled
  // blocks so the model never conflates them — and is told it may persist new
  // learnings via remember_project_context (user-approved).
  const projectBlock =
    activeProject &&
    (activeProject.goals || activeProject.instructions || activeProject.aiContext)
      ? [
          `\n## Project: ${activeProject.name}${activeProject.description ? ` — ${activeProject.description}` : ""}`,
          activeProject.goals ? `\n### Goals (set by the user)\n${activeProject.goals}` : "",
          activeProject.instructions
            ? `\n### Instructions & reference context (set by the user)\n${activeProject.instructions}`
            : "",
          activeProject.aiContext
            ? `\n### AI-managed context — learnings you saved in earlier sessions (NOT user-authored; you may add to it via remember_project_context when the user teaches you durable, project-specific behavior, with their approval)\n${activeProject.aiContext}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : activeProject
        ? `\n## Project: ${activeProject.name} (no goals/instructions/AI context set yet — you may propose saving durable learnings via remember_project_context)`
        : "";
  const prompt = [
    INSTRUCTIONS,
    projectBlock,
    contextBlock ? `\n## Connected context\n${contextBlock}` : "",
    history ? `\n## Conversation so far\n${history}` : "",
    `\n## User request\n${request.prompt}`,
  ].join("\n");

  // This extension's tools (SharePoint + reference sources + bookmarks),
  // declared on the request so the model can call them from @sharepoint —
  // not only from Copilot agent mode.
  const tools: vscode.LanguageModelChatTool[] = vscode.lm.tools
    .filter((t) => t.name.startsWith("aisharepoint_"))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  let inputTokens = 0;
  try {
    inputTokens = await model.countTokens(prompt);
  } catch {
    // best-effort
  }

  let sawText = false;
  for (let round = 0; ; round++) {
    // Per-round status so the user can follow a multi-step turn (pilot):
    // name the model and the step so long turns read as a narrated plan.
    stream.progress(
      round === 0
        ? `Asking ${model.name}…`
        : `Step ${round + 1}: ${model.name} is reviewing the results…`,
    );

    let text = "";
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let ok = false;
    try {
      const response = await model.sendRequest(
        messages,
        {
          justification: "AI SharePoint chat (uses your Copilot subscription)",
          ...(round < MAX_TOOL_ROUNDS ? { tools } : {}),
        },
        token,
      );
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          sawText = true;
          stream.markdown(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }
      ok = true;
    } finally {
      let outputTokens = 0;
      if (text) {
        try {
          outputTokens = await model.countTokens(text);
        } catch {
          outputTokens = Math.ceil(text.length / 4);
        }
      }
      await deps.meter.record(
        modelKey,
        round === 0 ? inputTokens : 0,
        outputTokens,
        deps.now(),
        "chat",
        ok,
      );
    }

    if (toolCalls.length === 0) {
      break;
    }

    // Record the assistant turn (text + calls), invoke each tool, and feed
    // results back. toolInvocationToken routes confirmations (e.g. the
    // suggest-bookmark approval) into this chat turn's UI.
    messages.push(
      vscode.LanguageModelChatMessage.Assistant([
        ...(text ? [new vscode.LanguageModelTextPart(text)] : []),
        ...toolCalls,
      ]),
    );
    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      // Accurate, input-aware status — "Searching CMDB for …", not a generic
      // "Running search context …" (pilot).
      stream.progress(describeToolCall(call.name, call.input));
      deps.telemetry.record("chat.toolCall", { tool: call.name });
      if (wireEnabled()) {
        emitWire("tool", "→", `${call.name} (round ${round + 1})`, safeJson(call.input));
      }
      try {
        const result = await vscode.lm.invokeTool(
          call.name,
          { input: call.input, toolInvocationToken: request.toolInvocationToken },
          token,
        );
        const rendered = result.content
          .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "[non-text part]"))
          .join("\n");
        if (wireEnabled()) {
          emitWire("tool", "←", `${call.name} — ${rendered.length} chars`, capDetail(rendered));
        }
        // Completion status: what came back, not just what was attempted —
        // "Search of CMDB: 12 result(s) — continuing…" (pilot).
        stream.progress(describeToolResult(call.name, call.input, rendered));
        resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
      } catch (err) {
        emitWire("tool", "✗", `${call.name} — ${redactError(err).message}`);
        // Tool denied (user rejected a confirmation) or failed — tell the
        // model so it can continue gracefully instead of dying mid-turn.
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(
              `Tool ${call.name} was not completed: ${redactError(err).message}`,
            ),
          ]),
        );
      }
    }
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
  }

  if (!sawText) {
    stream.markdown("_(The model returned no text — try rephrasing.)_");
  }
  return { metadata: { modelId: model.id } };
}

/** Live, silent-auth-only context about the referenced (or sole) site. */
async function buildSiteContext(
  deps: ChatDeps,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<string> {
  const activeProject = deps.projects.active();
  const referenceSources = deps.projects.scope(deps.sources.list());
  const scopedIds = new Set(referenceSources.map((s) => s.id));
  const bookmarkList = deps.bookmarks.list().filter((b) => scopedIds.has(b.sourceId));
  const projectLine = activeProject
    ? `Active project: "${activeProject.name}"${activeProject.description ? ` — ${activeProject.description}` : ""}. Only its sources/bookmarks are listed below.\n`
    : "";
  const referenceBlock = [
    projectLine,
    referenceSources.length
      ? `Reference sources available to the search/get tools (alias in quotes — pass it as the source argument):\n${referenceSources
          .map((s) => {
            const base = `- ${s.alias ? `"${s.alias}" — ` : ""}${s.displayName} (${s.type}, ${s.deployment})${s.description ? `: ${s.description}` : ""}`;
            if (!["mssql", "postgres", "mysql", "mongodb"].includes(s.type)) return base;
            const schema = deps.schemas.getSync(s.id);
            const note = !schema
              ? "schema not loaded yet — db_schema loads it on first use"
              : schema.semanticState === "indexed"
                ? "schema semantically indexed — db_schema(topic) maps concepts like ownership to columns"
                : "schema loaded, no semantic index — offer index_db_schema";
            return `${base} [${note}]`;
          })
          .join("\n")}`
      : "No reference sources configured (the user can add Confluence/Jira/LDAP via 'Add Context Source').",
    bookmarkList.length
      ? `Saved bookmarks (run by name with run_bookmark):\n${bookmarkList
          .map((b) => `- ${b.name} [${b.kind}] on ${deps.sources.get(b.sourceId)?.displayName ?? "?"}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const all = deps.sites.list();
  if (all.length === 0) {
    return `${referenceBlock}\nThe user has no SharePoint connections configured yet. Suggest running 'AI SharePoint: Connect SharePoint Site' when site access would help.`;
  }

  const urlInPrompt = deps.access.extractSiteUrl(request.prompt);
  const promptLc = request.prompt.toLowerCase();
  const namedConn = all.find(
    (c) => c.displayName.length > 2 && promptLc.includes(c.displayName.toLowerCase()),
  );
  // A site the user explicitly pointed at (URL or name) vs. the sole-connection
  // fallback — only the former forces a read.
  const explicitConn = deps.access.resolve(urlInPrompt) ?? namedConn;
  const conn = explicitConn ?? (all.length === 1 ? all[0] : undefined);

  const inventory = all
    .map((c) => `- ${c.displayName} (${c.siteUrl}) — role: ${c.role}`)
    .join("\n");

  if (!conn) {
    return `${referenceBlock}\nConfigured connections:\n${inventory}\n(No single site could be inferred for this question — ask the user to name one if needed.)`;
  }

  // Read the live site ONLY on actual site evidence: one is explicitly
  // referenced (URL or name), or the prompt uses SHAREPOINT-SPECIFIC
  // vocabulary. The vocabulary is deliberately narrow — generic words like
  // "list", "page", or "document" appear constantly in questions aimed at
  // OTHER sources ("list the top Splunk errors"), and the old broad match
  // (plus a no-reference-sources bypass) kept showing "Reading <site>…" on
  // every turn regardless of what was being done (pilot, twice). Skipping
  // costs nothing: the tools are declared on every request, so the model
  // calls site_overview/list_pages itself — with its own accurate status —
  // whenever the question turns out to concern the site.
  const siteVocab =
    /\b(sharepoint|site|sites|subsite|web ?parts?|site ?(?:map|nav)|navigation|home ?page|landing ?page|librar(?:y|ies))\b/i.test(
      request.prompt,
    );
  if (!explicitConn && !siteVocab) {
    return [
      referenceBlock,
      `Configured SharePoint connections (not read live — call site_overview / list_pages if the question turns out to concern a site):\n${inventory}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  try {
    stream.progress(`Reading ${conn.displayName}…`);
    const overview = await deps.access
      .clientFor(conn, { silent: true })
      .getSiteOverview(conn.siteUrl);
    const lists = overview.lists
      .slice(0, 20)
      .map((l) => `  - ${l.displayName}${l.template ? ` (${l.template})` : ""}`)
      .join("\n");
    const pages = overview.pages
      ?.slice(0, 20)
      .map((p) => `  - ${p.title}`)
      .join("\n");
    return [
      referenceBlock,
      `Configured connections:\n${inventory}`,
      `Active site: ${overview.site.displayName} (${overview.site.webUrl}) — role: ${conn.role}`,
      overview.site.description ? `Description: ${overview.site.description}` : "",
      `Lists/libraries:\n${lists || "  (none visible)"}`,
      pages !== undefined ? `Pages:\n${pages || "  (none)"}` : "Pages: unavailable",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    deps.log.warn(`Chat context read failed: ${redactError(err).message}`);
    return `${referenceBlock}\nConfigured connections:\n${inventory}\n(Live read of "${conn.displayName}" failed — likely sign-in needed. The user can run "AI SharePoint: Test Site Connection".)`;
  }
}

/** Compact plain-text rendering of recent turns for conversational continuity. */
function formatHistory(context: vscode.ChatContext): string {
  const turns: string[] = [];
  for (const turn of context.history.slice(-6)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      turns.push(`User: ${turn.prompt.slice(0, 600)}`);
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) =>
          part instanceof vscode.ChatResponseMarkdownPart
            ? part.value.value
            : "",
        )
        .join("")
        .slice(0, 600);
      if (text) turns.push(`Assistant: ${text}`);
    }
  }
  return turns.join("\n");
}
