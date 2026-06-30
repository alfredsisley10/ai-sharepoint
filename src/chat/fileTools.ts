import * as vscode from "vscode";
import { FileSourcesStore } from "../context/files/fileSourcesStore";
import { FileSource } from "../context/files/fileSources";
import { renderTable } from "../context/files/tabular";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * Read-only file context tool: lets @sharepoint read a registered spreadsheet/CSV
 * (local now; OneDrive/shared SharePoint later) into the chat as a bounded table.
 * Reads only files the user has explicitly registered — never an arbitrary path —
 * and is release-expiry gated.
 */
export function registerFileTools(
  files: FileSourcesStore,
  read: (source: FileSource) => Promise<string[][]>,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{ name?: string }>("aisharepoint_read_file", {
      prepareInvocation(options) {
        return { invocationMessage: options.input.name ? `📄 Reading file “${options.input.name}”` : "📄 Reading a registered file" };
      },
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_read_file" });
        try {
          const all = files.list();
          if (all.length === 0) {
            return text("No files are registered for context. Ask the user to run “Add File for Context…” first — do not read arbitrary paths.");
          }
          let source: FileSource | undefined;
          if (options.input.name) {
            const q = options.input.name.trim().toLowerCase();
            source = all.find((f) => f.label.toLowerCase() === q) ?? all.find((f) => f.label.toLowerCase().includes(q));
          } else if (all.length === 1) {
            source = all[0];
          }
          if (!source) {
            return text(`Which file? Registered: ${all.map((f) => `"${f.label}"`).join(", ")}. Pass one as 'name'.`);
          }
          const rows = await read(source);
          telemetry.record("file.read", { kind: source.tabular, rows: rows.length });
          return text(renderTable(source.label, rows));
        } catch (err) {
          errors.capture("tool:aisharepoint_read_file", err);
          return text(`Could not read the file: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
