# UX & aesthetics verification — 0.1.0

How the "polished UI" bar was verified for this release. Environment note: this release was
built and verified in a headless environment; everything below was validated by construction
(theme tokens, codicons, VS Code UX guidelines) plus the reviewable artifacts listed in §4.
A final on-device smoke pass of the checklist in §5 is recommended before wide rollout.

## 1. Design principles applied

- **Native first.** Every surface uses platform idioms — tree views, quick picks with
  multi-step titles ("1/3 … 3/3"), modals only for destructive/spend decisions, codicons
  everywhere (`$(cloud)`, `$(eye)`, `$(shield)`, `$(graph-line)`…), `ThemeColor` charts tokens
  for state (green/yellow/red). No custom chrome where VS Code provides one.
- **Theme-safe by construction.** The dashboard styles exclusively via `--vscode-*` variables
  with sensible dark fallbacks; tree icons use theme colors; the activity-bar icon is an alpha
  mask; walkthrough art is self-contained (reads correctly on light and dark panels).
- **Progressive disclosure.** Status bar → one number. Usage view → breakdowns. Dashboard →
  full picture. Same data, three zoom levels, consistent wording ("estimate") at each.
- **Empty states teach.** Sites view welcome explains roles/clouds/keychain with a primary
  action; dashboard tables show friendly empty hints; `/sites` in chat offers a connect button.
- **Errors are actionable.** Every error notification = redacted summary + remediation advice +
  `Open Logs` / `Export Diagnostics`. Cancellation is never an error. Chat failures render as
  guidance, not stack traces.
- **Spend anxiety addressed at the moment of spend.** Estimates before asking, soft-cap chips
  in chat, hard-cap modal with a deliberate "Proceed Once", gauge color shifts.

## 2. Surface-by-surface review

| Surface | Verified |
|---|---|
| Status bar | Compact `% · today`; warning/error backgrounds at caps; markdown tooltip table; click → dashboard. Named item id for fleet settings. |
| Sites view | Role + verification encoded in icon/color; description = role; hover = full detail table; inline test/open actions; destructive actions behind modals. |
| Usage view | Gauge with state icon; budget node opens editor; expandable breakdowns sorted by spend; "no usage yet" descriptions. |
| Support view | One item per operability task; error badge on the view container; version row. |
| Dashboard | Cards → gauge → chart → tables → actions reading order; tabular numerals; soft/hard markers on the gauge; estimate disclaimer footer; buttons map to existing commands. |
| Chat | `/help` table; overview uses headers/links/badges; budget refusal includes a settings button; metered footer only when units > 0. |
| Walkthrough | 5 steps, each with one action button and one illustration; completion events wired to real commands. |
| Quick picks | Cost badges (`0× · Economy`) in model picker; icons + detail lines in role/method pickers; Esc always safe. |
| Diagnostics flow | Scope pick → full preview → explicit modal (the save is the *last* step); reveal/copy-path affordances after save. |

## 3. Accessibility notes

- All meaning carried by color is duplicated in text (status pills say "hard cap reached"; tree
  descriptions say the role; the gauge has `aria-label` and a `role="img"`).
- SVG charts include `<title>` per bar (hover/AT) and axis text in description-foreground.
- Buttons are real `<button>` elements; the webview respects `color-scheme: light dark`.
- No information is conveyed only on hover except secondary detail (tooltips supplement,
  never replace, labels).

## 4. Reviewable artifacts

- `docs/ux/dashboard-sample.html` — the dashboard rendered by the *real* renderer with
  representative data (open in any browser; dark-theme fallbacks apply outside VS Code).
- `media/icon.png` — generated marketplace icon (visually verified at 256px).
- `media/walkthrough/*.svg` — the five walkthrough illustrations.
- `test/dashboardHtml.test.ts` — structural/escaping/CSP assertions keep the dashboard honest.

## 5. On-device smoke checklist (pre-rollout)

- [ ] Activity-bar icon renders crisply at standard DPI; three views populate.
- [ ] Light + dark + high-contrast theme pass over dashboard, views, status bar.
- [ ] Connect → chat → budget → export happy path ≤ 5 minutes on a fresh profile.
- [ ] Walkthrough completes; every button does what its step says.
- [ ] Error path: disconnect network, run Test Connection → notification offers logs/export.
- [ ] Screen reader pass over Sites view and dashboard landmarks.
