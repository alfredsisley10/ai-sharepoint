/**
 * Human-readable progress lines for @sharepoint tool calls (pilot: status
 * must reflect what was actually asked, not a generic "Running …"). Pure and
 * input-aware so multi-turn operations read like a narrated plan. Inputs are
 * model-supplied — kept short and never assumed well-formed.
 */

const short = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

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
    case "aisharepoint_test_outlook_channel":
      return "Testing the Outlook channel (draft to yourself — nothing is sent)…";
    case "aisharepoint_site_overview":
      return `Reading ${str(i.site) ?? "the site"} overview…`;
    case "aisharepoint_inspect_site":
      return str(i.page)
        ? `Inspecting page “${short(String(i.page), 40)}” (read-only)…`
        : `Inspecting ${str(i.site) ?? "the site"} architecture (read-only)…`;
    case "aisharepoint_list_pages":
      return `Listing pages of ${str(i.site) ?? "the site"}…`;
    case "aisharepoint_list_connections":
      return "Listing your SharePoint connections…";
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
