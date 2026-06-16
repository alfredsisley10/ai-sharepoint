import { redactText } from "../core/redaction";

/**
 * Anonymized "lessons learned" from real @sharepoint interactions (ADR-0041).
 *
 * When the assistant SELF-CORRECTS or discovers a reusable interaction pattern
 * — e.g. "the user said 'my Confluence space', so scope to their PERSONAL space
 * (~userid), not global" — it records a generalized, PII-free heuristic via the
 * capture_lesson tool. These accumulate locally (opt-in, default OFF) and the
 * user can review + export them so the plugin developer can fold the recurring
 * ones into the shipped system prompt / tool descriptions ("up-front
 * intelligence") in a future release.
 *
 * This module is PURE (only the pure redaction layer) and unit-tested. The
 * model is instructed to write already-generalized lessons; scrubbing here is
 * defense-in-depth for the cases where a literal slips through — every stored
 * field passes through `scrubLessonText`, and nothing raw (no transcripts, no
 * tool inputs) is ever persisted.
 */

export type LessonCategory =
  | "scoping" // narrowing/broadening where to look (the ~userid example)
  | "tool-selection" // reached for the wrong tool first, then corrected
  | "query-shape" // CQL/JQL/SQL/KQL phrasing that worked vs. didn't
  | "interpretation" // resolved an ambiguous user phrase a certain way
  | "workflow" // a multi-step ordering that worked
  | "other";

export const LESSON_CATEGORIES: LessonCategory[] = [
  "scoping",
  "tool-selection",
  "query-shape",
  "interpretation",
  "workflow",
  "other",
];

export interface LessonInput {
  category: LessonCategory;
  /** The user intent / situation that should trigger this lesson. */
  trigger: string;
  /** The better action learned — a generalized, reusable heuristic. */
  lesson: string;
  /** Optional tags: tool names, source types (confluence/sharepoint/…). */
  tags?: string[];
}

export interface Lesson extends LessonInput {
  id: string;
  /** Times this same lesson was observed (dedup counter — signal of how
   *  broadly useful baking it in would be). */
  count: number;
  firstAt: string;
  lastAt: string;
  /** Extension version when first captured. */
  version: string;
}

const FIELD_MAX = 280;
const TAG_MAX = 32;
const MAX_TAGS = 6;

/** Domain PII the generic redaction layer doesn't target: Confluence personal
 *  space keys / usernames (~userid) and space/site path segments. Applied
 *  after `redactText`. Conservative — only recognizable shapes. */
