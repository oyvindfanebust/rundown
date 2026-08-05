#!/bin/sh
# Live self-update gate (ADR-0001 §5): compile a binary stamped with an
# artificially old version, put it in a temp dir with a temp config path, run it,
# and assert it replaced itself with the current real release. This is the only
# layer that exercises the real redirect, the real asset URL, the real checksum
# file format, and a real cross-compiled binary — the integration details the unit
# fakes necessarily stub out.
#
# Hits live GitHub and mutates a file on disk, so it is NOT run in CI — run it
# locally before merging a change to the updater. Usage: scripts/update-e2e.sh
set -e

cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

# An artificially old version, so the strictly-greater comparison has something to
# find no matter which release is current.
OLD_VERSION="0.0.1"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bindir="$work/bin"
mkdir -p "$bindir"
target="$bindir/rundown"
config="$work/config.json"

# Compile for this host, the same way the release matrix does (ADR-0001 §3, §7).
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

echo "== compiling a stamped $OLD_VERSION binary for bun-$os-$arch =="
"$BUN" build --compile --target="bun-$os-$arch" \
  --define "RUNDOWN_VERSION=\"$OLD_VERSION\"" \
  src/cli.ts --outfile "$target"

before="$("$target" --version)"
echo "before: $before"
[ "$before" = "$OLD_VERSION" ] || { echo "FAIL: stamp did not take, got '$before'" >&2; exit 1; }

echo
echo "== running it once: the gate should arm and the worker should swap =="
RUNDOWN_CONFIG="$config" RUNDOWN_DEBUG=1 "$target" --version

# The worker is detached, so poll rather than assuming it finished.
echo
echo "== waiting for the worker to record an outcome =="
i=0
while [ "$i" -lt 120 ]; do
  if [ -f "$work/update-state.json" ] && grep -q '"outcome"' "$work/update-state.json"; then
    grep -q '"outcome": "current"' "$work/update-state.json" || break
  fi
  i=$((i + 1))
  sleep 0.5
done
cat "$work/update-state.json" 2>/dev/null || { echo "FAIL: no state document written" >&2; exit 1; }

echo
echo "== the binary should now report the current real release =="
after="$("$target" --version)"
echo "after:  $after"

if [ "$after" = "$before" ]; then
  echo "FAIL: the binary did not replace itself (still $after)" >&2
  echo "      check the state document above for the recorded reason." >&2
  exit 1
fi

# No debris: the candidate file is removed on every exit path.
if [ -e "$target.update-candidate" ]; then
  echo "FAIL: a candidate file was left behind" >&2
  exit 1
fi

echo
echo "PASS: $before → $after, replaced in place with no debris."
