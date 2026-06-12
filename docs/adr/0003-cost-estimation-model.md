# ADR-0003 — Cost visibility is a percentage-of-allowance estimate, not precise billing

- Status: **Superseded** (2026-06-12) — the estimated premium-unit meter, monthly-allowance
  gauge, and budget caps were removed: without an automated, authoritative source for the real
  allowance/bill the estimates misled users. The extension now records factual local request/
  token counts only; GitHub billing is the authoritative usage source. This ADR returns to
  consideration if an authoritative billing API becomes available.
- Date: 2026-06-10

## Context
A core requirement is that the user never "unknowingly uses up all their GitHub Copilot tokens." But
`vscode.lm` (ADR-0001) exposes token counts only — not dollars, and not the user's remaining
premium-request balance. Copilot's consumer billing uses **premium requests** with **per-model
multipliers** (a base model effectively unmetered; stronger models cost a multiplier of premium
requests per call). The live balance is not available to the extension.

The user confirmed: precise billing is not required, as long as a general relative estimate of the
**percentage of tokens/allowance used** is shown — and that the allowance should be obtained
automatically where possible rather than hand-entered.

GitHub *does* expose a programmatic read of **consumed** Copilot premium requests via the enhanced
billing usage REST API (`GET /users/{username}/settings/billing/usage`), but not via `vscode.lm`
(which surfaces tokens only). The **allowance ceiling** is plan-tied and not cleanly returned per user.
Separately, GitHub moved Copilot to **usage-based billing on 2026-06-01**, replacing the fixed monthly
premium-request allowance with an included budget + metered overage.

## Decision
Implement cost visibility as a **hybrid, auto-first estimator** whose headline is a
**percentage-of-allowance/budget gauge**. User entry is the fallback, not the default.

- **Always-on local meter:** record every request (model, input/output tokens, premium-request units =
  `multiplier × requestCount`) against an updatable **model→multiplier table** (`model-costs.json`).
- **Numerator — auto-read when possible:** pull actual consumed usage from the enhanced billing usage
  REST API via the VS Code GitHub session (needs **billing-read** scope + enhanced billing platform);
  fall back to the local meter when unavailable.
- **Denominator — auto-fill when possible:** derive the included allowance/budget from the same usage
  report where exposed; otherwise prompt once for confirm/override.
- **Built for usage-based billing:** model the gauge as "usage/spend against a budget" so it survives
  the 2026-06-01 transition.
- Surface: status-bar gauge (`◇ 35% · ~3 req today`), a Cost tree view with per-objective breakdown,
  pre-flight estimates before large agentic runs.
- Enforce soft (warn) and hard (block) caps; auto-downshift cheap operations to the economy/base model.
- **Always label** the figure as an estimate (local meter) or read-as-of-last-sync (billing API) — never
  imply a live, to-the-cent bill.

## Consequences
- Meets the "don't burn tokens unknowingly" goal; the common path is automatic, with manual entry only
  when billing scope can't be obtained.
- Billing-read scope may not be grantable through VS Code's built-in GitHub OAuth app, so a one-time
  user-supplied PAT (stored in the keychain) may be required for the auto-read path — graceful
  fallback to the local meter when absent.
- Numerator accuracy improves with the billing API; denominator and offline operation still depend on
  the multiplier table staying current (mitigated by making it updatable).
