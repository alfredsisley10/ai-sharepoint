/**
 * Project chat workspaces (ADR-0048) — the PURE core.
 *
 * A project's chat workspace is a durable, browsable mirror of the @sharepoint
 * conversations held under that project. Because a Copilot chat's own context
 * window is small (and often clamped hard in corporate tenants), the workspace
 * keeps the record OUTSIDE the window: a rolling human-readable SUMMARY, a full
 * per-session transcript, and a manifest index. That lets the user (a) follow a
 * long conversation, (b) reuse what was already gathered, and (c) restart a chat
 * that ran out of context by looking back at the workspace.
 *
 * This module is pure string/record math (no vscode, no IO) so it is fully
 * unit-tested; chatWorkspaceStore.ts layers the filesystem + redaction on top.
 */

import { avoidReservedName } from "./files/safeName";

export interface ToolResultRef {
  name: string;
  /** Bounded, redacted result text captured for reuse. */
  detail: string;
}

export interface WorkspaceTurn {
  /** ISO timestamp (UTC). */
  at: string;
  model?: string;
  /** The user's prompt (already redacted by the caller). */
  prompt: string;
  /** The assistant's reply (already redacted by the caller). */
  reply: string;
  /** The connected-context block assembled for this turn (redacted) — cached so
   *  a later chat can reuse gathered data instead of re-fetching. */
  context?: string;
  /** Tool calls + their results this turn (redacted, bounded). */
  toolResults?: ToolResultRef[];
}

export interface SessionMeta {
  /** e.g. "2026-07-07-1" — date plus a per-day ordinal. */
  id: string;
  /** Transcript path relative to the workspace root. */
  file: string;
  startedAt: string;
  updatedAt: string;
  turns: number;
  model?: string;
  /** Derived from the first prompt — a human label for the session. */
  title: string;
  /** Stable-ish key identifying the conversation this session mirrors (the first
   *  prompt of the chat). Lets concurrent chats under the same project append to
   *  their OWN session instead of whichever was created most recently. */
  conversationKey?: string;
  /** Truncated prompts, in order — the conversation outline for the SUMMARY and
   *  for restartability. Capped so the manifest can't grow without bound. */
  outline: string[];
}

export interface WorkspaceManifest {
  version: 1;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sessions: SessionMeta[];
  totalTurns: number;
}

export const OUTLINE_ITEM_MAX = 140;
export const OUTLINE_CAP = 100;
const TITLE_MAX = 80;

/** Filesystem-safe slug for a project name (folder name). Never empty, and
 *  never a Windows reserved device name (CON/NUL/COM1…). */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return avoidReservedName(s || "project");
}

