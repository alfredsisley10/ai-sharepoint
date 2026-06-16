import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson, htmlToText } from "../http";

/**
 * Confluence "Add more content" vocabulary (ADR-0043): the macros and special
 * storage-format elements a Confluence page can contain — code/markup blocks,
 * horizontal rules, task lists, info/note/warning panels, expand, status
 * lozenges, table of contents, layouts, Jira issue/filter, draw.io diagrams,
 * and more. Three capabilities live here:
 *
 *  1. CATALOG — a curated description of each element so @sharepoint knows what
 *     it can use and what each one needs (params, body type, owning app).
 *  2. EMITTERS — pure builders that produce CORRECT storage-format XHTML, so
 *     the assistant authors advanced pages deterministically instead of
 *     guessing macro syntax.
 *  3. DISCOVERY — because the *available* set depends on which apps the instance
 *     has installed (draw.io, Gliffy, Mermaid…), this empirically scans real
 *     pages' storage format to report which macros are actually in use, and
 *     best-effort lists installed apps.
 *
 * Storage format primer: a macro is
 *   <ac:structured-macro ac:name="NAME"><ac:parameter ac:name="k">v</ac:parameter>
 *     <ac:rich-text-body>…</ac:rich-text-body></ac:structured-macro>
 * with `<ac:plain-text-body><![CDATA[…]]></ac:plain-text-body>` for verbatim
 * bodies. A few things (horizontal rule, task list, multi-column layout) are
 * their own elements rather than macros.
 */

// ---------------------------------------------------------------------------
// Emitters (pure) — correct storage-format XHTML.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Generic structured-macro emitter. `richBody` is inserted as-is (it is itself
 *  storage format); `plainBody` is wrapped in CDATA (verbatim, e.g. code). */
