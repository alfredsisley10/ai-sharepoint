import { ContextSource, ContextCredential } from "../types";
import { fetchJson } from "../http";
import { AppError } from "../../core/errors";
import { EXTENSION_VERSION } from "../../core/version";
import { codeBlock, taskList, horizontalRule, tableOfContents } from "./confluenceMacros";

/**
 * Confluence write client (ADR-0038): create / update / delete pages in a
 * Confluence space via the REST content API, authenticated with the user's
 * OWN API token (Basic) or PAT (Bearer) — the same credential the read adapter
 * uses. This is the writable target that needs NO tenant-admin OAuth consent
 * (unlike SharePoint's Sites.* Graph scopes): writes succeed with exactly the
 * edit rights the user already has in Confluence.
 *
 * Confluence is page-centric, so this is a Confluence-native writer (pages,
 * with version-bumped updates and storage-format bodies) rather than the
 * SharePoint-shaped PushWriter (lists/columns/canvas).
 */

const enc = encodeURIComponent;

/**
 * Build the body of the confirmation a user must approve before ANY Confluence
 * mutation (create/update, archive, move, remove-from-search, label change). It
 * ALWAYS surfaces the instance **URL** and the connector's write **scope** (the
 * space key when the connector is space-bound, the page when page-bound, or a
 * clear "entire instance" warning otherwise) on top of the op-specific lines, so
 * the user verifies WHERE the change lands before it happens. Pure (no vscode) so
 * it's unit-tested; the tool layer wraps the returned text in a MarkdownString.
 */
export function confluenceWriteConfirmationText(
  target: Pick<ContextSource, "baseUrl" | "writeScope"> | undefined,
  ref: string | undefined,
  opLines: string[],
): string {
  const head: string[] = [];
  if (target) {
    head.push(`**Confluence instance:** ${target.baseUrl}`);
    const ws = target.writeScope;
    if (ws?.kind === "space" && ws.spaceKey) head.push(`**Space (connector write scope):** \`${ws.spaceKey}\``);
    else if (ws?.kind === "page") head.push(`**Write scope:** a single page${ws.url ? ` — ${ws.url}` : ""}`);
    else head.push(`**Write scope:** the ENTIRE instance — not bounded to one space`);
  } else {
    head.push(`**Source:** ${ref ?? "the configured Confluence source"}`);
  }
  return [
    ...head,
    ...opLines,
    "",
    "Verify the **space** and **URL** above before approving — this writes to Confluence with your own API token.",
  ].join("\n");
}

/**
 * Confirmation body for an INSTANCE-scoped connector about to write to a
 * SPECIFIC page. The (synchronous) tool approval card can't resolve where a page
 * lives, so a connector that can write anywhere in the instance would otherwise
 * mutate it without the user ever seeing the destination space. Once the tool
 * layer resolves the page's real space, this names it for an explicit second
 * confirmation. Plain text (shown in a modal dialog), so no Markdown. Pure.
 */
export function confluenceInstanceSpaceConfirmText(
  action: string,
  pageId: string,
  spaceKey: string | undefined,
  title?: string,
): string {
  const where = spaceKey ? `space "${spaceKey}"` : "an unrecognized space";
  const page = `page ${pageId}${title ? ` ("${title}")` : ""}`;
  return [
    "This Confluence connector can write anywhere in the instance — it isn't bound to a single space.",
    `The ${page} you're about to ${action} lives in ${where}.`,
    `Confirm writing to ${where}?`,
  ].join("\n\n");
}

/**
 * Headers that make a Confluence WRITE behave like the Atlassian Python client
 * (atlassian-python-api on `requests`), which succeeds where VS Code's Electron
 * `fetch` fails its CSRF check:
 *
 *  - `X-Atlassian-Token: no-check` — the documented bypass for programmatic
 *    non-GET REST calls (value must be exactly "no-check", with the hyphen).
 *  - A NON-browser `User-Agent` — the decisive difference. Atlassian applies a
 *    STRICTER CSRF path (Origin/Referer validation that rejects "both null")
 *    when the request carries a BROWSER User-Agent, which Electron fetch sends
 *    (Chrome). `requests` sends `python-requests/…` — a non-browser UA — so
 *    Confluence treats it as a trusted REST client and `no-check` suffices.
 *    Overriding the UA here reproduces that, while keeping Electron fetch on so
 *    the OS trust store still validates the SSL-inspecting proxy. (Atlassian KB:
 *    "REST API calls with a browser User-Agent header may fail CSRF checks.")
 *
 * A same-origin `Referer` is also presented on every write by the http layer —
 * the other documented fix ("remove the User-Agent OR set Origin/Referer").
 */
