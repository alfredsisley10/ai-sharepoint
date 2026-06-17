/**
 * Human-readable progress lines for @sharepoint tool calls (pilot: status
 * must reflect what was actually asked, not a generic "Running …"). Pure and
 * input-aware so multi-turn operations read like a narrated plan. Inputs are
 * model-supplied — kept short and never assumed well-formed.
 */

const short = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Compact completion line for a finished tool call — what came BACK, so a
 *  multi-round turn narrates results ("Search of CMDB: 12 result(s)"), not
 *  only intentions. Result text is the tool's own output (JSON or prose);
 *  never assumed well-formed. */
export function describeToolResult(name: string, input: unknown, resultText: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const src = str(i.source);
  const subject = (() => {
    switch (name) {
      case "aisharepoint_search_context":
        return `Search${src ? ` of ${src}` : ""}`;
      case "aisharepoint_run_bookmark":
        return `Bookmark${str(i.name) ? ` “${short(String(i.name), 40)}”` : ""}`;
      case "aisharepoint_get_context_item":
        return "Item fetch";
      case "aisharepoint_db_schema":
        return `${src ?? "Database"} schema lookup`;
      case "aisharepoint_test_join":
        return "Join probe";
      case "aisharepoint_vertex_answer":
        return "Grounded answer";
      case "aisharepoint_site_overview":
        return "Site overview";
      case "aisharepoint_list_pages":
        return "Page listing";
      default:
        return name.replace(/^aisharepoint_/, "").replace(/_/g, " ");
    }
  })();
  const text = resultText.trim();
  if (!text) return `${subject}: empty result — continuing…`;
  if (/^no (results|bookmarks|reference sources|visible)/i.test(text)) {
    return `${subject}: no results — continuing…`;
  }
  let measure: string;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      measure = `${parsed.length} result(s)`;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const arr = ["result", "results", "tables", "pages", "citations", "hits"]
        .map((k) => obj[k])
        .find(Array.isArray) as unknown[] | undefined;
      measure = arr
        ? `${arr.length} result(s)`
        : typeof obj.answer === "string"
          ? "answer ready"
          : `${Object.keys(obj).length} field(s)`;
    } else {
      measure = "done";
    }
  } catch {
    measure = text.length > 1024 ? `${(text.length / 1024).toFixed(1)} KB of text` : "done";
  }
  return `${subject}: ${measure} — continuing…`;
}