export function structuredMacro(
  name: string,
  params: Record<string, string | number | boolean> = {},
  opts: { richBody?: string; plainBody?: string } = {},
): string {
  const ps = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<ac:parameter ac:name="${esc(k)}">${esc(String(v))}</ac:parameter>`)
    .join("");
  const body =
    opts.richBody !== undefined
      ? `<ac:rich-text-body>${opts.richBody}</ac:rich-text-body>`
      : opts.plainBody !== undefined
        ? `<ac:plain-text-body><![CDATA[${opts.plainBody.replace(/]]>/g, "]]]]><![CDATA[>")}]]></ac:plain-text-body>`
        : "";
  return `<ac:structured-macro ac:name="${esc(name)}">${ps}${body}</ac:structured-macro>`;
}

/** Code block with optional language (syntax highlight) and title. */
export function codeBlock(code: string, language?: string, title?: string): string {
  return structuredMacro(
    "code",
    { ...(language ? { language } : {}), ...(title ? { title } : {}) },
    { plainBody: code },
  );
}

export type PanelKind = "info" | "note" | "warning" | "tip" | "panel";
/** Admonition / custom panel. `richBody` is storage format. */
export function panel(kind: PanelKind, richBody: string, params: Record<string, string> = {}): string {
  return structuredMacro(kind, params, { richBody });
}

/** Collapsible expand block. */
export function expand(richBody: string, title?: string): string {
  return structuredMacro("expand", title ? { title } : {}, { richBody });
}

export type StatusColour = "Grey" | "Red" | "Yellow" | "Green" | "Blue";
/** Inline status lozenge. */
export function status(title: string, colour: StatusColour = "Grey"): string {
  return structuredMacro("status", { colour, title });
}

/** Table of contents. */
export function tableOfContents(params: Record<string, string | number> = {}): string {
  return structuredMacro("toc", params);
}

/** Anchor target (the default/unnamed parameter holds the name). */
export function anchor(name: string): string {
  return structuredMacro("anchor", { "": name });
}

/** Horizontal rule (an element, not a macro). */
export function horizontalRule(): string {
  return "<hr/>";
}

export interface TaskItem {
  text: string;
  done?: boolean;
}
/** Interactive task list (an element, not a macro). */
export function taskList(items: TaskItem[]): string {
  const tasks = items
    .map(
      (it, i) =>
        `<ac:task><ac:task-id>${i + 1}</ac:task-id><ac:task-status>${it.done ? "complete" : "incomplete"}</ac:task-status><ac:task-body>${esc(it.text)}</ac:task-body></ac:task>`,
    )
    .join("");
  return `<ac:task-list>${tasks}</ac:task-list>`;
}

export interface JiraMacroOptions {
  /** A single issue key, e.g. "PROJ-123". */
  key?: string;
  /** A JQL query (filter), e.g. 'project = PROJ AND status = "In Progress"'. */
  jql?: string;
  /** Comma-separated columns, e.g. "key,summary,status,assignee". */
  columns?: string;
  /** Show only the issue count rather than the table. */
  count?: boolean;
  maximumIssues?: number;
  /** Linked Jira application name / id (from the Application Link). */
  server?: string;
  serverId?: string;
}
/** Jira issue (key) or Jira filter (jqlQuery) macro. Needs a Jira Application
 *  Link configured in Confluence. */
export function jira(opts: JiraMacroOptions): string {
  const params: Record<string, string | number | boolean> = {};
  if (opts.key) params.key = opts.key;
  if (opts.jql) params.jqlQuery = opts.jql;
  if (opts.columns) params.columns = opts.columns;
  if (opts.count !== undefined) params.count = opts.count;
  if (opts.maximumIssues !== undefined) params.maximumIssues = opts.maximumIssues;
  if (opts.server) params.server = opts.server;
  if (opts.serverId) params.serverId = opts.serverId;
  return structuredMacro("jira", params);
}

/** draw.io / diagrams.net diagram (requires the draw.io app). */
export function drawio(opts: { diagramName: string; pageId?: string; revision?: number; width?: number; height?: number }): string {
  return structuredMacro("drawio", {
    diagramName: opts.diagramName,
    ...(opts.pageId ? { pageId: opts.pageId } : {}),
    ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.height !== undefined ? { height: opts.height } : {}),
  });
}

/** Child-pages display. */
export function children(params: Record<string, string | number> = {}): string {
  return structuredMacro("children", params);
}

/** Multi-column layout. `type` is e.g. "single", "two_equal", "two_left_sidebar",
 *  "three_equal"; each section holds one cell per column (storage format). */
export function layout(sections: Array<{ type: string; cells: string[] }>): string {
  const body = sections
    .map(
      (s) =>
        `<ac:layout-section ac:type="${esc(s.type)}">${s.cells.map((c) => `<ac:layout-cell>${c}</ac:layout-cell>`).join("")}</ac:layout-section>`,
    )
    .join("");
  return `<ac:layout>${body}</ac:layout>`;
}

// ---------------------------------------------------------------------------
// Catalog — the "Add more content" vocabulary.
// ---------------------------------------------------------------------------

export type MacroCategory =
  | "formatting"
  | "panel"
  | "structure"
  | "navigation"
  | "media"
  | "integration";

export type MacroBody = "none" | "plain" | "rich";

export interface MacroParamSpec {
  name: string;
  required?: boolean;
  description: string;
}

export interface MacroSpec {
  /** Storage-format ac:name, or a synthetic id for non-macro elements
   *  ("hr", "task-list", "layout"). */
  name: string;
  label: string;
  category: MacroCategory;
  description: string;
  body: MacroBody;
  params?: MacroParamSpec[];
  /** App that must be installed for this to render (undefined = built-in). */
  app?: string;
  /** Ready-to-use storage-format example. */
  example: string;
}

export const MACRO_CATALOG: MacroSpec[] = [
  {
    name: "code",
    label: "Code block / markup",
    category: "formatting",
    description: "Monospaced block with syntax highlighting. Use for code, config, or any verbatim markup.",
    body: "plain",
    params: [
      { name: "language", description: "Highlighting language, e.g. java, python, yaml, sql." },
      { name: "title", description: "Optional caption shown above the block." },
    ],
    example: codeBlock('print("hello")', "python", "Example"),
  },
  {
    name: "noformat",
    label: "No-format / preformatted",
    category: "formatting",
    description: "Monospaced verbatim block with no syntax highlighting.",
    body: "plain",
    example: structuredMacro("noformat", {}, { plainBody: "raw text" }),
  },
  {
    name: "status",
    label: "Status lozenge",
    category: "formatting",
    description: "Inline coloured status pill, e.g. a DONE/IN PROGRESS/BLOCKED badge.",
    body: "none",
    params: [
      { name: "colour", description: "Grey, Red, Yellow, Green, or Blue." },
      { name: "title", required: true, description: "The label text." },
    ],
    example: status("IN PROGRESS", "Yellow"),
  },
  {
    name: "hr",
    label: "Horizontal rule",
    category: "formatting",
    description: "A divider line between sections.",
    body: "none",
    example: horizontalRule(),
  },
  {
    name: "info",
    label: "Info panel",
    category: "panel",
    description: "Blue informational callout.",
    body: "rich",
    example: panel("info", "<p>Heads up.</p>"),
  },
  {
    name: "note",
    label: "Note panel",
    category: "panel",
    description: "Yellow note callout.",
    body: "rich",
    example: panel("note", "<p>Take note.</p>"),
  },
  {
    name: "warning",
    label: "Warning panel",
    category: "panel",
    description: "Red warning callout.",
    body: "rich",
    example: panel("warning", "<p>Be careful.</p>"),
  },
  {
    name: "tip",
    label: "Tip panel",
    category: "panel",
    description: "Green tip callout.",
    body: "rich",
    example: panel("tip", "<p>Pro tip.</p>"),
  },
  {
    name: "panel",
    label: "Custom panel",
    category: "panel",
    description: "Bordered panel with an optional title and custom colours.",
    body: "rich",
    params: [
      { name: "title", description: "Panel heading." },
      { name: "borderColor", description: "CSS colour for the border." },
      { name: "bgColor", description: "CSS colour for the background." },
    ],
    example: panel("panel", "<p>Body.</p>", { title: "Summary" }),
  },
  {
    name: "expand",
    label: "Expand (collapsible)",
    category: "panel",
    description: "Collapsible section that hides content behind a clickable title.",
    body: "rich",
    params: [{ name: "title", description: "The clickable label." }],
    example: expand("<p>Hidden detail.</p>", "Show details"),
  },
  {
    name: "toc",
    label: "Table of contents",
    category: "structure",
    description: "Auto-generated outline from the page's headings.",
    body: "none",
    params: [
      { name: "maxLevel", description: "Deepest heading level to include (1–6)." },
      { name: "minLevel", description: "Shallowest heading level to include." },
    ],
    example: tableOfContents({ maxLevel: 3 }),
  },
  {
    name: "anchor",
    label: "Anchor",
    category: "structure",
    description: "Named in-page jump target for links.",
    body: "none",
    example: anchor("section-1"),
  },
  {
    name: "task-list",
    label: "Task list (action items)",
    category: "structure",
    description: "Interactive checkbox list of action items, each tickable in the page.",
    body: "none",
    example: taskList([{ text: "Draft the spec" }, { text: "Review", done: true }]),
  },
  {
    name: "layout",
    label: "Multi-column layout",
    category: "structure",
    description: "Arrange content in columns (two/three equal, sidebars).",
    body: "rich",
    example: layout([{ type: "two_equal", cells: ["<p>Left</p>", "<p>Right</p>"] }]),
  },
  {
    name: "children",
    label: "Children display",
    category: "navigation",
    description: "List or tree of child pages under this page.",
    body: "none",
    params: [
      { name: "all", description: "true to show the whole descendant tree." },
      { name: "depth", description: "How many levels deep." },
    ],
    example: children({ all: "true" }),
  },
  {
    name: "pagetree",
    label: "Page tree",
    category: "navigation",
    description: "Expandable tree of pages rooted at a page or the space home.",
    body: "none",
    example: structuredMacro("pagetree", {}),
  },
  {
    name: "include",
    label: "Include page",
    category: "navigation",
    description: "Embed the full contents of another page.",
    body: "none",
    example: structuredMacro("include", {}, { richBody: '<ac:link><ri:page ri:content-title="Other Page"/></ac:link>' }),
  },
  {
    name: "excerpt-include",
    label: "Excerpt include",
    category: "navigation",
    description: "Embed the excerpt defined on another page.",
    body: "none",
    example: structuredMacro("excerpt-include", {}, { richBody: '<ac:link><ri:page ri:content-title="Other Page"/></ac:link>' }),
  },
  {
    name: "contentbylabel",
    label: "Content by label",
    category: "navigation",
    description: "Dynamic list of pages matching one or more labels (CQL).",
    body: "none",
    params: [{ name: "cql", description: 'A CQL query, e.g. label = "runbook".' }],
    example: structuredMacro("contentbylabel", { cql: 'label = "runbook"' }),
  },
  {
    name: "jira",
    label: "Jira issue / filter",
    category: "integration",
    description: "Embed a single Jira issue (key) or a live table of issues from a JQL filter. Needs a Jira Application Link.",
    body: "none",
    app: "Jira (Application Link)",
    params: [
      { name: "key", description: "A single issue, e.g. PROJ-123." },
      { name: "jqlQuery", description: "JQL for a filter/table of issues." },
      { name: "columns", description: "Columns to show, e.g. key,summary,status." },
      { name: "count", description: "true to show just the count." },
    ],
    example: jira({ jql: 'project = PROJ AND statusCategory != Done', columns: "key,summary,status,assignee" }),
  },
  {
    name: "drawio",
    label: "draw.io / diagrams.net diagram",
    category: "media",
    description: "Embed an editable draw.io diagram. Requires the draw.io app to be installed.",
    body: "none",
    app: "draw.io / diagrams.net",
    params: [
      { name: "diagramName", required: true, description: "Name of the diagram attachment." },
      { name: "pageId", description: "Page the diagram attachment lives on." },
    ],
    example: drawio({ diagramName: "Architecture" }),
  },
  {
    name: "gliffy",
    label: "Gliffy diagram",
    category: "media",
    description: "Embed a Gliffy diagram. Requires the Gliffy app.",
    body: "none",
    app: "Gliffy",
    params: [{ name: "name", required: true, description: "Diagram name." }],
    example: structuredMacro("gliffy", { name: "Network" }),
  },
  {
    name: "mermaid",
    label: "Mermaid diagram",
    category: "media",
    description: "Render a Mermaid text diagram (flowchart/sequence/…). Requires a Mermaid app.",
    body: "plain",
    app: "Mermaid (e.g. Mermaid Diagrams)",
    example: structuredMacro("mermaid", {}, { plainBody: "graph TD; A-->B;" }),
  },
  {
    name: "drawio-plantuml",
    label: "PlantUML diagram",
    category: "media",
    description: "Render a PlantUML text diagram. Requires a PlantUML app.",
    body: "plain",
    app: "PlantUML",
    example: structuredMacro("plantuml", {}, { plainBody: "@startuml\nA -> B\n@enduml" }),
  },
  {
    name: "image",
    label: "Image / attachment",
    category: "media",
    description: "Display an attached image (or external URL).",
    body: "none",
    example: '<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>',
  },
];

/** Catalog grouped by category, in display order. Pure. */
export function catalogByCategory(): Array<{ category: MacroCategory; macros: MacroSpec[] }> {
  const order: MacroCategory[] = ["formatting", "panel", "structure", "navigation", "media", "integration"];
  return order
    .map((category) => ({ category, macros: MACRO_CATALOG.filter((m) => m.category === category) }))
    .filter((g) => g.macros.length > 0);
}

// ---------------------------------------------------------------------------
// Discovery — what's actually used / available in this instance.
// ---------------------------------------------------------------------------

/** Extract the macro/element names present in a storage-format body. Catches
 *  structured macros plus the special elements (task list, layout, hr, image,
 *  emoticon, date, mentions, links). Pure. */
export function extractMacrosFromStorage(xhtml: string): string[] {
  const names = new Set<string>();
  for (const m of (xhtml ?? "").matchAll(/<ac:structured-macro[^>]*\bac:name="([^"]+)"/g)) {
    names.add(m[1]);
  }
  if (/<ac:task-list\b/.test(xhtml)) names.add("task-list");
  if (/<ac:layout\b/.test(xhtml)) names.add("layout");
  if (/<hr\b/.test(xhtml)) names.add("hr");
  if (/<ac:image\b/.test(xhtml)) names.add("image");
  if (/<ac:emoticon\b/.test(xhtml)) names.add("emoticon");
  if (/<time\b/.test(xhtml)) names.add("date");
  if (/<ri:user\b/.test(xhtml)) names.add("mention");
  return [...names];
}

export interface MacroUsage {
  name: string;
  count: number;
  /** Catalog entry, when this is a known element. */
  spec?: MacroSpec;
  /** App the element belongs to (from the catalog), if any. */
  app?: string;
  /** Known built-in (in catalog, no owning app). Unknown macros are app- or
   *  plugin-provided ones we don't have a catalog entry for. */
  known: boolean;
}

/** Tally macro usage across page bodies, richest-first, annotated from the
 *  catalog. Pure. */
export function tallyMacros(bodies: string[]): MacroUsage[] {
  const counts = new Map<string, number>();
  for (const b of bodies) {
    for (const n of extractMacrosFromStorage(b)) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => {
      const spec = MACRO_CATALOG.find((s) => s.name === name);
      return { name, count, spec, app: spec?.app, known: Boolean(spec) };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

interface ContentItem {
  body?: { storage?: { value?: string } };
}

/** Empirically sample a space / subtree / page in storage format and report the
 *  macros actually in use (the most reliable "what's available here" signal —
 *  needs only read access). */
export async function discoverConfluenceMacros(
  source: ContextSource,
  credential: ContextCredential,
  scope: { spaceKey?: string; pageId?: string; subtree?: boolean },
  caps: ReadCaps,
  maxPages = 50,
): Promise<{ pagesSampled: number; used: MacroUsage[] }> {
  const base = source.baseUrl.replace(/\/$/, "");
  const enc = encodeURIComponent;
  let bodies: string[] = [];
  if (scope.pageId && !scope.subtree) {
    const c = await fetchJson<ContentItem>(
      `${base}/rest/api/content/${enc(scope.pageId)}?expand=body.storage`,
      credential,
      caps.timeoutMs,
    );
    bodies = [c.body?.storage?.value ?? ""];
  } else if (scope.pageId && scope.subtree) {
    const r = await fetchJson<{ results?: ContentItem[] }>(
      `${base}/rest/api/content/${enc(scope.pageId)}/descendant/page?expand=body.storage&limit=${maxPages}`,
      credential,
      caps.timeoutMs,
    );
    bodies = (r.results ?? []).map((c) => c.body?.storage?.value ?? "");
  } else if (scope.spaceKey) {
    const r = await fetchJson<{ results?: ContentItem[] }>(
      `${base}/rest/api/content?spaceKey=${enc(scope.spaceKey)}&type=page&expand=body.storage&limit=${maxPages}`,
      credential,
      caps.timeoutMs,
    );
    bodies = (r.results ?? []).map((c) => c.body?.storage?.value ?? "");
  }
  return { pagesSampled: bodies.length, used: tallyMacros(bodies) };
}

interface UpmPlugin {
  name?: string;
  key?: string;
  enabled?: boolean;
  userInstalled?: boolean;
}

/** Best-effort list of user-installed, enabled apps via the UPM endpoint. Often
 *  admin-only — returns [] (rather than throwing) when not permitted, since the
 *  empirical scan is the primary signal. */
export async function detectConfluenceApps(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<string[]> {
  try {
    const base = source.baseUrl.replace(/\/$/, "");
    const r = await fetchJson<{ plugins?: UpmPlugin[] }>(`${base}/rest/plugins/1.0/`, credential, caps.timeoutMs);
    return (r.plugins ?? [])
      .filter((p) => p.userInstalled && p.enabled)
      .map((p) => p.name ?? p.key ?? "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export interface CapabilityReport {
  pagesSampled: number;
  used: MacroUsage[];
  apps: string[];
  catalog: MacroSpec[];
}

// ---------------------------------------------------------------------------
// Rendered-content validation — confirm elements are TRUE Confluence elements.
//
// The recurring bug: the assistant writes wiki/markdown shorthand like "[TOC]"
// or "{toc}" instead of a real macro, so Confluence shows the literal text
// "[TOC]" rather than a table of contents. Pulling the RENDERED view and
// scanning it catches exactly that — and inventories what actually rendered.
// ---------------------------------------------------------------------------

/** Known macro names whose wiki shorthand ({name} / {name:params}) leaking into
 *  visible text means it was authored as markup, not a real macro. */
const WIKI_MACRO_NAMES =
  "toc|info|note|warning|tip|code|noformat|expand|status|panel|jira|jiraissues|children|pagetree|anchor|section|column|include|excerpt|excerpt-include|contentbylabel|recently-updated|attachments|gallery|drawio|gliffy|mermaid|plantuml";

export interface LeakFinding {
  /** The literal text that leaked (e.g. "[TOC]" or "{info}"). */
  markup: string;
  /** Best-guess macro it was meant to be. */
  macro: string;
}

/** Find literal macro markup that leaked into VISIBLE TEXT — the signal that an
 *  element was written as wiki/markdown shorthand and did NOT become a real
 *  Confluence element. Run on the rendered view's plain text. Pure. */
export function findLeakedMacroMarkup(text: string): LeakFinding[] {
  const out: LeakFinding[] = [];
  const seen = new Set<string>();
  const push = (markup: string, macro: string) => {
    const key = `${markup}|${macro}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ markup, macro });
    }
  };
  // Markdown TOC shorthand: [TOC] / [[TOC]]
  for (const m of text.matchAll(/\[\[?\s*toc\s*\]?\]/gi)) push(m[0], "toc");
  // Wiki macro shorthand: {macro} or {macro:params} for known macros.
  const wiki = new RegExp(`\\{(${WIKI_MACRO_NAMES})(?::[^}]*)?\\}`, "gi");
  for (const m of text.matchAll(wiki)) push(m[0], m[1].toLowerCase());
  // Raw storage tags showing as text = storage wasn't interpreted at all.
  for (const m of text.matchAll(/<\s*ac:(structured-macro|task-list)\b/gi)) push(m[0], m[1].toLowerCase());
  return out;
}