export const CONFLUENCE_WRITE_HEADERS: Record<string, string> = {
  "X-Atlassian-Token": "no-check",
  "User-Agent": `ai-toolkit-confluence/${EXTENSION_VERSION}`,
};

function base(source: Pick<ContextSource, "baseUrl">): string {
  return source.baseUrl.replace(/\/$/, "");
}

function webUrl(source: Pick<ContextSource, "baseUrl">, webui?: string): string {
  return webui ? `${base(source)}${webui}` : base(source);
}

export interface ConfluencePageWrite {
  spaceKey: string;
  title: string;
  /** Confluence storage-format (XHTML) body — see markdownToStorage. */
  body: string;
  /** Optional parent page id (creates the page under it). */
  parentId?: string;
}

export interface ConfluenceWriteResult {
  id: string;
  title: string;
  version: number;
  url: string;
}

interface ContentResponse {
  id?: string;
  title?: string;
  version?: { number?: number };
  space?: { key?: string };
  ancestors?: Array<{ id?: string }>;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

// ---------------------------------------------------------------------------
// Write-data hygiene (ADR-0045). Confluence storage format is STRICT XHTML and
// titles are PLAIN TEXT, but an LLM commonly emits a bare "&" (illegal in
// XHTML), an un-self-closed void element (<br>, <img>), or a title carrying
// HTML/entities ("<b>R&amp;D</b>"). These normalizers run on every write so a
// well-meaning-but-imperfect body/title still produces a valid page.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

/** Decode HTML entities (named + numeric) to their characters. Pure. */
export function decodeEntities(s: string): string {
  return String(s ?? "").replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent] ?? m;
  });
}

/** A Confluence page title is PLAIN TEXT. Strip any HTML tags, decode entities
 *  to their characters (so "R&amp;D" → "R&D", not double-encoded), collapse
 *  whitespace, and cap at Confluence's 255-char limit. Pure. */