export function describeToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const src = str(i.source);
  const query = str(i.query);
  switch (name) {
    case "aisharepoint_search_context":
      return src
        ? `Searching ${src}${query ? ` for “${short(query)}”` : ""}…`
        : `Searching reference sources${query ? ` for “${short(query)}”` : ""}…`;
    case "aisharepoint_get_context_item":
      return `Fetching ${str(i.id) ? `“${short(String(i.id), 40)}”` : "an item"}${src ? ` from ${src}` : ""}…`;
    case "aisharepoint_db_schema":
      return `Reading ${src ?? "database"} schema${str(i.topic) ? ` for “${short(String(i.topic), 40)}”` : ""}…`;
    case "aisharepoint_index_db_schema":
      return `Indexing ${src ?? "database"} schema with Copilot…`;
    case "aisharepoint_test_join":
      return i.save
        ? `Saving join ${str(i.join) ? `“${short(String(i.join), 50)}” ` : ""}to the ER model…`
        : `Probing join ${str(i.join) ? `“${short(String(i.join), 50)}”` : ""}…`;
    case "aisharepoint_vertex_answer":
      return `Asking ${src ?? "Vertex AI Search"}${query ? ` “${short(query)}”` : ""}…`;
    case "aisharepoint_list_sources":
      return "Listing your reference sources…";
    case "aisharepoint_list_bookmarks":
      return "Listing your saved bookmarks…";
    case "aisharepoint_run_bookmark":
      return `Running bookmark${str(i.name) ? ` “${short(String(i.name), 40)}”` : ""}…`;
    case "aisharepoint_suggest_bookmark":
      return `Proposing a bookmark${str(i.name) ? ` “${short(String(i.name), 40)}”` : ""} to save…`;
    case "aisharepoint_export_context_results":
      return `Exporting ${src ?? "search"} results to a workspace file…`;
    case "aisharepoint_draft_communication":
      return `Preparing a ${i.channel === "teams" ? "Teams message" : "draft email"}${str(i.to) ? ` to ${short(String(i.to), 40)}` : ""}…`;
    case "aisharepoint_write_confluence_page":
      return `${i.action === "update" ? "Updating" : "Creating"} a Confluence page${str(i.title) ? ` “${short(String(i.title), 40)}”` : ""} (awaiting approval)…`;
    case "aisharepoint_confluence_capabilities":
      return "Discovering Confluence content capabilities…";
    case "aisharepoint_validate_confluence_page":
      return `Validating the rendered Confluence page${str(i.pageId) ? ` ${String(i.pageId)}` : ""}…`;
    case "aisharepoint_manage_confluence_labels":
      return `${i.action === "add" ? "Adding" : i.action === "remove" ? "Removing" : "Reading"} Confluence page label(s)${i.action && i.action !== "list" ? " (awaiting approval)" : ""}…`;
    case "aisharepoint_archive_confluence_page":
      return `Archiving Confluence page${str(i.pageId) ? ` ${String(i.pageId)}` : ""} (awaiting approval)…`;
    case "aisharepoint_move_confluence_page":
      return `${i.position === "before" || i.position === "after" ? "Reordering" : "Re-parenting"} Confluence page${str(i.pageId) ? ` ${String(i.pageId)}` : ""} (awaiting approval)…`;
    case "aisharepoint_remove_confluence_page_from_search":
      return `Removing Confluence page${str(i.pageId) ? ` ${String(i.pageId)}` : ""} from search (awaiting approval)…`;
    case "aisharepoint_resolve_page_owners":
      return `Resolving the owner(s) of Confluence page${str(i.pageId) ? ` ${String(i.pageId)}` : ""}…`;
    case "aisharepoint_review_space_manageability":
      return `Reviewing manageability of ${str(i.spaceKey) ? `space ${String(i.spaceKey)}` : "the Confluence space"}…`;
    case "aisharepoint_review_page_currency":
      return `Reviewing currency of Confluence page${str(i.pageId) ? ` ${String(i.pageId)}` : ""}…`;
    case "aisharepoint_confluence_page_tree":
      return str(i.spaceKey) && !str(i.pageId)
        ? `Listing root pages of Confluence space ${String(i.spaceKey)}…`
        : `Reading the Confluence page hierarchy${str(i.pageId) ? ` of ${String(i.pageId)}` : ""} (${str(i.view) ? String(i.view) : "context"})…`;
    case "aisharepoint_site_overview":
      return `Reading ${str(i.site) ?? "the site"} overview…`;
    case "aisharepoint_inspect_site":
      return str(i.page)
        ? `Inspecting page “${short(String(i.page), 40)}” (read-only)…`
        : `Inspecting ${str(i.site) ?? "the site"} architecture (read-only)…`;
    case "aisharepoint_scan_site_content":
      return `Scanning every page of ${str(i.site) ?? "the site"} for content (read-only)…`;
    case "aisharepoint_list_pages":
      return `Listing pages of ${str(i.site) ?? "the site"}…`;
    case "aisharepoint_list_connections":
      return "Listing your SharePoint connections…";
    case "aisharepoint_sp_list_items":
      return `Reading SharePoint list${str(i.list) ? ` “${short(String(i.list), 40)}”` : ""} (browser session)…`;
    case "aisharepoint_sp_write_item":
      return `${i.action === "update" ? "Updating" : "Creating"} a SharePoint list item${str(i.list) ? ` in “${short(String(i.list), 40)}”` : ""} (browser session, awaiting approval)…`;
    case "aisharepoint_copilot_usage":
      return "Checking Copilot usage…";
    case "aisharepoint_write_site_files":
      return `Writing ${Array.isArray(i.files) ? `${i.files.length} site file(s)` : "site files"} into the repository…`;
    case "aisharepoint_pull_site":
      return "Pulling the site into its repository…";
    case "aisharepoint_apply_site":
      return "Launching apply-to-SharePoint (your approval required)…";
    default:
      return `Running ${name.replace(/^aisharepoint_/, "").replace(/_/g, " ")}…`;
  }
}