/** Inventory the macros that ACTUALLY rendered in the view HTML. Confluence
 *  wraps rendered macros with `data-macro-name` (reliable across versions) and
 *  a handful of well-known classes; tally both. Pure. */
export function inventoryRenderedMacros(viewHtml: string): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  const bump = (n: string) => counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const m of (viewHtml ?? "").matchAll(/data-macro-name="([^"]+)"/gi)) bump(m[1].toLowerCase());
  // Class-based fallbacks for elements that don't always carry data-macro-name.
  const classHits: Array<[RegExp, string]> = [
    [/class="[^"]*\btoc-macro\b/gi, "toc"],
    [/class="[^"]*\bconfluence-information-macro\b/gi, "panel"],
    [/class="[^"]*\b(?:task-list|inline-task-list)\b/gi, "task-list"],
    [/class="[^"]*\bcode\b[^"]*\bpanel\b|class="[^"]*\bsyntaxhighlighter\b/gi, "code"],
    [/class="[^"]*\bjira-issue\b|data-issue-key=/gi, "jira"],
    [/class="[^"]*\bstatus-macro\b|\baui-lozenge\b/gi, "status"],
  ];
  for (const [re, name] of classHits) {
    const n = (viewHtml ?? "").match(re)?.length ?? 0;
    if (n > 0) counts.set(name, (counts.get(name) ?? 0) + (counts.has(name) ? 0 : n));
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface RenderedValidation {
  pageId: string;
  title: string;
  url: string;
  /** Literal macro markup visible in the rendered page (BAD — not real elements). */
  leaks: LeakFinding[];
  /** Macros that actually rendered. */
  rendered: Array<{ name: string; count: number }>;
  /** Length of the rendered plain text (sanity signal). */
  textLength: number;
  ok: boolean;
}

interface RenderedContent {
  title?: string;
  body?: { view?: { value?: string }; storage?: { value?: string } };
  _links?: { webui?: string };
}

/** Pull a page's TRUE RENDERED content (body.view — macros expanded) and
 *  validate it: flag any wiki/markdown shorthand that leaked as visible text,
 *  and inventory the macros that genuinely rendered. This is the post-write
 *  confirmation that elements are as intended. */
export async function validateConfluencePageRendered(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
): Promise<RenderedValidation> {
  const base = source.baseUrl.replace(/\/$/, "");
  const enc = encodeURIComponent;
  const c = await fetchJson<RenderedContent>(
    `${base}/rest/api/content/${enc(pageId)}?expand=body.view,body.storage`,
    credential,
    caps.timeoutMs,
  );
  const view = c.body?.view?.value ?? "";
  const renderedText = htmlToText(view, caps.maxBodyChars);
  // Scan only the VISIBLE rendered text: a leak (a literal "[TOC]" or "<ac:…"
  // showing as text) means it did not render. The storage source legitimately
  // contains <ac:…> macros, so scanning it would false-positive.
  const leaks = findLeakedMacroMarkup(renderedText);
  const rendered = inventoryRenderedMacros(view);
  return {
    pageId,
    title: c.title ?? "(untitled)",
    url: c._links?.webui ? `${base}${c._links.webui}` : base,
    leaks,
    rendered,
    textLength: renderedText.length,
    ok: leaks.length === 0,
  };
}
