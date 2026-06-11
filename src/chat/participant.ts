import * as vscode from "vscode";
import { SitesStore } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { SiteOverview } from "../auth/sharePointClient";
import { CopilotService } from "../copilot/copilotService";
import { UsageMeter } from "../copilot/meter";
import { BudgetGuard, BudgetBlockedError } from "../copilot/budget";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { adviceFor } from "../core/errors";
import { Logger } from "../core/log";

export const PARTICIPANT_ID = "aiSharePoint.sharepoint";

const INSTRUCTIONS = [
  "You are the AI SharePoint assistant inside Visual Studio Code.",
  "You help users understand and manage SharePoint Online sites. YOUR access is READ-ONLY:",
  "you can describe sites, lists, and pages from the provided context, answer governance questions,",
  "and draft changes — but you must never claim to have changed anything in SharePoint yourself.",
  "Users CAN apply changes via the extension's write-back flow: edit the site repository files",
  "(lists/*.json, pages/*.json from 'Pull Site to Repository'), commit, then run",
  "'AI SharePoint: Apply Repository to SharePoint' — every change is previewed, snapshot-guarded,",
  "and human-approved. When asked to make a change, draft the exact file edits and point the user",
  "to that flow. Prefer SharePoint's no-code, out-of-the-box features (modern pages, standard web",
  "parts, lists) so sites stay maintainable by end users. Be concise and practical.",
].join(" ");

interface ChatDeps {
  ctx: vscode.ExtensionContext;
  sites: SitesStore;
  access: SiteAccess;
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
      "Ask anything else in natural language — e.g. _“what's on my Marketing site?”_ or",
      "_“draft a landing-page outline for our product catalog”_. In **agent mode**, Copilot can also call",
      "the `#aisharepoint` tools (connections, site overview, pages, usage) automatically.",
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
  const model = request.model ?? undefined;

  // Soft-cap heads-up before spending (hard cap throws from enforce()).
  const nowIso = deps.now();
  const multiplier = model
    ? deps.meter.multiplierFor(model.family || model.id)
    : 1;
  const verdict = deps.budget.evaluate(multiplier, nowIso);
  if (verdict.state === "soft") {
    stream.markdown(
      `> ⚠️ Heads-up: ~${verdict.usedPct.toFixed(0)}% of your monthly Copilot allowance is used (soft cap ${verdict.softPct}%).\n\n`,
    );
  }

  const contextBlock = await buildSiteContext(deps, request, stream);
  const history = formatHistory(context);

  const prompt = [
    INSTRUCTIONS,
    contextBlock ? `\n## Connected SharePoint context\n${contextBlock}` : "",
    history ? `\n## Conversation so far\n${history}` : "",
    `\n## User request\n${request.prompt}`,
  ].join("\n");

  const result = await deps.copilot.ask(
    {
      prompt,
      label: "chat",
      model,
      onChunk: (chunk) => stream.markdown(chunk),
      token,
    },
    deps.now,
  );

  if (result.premiumUnits > 0) {
    stream.markdown(
      `\n\n---\n_~${result.premiumUnits} premium unit(s) metered (estimate)._`,
    );
  }
  return { metadata: { modelId: result.modelId } };
}

/** Live, silent-auth-only context about the referenced (or sole) site. */
async function buildSiteContext(
  deps: ChatDeps,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<string> {
  const all = deps.sites.list();
  if (all.length === 0) {
    return "The user has no SharePoint connections configured yet. Suggest running 'AI SharePoint: Connect SharePoint Site' when site access would help.";
  }

  const urlInPrompt = deps.access.extractSiteUrl(request.prompt);
  const conn = deps.access.resolve(urlInPrompt) ?? (all.length === 1 ? all[0] : undefined);

  const inventory = all
    .map((c) => `- ${c.displayName} (${c.siteUrl}) — role: ${c.role}`)
    .join("\n");

  if (!conn) {
    return `Configured connections:\n${inventory}\n(No single site could be inferred for this question — ask the user to name one if needed.)`;
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
    return `Configured connections:\n${inventory}\n(Live read of "${conn.displayName}" failed — likely sign-in needed. The user can run "AI SharePoint: Test Site Connection".)`;
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
