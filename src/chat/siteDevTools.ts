import * as vscode from "vscode";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";
import { SitesStore, SiteConnection } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { SyncConfigStore } from "../sync/syncConfigStore";
import { openOrInitRepository } from "../sync/vscodeGit";
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
        if (releaseExpired()) return text(expiredNotice());
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
          const written: string[] = [];
          for (const f of files) {
            const target = vscode.Uri.joinPath(root, f.path);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, f.path.split("/")[0]));
            await vscode.workspace.fs.writeFile(target, Buffer.from(f.content, "utf8"));
            written.push(target.fsPath);
          }
          telemetry.record("siteDev.writeFiles", { count: String(files.length) });
          // Commit exactly what was written (scoped staging — the user's own
          // uncommitted edits are untouched): apply's clean-tree guard would
          // otherwise block with files the AGENT left dirty (pilot: the user
          // was then sent hunting for a preview that never opened).
          try {
            const repo = await openOrInitRepository(root);
            await repo.add(written);
            await repo.commit(
              `@sharepoint drafted ${files.length} site spec file(s)${
                options.input.reason ? ` — ${options.input.reason.slice(0, 72)}` : ""
              }`,
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_write_site_files", err);
            return text(
              `Wrote ${files.length} file(s) into ${conn.displayName}'s repository but could NOT commit them (${redactError(err).message}). apply_site requires a clean tree — ask the user to commit these files in the Source Control view, then call apply_site.`,
            );
          }
          return text(
            `Wrote and committed ${files.length} file(s) into ${conn.displayName}'s repository (local only — nothing reached SharePoint). Next: call apply_site — a PREVIEW DOCUMENT opens as an editor tab listing every operation, then a MODAL CONFIRMATION asks the user to apply. (Tip: pull_site first if the repo might be stale.)`,
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
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_pull_site" });
        try {
          const conn = resolveManaged(options.input.site);
          const outcome = await vscode.commands.executeCommand<string | undefined>(
            "aiSharePoint.pullSiteToRepo",
            conn,
          );
          // Relay what ACTUALLY happened — never describe UI that didn't open.
          if (outcome === "up-to-date") {
            return text(`"${conn.displayName}"'s repository already matches the live site — nothing to pull.`);
          }
          if (outcome === "no-repo") {
            return text(`Pull did NOT run: "${conn.displayName}" has no repository configured yet (the user was offered "Configure Repository…"). Once configured, call pull_site again.`);
          }
          if (outcome === "blocked") {
            return text("Pull was blocked by the safety scan (credential-shaped or oversize content) — the user saw the error; nothing was written.");
          }
          if (outcome === "cancelled" || outcome === undefined) {
            return text("The user closed the pull preview without applying (or an error was already shown) — the repository is unchanged. Call pull_site again if they want to retry.");
          }
          return text(`Pull complete for "${conn.displayName}" — the user approved the preview and the changes are committed (${outcome.replace("committed:", "")} added+updated~removed). The repository now reflects the live site.`);
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
            "Opens the write-back flow: a **preview document** (editor tab) lists every operation, deletions stay opt-in, a safety snapshot is taken, and a **modal confirmation** is the binding checkpoint — **nothing changes until the user clicks Apply**.",
          ),
        },
      }),
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_apply_site" });
        try {
          const conn = resolveManaged(options.input.site);
          const outcome = await vscode.commands.executeCommand<string | undefined>(
            "aiSharePoint.applyRepoToSharePoint",
            conn,
          );
          // Relay what ACTUALLY happened (pilot: the flow can end before any
          // preview exists — never send the user looking for one).
          if (outcome?.startsWith("dirty:")) {
            return text(
              `Apply did NOT start — no preview opened: the site repository has ${outcome.slice(6)} uncommitted change(s) the user made themselves (a notification asked them to commit first). Files written via write_site_files are committed automatically, so these are other local edits. Ask the user to commit them (Source Control view), then call apply_site again.`,
            );
          }
          if (outcome === "no-repo") {
            return text(`Apply did NOT start: "${conn.displayName}" has no repository configured (the user saw guidance). Configure + pull first.`);
          }
          if (outcome === "empty-repo") {
            return text("Apply did NOT start: the repository has no site files yet — call pull_site (or write_site_files) first.");
          }
          if (outcome === "no-changes") {
            return text(`SharePoint already matches the repository for "${conn.displayName}" — there was nothing to apply (no preview needed).`);
          }
          if (outcome === "cancelled" || outcome === undefined) {
            return text(
              "The user closed the apply flow WITHOUT applying — nothing changed in SharePoint. (What they saw: a markdown PREVIEW DOCUMENT in an editor tab plus a modal confirmation — there is no separate 'preview dialog'.) If they dismissed it accidentally, call apply_site again to reopen it.",
            );
          }
          if (outcome.startsWith("failed:")) {
            const [, applied, op] = outcome.split(":");
            return text(
              `Apply stopped early after ${applied} operation(s) at "${op}" — the user saw the error; the repository was reconciled to the actual live state and the intended state is preserved in git history. Diagnose, fix the spec, and re-run apply_site.`,
            );
          }
          return text(
            `Apply COMPLETE for "${conn.displayName}": the user approved and ${outcome.replace("applied:", "")} operation(s) were applied. Verify with site_overview before describing the result.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_apply_site", err);
          return text(`Apply failed to start: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
