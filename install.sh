#!/usr/bin/env bash
# rundown installer (ADR-0001 §2–§3).
#
#   curl -fsSL https://github.com/oyvindfanebust/rundown/releases/latest/download/install.sh | bash
#
# Maps `uname -sm` onto a release binary, verifies its SHA-256 checksum, and
# installs it into the user-writable ~/.config/rundown/bin/ (required for
# self-update's atomic rename). No PATH or rc-file mutation. Re-running
# upgrades in place. Pin a version with RUNDOWN_VERSION=v0.1.0.
set -euo pipefail

REPO="oyvindfanebust/rundown"
VERSION="${RUNDOWN_VERSION:-latest}"
INSTALL_DIR="${HOME}/.config/rundown/bin"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64) asset="rundown-darwin-arm64" ;;
      x86_64) asset="rundown-darwin-x64" ;;
      *) fail "unsupported macOS architecture '$arch' (supported: arm64, x86_64)" ;;
    esac
    ;;
  Linux)
    # The release binaries are glibc builds; on musl (Alpine et al.) they break at
    # runtime, so refuse cleanly rather than install something broken (ADR-0001 §3).
    if [ -f /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then
      fail "musl-libc Linux (e.g. Alpine) is not supported — the release binaries target glibc. Run from source instead (see the README)."
    fi
    case "$arch" in
      x86_64) asset="rundown-linux-x64" ;;
      aarch64 | arm64) asset="rundown-linux-arm64" ;;
      *) fail "unsupported Linux architecture '$arch' (supported: x86_64, aarch64/arm64)" ;;
    esac
    ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "Windows is not supported; see the README."
    ;;
  *)
    fail "unsupported platform '$os $arch' (supported: macOS arm64/x86_64, glibc Linux x86_64/aarch64)"
    ;;
esac

if [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/${REPO}/releases/latest/download"
else
  base_url="https://github.com/${REPO}/releases/download/${VERSION}"
fi

# Stage inside the install dir so the final `mv` is a same-filesystem atomic
# rename — an interrupted install never leaves a half-written binary.
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d "${INSTALL_DIR}/.install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset} (${VERSION}) from ${REPO}..."
curl -fsSL "${base_url}/${asset}" -o "${tmp}/${asset}"
curl -fsSL "${base_url}/${asset}.sha256" -o "${tmp}/${asset}.sha256"

# Verify before install: a mismatch aborts non-zero and installs nothing.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c "${asset}.sha256" >/dev/null) || fail "checksum mismatch for ${asset} — corrupted or tampered download; nothing was installed."
elif command -v shasum >/dev/null 2>&1; then
  (cd "$tmp" && shasum -a 256 -c "${asset}.sha256" >/dev/null) || fail "checksum mismatch for ${asset} — corrupted or tampered download; nothing was installed."
else
  fail "no sha256sum or shasum found to verify the download; nothing was installed."
fi

chmod +x "${tmp}/${asset}"
dest="${INSTALL_DIR}/rundown"
mv -f "${tmp}/${asset}" "$dest"

echo "Installed: $dest"
echo "Version:   $("$dest" --version)"

# Expose the binary under the standard user bin dir (XDG ~/.local/bin), the uv/pipx
# pattern: the real binary stays in INSTALL_DIR (self-update's atomic-rename home),
# and ~/.local/bin/rundown is a symlink to that stable path. Skip if the name is
# already taken by something that isn't ours — never clobber a foreign file.
LINK_DIR="${HOME}/.local/bin"
link="${LINK_DIR}/rundown"
mkdir -p "$LINK_DIR"
if [ ! -e "$link" ] && [ ! -L "$link" ]; then
  ln -s "$dest" "$link"
  echo "Symlinked: $link -> $dest"
elif [ -L "$link" ] && [ "$(readlink "$link")" = "$dest" ]; then
  : # already ours
else
  echo "Note: $link already exists and is not managed by this installer; leaving it alone."
fi

# PATH guidance: fine if either the link dir or the install dir is already on PATH.
case ":${PATH}:" in
  *":${LINK_DIR}:"* | *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "Hint: ${LINK_DIR} is not on your PATH. Add it to your shell profile:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
