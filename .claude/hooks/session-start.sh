#!/bin/bash
# SessionStart hook for Claude Code on the web: install dependencies and run
# the build + test gate so a maintainer's web session starts ready (and knows
# the project's state). Synchronous — the session starts after this completes.
set -euo pipefail

# Web (Claude Code on the web) only; local sessions manage their own env.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

echo "[session-start] Installing dependencies (npm install)…"
npm install --no-audit --no-fund

# Build + test gate. Report status but DON'T block the session on a red gate —
# a session may be starting precisely to fix it.
gate=0

echo "[session-start] Typecheck (tsc --noEmit)…"
npm run typecheck || gate=1

echo "[session-start] Compile (esbuild bundle)…"
npm run compile >/dev/null 2>&1 || { gate=1; echo "  compile FAILED"; }

echo "[session-start] Tests…"
if npm test >/tmp/session-start-test.log 2>&1; then
  grep -E '^# (tests|pass|fail)' /tmp/session-start-test.log || true
else
  gate=1
  echo "  tests FAILED — tail:"
  tail -25 /tmp/session-start-test.log
fi

if [ "$gate" -eq 0 ]; then
  echo "[session-start] ✅ Build + test gate green."
else
  echo "[session-start] ‼️  Build + test gate has failures (see above) — session continues so you can fix them."
fi
exit 0
