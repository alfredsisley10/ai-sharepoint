# ADR-0045: Remediation work inventory (event-sourced, exportable)

- **Status:** Accepted (2026-07-02)
- **Context:** The information-sprawl cleanup workflow (see
  `docs/research/info-sprawl-reconciliation-review.md`) finds inaccurate /
  inconsistent / stale content, resolves the effective owner, and notifies them.
  To drive that to completion across many items and many people, we need a
  **local, exportable backlog** that tracks *every step* — creation, owner
  resolution, each communication, each follow-up scheduled and sent, and final
  resolution — so nothing is dropped and progress can be backed up, restarted,
  and handed between users.

## Decision

An **event-sourced** work inventory (`workItems.ts` pure core +
`workItemsStore.ts` vscode persistence):

1. **A `WorkItem` is its append-only event log.** Every change is a
   `WorkItemEvent` (`created`, `owner_resolved`, `communication`,
   `followup_scheduled`, `followup_sent`, `status_changed`, `resolved`,
   `reopened`, `note`). The denormalized `status`, `owner`, and `followUpDueAt`
   are **derived** by folding the events (`applyEvent`) — the history is the
   source of truth, so the audit trail is complete by construction and
   `rebuildWorkItem` can always recompute current state from the log.
2. **Each item points at its target** (`source` + `kind` confluence/sharepoint/
   servicenow/file + `ref`/`url`), optional `authorityTopic` it conflicts with,
   `evidence` snippet, and the resolved `owner` (`sam`, `displayName`, `contact`,
   `basis` — fed by ownership + the user directory, ADR-0039/0041). Communications
   link the comms-outbox `draftId` (ADR-0025), so a message and its work item are
   cross-referenced.
3. **Follow-ups are first-class.** `followup_scheduled` sets a due date;
   `dueFollowUps(now)` lists what's overdue and unresolved so the assistant can
   draft reminders; sending (`followup_sent`) or resolving clears it.
4. **Export / import (`work-items/v1`).** `export()` serializes the whole
   backlog for **backup**; `import(json, "replace")` **restores** it, and
   `import(json, "merge")` combines two backlogs by id, **unioning event logs**
   (dedup by event id, then rebuild) so collaborators never clobber each other's
   progress. This is deliberately a *separate* export from the secret-free
   reference-config (ADR-0013): work items are operational progress and carry
   recipient contact PII, so they are not part of the "share your setup" config.

## Consequences

- Full accountability: for any item you can see who was contacted, when, on
  which channel, with which follow-ups, and how it resolved — the event log
  *is* the report, and the oversight exporter (staged) renders it to CSV/XLSX.
- Backup/restart and multi-user handoff are built in via the event-union merge;
  a lost machine or a mid-cleanup restart loses nothing that was exported.
- Pure core (ids/timestamps injected) is fully unit-tested; the store is a thin
  Memento wrapper mirroring memory/projects.
- **Next (staged):** chat tools + a Work Items tree view to create/advance/list
  items and run "draft reminders for everything overdue", and the findings
  oversight exporter that renders the backlog (+ authoritative-space review) to
  a single CSV/XLSX workbook.