function scrubDomain(s: string): string {
  return (
    s
      // Confluence personal space key / username: ~jdoe, ~712020:abc → ~<user>
      .replace(/~[A-Za-z0-9][\w.:%-]*/g, "~<user>")
      // Space path segments: /spaces/ENG, /display/ENG, /spaces/~jdoe → <space>
      .replace(/\b(spaces|display)\/[~]?[A-Za-z0-9][\w.:%+-]*/gi, "$1/<space>")
      // SharePoint site/team path segments: /sites/Marketing, /teams/Eng
      .replace(/\b(sites|teams)\/[A-Za-z0-9][\w%-]*/gi, "$1/<site>")
      // Quoted UPPERCASE space-key tokens after the word "space": space "ENG"
      .replace(/\b(space(?:\s+key)?\s+["“'])[A-Z][A-Z0-9_]{1,15}(["”'])/g, "$1<KEY>$2")
  );
}

/** Scrub a single lesson string: generic redaction THEN domain shapes. */
export function scrubLessonText(s: string): string {
  return scrubDomain(redactText(s ?? "")).replace(/\s+/g, " ").trim();
}

/** Coerce arbitrary tool input into a clean, scrubbed, capped lesson (or
 *  undefined when there's nothing usable). Pure. */
export function normalizeLesson(input: Partial<LessonInput>): LessonInput | undefined {
  const trigger = scrubLessonText(String(input.trigger ?? "")).slice(0, FIELD_MAX);
  const lesson = scrubLessonText(String(input.lesson ?? "")).slice(0, FIELD_MAX);
  if (!trigger || !lesson) return undefined;
  const category = (LESSON_CATEGORIES as string[]).includes(String(input.category))
    ? (input.category as LessonCategory)
    : "other";
  const tags = Array.isArray(input.tags)
    ? Array.from(
        new Set(
          input.tags
            .map((t) => scrubLessonText(String(t)).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, TAG_MAX))
            .filter(Boolean),
        ),
      ).slice(0, MAX_TAGS)
    : [];
  return { category, trigger, lesson, ...(tags.length ? { tags } : {}) };
}

/** Stable dedup key: same category + same heuristic (whitespace/punct-folded)
 *  collapses to one entry whose count rises. Pure. */
export function lessonKey(l: Pick<Lesson, "category" | "trigger" | "lesson">): string {
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${l.category}|${fold(l.trigger)}|${fold(l.lesson)}`;
}

/** Merge a new observation into an existing lesson (bumps count/lastAt, unions
 *  tags). Returns a new object; pure. */
export function mergeLesson(existing: Lesson, incoming: LessonInput, at: string): Lesson {
  const tags = Array.from(new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])).slice(0, MAX_TAGS);
  return {
    ...existing,
    count: existing.count + 1,
    lastAt: at,
    ...(tags.length ? { tags } : {}),
  };
}

export interface LessonsExport {
  schema: "ai-sharepoint-lessons/1";
  generatedAt: string;
  anonymousInstallId: string;
  extensionVersion: string;
  count: number;
  /** Sorted most-observed first — the recurring ones are the best baking-in
   *  candidates. */
  lessons: Array<{
    category: LessonCategory;
    trigger: string;
    lesson: string;
    tags?: string[];
    count: number;
    firstSeen: string;
    lastSeen: string;
    firstSeenVersion: string;
  }>;
}

/** Shape the ledger into the export payload. Re-scrubs every field (belt &
 *  braces) so the exported file is clean even if an older entry predates a
 *  scrubber rule. Pure. */
export function buildLessonsExport(
  lessons: Lesson[],
  env: { generatedAt: string; anonymousInstallId: string; extensionVersion: string },
): LessonsExport {
  const sorted = [...lessons].sort((a, b) => b.count - a.count || a.firstAt.localeCompare(b.firstAt));
  return {
    schema: "ai-sharepoint-lessons/1",
    generatedAt: env.generatedAt,
    anonymousInstallId: env.anonymousInstallId,
    extensionVersion: env.extensionVersion,
    count: sorted.length,
    lessons: sorted.map((l) => ({
      category: l.category,
      trigger: scrubLessonText(l.trigger),
      lesson: scrubLessonText(l.lesson),
      ...(l.tags && l.tags.length ? { tags: l.tags } : {}),
      count: l.count,
      firstSeen: l.firstAt,
      lastSeen: l.lastAt,
      firstSeenVersion: l.version,
    })),
  };
}

/** Human-readable companion shown in the export preview. Pure. */
export function lessonsToMarkdown(ex: LessonsExport): string {
  const lines = [
    `# AI SharePoint — anonymized lessons learned`,
    "",
    `- Generated: ${ex.generatedAt}`,
    `- Anonymous install: ${ex.anonymousInstallId}`,
    `- Extension version: ${ex.extensionVersion}`,
    `- Lessons: ${ex.count}`,
    "",
    `> These are generalized, anonymized interaction heuristics — no transcripts, no tenant/user`,
    `> identifiers. Nothing is transmitted by the extension; you are saving a file to share.`,
    "",
  ];
  if (ex.lessons.length === 0) {
    lines.push("_No lessons captured yet._");
    return lines.join("\n");
  }
  lines.push(`| # | Category | When (trigger) | Learned | Seen | Tags |`, `|---|---|---|---|---|---|`);
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  ex.lessons.forEach((l, i) => {
    lines.push(
      `| ${i + 1} | ${l.category} | ${cell(l.trigger)} | ${cell(l.lesson)} | ${l.count}× | ${(l.tags ?? []).join(", ")} |`,
    );
  });
  return lines.join("\n");
}
