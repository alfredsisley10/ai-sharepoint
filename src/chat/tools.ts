import * as vscode from "vscode";
import { SitesStore } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { UsageMeter } from "../copilot/meter";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";
import { describeColumn, summarizeCanvas, summarizePageContent, PageContentSummary } from "./siteInspect";
import { resolveSharePointOwners } from "../auth/sharePointOwnership";
import { UserDirectory, activeFromDirectory, contactOf } from "../context/userDirectory";

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

/** Run `fn` over `items` with at most `limit` concurrent executions, preserving
 *  input order. Bounds Graph fan-out when a content scan fetches many pages. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function registerLanguageModelTools(
  sites: SitesStore,
  access: SiteAccess,
  meter: UsageMeter,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  now: () => string,
  /** Email-keyed user directory (from a configured LDAP source), so SharePoint
   *  page owners can be validated as current active employees. */
  emailDirectory?: () => { dir: UserDirectory; label: string } | undefined,
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
      if (releaseExpired()) return text(expiredNotice());
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

    // Ownership — resolve a modern page's effective owner from its version
    // history (most recently-active editor who is a current active employee).
    vscode.lm.registerTool(
      "aisharepoint_resolve_sharepoint_page_owner",
      guarded<{ site?: string; pageId?: string; itemId?: string }>(
        "aisharepoint_resolve_sharepoint_page_owner",
        "Resolving SharePoint page owner",
        async (input) => {
          const conn = resolveOrExplain(input.site);
          if (!input.pageId?.trim() && !input.itemId?.trim()) {
            return "A pageId (or the Site Pages list itemId) is required — list pages first.";
          }
          const client = access.clientFor(conn, { silent: true });
          const site = await client.getSite(conn.siteUrl);
          const editors = await client.getPageEditors(site.id, input.pageId?.trim() ?? input.itemId!.trim(), input.itemId?.trim());
          if (!editors.length) {
            return "Couldn't read this page's version history (the Site Pages library or the versions endpoint may be restricted, or the id isn't a Site Pages list-item id — try passing the numeric itemId). No owner resolved.";
          }
          const directory = emailDirectory?.();
          const resolution = await resolveSharePointOwners(
            editors,
            directory ? activeFromDirectory(directory.dir) : async () => true,
            { nowMs: Date.parse(now()) },
          );
          const lines = ["# SharePoint page owner"];
          if (resolution.owners.length && directory) {
            const rec = await directory.dir(resolution.owners[0]);
            lines.push(`- Owner: ${rec?.displayName ?? resolution.owners[0]}${contactOf(rec) ? ` <${contactOf(rec)}>` : ` <${resolution.owners[0]}>`}${rec?.sam ? ` (${rec.sam})` : ""}`);
          } else {
            lines.push(`- Owner: ${resolution.owners[0] ?? "(none determined)"}`);
          }
          lines.push(`- Basis: ${resolution.basis}${resolution.note ? ` — ${resolution.note}` : ""}`);
          if (resolution.considered?.length) {
            lines.push(`- Top recent editors: ${resolution.considered.slice(0, 5).map((c) => `${c.sam} (${c.count}×)`).join(", ")}`);
          }
          lines.push(
            "",
            directory
              ? `Active-employee validation: ON via ${directory.label} (email-keyed; ranked by recency-weighted edits).`
              : "No LDAP directory configured — ranked by recency-weighted edits, not filtered by who is still active.",
          );
          return lines.join("\n");
        },
      ),
    ),

    // Pilot: an authoritative component-by-page breakdown must work for
    // ANY connection — reference (read-only) included. Managed onboarding
    // is for CHANGING a site, never a prerequisite for reading it.
    vscode.lm.registerTool(
      "aisharepoint_inspect_site",
      guarded<{ site?: string; page?: string }>(
        "aisharepoint_inspect_site",
        "Inspecting site architecture (read-only)",
        async (input) => {
          const conn = resolveOrExplain(input.site);
          const client = access.clientFor(conn, { silent: true });
          const site = await client.getSite(conn.siteUrl);
          if (input.page?.trim()) {
            const pages = await client.getPages(site.id);
            const refRaw = input.page.trim();
            const ref = refRaw.toLowerCase();
            const match =
              pages.find((p) => p.id === refRaw || p.title.toLowerCase() === ref) ??
              pages.find((p) => p.title.toLowerCase().includes(ref));
            if (!match) {
              return `No page matched "${refRaw}". Pages: ${pages
                .map((p) => p.title)
                .join("; ")
                .slice(0, 1500)}`;
            }
            const content = await client.getPageContent(site.id, match.id);
            return JSON.stringify(
              {
                page: {
                  title: match.title,
                  url: match.webUrl,
                  layout: content.pageLayout ?? null,
                },
                canvas: summarizeCanvas(content.canvasLayout),
              },
              null,
              2,
            );
          }
          const INSPECT_MAX_LISTS = 20;
          const INSPECT_MAX_COLUMNS = 40;
          const [lists, pages] = await Promise.all([
            client.getLists(site.id),
            client.getPages(site.id).catch(() => undefined),
          ]);
          const withColumns = [];
          for (const l of lists.slice(0, INSPECT_MAX_LISTS)) {
            const cols = (await client
              .getListColumns(site.id, l.id)
              .catch(() => [])) as Array<Record<string, unknown>>;
            withColumns.push({
              name: l.displayName,
              template: l.template ?? null,
              url: l.webUrl,
              columns: cols.slice(0, INSPECT_MAX_COLUMNS).map(describeColumn),
              ...(cols.length > INSPECT_MAX_COLUMNS
                ? { columnsTruncated: cols.length - INSPECT_MAX_COLUMNS }
                : {}),
            });
          }
          return JSON.stringify(
            {
              site: {
                name: site.displayName,
                url: site.webUrl,
                role: conn.role,
                ...(conn.role === "reference"
                  ? {
                      note: "Read-only reference connection — inspection is fully available; managed onboarding is only needed to CHANGE the site.",
                    }
                  : {}),
              },
              lists: withColumns,
              ...(lists.length > INSPECT_MAX_LISTS
                ? { listsTruncated: lists.length - INSPECT_MAX_LISTS }
                : {}),
              pages:
                pages?.map((p) => ({ title: p.title, url: p.webUrl })) ??
                "unavailable (tenant restricts the Pages API)",
              tip: 'For a page\'s full section/web-part breakdown, call inspect_site again with page: "<title>".',
            },
            null,
            2,
          );
        },
      ),
    ),

    // Full-site content scan (read-only): walk EVERY modern page and extract
    // its rendered content + web-part inventory, so the model can review the
    // whole site for duplicative / out-of-date / confusing content. Works for
    // reference and managed connections alike — no onboarding required.
    vscode.lm.registerTool(
      "aisharepoint_scan_site_content",
      guarded<{ site?: string; maxPages?: number }>(
        "aisharepoint_scan_site_content",
        "Scanning every page's content (read-only)",
        async (input) => {
          const conn = resolveOrExplain(input.site);
          const client = access.clientFor(conn, { silent: true });
          const site = await client.getSite(conn.siteUrl);
          let pages;
          try {
            pages = await client.getPages(site.id);
          } catch {
            return JSON.stringify(
              {
                site: { name: site.displayName, url: site.webUrl },
                pages:
                  "unavailable — this tenant restricts the Graph Pages API, so page content cannot be scanned. Lists/columns are still available via inspect_site.",
              },
              null,
              2,
            );
          }
          if (pages.length === 0) {
            return `Site "${site.displayName}" has no modern pages to scan (or none are visible to this account).`;
          }
          const HARD_CAP = 100;
          const cap = Math.min(
            input.maxPages && input.maxPages > 0 ? input.maxPages : 50,
            HARD_CAP,
          );
          const target = pages.slice(0, cap);
          const scanned = await mapPool(target, 5, async (p): Promise<PageContentSummary> => {
            try {
              const content = await client.getPageContent(site.id, p.id);
              return summarizePageContent(
                { title: p.title, webUrl: p.webUrl, lastModified: p.lastModified },
                content,
              );
            } catch (err) {
              return {
                title: p.title,
                url: p.webUrl,
                ...(p.lastModified ? { lastModified: p.lastModified } : {}),
                headings: [],
                text: `(content unavailable: ${redactError(err).message})`,
                links: [],
                webParts: [],
                embeddedLists: [],
                webPartCount: 0,
              };
            }
          });
          // Site-wide web-part histogram — a quick read on composition.
          const histogram = new Map<string, number>();
          for (const pg of scanned)
            for (const wp of pg.webParts)
              histogram.set(wp.type, (histogram.get(wp.type) ?? 0) + wp.count);
          return JSON.stringify(
            {
              site: { name: site.displayName, url: site.webUrl, role: conn.role },
              pageCount: pages.length,
              scannedPages: scanned.length,
              ...(pages.length > cap
                ? {
                    truncated: pages.length - cap,
                    note: `Only the first ${cap} pages were scanned; call again with maxPages to widen.`,
                  }
                : {}),
              webPartHistogram: [...histogram.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => ({ type, count })),
              pages: scanned,
              analysisHint:
                "Review ACROSS pages: DUPLICATIVE content (near-identical headings/text/links, or several pages on one topic), OUT-OF-DATE content (stale lastModified, superseded topics, dead-looking links), and CONFUSING overlap. Cite page titles + urls in every finding and propose concrete cleanup (merge, archive, update, or delete).",
            },
            null,
            2,
          );
        },
      ),
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