export function normalizeTitle(raw: string): string {
  return decodeEntities(String(raw ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

const VOID_ELEMENTS = "br|hr|img|input|meta|link|col|area|base|source|wbr|embed|track|param";

/** Escape ampersands that don't already start a valid entity — the #1 thing
 *  that makes a storage body malformed XHTML. */
function escapeBareAmpersands(s: string): string {
  return s.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

/** Self-close void HTML elements the LLM writes unclosed (<br>, <img …>). */
function selfCloseVoidElements(s: string): string {
  return s.replace(new RegExp(`<(${VOID_ELEMENTS})\\b([^>]*?)(?<!/)>`, "gi"), (_m, tag, attrs) => `<${tag}${attrs}/>`);
}

/**
 * Make a storage-format body well-formed enough for Confluence: escape bare
 * ampersands and self-close void elements, WITHOUT touching verbatim CDATA
 * (code-macro bodies, where "&" and "<br>" are literal text). Idempotent — a
 * body produced by markdownToStorage passes through unchanged. Pure.
 */
export function sanitizeStorageBody(xhtml: string): string {
  // Split on CDATA sections (odd indices) so they're preserved verbatim.
  return String(xhtml ?? "")
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part, i) => (i % 2 === 1 ? part : selfCloseVoidElements(escapeBareAmpersands(part))))
    .join("");
}

/** Create-content request body (pure, testable). Title + body are normalized. */
export function buildCreateBody(page: ConfluencePageWrite): Record<string, unknown> {
  return {
    type: "page",
    title: normalizeTitle(page.title),
    space: { key: page.spaceKey },
    body: { storage: { value: sanitizeStorageBody(page.body), representation: "storage" } },
    ...(page.parentId ? { ancestors: [{ id: page.parentId }] } : {}),
  };
}

/** Update-content request body (pure, testable). Confluence requires the NEXT
 *  version number — one above the page's current version. */
export function buildUpdateBody(
  title: string,
  body: string,
  nextVersion: number,
): Record<string, unknown> {
  return {
    type: "page",
    title: normalizeTitle(title),
    version: { number: nextVersion },
    body: { storage: { value: sanitizeStorageBody(body), representation: "storage" } },
  };
}

function toResult(source: Pick<ContextSource, "baseUrl">, res: ContentResponse | undefined): ConfluenceWriteResult {
  if (!res?.id) {
    throw new AppError("Confluence did not return the saved page.", "unknown");
  }
  return {
    id: String(res.id),
    title: res.title ?? "(untitled)",
    version: res.version?.number ?? 1,
    url: webUrl(source, res._links?.webui),
  };
}

/** Create a new page in a space (optionally under a parent). */
export async function createConfluencePage(
  source: ContextSource,
  credential: ContextCredential,
  page: ConfluencePageWrite,
  timeoutMs: number,
): Promise<ConfluenceWriteResult> {
  if (!page.spaceKey.trim() || !page.title.trim()) {
    throw new AppError("A Confluence page needs a space key and a title.", "config");
  }
  const res = await fetchJson<ContentResponse>(
    `${base(source)}/rest/api/content`,
    credential,
    timeoutMs,
    CONFLUENCE_WRITE_HEADERS,
    { method: "POST", body: buildCreateBody(page) },
  );
  return toResult(source, res);
}

export interface ConfluencePageMeta {
  id: string;
  title: string;
  version: number;
  spaceKey?: string;
  parentId?: string;
  body?: string;
}

/** Read a page's current title/version/body — needed before an update (the
 *  next version is derived from the current one). */
export async function getConfluencePageMeta(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<ConfluencePageMeta> {
  const res = await fetchJson<ContentResponse>(
    `${base(source)}/rest/api/content/${enc(pageId)}?expand=version,space,ancestors,body.storage`,
    credential,
    timeoutMs,
  );
  if (!res?.id) throw new AppError(`Confluence page "${pageId}" was not found.`, "graph.notFound");
  const ancestors = res.ancestors ?? [];
  return {
    id: String(res.id),
    title: res.title ?? "(untitled)",
    version: res.version?.number ?? 1,
    ...(res.space?.key ? { spaceKey: res.space.key } : {}),
    ...(ancestors.length ? { parentId: String(ancestors[ancestors.length - 1].id) } : {}),
    ...(res.body?.storage?.value ? { body: res.body.storage.value } : {}),
  };
}

/** Update a page's title/body. Reads the current version first and bumps it
 *  (the API rejects an update whose version isn't current+1), so concurrent
 *  edits fail loudly instead of silently clobbering. */
export async function updateConfluencePage(
  source: ContextSource,
  credential: ContextCredential,
  update: { id: string; title: string; body: string },
  timeoutMs: number,
): Promise<ConfluenceWriteResult> {
  const current = await getConfluencePageMeta(source, credential, update.id, timeoutMs);
  const res = await fetchJson<ContentResponse>(
    `${base(source)}/rest/api/content/${enc(update.id)}`,
    credential,
    timeoutMs,
    CONFLUENCE_WRITE_HEADERS,
    { method: "PUT", body: buildUpdateBody(update.title, update.body, current.version + 1) },
  );
  return toResult(source, res);
}

/** Trash a page (Confluence keeps it recoverable from the space trash). */
export async function deleteConfluencePage(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<void> {
  await fetchJson<unknown>(
    `${base(source)}/rest/api/content/${enc(pageId)}`,
    credential,
    timeoutMs,
    CONFLUENCE_WRITE_HEADERS,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Labels — page metadata (add / remove). Labels power search, the "content by
// label" macro, and the ownership/archive constructs.
// ---------------------------------------------------------------------------

/** Confluence label rules: lowercase, no whitespace. Normalize a human label
 *  ("Needs Review") to a valid one ("needs-review") so the write doesn't 400.
 *  Pure. */
export function normalizeLabel(raw: string): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_:.-]/g, "");
}

/** Add one or more labels to a page (POST /label). Returns the page's labels
 *  after the change. */
export async function addConfluenceLabels(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  labels: string[],
  timeoutMs: number,
): Promise<string[]> {
  const clean = Array.from(new Set(labels.map(normalizeLabel).filter(Boolean)));
  if (clean.length === 0) throw new AppError("No valid label to add (labels are lowercase, no spaces).", "config");
  const res = await fetchJson<{ results?: Array<{ name?: string }> }>(
    `${base(source)}/rest/api/content/${enc(pageId)}/label`,
    credential,
    timeoutMs,
    CONFLUENCE_WRITE_HEADERS,
    { method: "POST", body: clean.map((name) => ({ prefix: "global", name })) },
  );
  return (res.results ?? []).map((l) => String(l.name ?? "")).filter(Boolean);
}

/** Remove one label from a page (DELETE /label?name=). */
export async function removeConfluenceLabel(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const clean = normalizeLabel(label);
  if (!clean) throw new AppError("No valid label to remove.", "config");
  await fetchJson<unknown>(
    `${base(source)}/rest/api/content/${enc(pageId)}/label?name=${enc(clean)}`,
    credential,
    timeoutMs,
    CONFLUENCE_WRITE_HEADERS,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Markdown → Confluence storage format (XHTML). Pragmatic converter for the
// common blocks the assistant authors; pure and testable.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline spans on already-HTML-escaped text: links, code, bold, italic. */
function inlineMarkdown(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

const line = (s: string): string => inlineMarkdown(escapeHtml(s));

/** Convert common Markdown to Confluence storage XHTML. Handles headings,
 *  paragraphs, unordered/ordered lists, fenced code, and inline emphasis/links.
 *  Not a full Markdown engine — enough for readable, well-formed pages. */
export function markdownToStorage(md: string): string {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(line).join("<br/>")}</p>`);
      para = [];
    }
  };
  const flushList = (items: string[], tag: "ul" | "ol") => {
    out.push(`<${tag}>${items.map((it) => `<li>${line(it)}</li>`).join("")}</${tag}>`);
  };
  while (i < lines.length) {
    const raw = lines[i];
    const fence = raw.match(/^```(\w[\w+-]*)?/);
    if (fence) {
      flushPara();
      const lang = fence[1];
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i += 1; // closing fence
      // A fenced block becomes a proper code macro (syntax highlighting) rather
      // than a bare <pre>, so the page reads like a hand-authored one.
      out.push(codeBlock(code.join("\n"), lang));
      continue;
    }
    // Thematic break (---, ***, ___) → horizontal rule. Checked before lists so
    // "---" isn't mistaken for a "-" bullet.
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      flushPara();
      out.push(horizontalRule());
      i += 1;
      continue;
    }
    // Safety net for the #1 authoring mistake: a literal "[TOC]" / "[[TOC]]" /
    // "{toc}" line is MARKDOWN/wiki shorthand Confluence does NOT interpret — it
    // renders as the visible text "[TOC]". Convert it to the REAL toc macro so a
    // table of contents actually appears. (The catalog/guidance steer the model
    // to emit real macros; this catches the slip.)
    if (/^\s*(\[\[?\s*toc\s*\]?\]|\{toc(:[^}]*)?\})\s*$/i.test(raw)) {
      flushPara();
      out.push(tableOfContents());
      i += 1;
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${line(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    // GitHub-style task list ("- [ ]" / "- [x]") → interactive Confluence task
    // list. Checked before the plain bullet list so the checkboxes are kept.
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(raw)) {
      flushPara();
      const items: { text: string; done: boolean }[] = [];
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const mm = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)!;
        items.push({ text: mm[2], done: mm[1].toLowerCase() === "x" });
        i += 1;
      }
      out.push(taskList(items));
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      flushList(items, "ul");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(raw)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      flushList(items, "ol");
      continue;
    }
    if (raw.trim() === "") {
      flushPara();
      i += 1;
      continue;
    }
    para.push(raw);
    i += 1;
  }
  flushPara();
  return out.join("");
}
