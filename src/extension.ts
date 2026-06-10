import * as vscode from "vscode";
import { SecretStore } from "./secrets/secretStore";
import { UsageMeter } from "./copilot/meter";
import { CopilotService } from "./copilot/copilotService";
import { UsageStatusBar } from "./ui/statusBar";
import { MsalPublicClientProvider } from "./auth/msalPublicProvider";
import { SharePointClient } from "./auth/sharePointClient";
import { SitesStore } from "./auth/sitesStore";

/** Host clock, isolated so it's the single source of "now" (ISO, UTC). */
const nowIso = () => new Date().toISOString();

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("AI SharePoint");
  const secrets = new SecretStore(context.secrets);
  const meter = new UsageMeter(context.globalState);
  const copilot = new CopilotService(meter);
  const sites = new SitesStore(context.workspaceState);
  const statusBar = new UsageStatusBar(meter, nowIso);

  context.subscriptions.push(output, meter, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiSharePoint.listModels", () =>
      listModels(copilot, output),
    ),
    vscode.commands.registerCommand("aiSharePoint.askCopilot", () =>
      askCopilot(copilot, output),
    ),
    vscode.commands.registerCommand("aiSharePoint.connectSite", () =>
      connectSite(secrets, sites, output),
    ),
    vscode.commands.registerCommand("aiSharePoint.showUsage", () =>
      showUsage(meter),
    ),
    vscode.commands.registerCommand("aiSharePoint.resetUsage", async () => {
      await meter.reset();
      void vscode.window.showInformationMessage("Copilot usage meter reset.");
    }),
  );
}

export function deactivate(): void {
  // Subscriptions are disposed by the host.
}

async function listModels(
  copilot: CopilotService,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    const models = await copilot.listModels();
    if (models.length === 0) {
      void vscode.window.showWarningMessage(
        "No Copilot models available. Is GitHub Copilot installed and signed in?",
      );
      return;
    }
    output.show(true);
    output.appendLine("Available Copilot models:");
    for (const m of models) {
      output.appendLine(
        `  • ${m.name} (${m.family}) — ${m.tier} ${m.badge}, max input ${m.maxInputTokens} tokens`,
      );
    }
    await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.name,
        description: `${m.tier} ${m.badge}`,
        detail: `family ${m.family} · max input ${m.maxInputTokens} tokens`,
      })),
      { title: "Copilot models (relative premium-request cost)" },
    );
  } catch (err) {
    reportError(err, "List models");
  }
}

async function askCopilot(
  copilot: CopilotService,
  output: vscode.OutputChannel,
): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    title: "Ask Copilot (metered)",
    prompt: "Your prompt — usage will be metered against your allowance.",
  });
  if (!prompt) {
    return;
  }
  output.show(true);
  output.appendLine(`\n> ${prompt}\n`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Copilot…" },
      async (_p, token) => {
        const { modelId, premiumUnits } = await copilot.ask(
          prompt,
          (chunk) => output.append(chunk),
          nowIso(),
          token,
          "askCopilot",
        );
        output.appendLine(
          `\n\n[${modelId} · +${premiumUnits} premium unit(s)]`,
        );
      },
    );
  } catch (err) {
    reportError(err, "Ask Copilot");
  }
}

async function connectSite(
  secrets: SecretStore,
  sites: SitesStore,
  output: vscode.OutputChannel,
): Promise<void> {
  const siteUrl = await vscode.window.showInputBox({
    title: "Connect SharePoint Site",
    prompt: "Site URL, e.g. https://contoso.sharepoint.com/sites/Marketing",
    validateInput: (v) =>
      /^https:\/\/[^/]+\.sharepoint\.com(\/.*)?$/i.test(v.trim())
        ? undefined
        : "Enter a valid https://*.sharepoint.com URL",
  });
  if (!siteUrl) {
    return;
  }
  const trimmed = siteUrl.trim();

  const role = await vscode.window.showQuickPick(
    [
      { label: "managed", description: "full sync / Git lifecycle" },
      { label: "reference", description: "read-only context (§9)" },
    ],
    { title: "Connection role" },
  );
  if (!role) {
    return;
  }

  const authority = vscode.workspace
    .getConfiguration("aiSharePoint")
    .get<string>("auth.tenantAuthority", "https://login.microsoftonline.com/common");
  const cacheHandle = `msal-cache:${trimmed}`;
  const provider = new MsalPublicClientProvider(secrets, cacheHandle, authority);
  const client = new SharePointClient(provider);

  try {
    const site = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Signing in and resolving site…",
      },
      () => client.getSite(trimmed),
    );
    await sites.upsert({
      siteUrl: trimmed,
      displayName: site.displayName,
      role: role.label as "managed" | "reference",
      authProviderId: provider.id,
      cacheHandle,
    });
    output.appendLine(
      `Connected: "${site.displayName}" (${site.webUrl}) [${role.label}]`,
    );
    void vscode.window.showInformationMessage(
      `Connected to "${site.displayName}".`,
    );
  } catch (err) {
    reportError(err, "Connect site");
  }
}

function showUsage(meter: UsageMeter): void {
  const used = meter.premiumUnitsThisMonth(nowIso());
  const today = meter.requestsToday(nowIso());
  void vscode.window.showInformationMessage(
    `Copilot usage (estimate): ~${used.toFixed(
      1,
    )} premium units this month, ${today} request(s) today.`,
  );
}

function reportError(err: unknown, context: string): void {
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`${context}: ${message}`);
}
