import { test } from "node:test";
import * as assert from "node:assert/strict";
import { describeToolCall } from "../src/chat/toolStatus";

test("search status names the source and query, not a generic 'Running'", () => {
  assert.equal(
    describeToolCall("aisharepoint_search_context", { source: "CMDB", query: "owned by jdoe" }),
    "Searching CMDB for “owned by jdoe”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_search_context", { query: "release notes" }),
    "Searching reference sources for “release notes”…",
  );
});

test("each tool gets a meaningful, input-aware line", () => {
  assert.equal(
    describeToolCall("aisharepoint_db_schema", { source: "CMDB", topic: "ownership" }),
    "Reading CMDB schema for “ownership”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_vertex_answer", { source: "Corp Search", query: "policy" }),
    "Asking Corp Search “policy”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_run_bookmark", { name: "Open incidents" }),
    "Running bookmark “Open incidents”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_draft_communication", { channel: "teams", to: "jdoe@corp.example" }),
    "Preparing a Teams message to jdoe@corp.example…",
  );
  assert.equal(
    describeToolCall("aisharepoint_export_context_results", { source: "CMDB" }),
    "Exporting CMDB results to a workspace file…",
  );
  assert.equal(
    describeToolCall("aisharepoint_apply_site", {}),
    "Launching apply-to-SharePoint (your approval required)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_write_site_files", { files: [{ path: "lists/A.json", content: "{}" }, { path: "pages/B.json", content: "{}" }] }),
    "Writing 2 site file(s) into the repository…",
  );
});

test("malformed/empty input degrades gracefully; unknown tools get a readable fallback", () => {
  assert.equal(describeToolCall("aisharepoint_search_context", undefined), "Searching reference sources…");
  assert.equal(describeToolCall("aisharepoint_search_context", { source: 42 }), "Searching reference sources…");
  assert.equal(describeToolCall("aisharepoint_future_tool", {}), "Running future tool…");
});

test("Confluence governance tools get input-aware status lines", () => {
  assert.equal(
    describeToolCall("aisharepoint_archive_confluence_page", { pageId: "123" }),
    "Archiving Confluence page 123 (awaiting approval)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_remove_confluence_page_from_search", { pageId: "9" }),
    "Removing Confluence page 9 from search (awaiting approval)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_manage_confluence_labels", { action: "add", pageId: "1" }),
    "Adding Confluence page label(s) (awaiting approval)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_manage_confluence_labels", { action: "list", pageId: "1" }),
    "Reading Confluence page label(s)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_review_space_manageability", { spaceKey: "ENG" }),
    "Reviewing manageability of space ENG…",
  );
});

test("long queries are truncated so the status line stays short", () => {
  const out = describeToolCall("aisharepoint_search_context", { query: "x".repeat(200) });
  assert.ok(out.length < 100, out);  // bounded, not the full 200-char query
  assert.ok(out.includes("…"));
});

test("describeToolResult counts what came back from JSON tool output", async () => {
  const { describeToolResult } = await import("../src/chat/toolStatus");
  assert.equal(
    describeToolResult(
      "aisharepoint_search_context",
      { source: "CMDB", query: "x" },
      JSON.stringify([{ title: "a" }, { title: "b" }, { title: "c" }]),
    ),
    "Search of CMDB: 3 result(s) — continuing…",
  );
  // Wrapped result arrays (run_bookmark envelope) count too.
  assert.equal(
    describeToolResult(
      "aisharepoint_run_bookmark",
      { name: "IT Help queue" },
      JSON.stringify({ bookmark: "IT Help queue", source: "Jira", kind: "query", result: [1, 2] }),
    ),
    "Bookmark “IT Help queue”: 2 result(s) — continuing…",
  );
});

test("describeToolResult handles prose results: no-results and plain text", async () => {
  const { describeToolResult } = await import("../src/chat/toolStatus");
  assert.equal(
    describeToolResult("aisharepoint_search_context", { source: "Wiki" }, 'No results in "Wiki" for that query.'),
    "Search of Wiki: no results — continuing…",
  );
  const big = describeToolResult("aisharepoint_get_context_item", {}, "x".repeat(5000));
  assert.match(big, /KB of text — continuing…$/);
  assert.equal(describeToolResult("aisharepoint_list_sources", {}, ""), "list sources: empty result — continuing…");
});
