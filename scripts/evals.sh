#!/bin/sh
# Brief-quality eval gate (ADR-0012): drive the REAL summarizer over the synthetic
# fixture corpus in evals/ and assert Brief quality. Calls the live Anthropic API
# (needs ANTHROPIC_API_KEY), so it is NOT run in CI — run it manually before merging
# any DEFAULT_MODEL bump or prompt change (summarize.ts hardening, plan.ts task
# prose). To eval a CANDIDATE model before changing the default:
#   RUNDOWN_MODEL=claude-x-y scripts/evals.sh
set -e

cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set — the eval suite calls the live Anthropic API." >&2
  exit 1
fi

echo "== brief quality evals (model: ${RUNDOWN_MODEL:-default}) =="
RUNDOWN_EVALS=1 "$BUN" test evals/
echo
echo "Brief quality evals: PASS"
