/**
 * The metered half of an alignment run (ADR-0049), kept PURE: build the
 * comparison prompt, parse the model's answer into a `ConflictVerdict`, and
 * compose the per-owner notice. No vscode, no Copilot, no I/O — so the two
 * things most likely to break in production (a model that doesn't return clean
 * JSON, and an email that leaks the wrong content) are unit-tested.
 */

import { AlignmentCandidate, AlignmentRun, ConflictVerdict } from "./alignmentRun";

/** Keep a single comparison well inside the per-turn budget: the authority is
 *  the larger side and is sent every time, so it gets the bigger allowance. */
export const AUTHORITY_PROMPT_CHARS = 12_000;
export const CANDIDATE_PROMPT_CHARS = 8_000;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export interface ComparePromptInput {
  topic: string;
  /** The gathered truth, already flattened to text. */
  authorityText: string;
  authorityTitle: string;
  candidateTitle: string;
  candidateText: string;
  candidateUrl: string;
}

/**
 * Build the comparison prompt.
 *
 * Two properties matter and are test-locked: the model is told to judge ONLY
 * against the supplied authority (not its own world knowledge, which would
 * invent conflicts), and it must answer with a single JSON object so the reply
 * is machine-readable rather than prose we have to guess at.
 */
export function buildComparePrompt(input: ComparePromptInput): string {
  return [
    `You are auditing enterprise documentation for content that CONTRADICTS an authoritative source.`,
    ``,
    `TOPIC: ${input.topic}`,
    ``,
    `--- AUTHORITATIVE CONTENT ("${input.authorityTitle}") — treat this as the ONLY truth ---`,
    clip(input.authorityText, AUTHORITY_PROMPT_CHARS),
    ``,
    `--- PAGE UNDER REVIEW ("${input.candidateTitle}", ${input.candidateUrl}) ---`,
    clip(input.candidateText, CANDIDATE_PROMPT_CHARS),
    ``,
    `Decide whether the page under review states anything that conflicts with, or is`,
    `misleading relative to, the authoritative content ON THIS TOPIC.`,
    ``,
    `Rules:`,
    `- Judge ONLY against the authoritative content above. Do NOT use outside knowledge.`,
    `- A page that simply does not mention the topic is NOT a conflict.`,
    `- Being less detailed is NOT a conflict. Stating something DIFFERENT is.`,
    `- Quote the specific wording that conflicts; do not generalize.`,
    ``,
    `Reply with ONE JSON object and nothing else:`,
    `{"conflicts": true|false, "severity": "high"|"medium"|"low", "summary": "<one sentence>", "requestedEdits": ["<specific correction>", ...]}`,
    `- severity: high = actively wrong/unsafe to follow; medium = outdated; low = minor wording.`,
    `- requestedEdits: concrete changes the page's owner should make. Empty when conflicts is false.`,
  ].join("\n");
}

/**
 * Parse a model reply into a verdict.
 *
 * Deliberately forgiving about FORM and strict about MEANING: models wrap JSON
 * in prose or ```json fences, so the object is extracted from anywhere in the
 * reply, but anything that isn't a clear, well-formed "yes it conflicts" is
 * treated as NO conflict. Failing closed matters here — a false positive emails
 * a colleague to "correct" a page that was fine.
 */
export function parseVerdict(reply: string): ConflictVerdict | undefined {
  const obj = extractJsonObject(reply);
  if (!obj) return undefined;
  const conflicts = obj.conflicts === true;
  const severity = obj.severity === "high" || obj.severity === "medium" || obj.severity === "low" ? obj.severity : "medium";
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 500) : "";
  const requestedEdits = Array.isArray(obj.requestedEdits)
    ? obj.requestedEdits.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().slice(0, 500))
    : [];
  // A "conflict" with nothing to say is not actionable — and would produce an
  // empty correction request — so it fails closed to clean.
  if (conflicts && !summary && requestedEdits.length === 0) {
    return { conflicts: false, severity: "low", summary: "No specific conflict was identified.", requestedEdits: [] };
  }
  return { conflicts, severity: conflicts ? severity : "low", summary, requestedEdits: conflicts ? requestedEdits : [] };
}

/** Pull the first balanced {...} out of a reply that may be fenced or prefixed. */
function extractJsonObject(reply: string): Record<string, unknown> | undefined {
  const text = reply.replace(/```(?:json)?/gi, " ");
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export interface OwnerNotice {
  subject: string;
  body: string;
  /** Pages covered, so the caller can link work items to the draft. */
  candidateKeys: string[];
}

/**
 * Compose ONE notice covering every page a person owns — a message per page
 * would be spam. The tone is a correction REQUEST, not an accusation, and the
 * authority is always linked so the recipient can verify rather than take our
 * word for it.
 *
 * Pure: the caller supplies the already-grouped candidates (groupByOwner) and
 * puts the result in the approval-gated outbox. Nothing here sends.
 */
export function composeOwnerNotice(
  run: AlignmentRun,
  candidates: readonly AlignmentCandidate[],
  authorityUrl: string | undefined,
  ownerName?: string,
): OwnerNotice {
  const topic = run.authority.topic;
  const many = candidates.length > 1;
  const greeting = ownerName?.trim() ? `Hi ${ownerName.trim()},` : "Hi,";
  const lines: string[] = [
    greeting,
    "",
    `We're aligning our documentation on **${topic}** to a single source of truth${
      authorityUrl ? `: ${authorityUrl}` : ""
    }.`,
    "",
    many
      ? `You're listed as the owner of ${candidates.length} pages that appear to conflict with it:`
      : `You're listed as the owner of a page that appears to conflict with it:`,
    "",
  ];
  for (const c of candidates) {
    lines.push(`### ${c.title}`);
    lines.push(c.url);
    if (c.verdict?.summary) lines.push(`- What looks out of date: ${c.verdict.summary}`);
    for (const edit of c.verdict?.requestedEdits ?? []) lines.push(`- Requested change: ${edit}`);
    lines.push("");
  }
  lines.push(
    `Could you review and update ${many ? "these pages" : "this page"} against the source above?`,
    `If you believe the authoritative page is the one that's wrong, reply and we'll correct it there instead.`,
    "",
    `Thanks!`,
  );
  return {
    subject: many
      ? `Please review ${candidates.length} pages that conflict with the ${topic} source of truth`
      : `Please review "${candidates[0]?.title ?? "a page"}" — conflicts with the ${topic} source of truth`,
    body: lines.join("\n"),
    candidateKeys: candidates.map((c) => c.key),
  };
}
