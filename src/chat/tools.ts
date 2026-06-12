import * as vscode from "vscode";
import { SitesStore } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { UsageMeter } from "../copilot/meter";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * Language Model Tools (ADR-0017 surface 1): read-only capabilities Copilot
 * agent mode can auto-invoke and users can #-reference. All tools are strictly
 * read-only (PLAN §8 guardrails) — there is no write path to SharePoint in
 * this release. Site reads use silent auth only, so an agent loop can never
 * pop a browser window; sign-in happens through explicit user commands.
 */

interface SiteToolInput {
  /** Site URL or display name of a configured connection. */
  site?: string;
}

function text(parts: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(parts),
  ]);
}

export function registerLanguageModelTools(
  sites: SitesStore,
  access: SiteAccess,
  meter: UsageMeter,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  now: () => string,
): vscode.Disposable[] {
  const guarded = <T>(
    name: string,
    invocationMessage: string,
    run: (input: T, token: vscode.CancellationToken) => Promise<string>,
  ): vscode.LanguageModelTool<T> => ({
    prepareInvocation() {
      return { invocationMessage };
    },
    async invoke(options, token) {
      telemetry.record("tool.invoke", { tool: name });
      try {
        return text(await run(options.input, token));
      } catch (err) {
        errors.capture(`tool:${name}`, err);
        return text(
          `The ${name} tool failed: ${redactError(err).message}. ` +
            `If sign-in is required, ask the user to run "AI SharePoint: Test Site Connection".`,
        );
      }
    },
  });

  const resolveOrExplain = (ref?: string) => {
    const conn = access.resolve(ref);
    if (!conn) {
      const all = sites.list();
      if (all.length === 0) {
        throw new Error(
          'No SharePoint connections are configured. Ask the user to run "AI SharePoint: Connect SharePoint Site".',
        );
      }
      throw new Error(
        `Could not match "${ref ?? ""}" to a configured connection. Available: ${all
          .map((c) => `${c.displayName} (${c.siteUrl})`)
          .join("; ")}.`,
      );
    }
    return conn;
  };

  return [
    vscode.lm.registerTool(
      "aisharepoint_list_connections",
      guarded<Record<string, never>>("aisharepoint_list_connections", "Listing SharePoint connections", async () => {
        const all = sites.list();
        if (all.length === 0) {
          return 'No SharePoint connections configured. The user can add one with "AI SharePoint: Connect SharePoint Site".';
        }
        return JSON.stringify(
          all.map((c) => ({
            name: c.displayName,
            url: c.siteUrl,
            role: c.role,
            verified: Boolean(c.lastVerifiedAt),
          })),
          null,
          2,
        );
      }),
    ),

    vscode.lm.registerTool(
      "aisharepoint_site_overview",
      guarded<SiteToolInput>("aisharepoint_site_overview", "Reading SharePoint site overview", async (input) => {
        const conn = resolveOrExplain(input.site);
        const client = access.clientFor(conn, { silent: true });
        const overview = await client.getSiteOverview(conn.siteUrl);
        return JSON.stringify(
          {
            site: {
              name: overview.site.displayName,
              url: overview.site.webUrl,
              description: overview.site.description ?? null,
              role: conn.role,
            },
            lists: overview.lists.map((l) => ({
              name: l.displayName,
              template: l.template ?? null,
              url: l.webUrl,
            })),
            pages:
              overview.pages?.map((p) => ({
                title: p.title,
                url: p.webUrl,
                lastModified: p.lastModified ?? null,
              })) ?? "unavailable (tenant restricts the Pages API)",
          },
          null,
          2,
        );
      }),
    ),

    vscode.lm.registerTool(
      "aisharepoint_list_pages",
      guarded<SiteToolInput>("aisharepoint_list_pages", "Listing SharePoint pages", async (input) => {
        const conn = resolveOrExplain(input.site);
        const client = access.clientFor(conn, { silent: true });
        const site = await client.getSite(conn.siteUrl);
        const pages = await client.getPages(site.id);
        if (pages.length === 0) {
          return `Site "${site.displayName}" has no modern pages (or none are visible to this account).`;
        }
        return JSON.stringify(
          pages.map((p) => ({
            title: p.title,
            url: p.webUrl,
            lastModified: p.lastModified ?? null,
          })),
          null,
          2,
        );
      }),
    ),

    vscode.lm.registerTool(
      "aisharepoint_copilot_usage",
      guarded<Record<string, never>>("aisharepoint_copilot_usage", "Checking Copilot activity", async () => {
        // One clock read so all figures come from the same month/day window.
        const at = now();
        return JSON.stringify(
          {
            disclaimer:
              "Factual local counts of the requests this extension made. Premium-request consumption against the user's plan is NOT tracked (no authoritative local source) — the GitHub billing/plan page is.",
            requestsThisMonth: meter.requestsThisMonth(at),
            failuresThisMonth: meter.failuresThisMonth(at),
            requestsToday: meter.requestsToday(at),
            byModel: meter.byModelThisMonth(at),
          },
          null,
          2,
        );
      }),
    ),
  ];
}
