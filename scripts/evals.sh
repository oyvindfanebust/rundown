#!/bin/sh
# Live hostile-input eval gate (ADR-0023): drive the real Digester and the live Summarizer over the
# synthetic hostile-input fixtures in evals/ and grade the emitted digest. Calls the live
# Anthropic API (needs ANTHROPIC_API_KEY), so it is not run in CI. Run it manually before
# merging any DEFAULT_MODEL bump or prompt change (summarize.ts hardening, the Digester's
# instructions in digester.ts). To eval a candidate model before changing the default:
#   RUNDOWN_MODEL=claude-x-y scripts/evals.sh
set -e

cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set. The eval suite calls the live Anthropic API." >&2
  exit 1
fi

echo "== digest evals (model: ${RUNDOWN_MODEL:-default}) =="
RUNDOWN_EVALS=1 "$BUN" test evals/
echo
echo "Digest evals: PASS"
