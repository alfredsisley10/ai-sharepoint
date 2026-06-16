import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextService } from "../context/contextService";
import { BookmarksStore } from "../context/bookmarksStore";
import { SchemaStore } from "../context/schemaStore";
import { SchemaIndexer } from "../context/db/schemaIndexer";
import { SourceSchema, renderSchemaForModel, ProbedRelationship, qualifiedName } from "../context/db/schemaIndex";
import {
  renderErForModel,
  parseJoinSpec,
  pairKey,
  classifyJoin,
  initialSampleSize,
  upsertRelationship,
} from "../context/db/erDiagram";
import { ContextSource } from "../context/types";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { sourceChatLabel, resolveSourceRef } from "../context/sourceRef";
import { EXPORT_MAX_ROWS, EXPORT_TIMEOUT_MS, EXPORT_DIR } from "../context/exportData";
import { markdownToStorage } from "../context/adapters/confluenceWrite";
import { catalogByCategory, CapabilityReport, RenderedValidation } from "../context/adapters/confluenceMacros";
import { OwnerResolution } from "../context/adapters/confluenceOwnership";
import { ManageabilityReport } from "../context/adapters/confluenceEntitlements";
import { CurrencyReport } from "../context/adapters/confluenceCurrency";
import { PageRef, HierarchyResult, renderPageTree } from "../context/adapters/confluenceHierarchy";

const DB_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);

/**
 * LM tools over the read-only context-source framework (PLAN §9 + ADR-0017).
 * Strictly read-only, stored-credential only (a tool call can never prompt),
 * lockout-gated, cached, and result-capped.
 */

function text(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}

/** The Confluence "Add more content" capabilities, formatted for the model:
 *  what's in use in this scope, then the full authorable vocabulary. */
function renderCapabilities(r: CapabilityReport): string {
  const lines: string[] = ["# Confluence content capabilities", `Sampled ${r.pagesSampled} page(s) for what's actually in use here.`];
  if (r.apps.length) lines.push(`Apps detected (best-effort): ${r.apps.join(", ")}.`);
  if (r.used.length) {
    lines.push("", "## Elements already in use in this scope");
    for (const u of r.used) {
      lines.push(
        `- \`${u.name}\`${u.count > 1 ? ` ×${u.count}` : ""}${u.spec ? ` — ${u.spec.label}` : " — app/plugin macro (not in the built-in catalog)"}${u.app ? ` [needs ${u.app}]` : ""}`,
      );
    }
  }
  lines.push("", "## Authorable vocabulary — emit these as STORAGE-FORMAT elements");
  for (const g of catalogByCategory()) {
    lines.push("", `### ${g.category}`);
    for (const m of g.macros) {
      lines.push(`- **${m.label}** (\`${m.name}\`${m.app ? `, needs ${m.app}` : ""}): ${m.description}`);
    }
  }
  lines.push(
    "",
    'CRITICAL: author REAL storage-format elements — e.g. `<ac:structured-macro ac:name="toc"/>` — NEVER wiki/markdown shorthand like `[TOC]` or `{toc}`, which Confluence renders as the literal text "[TOC]". Pass the storage XHTML to write_confluence_page with format:"storage" (markdown bodies still auto-convert fenced code, "- [ ]" task lists, "---" rules, and a stray "[TOC]"). After writing, call validate_confluence_page with the returned pageId to confirm the elements rendered.',
  );
  return lines.join("\n");
}

/** The rendered-page validation, formatted for the model. */
function renderValidation(v: RenderedValidation): string {
  const lines: string[] = [`# Rendered validation — “${v.title}”`, v.url];
  if (v.leaks.length) {
    lines.push("", "## ⚠️ Leaked markup — these are NOT real Confluence elements");
    for (const l of v.leaks) {
      lines.push(
        `- \`${l.markup}\` rendered as literal text. It was authored as shorthand; re-publish it as the real **${l.macro}** element, e.g. \`<ac:structured-macro ac:name="${l.macro}"/>\` (or the matching ac: element).`,
      );
    }
  } else {
    lines.push("", "✅ No leaked wiki/markdown shorthand — macro markup rendered as real elements.");
  }
  lines.push("", "## Elements that rendered");
  if (v.rendered.length) {
    for (const e of v.rendered) lines.push(`- ${e.name}${e.count > 1 ? ` ×${e.count}` : ""}`);
  } else {
    lines.push("- (none detected — a plain-text page)");
  }
  lines.push("", `Rendered text length: ${v.textLength} chars.`);
  return lines.join("\n");
}

const UNVERIFIED_OWNER_NOTE =
  "Note: active-user verification needs an LDAP/M365 directory (not wired) — owners are ranked by contribution volume, not filtered by who is still active.";

function renderOwners(r: { resolution: OwnerResolution; labels: string[] }): string {
  const { resolution } = r;
  const lines = ["# Page owner(s)"];
  lines.push(`- Owner(s): ${resolution.owners.length ? resolution.owners.join(", ") : "(none determined)"}`);
  lines.push(`- Basis: ${resolution.basis}${resolution.note ? ` — ${resolution.note}` : ""}`);
  if (r.labels.length) lines.push(`- Labels: ${r.labels.join(", ")}`);
  if (resolution.considered?.length) {
    lines.push(`- Top contributors: ${resolution.considered.slice(0, 5).map((c) => `${c.sam} (${c.count})`).join(", ")}`);
  }
  lines.push("", UNVERIFIED_OWNER_NOTE);
  return lines.join("\n");
}

