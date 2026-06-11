import * as vscode from "vscode";
import { SitesStore } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { SiteOverview } from "../auth/sharePointClient";
import { CopilotService } from "../copilot/copilotService";
import { UsageMeter } from "../copilot/meter";
import { BudgetGuard, BudgetBlockedError } from "../copilot/budget";
import { ContextSourcesStore } from "../context/sourcesStore";
import { BookmarksStore } from "../context/bookmarksStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { adviceFor } from "../core/errors";
import { Logger } from "../core/log";

export const PARTICIPANT_ID = "aiSharePoint.sharepoint";

const INSTRUCTIONS = [
  "You are the AI SharePoint assistant inside Visual Studio Code.",
  "You help users with SharePoint Online sites AND the read-only reference sources they have",
  "connected (Confluence, Jira, LDAP/Active Directory). You have TOOLS — use them instead of",
  "guessing: search_context queries a reference source (free text, or raw CQL/JQL/LDAP filter),",
  "get_context_item fetches one page/issue/directory entry, list_sources and list_bookmarks show",
  "what is available, run_bookmark executes a saved query by name, and site_overview/list_pages",
  "read SharePoint sites. For research tasks (e.g. aggregating content about a topic), run one or",
  "more searches, synthesize the findings with links, and — when a query looks reusable — call",
  "suggest_bookmark to propose saving it; the user approves in a confirmation dialog.",
  "Your access is strictly READ-ONLY: never claim to have changed anything. Users apply changes",
  "via the extension's write-back flow ('Pull Site to Repository' → edit/commit → 'Apply",
  "Repository to SharePoint'), which is previewed, snapshot-guarded, and human-approved — when",
  "asked to change a site, draft the exact repo file edits and point at that flow.",
  "Prefer SharePoint's no-code, out-of-the-box features so sites stay maintainable. Be concise.",
].join(" ");

/** Cap on tool-calling rounds per turn (each round is a metered request). */
const MAX_TOOL_ROUNDS = 4;

interface ChatDeps {
  ctx: vscode.ExtensionContext;
  sites: SitesStore;
  access: SiteAccess;
  sources: ContextSourcesStore;
  bookmarks: BookmarksStore;
  copilot: CopilotService;
  meter: UsageMeter;
  budget: BudgetGuard;
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
      if (err instanceof BudgetBlockedError) {
        renderBudgetBlocked(stream, err);
        return { errorDetails: { message: err.userSummary ?? err.message } };
      }
      const code = deps.errors.capture("chat", err);
      const safe = redactError(err);
      const advice = adviceFor(code);
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
        { prompt: "/usage", label: "Check Copilot usage" },
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
      "| `/usage` | This extension's Copilot usage vs. your budget |",
      "| `/help` | This help |",
      "",
      "Ask anything else in natural language — I can **search your reference sources too**:",
      "_“search Confluence for content about AI automation and summarize it”_,",
      "_“what's in the IT Help queue?”_ (runs your bookmarks), or",
      "_“draft a landing-page outline for our product catalog”_. When a search proves useful,",
      "I can propose saving it as a **bookmark** — you approve before anything persists.",
      "The same tools are `#`-referenceable in Copilot **agent mode** (`#spSearchContext`, …).",
      "",
      "> Every model request is metered against your configured allowance — watch the gauge in the status bar.",
    ].join("\n"),
  );
}

