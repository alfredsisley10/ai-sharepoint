# ADR-0018 — Local-first anonymized diagnostics with user-controlled export

- Status: Accepted
- Date: 2026-06-11

## Context

Enterprise deployments are exactly where this extension is hardest to support: locked-down
tenants, no screen sharing, screenshots of internal URLs prohibited, and outbound telemetry
typically banned by policy. Release 0.1.0 must give users a way to surface bugs and usage
patterns to the development team **from inside** such environments without violating them.
The repo's existing posture (PLAN §6: nothing secret in logs; ADR-0013: exports secret-free by
construction) sets the bar.

Classic SaaS telemetry (auto-upload to a vendor endpoint) fails the constraint outright — it
would also be the only network destination beyond Microsoft/GitHub, instantly flagged in any
review. Conversely, "just send us your logs" fails the user: raw logs carry tenant names, UPNs,
GUIDs, and stack paths.

## Decision

Ship a **local-first diagnostics pipeline** with explicit, previewed export:

1. **Capture locally, already clean.** Usage counters (event names + counts), the Copilot usage
   ledger (aggregates only — never prompt/response text), and error reports pass through the
   central redaction layer *at capture time* (JWT/bearer/PEM/email/GUID/tenant-host/IP/user-path
   scrubbing; stacks reduced to basenames). Capture respects `diagnostics.usageCapture`
   (default: **follow VS Code's telemetry setting**, deferring to org policy even though we
   transmit nothing) and `diagnostics.errorCapture`.
2. **Pseudonymize at assembly.** The export builder replaces identifier-shaped values (tenant
   hosts, custom client IDs, authority tenant segments) with **salted short-hashes**
   (`anon-xxxxxxxxxx`), stable per install so multiple reports correlate, meaningless outside
   it. The salt never leaves the machine.
3. **Identity = random + rotatable.** Bundles carry a random UUID install ID — explicitly not
   `vscode.env.machineId` (hardware-stable, shared across extensions). One command rotates ID +
   salt together, severing all prior correlation.
4. **Export = preview → confirm → leak-scan → write.** The full Markdown rendering is shown
   before anything exists on disk; a final scan of the serialized JSON **fails closed** on
   anything secret-shaped (JWT, PEM, bearer, secret assignment, email, raw tenant host); the
   user picks the destination (file or clipboard). JSON for machines + Markdown for humans.

## Consequences

- The support loop works in air-gapped/regulated environments: the artifact is reviewable by
  the user and their IT before it travels, and safe to attach to a public issue.
- We give up passive fleet analytics — the development team learns only what users choose to
  send. Accepted: that property *is* the feature for the target market.
- The redaction/anonymization/leak-scan stack is the security-critical surface; it is pure,
  unit-tested (including adversarial cases like regex-boundary bypass inside pseudonyms and
  JSON-escaped secrets), and doubles as the log redaction layer (PLAN §6 deliverable).
- Future pillars (sync, provisioning) inherit the pipeline: their errors/usage become visible
  in bundles with no new privacy surface. A future opt-in "submit to issue tracker" button must
  keep the same preview + scan gates.