function renderManageability(r: { report: ManageabilityReport; note: string }): string {
  const { report, note } = r;
  const lines = [`# Space manageability — ${report.spaceKey} (as ${report.user})`];
  lines.push(`Checked ${report.checkedPages} page(s); you can fully manage ${report.manageablePages}.`);
  if (report.gaps.length) {
    lines.push("", `## Pages you can't fully manage (${report.gaps.length})`);
    for (const g of report.gaps.slice(0, 50)) lines.push(`- ${g.title} — missing **${g.missing.join("+")}** — ${g.url}`);
    lines.push("", "## Access request (send to the space admins)", note);
  } else {
    lines.push("", `✅ ${note}`);
  }
  return lines.join("\n");
}

function renderPageRefs(refs: PageRef[]): string {
  return refs.length ? refs.map((r) => `- ${r.title} (id ${r.id}) — ${r.url}`).join("\n") : "_(none)_";
}

function renderHierarchy(r: HierarchyResult): string {
  switch (r.kind) {
    case "roots":
      return [`# Space ${r.spaceKey} — ${r.roots.length} root page(s)`, "", renderPageRefs(r.roots)].join("\n");
    case "ancestors": {
      const a = r.ancestors;
      return [
        `# Ancestors of “${a.page.title}” (id ${a.page.id})`,
        `Breadcrumb: ${[...a.ancestors, a.page].map((p) => p.title).join(" › ")}`,
        ...(a.spaceKey ? [`Space: ${a.spaceKey}`] : []),
        "",
        renderPageRefs(a.ancestors),
      ].join("\n");
    }
    case "children":
      return [`# Children of “${r.page.title}” (id ${r.page.id}) — ${r.children.length}`, "", renderPageRefs(r.children)].join("\n");
    case "subtree":
      return [
        `# Subtree of “${r.root.title}” (id ${r.root.id}) — ${r.count} descendant page(s)`,
        "```",
        renderPageTree(r.tree),
        "```",
      ].join("\n");
    case "context": {
      const h = r.hierarchy;
      return [
        `# “${h.page.title}” (id ${h.page.id})`,
        ...(h.spaceKey ? [`Space: ${h.spaceKey}`] : []),
        `Breadcrumb: ${[...h.ancestors, h.page].map((p) => p.title).join(" › ")}`,
        `Parent: ${h.parent ? `${h.parent.title} (id ${h.parent.id})` : "(none — this is a root page)"}`,
        "",
        `## Children (${h.childCount})`,
        renderPageRefs(h.children),
      ].join("\n");
    }
  }
}

function renderCurrency(r: CurrencyReport): string {
  const lines = [`# Page currency — “${r.title}”`, r.url, "", "## Links"];
  if (r.brokenLinks.length) {
    for (const b of r.brokenLinks) lines.push(`- ❌ ${b.url}${b.status ? ` (${b.status})` : b.error ? ` (${b.error})` : ""}`);
  } else {
    lines.push(`- ✅ ${r.workingLinks} link(s) reachable`);
  }
  if (r.uncheckedRelativeLinks) lines.push(`- ${r.uncheckedRelativeLinks} relative link(s) not checked`);
  lines.push("", "## Ownership & age");
  lines.push(`- Owner tag: ${r.hasOwnerLabel ? r.owners.map((o) => o.sam).join(", ") : "none"}`);
  if (r.staleDays !== undefined) lines.push(`- Last updated ${r.staleDays} day(s) ago${r.staleDays > 365 ? " — **stale**" : ""}`);
  lines.push("", UNVERIFIED_OWNER_NOTE);
  return lines.join("\n");
}