function renderUsage(deps: ChatDeps, stream: vscode.ChatResponseStream): void {
  const nowIso = deps.now();
  const verdict = deps.budget.evaluate(0, nowIso);
  const byModel = deps.meter.byModelThisMonth(nowIso).slice(0, 5);
  const lines = [
    `**Copilot usage (this extension's estimate — not the live GitHub bill):**`,
    "",
    `- This month: **~${deps.meter.premiumUnitsThisMonth(nowIso).toFixed(1)}** of ${verdict.allowance} premium units (**${verdict.usedPct.toFixed(0)}%**)`,
    `- Today: **${deps.meter.requestsToday(nowIso)}** request(s)`,
    `- Budget: soft ${verdict.softPct}% / hard ${verdict.hardPct}% (${verdict.mode})`,
  ];
  if (byModel.length > 0) {
    lines.push("", "| Model | Requests | Premium units |", "|---|---|---|");
    for (const m of byModel) {
      lines.push(`| ${m.key} | ${m.requests} | ${m.premiumUnits.toFixed(1)} |`);
    }
  }
  stream.markdown(lines.join("\n"));
  stream.button({
    command: "aiSharePoint.showUsage",
    title: "Open usage dashboard",
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

function renderBudgetBlocked(
  stream: vscode.ChatResponseStream,
  err: BudgetBlockedError,
): void {
  stream.markdown(
    [
      `🛑 **Copilot budget cap reached.** ~${err.verdict.usedPct.toFixed(0)}% of your monthly allowance is used; the hard cap is ${err.verdict.hardPct}%.`,
      "",
      "Options: raise the cap in settings, switch `budget.mode` to `warn`, or wait for the next cycle.",
      "_The palette command “Ask Copilot” also offers a confirmed one-time override._",
    ].join("\n"),
  );
  stream.button({
    command: "aiSharePoint.openBudgetSettings",
    title: "Adjust budget settings",
  });
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
  const multiplier = deps.meter.multiplierFor(modelKey);
  const nowIso = deps.now();

  // Hard cap throws (caught by the handler); soft cap warns once up front.
  const verdict = deps.budget.enforce(multiplier, nowIso);
  if (verdict.state === "soft") {
    stream.markdown(
      `> ⚠️ Heads-up: ~${verdict.usedPct.toFixed(0)}% of your monthly Copilot allowance is used (soft cap ${verdict.softPct}%).\n\n`,
    );
  }

  const contextBlock = await buildSiteContext(deps, request, stream);
  const history = formatHistory(context);
  const prompt = [
    INSTRUCTIONS,
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

  let totalUnits = 0;
  let sawText = false;
  for (let round = 0; ; round++) {
    // Every round is its own premium request — re-check the budget so a tool
    // loop cannot blast through the hard cap mid-turn.
    if (round > 0 && deps.budget.evaluate(multiplier, deps.now()).state === "hard" && verdict.mode === "block") {
      stream.markdown("\n\n_Stopped: the Copilot budget hard cap was reached mid-conversation._");
      break;
    }

    let text = "";
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let ok = false;
    try {
      const response = await model.sendRequest(
        messages,
        {
          justification: "AI SharePoint chat (metered against your Copilot allowance)",
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
      totalUnits += multiplier;
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
      stream.progress(`Running ${call.name.replace("aisharepoint_", "").replace(/_/g, " ")}…`);
      deps.telemetry.record("chat.toolCall", { tool: call.name });
      try {
        const result = await vscode.lm.invokeTool(
          call.name,
          { input: call.input, toolInvocationToken: request.toolInvocationToken },
          token,
        );
        resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
      } catch (err) {
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
  if (totalUnits > 0) {
    stream.markdown(
      `\n\n---\n_~${totalUnits} premium unit(s) metered this turn (estimate)._`,
    );
  }
  return { metadata: { modelId: model.id } };
}

/** Live, silent-auth-only context about the referenced (or sole) site. */
async function buildSiteContext(
  deps: ChatDeps,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<string> {
  const referenceSources = deps.sources.list();
  const bookmarkList = deps.bookmarks.list();
  const referenceBlock = [
    referenceSources.length
      ? `Reference sources available to the search/get tools:\n${referenceSources
          .map((s) => `- ${s.displayName} (${s.type}, ${s.deployment})`)
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
  const conn = deps.access.resolve(urlInPrompt) ?? (all.length === 1 ? all[0] : undefined);

  const inventory = all
    .map((c) => `- ${c.displayName} (${c.siteUrl}) — role: ${c.role}`)
    .join("\n");

  if (!conn) {
    return `${referenceBlock}\nConfigured connections:\n${inventory}\n(No single site could be inferred for this question — ask the user to name one if needed.)`;
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
