import { looksLikeConfluenceOptimization } from "./intent";

/**
 * Context-aware chat follow-up suggestions (pure, unit-tested).
 *
 * The old follow-ups were static ("Explore my site", "Plan a site", "Check
 * Copilot activity") and often irrelevant — e.g. suggesting site exploration to
 * a user with only Confluence connected mid-cleanup. This tailors them to what's
 * actually connected, the active project, and the task in flight, while always
 * keeping a cost/activity option.
 */

export interface FollowupInput {
  project?: { name: string; hasGoals: boolean; workspaceEnabled: boolean };
  /** Source types scoped to the active project (or all sources). */
  sourceTypes: string[];
  /** Whether any SharePoint site is connected. */
  hasSites: boolean;
  /** The user's most recent prompt, to detect the task in flight. */
  lastPrompt?: string;
}

export interface Followup {
  prompt: string;
  label: string;
}

const DB_TYPES = ["mssql", "postgres", "mysql", "mongodb"];

export function computeFollowups(input: FollowupInput): Followup[] {
  const types = new Set(input.sourceTypes);
  const has = (t: string) => types.has(t);
  const cleanup = input.lastPrompt ? looksLikeConfluenceOptimization(input.lastPrompt) : false;
  const contextual: Followup[] = [];

  // Confluence content-management task in flight (or a tracked cleanup) → the
  // dossier → owners → outreach next steps.
  if (has("confluence") && (cleanup || input.project?.workspaceEnabled)) {
    contextual.push({ prompt: "Build a dossier of my Confluence space: owners, stale pages, and data-quality issues.", label: "Build space dossier" });
    contextual.push({ prompt: "Who owns the stale or inaccurate pages, and how do I reach them?", label: "Find page owners" });
    contextual.push({ prompt: "Draft outreach to the owners of the flagged pages, including recommended revisions.", label: "Draft owner outreach" });
  } else if (has("confluence")) {
    contextual.push({ prompt: "Find stale, unowned, or inconsistent pages in my Confluence space.", label: "Review Confluence" });
  }

  if (has("jira")) contextual.push({ prompt: "Summarize the open issues in my Jira project and who owns them.", label: "Review Jira" });
  if (has("servicenow")) contextual.push({ prompt: "Summarize recent ServiceNow records relevant to my project.", label: "Review ServiceNow" });
  if (DB_TYPES.some(has)) contextual.push({ prompt: "Which tables or columns map to ownership and status?", label: "Map my database" });

  if (input.hasSites) {
    contextual.push({ prompt: "What lists and pages does my site have?", label: "Explore my site" });
    contextual.push({
      prompt: input.project?.hasGoals
        ? "Suggest a structure for this SharePoint site based on my project goals."
        : "Suggest a structure for a SharePoint site.",
      label: "Plan my site",
    });
  }

  // Project-relative nudge.
  if (input.project?.workspaceEnabled) {
    contextual.push({ prompt: "Summarize where we left off from the project workspace.", label: "Resume from workspace" });
  } else if (input.project) {
    contextual.push(
      input.project.hasGoals
        ? { prompt: "Given my project goals, what should I work on next?", label: "Suggest next steps" }
        : { prompt: "Help me set goals and instructions for this project.", label: "Set project goals" },
    );
  }

  // Nothing connected yet → onboarding.
  if (types.size === 0 && !input.hasSites) {
    contextual.push({ prompt: "What can you help me with, and what should I connect first?", label: "Get started" });
  }

  // Dedup by label, keep the most relevant three, then always append a
  // cost/activity option (reflecting the dollar estimate now shown).
  //
  // IMPORTANT: this is a PLAIN-LANGUAGE prompt, not the `/usage` slash command.
  // A VS Code chat follow-up inherits the CURRENT slash command when it doesn't
  // set one, so a `/usage` follow-up would leave the chat "in /usage mode" and
  // make the NEXT round of follow-ups (dossier, owners, …) all re-run /usage.
  // A natural-language ask keeps every turn command-free (the model answers via
  // the copilot_usage tool, which now includes the dollar cost).
  const seen = new Set<string>();
  const top = contextual.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true))).slice(0, 3);
  return [
    ...top,
    { prompt: "How many Copilot requests have I used this month, and what's the estimated cost?", label: "Check Copilot cost & activity" },
  ];
}