/** One-line snippet of a longer text (collapse whitespace, cap length). */
export function snippet(text: string, max = OUTLINE_ITEM_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function emptyManifest(projectId: string, name: string, now: string): WorkspaceManifest {
  return { version: 1, projectId, name, createdAt: now, updatedAt: now, sessions: [], totalTurns: 0 };
}

/** Next session id for a date: "<YYYY-MM-DD>-<n>", n growing past same-day ids. */
export function nextSessionId(dateIso: string, existing: SessionMeta[]): string {
  const day = dateIso.slice(0, 10);
  const sameDay = existing.filter((s) => s.id.startsWith(`${day}-`)).length;
  return `${day}-${sameDay + 1}`;
}

/**
 * Fold one completed turn into the manifest. Starts a new session when
 * `newSession` is set, otherwise appends to the session for this conversation
 * (matched by `conversationKey`, falling back to the most recent session when no
 * key is supplied or matches). Matching by conversation key stops two chats open
 * against the same project from cross-contaminating each other's transcript.
 * Returns the updated manifest and the session the turn landed in (so the caller
 * knows which transcript file to append to). Pure.
 */
export function foldTurn(
  manifest: WorkspaceManifest,
  turn: WorkspaceTurn,
  newSession: boolean,
  now: string,
  conversationKey?: string,
): { manifest: WorkspaceManifest; session: SessionMeta } {
  const sessions = manifest.sessions.map((s) => ({ ...s, outline: [...s.outline] }));
  let session: SessionMeta | undefined;
  if (!newSession) {
    if (conversationKey) session = [...sessions].reverse().find((s) => s.conversationKey === conversationKey);
    if (!session) session = sessions[sessions.length - 1];
  }
  if (!session || newSession) {
    const id = nextSessionId(turn.at, sessions);
    session = {
      id,
      file: `sessions/${id}.md`,
      startedAt: turn.at,
      updatedAt: turn.at,
      turns: 0,
      model: turn.model,
      title: snippet(turn.prompt, TITLE_MAX) || "Untitled session",
      ...(conversationKey ? { conversationKey } : {}),
      outline: [],
    };
    sessions.push(session);
  }
  session.turns += 1;
  session.updatedAt = turn.at;
  if (turn.model) session.model = turn.model;
  session.outline.push(snippet(turn.prompt));
  if (session.outline.length > OUTLINE_CAP) {
    session.outline.splice(0, session.outline.length - OUTLINE_CAP);
  }
  return {
    manifest: {
      ...manifest,
      updatedAt: now,
      totalTurns: manifest.totalTurns + 1,
      sessions,
    },
    session,
  };
}

/** The markdown header written once at the top of a session transcript. */
export function transcriptHeader(session: SessionMeta, projectName: string): string {
  return [
    `# ${projectName} — session ${session.id}`,
    "",
    `_Started ${session.startedAt}${session.model ? ` · model ${session.model}` : ""}._`,
    "",
    "> Mirror of an @sharepoint chat, kept outside the chat's context window so you can",
    "> follow along and restart it later. Newest turn at the bottom.",
    "",
  ].join("\n");
}

/** A single turn rendered for the transcript (appended, newest last). */
export function renderTurn(turn: WorkspaceTurn, index: number): string {
  return [
    `## Turn ${index} — ${turn.at}${turn.model ? ` · ${turn.model}` : ""}`,
    "",
    "**You:**",
    "",
    turn.prompt.trim() || "_(empty)_",
    "",
    "**Assistant:**",
    "",
    turn.reply.trim() || "_(no reply captured)_",
    "",
    "---",
    "",
  ].join("\n");
}

/** True when a turn carried reusable knowledge (context or tool results). */
export function hasKnowledge(turn: WorkspaceTurn): boolean {
  return Boolean(turn.context?.trim() || (turn.toolResults && turn.toolResults.length > 0));
}

/** A knowledge-cache entry for a turn: the connected context + tool results,
 *  appended to `context/<session>.md` so a later chat (or the user) can reuse
 *  what was gathered instead of re-fetching. Newest last. */
export function renderKnowledgeEntry(turn: WorkspaceTurn, index: number): string {
  const lines: string[] = [`## Turn ${index} — ${turn.at}`, "", `**Asked:** ${snippet(turn.prompt, 200)}`, ""];
  if (turn.context?.trim()) {
    lines.push("### Connected context", "", turn.context.trim(), "");
  }
  for (const t of turn.toolResults ?? []) {
    lines.push(`### Tool: ${t.name}`, "", "```", t.detail.trim(), "```", "");
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** A compact restart brief for seeding a fresh chat when one ran out of context:
 *  the user's goals/instructions and the most recent conversation outline. Kept
 *  short (the point is to fit a new chat's window). Pure. */
export function buildResumeBrief(
  manifest: WorkspaceManifest,
  project: { name: string; goals?: string; instructions?: string },
  recentOutline = 15,
): string {
  const last = manifest.sessions[manifest.sessions.length - 1];
  const outline = (last?.outline ?? []).slice(-recentOutline);
  const lines: string[] = [
    `# Resume — ${project.name}`,
    "",
    `_Seed for continuing a prior conversation (${manifest.sessions.length} session(s), ${manifest.totalTurns} turn(s)). Full transcripts and cached context live in this workspace._`,
    "",
  ];
  if (project.goals) lines.push("## Goals", "", project.goals, "");
  if (project.instructions) lines.push("## Instructions", "", project.instructions, "");
  lines.push("## Where we left off", "");
  if (outline.length) {
    outline.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
  } else {
    lines.push("_No prior turns captured._");
  }
  lines.push(
    "",
    "> Continue from here. The project's SUMMARY.md, session transcripts, and `context/` cache hold",
    "> the earlier detail if you need to look something up rather than re-fetch it.",
    "",
  );
  return lines.join("\n");
}

/** A short seed prompt to prefill a new @sharepoint chat on resume. */
export function buildResumeSeedPrompt(
  manifest: WorkspaceManifest,
  projectName: string,
  recentOutline = 8,
): string {
  const last = manifest.sessions[manifest.sessions.length - 1];
  const outline = (last?.outline ?? []).slice(-recentOutline);
  const bullets = outline.map((o) => `- ${o}`).join("\n");
  return [
    `I'm resuming an earlier conversation for the project "${projectName}".`,
    outline.length ? `Recently we covered:\n${bullets}` : "",
    "Its full history and cached context are saved in the project workspace (RESUME.md / SUMMARY.md / transcripts). Please continue from where we left off.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The rolling SUMMARY.md — regenerated from the manifest on every turn. Includes
 *  the user's own project goals/instructions (if any) followed by a session index
 *  and a per-session conversation outline. Deterministic; no LLM. */
export function renderSummary(
  manifest: WorkspaceManifest,
  project: { goals?: string; instructions?: string; description?: string },
): string {
  const lines: string[] = [
    `# ${manifest.name} — chat workspace`,
    "",
    `_Last updated ${manifest.updatedAt} · ${manifest.sessions.length} session(s) · ${manifest.totalTurns} turn(s)._`,
    "",
  ];
  if (project.description) lines.push(project.description, "");
  if (project.goals) lines.push("## Goals (you set)", "", project.goals, "");
  if (project.instructions) lines.push("## Instructions & reference context (you set)", "", project.instructions, "");

  lines.push("## Sessions", "");
  if (manifest.sessions.length === 0) {
    lines.push("_No chats captured yet._", "");
  } else {
    for (const s of manifest.sessions) {
      lines.push(
        `- **${s.title}** — \`${s.id}\` · ${s.turns} turn(s)${s.model ? ` · ${s.model}` : ""} · [transcript](${s.file})`,
      );
    }
    lines.push("");
    lines.push("## Conversation outline", "");
    for (const s of manifest.sessions) {
      lines.push(`### ${s.title} (\`${s.id}\`)`);
      s.outline.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
      lines.push("");
    }
  }

  lines.push(
    "> This file mirrors your @sharepoint chats under this project so a conversation survives the",
    "> chat's context window. To restart a starved chat, skim this summary, open the relevant session",
    "> transcript (and the `context/` cache of gathered data), then continue in a new chat — or run",
    "> \"Resume Chat from Project Workspace\" to seed one automatically.",
    "",
  );
  return lines.join("\n");
}
