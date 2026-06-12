import * as vscode from "vscode";
import { SitesStore, SiteConnection } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { SyncConfigStore } from "../sync/syncConfigStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * Site-developer tools (ADR-0021 amendment — the "agent drafts, human
 * applies" gate lifted by pilot direction): @sharepoint can now EXECUTE the
 * implementation pipeline itself — write spec files into the site repo,
 * pull a baseline, launch apply — while every mutating step keeps a human
 * checkpoint: each tool call needs in-chat confirmation, and APPLY still
 * runs the full preview → freshness gate → snapshot → modal-approval flow.
 * The agent never touches SharePoint directly; it only feeds the same
 * guarded pipeline a human would.
 */

import { validateSiteFilePath } from "./siteDevPaths";

const MAX_FILES = 30;
const MAX_FILE_CHARS = 200_000;

function text(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}

export function registerSiteDevTools(
  sites: SitesStore,
  access: SiteAccess,
  syncConfigs: SyncConfigStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const resolveManaged = (ref?: string): SiteConnection => {
    const conn =
      access.resolve(ref) ??
      (sites.list().filter((c) => c.role === "managed").length === 1
        ? sites.list().find((c) => c.role === "managed")
        : undefined);
    if (!conn) {
      throw new Error(
        `No site matched "${ref ?? ""}". Managed sites: ${sites
          .list()
          .filter((c) => c.role === "managed")
          .map((c) => c.displayName)
          .join("; ") || "(none — the user must connect one as managed)"}.`,
      );
    }
    if (conn.role !== "managed") {
      throw new Error(
        `"${conn.displayName}" is a reference connection — implementation needs a managed site.`,
      );
    }
    return conn;
  };

  return [
    vscode.lm.registerTool<{
      site?: string;
      files: Array<{ path: string; content: string }>;
      reason?: string;
    }>("aisharepoint_write_site_files", {
      prepareInvocation(options) {
        const files = options.input.files ?? [];
        return {
          invocationMessage: "Writing site spec files into the repository",
          confirmationMessages: {
            title: `Write ${files.length} file(s) into the site repository?`,
            message: new vscode.MarkdownString(
              [
                "Local repo only — **nothing reaches SharePoint** until you approve an apply preview.",
                "",
                ...files.slice(0, MAX_FILES).map((f) => `- \`${f.path}\` (${f.content?.length ?? 0} chars)`),
                ...(options.input.reason ? ["", `_${options.input.reason}_`] : []),
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_write_site_files" });
        try {
          const conn = resolveManaged(options.input.site);
          const config = syncConfigs.get(conn.siteUrl);
          if (!config?.folder) {
            return text(
              `"${conn.displayName}" has no site repository yet. Ask the user to run "Configure Site Repository (Git)…" on it first, then retry.`,
            );
          }
          const files = (options.input.files ?? []).slice(0, MAX_FILES);
          if (files.length === 0) return text("No files provided.");
          for (const f of files) {
            const pathIssue = validateSiteFilePath(f.path);
            if (pathIssue) return text(`Refused: ${pathIssue}`);
            if (typeof f.content !== "string" || f.content.length > MAX_FILE_CHARS) {
              return text(`Refused: ${f.path} content missing or over ${MAX_FILE_CHARS} chars.`);
            }
            try {
              JSON.parse(f.content);
            } catch {
              return text(`Refused: ${f.path} is not valid JSON — site spec files are JSON (see the pulled examples under lists/ and pages/).`);
            }
          }
          const root = vscode.Uri.file(config.folder);
          for (const f of files) {
            const target = vscode.Uri.joinPath(root, f.path);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, f.path.split("/")[0]));
            await vscode.workspace.fs.writeFile(target, Buffer.from(f.content, "utf8"));
          }
          telemetry.record("siteDev.writeFiles", { count: String(files.length) });
          return text(
            `Wrote ${files.length} file(s) into ${conn.displayName}'s repository. Next: call apply_site — the user reviews the full preview diff and approves before anything changes in SharePoint. (Tip: pull_site first if the repo might be stale.)`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_write_site_files", err);
          return text(`Could not write site files: ${redactError(err).message}`);
        }
      },
    }),
    vscode.lm.registerTool<{ site?: string }>("aisharepoint_pull_site", {
      prepareInvocation: (options) => ({
        invocationMessage: "Pulling the live site into its repository",
        confirmationMessages: {
          title: `Pull "${options.input.site ?? "the site"}" into its repository?`,
          message: new vscode.MarkdownString(
            "Reads the live site and updates the local repo (preview-first; commits only real changes). No SharePoint writes.",
          ),
        },
      }),
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_pull_site" });
        try {
          const conn = resolveManaged(options.input.site);
          await vscode.commands.executeCommand("aiSharePoint.pullSiteToRepo", conn);
          return text(
            `Pull launched for "${conn.displayName}" — the user completes it in the preview dialog. The repository now reflects the live site once they confirm.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_pull_site", err);
          return text(`Pull failed to start: ${redactError(err).message}`);
        }
      },
    }),
    vscode.lm.registerTool<{ site?: string }>("aisharepoint_apply_site", {
      prepareInvocation: (options) => ({
        invocationMessage: "Launching apply-to-SharePoint",
        confirmationMessages: {
          title: `Apply the repository to "${options.input.site ?? "the site"}"?`,
          message: new vscode.MarkdownString(
            "Opens the standard write-back flow: the user sees the **operation-level preview**, deletions stay opt-in, a safety snapshot is taken, and **nothing changes until they approve the dialog**. This is the binding human checkpoint.",
          ),
        },
      }),
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_apply_site" });
        try {
          const conn = resolveManaged(options.input.site);
          await vscode.commands.executeCommand("aiSharePoint.applyRepoToSharePoint", conn);
          return text(
            `Apply flow launched for "${conn.displayName}". The user reviews the preview and approves (or cancels) in the dialog — do NOT claim the site changed; the dialog's outcome decides. Offer to verify with site_overview afterwards.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_apply_site", err);
          return text(`Apply failed to start: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