export function registerContextTools(
  store: ContextSourcesStore,
  service: ContextService,
  bookmarks: BookmarksStore,
  schemas: SchemaStore,
  indexer: SchemaIndexer,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  nowIso: () => string,
  scopedSources: () => ContextSource[] = () => store.list(),
): vscode.Disposable[] {
  const guarded = <T>(
    name: string,
    invocationMessage: string,
    run: (input: T) => Promise<string>,
  ): vscode.LanguageModelTool<T> => ({
    prepareInvocation() {
      return { invocationMessage };
    },
    async invoke(options) {
      telemetry.record("tool.invoke", { tool: name });
      try {
        return text(await run(options.input));
      } catch (err) {
        errors.capture(`tool:${name}`, err);
        return text(`The ${name} tool failed: ${redactError(err).message}`);
      }
    },
  });

  const resolveOrExplain = (ref?: string) => {
    const all = scopedSources();
    const source = resolveSourceRef(all, ref);
    if (!source) {
      throw new Error(
        all.length === 0
          ? 'No reference sources configured. The user can add Confluence/Jira via "AI SharePoint: Add Context Source".'
          : `Could not match "${ref ?? ""}" to a source in the active project scope. Available: ${all
              .map(sourceChatLabel)
              .join("; ")}. Aliases, display names, and types all work as the source argument.`,
      );
    }
    return source;
  };

  const resolveDbOrExplain = (ref?: string): ContextSource => {
    const source = resolveOrExplain(ref);
    if (!DB_TYPES.has(source.type)) {
      throw new Error(
        `"${source.displayName}" is a ${source.type} source — schema catalogs apply to database sources (SQL Server, PostgreSQL, MySQL, MongoDB).`,
      );
    }
    return source;
  };

  /** Catalog on demand: cached on disk; first touch loads it live (stored
   *  credential only — a tool call never prompts). */
  const schemaFor = async (source: ContextSource): Promise<SourceSchema> => {
    const cached = schemas.getSync(source.id);
    if (cached) return cached;
    const catalog = await service.loadSchemaCatalog(source, nowIso());
    const fresh: SourceSchema = { catalog, semanticState: "none" };
    await schemas.set(source.id, fresh);
    return fresh;
  };

  return [
    // The one WRITE tool over the context framework: create/update a Confluence
    // page. Approval-gated (VS Code tool confirmation) before anything is
    // written — uses the source's own API token, no admin OAuth consent.
    vscode.lm.registerTool<{
      source?: string;
      action?: "create" | "update";
      spaceKey?: string;
      title?: string;
      markdown?: string;
      pageId?: string;
      parentId?: string;
      format?: "markdown" | "storage";
    }>("aisharepoint_write_confluence_page", {
      prepareInvocation(options) {
        const i = options.input;
        const verb = i.action === "update" ? "Update" : "Create";
        return {
          invocationMessage: `${verb} a Confluence page`,
          confirmationMessages: {
            title: `${verb} Confluence page “${i.title ?? "(untitled)"}”?`,
            message: new vscode.MarkdownString(
              [
                `**Source:** ${i.source ?? "_the configured Confluence source_"}`,
                i.action === "update"
                  ? `**Page id:** ${i.pageId ?? "_?_"}`
                  : `**Space:** ${i.spaceKey ?? "_?_"}${i.parentId ? ` · under parent ${i.parentId}` : ""}`,
                "",
                "Writes to **Confluence** with your own API token — a real change. Confluence keeps version history (updates bump the version), so it's reversible there.",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_write_confluence_page" });
        try {
          const i = options.input;
          const source = resolveOrExplain(i.source);
          if (source.type !== "confluence") {
            return text(
              `"${source.displayName}" is a ${source.type} source — page writes target a Confluence source.`,
            );
          }
          if (!i.title?.trim()) return text("A page title is required.");
          if (!i.markdown?.trim()) return text("The page body (markdown) is required.");
          const action = i.action === "update" ? "update" : "create";
          if (action === "update" && !i.pageId?.trim()) {
            return text("Updating a page needs its pageId (search the source first to find it).");
          }
          if (action === "create" && !i.spaceKey?.trim()) {
            return text("Creating a page needs the target spaceKey.");
          }
          // The body may be markdown (auto-converted, incl. fenced code →
          // code macro, "- [ ]" → task list, "---" → rule) OR storage-format
          // XHTML (macros, or hand-authored HTML). Honor an explicit format;
          // otherwise detect storage — an ac: macro, ANY HTML closing tag, or a
          // void element — so HTML the model emits renders as HTML instead of
          // being escaped to literal text. Either way the body is sanitized
          // (bare "&" escaped, void elements self-closed) before the write.
          const looksLikeStorage = /<ac:|<\/[a-zA-Z]|<(?:br|hr|img|table|p|ul|ol|h[1-6]|blockquote|pre)\b/i.test(i.markdown);
          const body =
            i.format === "storage" || (i.format !== "markdown" && looksLikeStorage)
              ? i.markdown
              : markdownToStorage(i.markdown);
          const res = await service.writeConfluencePage(source, {
            action,
            ...(i.spaceKey ? { spaceKey: i.spaceKey.trim() } : {}),
            title: i.title.trim(),
            body,
            ...(i.pageId ? { pageId: i.pageId.trim() } : {}),
            ...(i.parentId ? { parentId: i.parentId.trim() } : {}),
          });
          telemetry.record("confluence.write", { action });
          return text(
            `Confluence page ${action === "update" ? "updated" : "created"}: “${res.title}” (v${res.version}) — ${res.url}`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_write_confluence_page", err);
          return text(`Could not write the Confluence page: ${redactError(err).message}`);
        }
      },
    }),
    // Discover the "Add more content" vocabulary (macros/elements) + what's
    // installed/in-use, so the model designs advanced pages with real elements.
    vscode.lm.registerTool<{ source?: string; spaceKey?: string; pageId?: string; subtree?: boolean }>(
      "aisharepoint_confluence_capabilities",
      guarded("aisharepoint_confluence_capabilities", "Discovering Confluence content capabilities", async (i) => {
        const source = resolveOrExplain(i.source);
        if (source.type !== "confluence") {
          return `"${source.displayName}" is a ${source.type} source — capability discovery targets a Confluence source.`;
        }
        const report = await service.discoverConfluenceCapabilities(source, {
          ...(i.spaceKey ? { spaceKey: i.spaceKey } : {}),
          ...(i.pageId ? { pageId: i.pageId } : {}),
          ...(i.subtree ? { subtree: true } : {}),
        });
        return renderCapabilities(report);
      }),
    ),
    // Pull the TRUE rendered content and validate elements rendered as intended
    // (catches "[TOC]" leaking as literal text instead of a real table of
    // contents). The post-write confirmation step.
    vscode.lm.registerTool<{ source?: string; pageId?: string }>(
      "aisharepoint_validate_confluence_page",
      guarded("aisharepoint_validate_confluence_page", "Validating the rendered Confluence page", async (i) => {
        const source = resolveOrExplain(i.source);
        if (source.type !== "confluence") {
          return `"${source.displayName}" is a ${source.type} source — validation targets a Confluence source.`;
        }
        if (!i.pageId?.trim()) {
          return "A pageId is required (use the id returned by write_confluence_page, or search the source first).";
        }
        const v = await service.validateConfluencePage(source, i.pageId.trim());
        return renderValidation(v);
      }),
    ),
    // Manage a page's labels (list / add / remove). Add & remove are writes —
    // approval-gated and bounded by the connector's write scope; list is a read.
    vscode.lm.registerTool<{ source?: string; pageId?: string; action?: "add" | "remove" | "list"; labels?: string[] }>(
      "aisharepoint_manage_confluence_labels",
      {
        prepareInvocation(options) {
          const i = options.input;
          const action = i.action ?? "list";
          if (action === "list") return { invocationMessage: "Reading Confluence page labels" };
          const verb = action === "add" ? "Add" : "Remove";
          return {
            invocationMessage: `${verb} Confluence page label(s)`,
            confirmationMessages: {
              title: `${verb} label(s) on page ${i.pageId ?? "?"}?`,
              message: new vscode.MarkdownString(
                [
                  `**Labels:** ${(i.labels ?? []).map((l) => `\`${l}\``).join(", ") || "_?_"}`,
                  "",
                  "Changes the page's labels in Confluence (metadata — reversible). Labels are lowercased and spaces become hyphens.",
                ].join("\n"),
              ),
            },
          };
        },
        async invoke(options) {
          telemetry.record("tool.invoke", { tool: "aisharepoint_manage_confluence_labels" });
          try {
            const i = options.input;
            const source = resolveOrExplain(i.source);
            if (source.type !== "confluence") {
              return text(`"${source.displayName}" is a ${source.type} source — labels target a Confluence source.`);
            }
            if (!i.pageId?.trim()) return text("A pageId is required (search the source first to find it).");
            const action = i.action ?? "list";
            if (action !== "list" && (!i.labels || i.labels.length === 0)) {
              return text(`Provide at least one label to ${action}.`);
            }
            const res = await service.manageConfluenceLabels(source, {
              action,
              pageId: i.pageId.trim(),
              ...(i.labels ? { labels: i.labels } : {}),
            });
            telemetry.record("confluence.labels", { action });
            return text(
              `Page labels after ${res.action}: ${res.labels.length ? res.labels.map((l) => `\`${l}\``).join(", ") : "(none)"}.`,
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_manage_confluence_labels", err);
            return text(`Could not manage labels: ${redactError(err).message}`);
          }
        },
      },
    ),
    // Governance — ARCHIVE a page (move under the space's Archive root). Write.
    vscode.lm.registerTool<{ source?: string; pageId?: string }>("aisharepoint_archive_confluence_page", {
      prepareInvocation(options) {
        return {
          invocationMessage: "Archiving a Confluence page",
          confirmationMessages: {
            title: `Archive Confluence page ${options.input.pageId ?? "?"}?`,
            message: new vscode.MarkdownString(
              "Moves the page under the space's **Archive** root (created if absent). Reversible — the page isn't deleted, just relocated.",
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_archive_confluence_page" });
        try {
          const i = options.input;
          const source = resolveOrExplain(i.source);
          if (source.type !== "confluence") return text(`"${source.displayName}" is a ${source.type} source — archiving targets Confluence.`);
          if (!i.pageId?.trim()) return text("A pageId is required (search the source first to find it).");
          const r = await service.archiveConfluencePage(source, i.pageId.trim());
          telemetry.record("confluence.archive");
          return text(`Archived page ${r.pageId} under "${r.archiveRootTitle}"${r.createdArchiveRoot ? " (created the Archive root)" : ""}.`);
        } catch (err) {
          errors.capture("tool:aisharepoint_archive_confluence_page", err);
          return text(`Could not archive the page: ${redactError(err).message}`);
        }
      },
    }),
    // Governance — MOVE / RE-PARENT a page (re-parent under a page, or reorder). Write.
    vscode.lm.registerTool<{ source?: string; pageId?: string; parentId?: string; position?: "append" | "before" | "after"; targetId?: string }>(
      "aisharepoint_move_confluence_page",
      {
        prepareInvocation(options) {
          const i = options.input;
          const position = i.position ?? "append";
          const target = position === "append" ? i.parentId ?? i.targetId : i.targetId ?? i.parentId;
          const what =
            position === "append"
              ? `under parent ${target ?? "?"}`
              : `${position} sibling ${target ?? "?"}`;
          return {
            invocationMessage: "Moving a Confluence page",
            confirmationMessages: {
              title: `Move page ${i.pageId ?? "?"} ${what}?`,
              message: new vscode.MarkdownString(
                position === "append"
                  ? "Re-parents the page (makes it a child of the new parent). Stays within the managed space; reversible by moving it back."
                  : "Reorders the page relative to a sibling under the same parent. Reversible.",
              ),
            },
          };
        },
        async invoke(options) {
          telemetry.record("tool.invoke", { tool: "aisharepoint_move_confluence_page" });
          try {
            const i = options.input;
            const source = resolveOrExplain(i.source);
            if (source.type !== "confluence") return text(`"${source.displayName}" is a ${source.type} source — moving pages targets Confluence.`);
            if (!i.pageId?.trim()) return text("A pageId is required (search the source first to find it).");
            const res = await service.moveConfluencePage(source, {
              pageId: i.pageId.trim(),
              ...(i.parentId ? { parentId: i.parentId.trim() } : {}),
              ...(i.position ? { position: i.position } : {}),
              ...(i.targetId ? { targetId: i.targetId.trim() } : {}),
            });
            telemetry.record("confluence.move", { position: i.position ?? "append" });
            return text(`Moved page “${res.title}” (${res.pageId})${res.parentId ? ` — now a child of ${res.parentId}` : ""}.`);
          } catch (err) {
            errors.capture("tool:aisharepoint_move_confluence_page", err);
            return text(`Could not move the page: ${redactError(err).message}`);
          }
        },
      },
    ),
    // Governance — REMOVE FROM SEARCH (blank current content; history retained). Write.
    vscode.lm.registerTool<{ source?: string; pageId?: string }>("aisharepoint_remove_confluence_page_from_search", {
      prepareInvocation(options) {
        return {
          invocationMessage: "Removing a Confluence page from search",
          confirmationMessages: {
            title: `Remove page ${options.input.pageId ?? "?"} from search?`,
            message: new vscode.MarkdownString(
              "**Blanks the page's current content** so it drops out of search and navigation. The page is NOT deleted — Confluence keeps every prior version, so the original content is retained for compliance and is restorable. Usually done AFTER archiving.",
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_remove_confluence_page_from_search" });
        try {
          const i = options.input;
          const source = resolveOrExplain(i.source);
          if (source.type !== "confluence") return text(`"${source.displayName}" is a ${source.type} source — this targets Confluence.`);
          if (!i.pageId?.trim()) return text("A pageId is required.");
          const r = await service.removeConfluencePageFromSearch(source, i.pageId.trim());
          telemetry.record("confluence.removeFromSearch");
          return text(`Removed page ${r.id} from search (content blanked, now v${r.version}; prior versions retain the original). ${r.url}`);
        } catch (err) {
          errors.capture("tool:aisharepoint_remove_confluence_page_from_search", err);
          return text(`Could not remove the page from search: ${redactError(err).message}`);
        }
      },
    }),
    // Governance — resolve page OWNER(S) (read).
    vscode.lm.registerTool<{ source?: string; pageId?: string }>(
      "aisharepoint_resolve_page_owners",
      guarded("aisharepoint_resolve_page_owners", "Resolving Confluence page owner(s)", async (i) => {
        const source = resolveOrExplain(i.source);
        if (source.type !== "confluence") return `"${source.displayName}" is a ${source.type} source — ownership targets Confluence.`;
        if (!i.pageId?.trim()) return "A pageId is required (search the source first to find it).";
        return renderOwners(await service.resolveConfluenceOwners(source, i.pageId.trim()));
      }),
    ),
    // Governance — review SPACE MANAGEABILITY / entitlements (read).
    vscode.lm.registerTool<{ source?: string; spaceKey?: string }>(
      "aisharepoint_review_space_manageability",
      guarded("aisharepoint_review_space_manageability", "Reviewing Confluence space manageability", async (i) => {
        const source = resolveOrExplain(i.source);
        if (source.type !== "confluence") return `"${source.displayName}" is a ${source.type} source — this targets Confluence.`;
        return renderManageability(await service.reviewConfluenceManageability(source, i.spaceKey?.trim() || undefined));
      }),
    ),
    // Governance — review PAGE CURRENCY: broken links + owner tag + age (read).
    vscode.lm.registerTool<{ source?: string; pageId?: string }>(
      "aisharepoint_review_page_currency",
      guarded("aisharepoint_review_page_currency", "Reviewing Confluence page currency", async (i) => {
        const source = resolveOrExplain(i.source);
        if (source.type !== "confluence") return `"${source.displayName}" is a ${source.type} source — this targets Confluence.`;
        if (!i.pageId?.trim()) return "A pageId is required.";
        return renderCurrency(await service.reviewConfluenceCurrency(source, i.pageId.trim()));
      }),
    ),
    // Hierarchy & relationships — enumerate a page's parent/ancestors, immediate
    // children, full subtree, or a space's root pages (all fully paginated).
    vscode.lm.registerTool<{ source?: string; pageId?: string; spaceKey?: string; view?: "context" | "ancestors" | "children" | "subtree" }>(
      "aisharepoint_confluence_page_tree",
      guarded("aisharepoint_confluence_page_tree", "Reading the Confluence page hierarchy", async (i) => {
        const source = resolveOrExplain(i.source);
        if (source.type !== "confluence") return `"${source.displayName}" is a ${source.type} source — page hierarchy targets Confluence.`;
        if (!i.pageId?.trim() && !i.spaceKey?.trim()) {
          return "Provide a pageId (to see its parent/children/subtree) or a spaceKey (to list the space's root pages).";
        }
        const r = await service.exploreConfluenceHierarchy(source, {
          ...(i.pageId ? { pageId: i.pageId.trim() } : {}),
          ...(i.spaceKey ? { spaceKey: i.spaceKey.trim() } : {}),
          ...(i.view ? { view: i.view } : {}),
        });
        return renderHierarchy(r);
      }),
    ),
    vscode.lm.registerTool(
      "aisharepoint_db_schema",
      guarded<{ source?: string; topic?: string }>(
        "aisharepoint_db_schema",
        "Reading the database schema",
        async (input) => {
          const source = resolveDbOrExplain(input.source);
          const schema = await schemaFor(source);
          const rendered = renderSchemaForModel(schema, input.topic);
          // Probed JOIN paths (ADR-0030) ride along so multi-table questions
          // get correct joins even though the schema declares no foreign keys.
          const er = schema.er ? `\n${renderErForModel(schema.er).join("\n")}` : "";
          const hint =
            schema.semanticState === "none"
              ? '\n\nNote: this schema has no semantic index yet — column meanings are raw names. Offer to build one with the index_db_schema tool (the user approves in chat; only table/column names are sent to Copilot). With an index, questions like "records owned by X" map to ownership columns automatically.'
              : schema.semantic?.partial
                ? "\n\nNote: the semantic index is partial — re-running index_db_schema can complete it."
                : "";
          return rendered + er + hint;
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_vertex_answer",
      guarded<{ source?: string; query: string }>(
        "aisharepoint_vertex_answer",
        "Asking Vertex AI Search",
        async (input) => {
          const source = resolveOrExplain(input.source);
          if (source.type !== "vertexai") {
            throw new Error(
              `"${source.displayName}" is a ${source.type} source — grounded answers need a Vertex AI Search source.`,
            );
          }
          const result = await service.vertexAnswer(source, input.query);
          if (!result.answer) {
            return `Vertex AI Search produced no grounded answer for that query — try the search tool for raw results.`;
          }
          return JSON.stringify(result, null, 2);
        },
      ),
    ),
    // User-defined joins from chat (ADR-0030 amendment): validate against
    // the persisted ER model, probe the live join rate when unknown, and —
    // with the user's confirmation via the tool-approval UI — extend the
    // model. save=true is the only state-changing path and is gated.
    vscode.lm.registerTool<{ source?: string; join: string; save?: boolean }>(
      "aisharepoint_test_join",
      {
        prepareInvocation(options) {
          if (!options.input.save) {
            return { invocationMessage: "Testing a user-defined join" };
          }
          return {
            invocationMessage: "Saving a join to the ER model",
            confirmationMessages: {
              title: "Extend the ER model with this join?",
              message: new vscode.MarkdownString(
                [
                  `Adds \`${options.input.join.slice(0, 160)}\` to the persisted ER model of **${store.resolve(options.input.source)?.displayName ?? options.input.source ?? "the database"}**.`,
                  "",
                  "The join rate is re-probed first (counts only — no row data). The model is used by chat for multi-table JOINs and travels with reference-config exports.",
                ].join("\n"),
              ),
            },
          };
        },
        async invoke(options, token) {
          void token;
          telemetry.record("tool.invoke", { tool: "aisharepoint_test_join" });
          try {
            const input = options.input;
            const source = resolveDbOrExplain(input.source);
            const schema = await schemaFor(source);
            const parsed = parseJoinSpec(input.join, schema);
            if ("issue" in parsed) return text(parsed.issue);
            const key = pairKey(parsed);
            const existing = schema.er?.relationships.find((r) => pairKey(r) === key);
            if (existing && !input.save) {
              return text(
                JSON.stringify(
                  {
                    status: "already-in-er-model",
                    relationship: existing,
                    hint: "This join is already part of the ER diagram — no probe needed.",
                  },
                  null,
                  2,
                ),
              );
            }
            // Probe fresh (adaptive sample from the model's row estimates).
            const endFor = (qualified: string, column: string) => {
              const t = schema.catalog.tables.find(
                (x) => qualifiedName(x).toLowerCase() === qualified.toLowerCase(),
              )!;
              return { ...(t.schema ? { schema: t.schema } : {}), table: t.name, column };
            };
            const sample = initialSampleSize(
              schema.er?.rowEstimates?.[parsed.fromTable.toLowerCase()] ?? 0,
              schema.er?.rowEstimates?.[parsed.toTable.toLowerCase()] ?? 0,
            );
            // Cross-family user joins probe with the cast comparison — the
            // user asserted the join works, so test it the way it would run.
            const cast = Boolean(parsed.warning);
            const forward = await service.probeJoin(
              source,
              endFor(parsed.fromTable, parsed.fromColumn),
              endFor(parsed.toTable, parsed.toColumn),
              sample,
              cast,
            );
            const backward = await service.probeJoin(
              source,
              endFor(parsed.toTable, parsed.toColumn),
              endFor(parsed.fromTable, parsed.fromColumn),
              sample,
              cast,
            );
            const graded = classifyJoin(forward, backward);
            const prior = schema.er?.report?.tested.find((t) => pairKey(t) === key);
            const rel: ProbedRelationship = {
              fromTable: parsed.fromTable,
              fromColumn: parsed.fromColumn,
              toTable: parsed.toTable,
              toColumn: parsed.toColumn,
              forwardRate: graded.forwardRate,
              backwardRate: graded.backwardRate,
              sampledForward: forward.sampled,
              sampledBackward: backward.sampled,
              ...(sample === "full" ? { complete: true } : {}),
              ...(cast ? { cast: true } : {}),
              // A user-DEFINED join is kept even below the automatic
              // thresholds — the user asserted it; the measured rates stay
              // visible so a data-quality story is still tellable.
              verdict: graded.verdict ?? "defined",
              ...(graded.note ? { note: graded.note } : {}),
              reason: "user-defined join (chat)",
            };
            let saved = false;
            if (input.save) {
              const er = upsertRelationship(schema.er, rel, nowIso());
              await schemas.set(source.id, { ...(schemas.getSync(source.id) ?? schema), er });
              saved = true;
            }
            return text(
              JSON.stringify(
                {
                  status: saved
                    ? "saved-to-er-model"
                    : graded.verdict
                      ? "confirmed-by-probe"
                      : "below-thresholds",
                  join: `${parsed.fromTable}.${parsed.fromColumn} = ${parsed.toTable}.${parsed.toColumn}`,
                  measured: {
                    forwardRate: graded.forwardRate,
                    backwardRate: graded.backwardRate,
                    sample: sample === "full" ? "complete join" : sample,
                  },
                  verdict: rel.verdict,
                  note: rel.note ?? null,
                  typeWarning: parsed.warning ?? null,
                  priorProbe: prior
                    ? { forwardRate: prior.forwardRate, backwardRate: prior.backwardRate, outcome: prior.outcome }
                    : null,
                  hint: saved
                    ? "Persisted — the ER diagram and chat's JOIN paths now include this join."
                    : "To add it to the ER diagram, call this tool again with save=true (the user approves in chat).",
                },
                null,
                2,
              ),
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_test_join", err);
            return text(`The test_join tool failed: ${redactError(err).message}`);
          }
        },
      },
    ),
    // In-chat indexing: VS Code's tool-confirmation UI is the consent gate —
    // the user sees exactly what will be sent (names only) and must approve.
    vscode.lm.registerTool<{ source?: string }>("aisharepoint_index_db_schema", {
      prepareInvocation(options) {
        const source = store.resolve(options.input.source);
        const schema = source ? schemas.getSync(source.id) : undefined;
        const tables = schema?.catalog.tables.length;
        return {
          invocationMessage: "Indexing database schema with Copilot",
          confirmationMessages: {
            title: `Index "${source?.displayName ?? options.input.source ?? "database"}" schema with Copilot?`,
            message: new vscode.MarkdownString(
              [
                `Sends **table and column names only** — no data rows — to your Copilot model${tables !== undefined ? ` (${tables} tables)` : ""}, using your Copilot subscription.`,
                "",
                "The resulting semantic index lets free-form questions find the right columns (e.g. `group_cio` → _owned by …_).",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options, token) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_index_db_schema" });
        try {
          if (!SchemaIndexer.enabledByPolicy()) {
            return text(
              "Schema indexing with Copilot is disabled by policy (aiSharePoint.context.allowSchemaIndexing).",
            );
          }
          const source = resolveDbOrExplain(options.input.source);
          const schema = await schemaFor(source);
          const indexed = await indexer.runIndexing(source, schema, undefined, token);
          const n = indexed.semantic?.tables.length ?? 0;
          return text(
            `Schema indexed: ${n} of ${indexed.catalog.tables.length} tables now carry semantic tags${indexed.semantic?.partial ? " (partial — can be re-run to complete)" : ""}. Use the db_schema tool with a topic to find columns, then search with a SELECT.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_index_db_schema", err);
          return text(`Schema indexing failed: ${redactError(err).message}`);
        }
      },
    }),
    vscode.lm.registerTool(
      "aisharepoint_list_sources",
      guarded<Record<string, never>>(
        "aisharepoint_list_sources",
        "Listing reference sources",
        async () => {
          const all = scopedSources();
          if (all.length === 0) {
            return 'No reference sources in the active project scope. The user can add sources via "AI SharePoint: Add Context Source" or switch projects ("Projects: Switch").';
          }
          return JSON.stringify(
            all.map((s) => ({
              name: s.displayName,
              ...(s.alias ? { alias: s.alias } : {}),
              ...(s.description ? { description: s.description } : {}),
              type: s.type,
              deployment: s.deployment,
              verified: Boolean(s.lastVerifiedAt),
            })),
            null,
            2,
          );
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_search_context",
      guarded<{ source?: string; query: string; allowExpensive?: boolean }>(
        "aisharepoint_search_context",
        "Searching reference sources",
        async (input) => {
          const source = resolveOrExplain(input.source);
          const hits = await service.search(source, input.query, {
            allowExpensive: input.allowExpensive === true,
          });
          if (hits.length === 0) {
            return `No results in "${source.displayName}" for that query. (Confluence accepts raw CQL, Jira raw JQL, or plain text.)`;
          }
          return JSON.stringify(hits, null, 2);
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_get_context_item",
      guarded<{ source?: string; id: string }>(
        "aisharepoint_get_context_item",
        "Reading a reference item",
        async (input) => {
          const source = resolveOrExplain(input.source);
          const item = await service.getItem(source, input.id);
          return JSON.stringify(item, null, 2);
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_run_bookmark",
      guarded<{ name: string }>(
        "aisharepoint_run_bookmark",
        "Running a saved bookmark",
        async (input) => {
          const all = bookmarks.list();
          if (all.length === 0) {
            return 'No bookmarks saved. The user can save reusable queries via "AI SharePoint: Add Bookmark".';
          }
          const bookmark = bookmarks.resolve(input.name);
          if (!bookmark) {
            return `No bookmark named "${input.name}". Available: ${all
              .map((b) => b.name)
              .join("; ")}.`;
          }
          const source = store.get(bookmark.sourceId);
          if (!source) {
            return `The source for bookmark "${bookmark.name}" no longer exists.`;
          }
          const result =
            bookmark.kind === "item"
              ? await service.getItem(source, bookmark.locator)
              : await service.search(source, bookmark.locator);
          return JSON.stringify(
            { bookmark: bookmark.name, source: source.displayName, kind: bookmark.kind, result },
            null,
            2,
          );
        },
      ),
    ),
    // ADR-0031: large datasets leave through FILES — the tool runs the query
    // with export bounds, writes every row into the workspace, and hands the
    // model ONLY the path + count (the data never enters chat context).
    vscode.lm.registerTool<{ source?: string; query: string; fileName?: string }>(
      "aisharepoint_export_context_results",
      {
        prepareInvocation(options) {
          const src = resolveSourceRef(scopedSources(), options.input.source);
          const q = options.input.query ?? "";
          return {
            invocationMessage: "Exporting search results to a workspace file",
            confirmationMessages: {
              title: `Export results from ${src?.displayName ?? options.input.source ?? "a source"} to a file?`,
              message: new vscode.MarkdownString(
                [
                  "```",
                  q.length > 400 ? `${q.slice(0, 400)}…` : q,
                  "```",
                  `Runs read-only with export bounds (up to **${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows**, ${Math.round(EXPORT_TIMEOUT_MS / 1000)}s) and writes every result to \`${EXPORT_DIR}/\` in your workspace.`,
                  "",
                  "_The dataset goes to the file only — it is **not** loaded into the chat context. For SQL Server this bulk read intentionally bypasses the cost guard._",
                ].join("\n"),
              ),
            },
          };
        },
        async invoke(options) {
          telemetry.record("tool.invoke", { tool: "aisharepoint_export_context_results" });
          try {
            const source = resolveOrExplain(options.input.source);
            const result = await vscode.commands.executeCommand<
              { file: string; rows: number } | undefined
            >("aiSharePoint.exportSearchResults", {
              source: source.id,
              query: options.input.query,
              ...(options.input.fileName ? { fileName: options.input.fileName } : {}),
            });
            if (!result) {
              return text(
                "The export did not complete (the user cancelled, or an error was already shown to them). Do not retry on your own.",
              );
            }
            return text(
              `Exported ${result.rows} row(s) from "${source.displayName}" to "${result.file}" in the workspace${
                result.rows >= EXPORT_MAX_ROWS ? ` (hit the ${EXPORT_MAX_ROWS}-row export cap — suggest narrowing the query if they need the rest)` : ""
              }. The dataset was intentionally NOT loaded into chat — point the user at the file. Do not read it back into context unless the user asks about a specific small slice.`,
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_export_context_results", err);
            return text(`The export failed: ${redactError(err).message}`);
          }
        },
      },
    ),
    // Agent-proposed bookmarks: persistence is gated by VS Code's tool
    // confirmation UI — the user sees name/locator/source and must approve
    // in chat before anything is saved (human-in-the-loop by construction).
    vscode.lm.registerTool<{
      source?: string;
      name: string;
      locator: string;
      kind?: "query" | "item";
      reason?: string;
    }>("aisharepoint_suggest_bookmark", {
      prepareInvocation(options) {
        const sourceName =
          store.resolve(options.input.source)?.displayName ?? options.input.source ?? "?";
        return {
          invocationMessage: "Proposing a bookmark",
          confirmationMessages: {
            title: `Save bookmark "${options.input.name}"?`,
            message: new vscode.MarkdownString(
              [
                `**Source:** ${sourceName}`,
                `**Kind:** ${options.input.kind ?? "query"}`,
                `**Locator:**`,
                "```",
                options.input.locator,
                "```",
                ...(options.input.reason ? [`_${options.input.reason}_`] : []),
                "",
                "Saved bookmarks appear in the Reference Sources view and run by name.",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_suggest_bookmark" });
        try {
          const input = options.input;
          const source = resolveOrExplain(input.source);
          if (!input.name?.trim() || !input.locator?.trim()) {
            return text("A bookmark needs both a name and a locator (query or item id).");
          }
          await bookmarks.add({
            id: crypto.randomUUID(),
            sourceId: source.id,
            name: input.name.trim().slice(0, 80),
            locator: input.locator.trim(),
            kind: input.kind === "item" ? "item" : "query",
          });
          telemetry.record("bookmark.add", { type: source.type, via: "agent" });
          return text(
            `Bookmark "${input.name.trim()}" saved under ${source.displayName}. It can now be run by name with the run-bookmark tool or from the Reference Sources view.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_suggest_bookmark", err);
          return text(`Could not save the bookmark: ${redactError(err).message}`);
        }
      },
    }),
    vscode.lm.registerTool(
      "aisharepoint_list_bookmarks",
      guarded<Record<string, never>>(
        "aisharepoint_list_bookmarks",
        "Listing bookmarks",
        async () => {
          const visibleIds = new Set(scopedSources().map((s) => s.id));
          const all = bookmarks.list().filter((b) => visibleIds.has(b.sourceId));
          if (all.length === 0) return "No bookmarks saved in the active project scope.";
          return JSON.stringify(
            all.map((b) => ({
              name: b.name,
              source: store.get(b.sourceId)?.displayName ?? "(missing)",
              kind: b.kind,
            })),
            null,
            2,
          );
        },
      ),
    ),
  ];
}
