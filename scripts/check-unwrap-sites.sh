#!/usr/bin/env bash
# Trust-boundary gate (ADR-0004 §3): the `unwrap()` call sites ARE the leak-path
# audit, and there is exactly one legitimate pair — the definition in
# `src/trust.ts` and the summarizer-prompt assembly in `src/plan.ts`. This check
# fails the build when `unwrap` is imported, re-exported, or called in any other
# file under src/, printing the offending file:line.
#
# Grep on purpose, not a linter: the invariant is literally "a short, greppable
# list", the project carries no ESLint, and anyone can read this script and see
# exactly what it forbids. Full-line comments are ignored so prose like
# "NOT a new unwrap() site" doesn't trip it; matches anchor on real usage
# (`unwrap(`, `unwrap<`, or `unwrap` named in an import/export).
set -euo pipefail

SRC_DIR="${1:-src}"

# Word-boundary via [[:alnum:]_] classes for BSD/GNU grep portability.
CALL_RE='(^|[^[:alnum:]_])unwrap[[:space:]]*[(<]'
IMPORT_RE='(^|[^[:alnum:]_])(import|export)[^;]*[^[:alnum:]_]unwrap([^[:alnum:]_]|$)'
COMMENT_LINE_RE='^[0-9]+:[[:space:]]*(//|\*|/\*)'

status=0
while IFS= read -r file; do
  rel="${file#"$SRC_DIR"/}"
  case "$rel" in
    trust.ts | plan.ts) continue ;;
  esac
  matches=$(grep -nE "$CALL_RE|$IMPORT_RE" "$file" | grep -vE "$COMMENT_LINE_RE" || true)
  if [[ -n "$matches" ]]; then
    status=1
    while IFS= read -r m; do
      echo "$file:$m"
    done <<<"$matches"
  fi
done < <(find "$SRC_DIR" -type f -name '*.ts' | sort)

if [[ "$status" -ne 0 ]]; then
  echo >&2
  echo "unwrap() outside its two allowed sites (src/trust.ts definition, src/plan.ts sole caller)." >&2
  echo "Untrusted bytes may only meet a model inside the sandboxed Summarizer — see ADR-0004 §3." >&2
  exit 1
fi

echo "OK: unwrap confined to src/trust.ts (definition) and src/plan.ts (sole caller)."
