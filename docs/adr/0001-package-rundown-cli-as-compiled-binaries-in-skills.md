# ADR 0001 — Distribute the rundown CLI as a self-updating standalone binary via GitHub Releases

**Status:** Accepted

The compiled-binary distribution described below (the release workflow, `install.sh`, and background
self-update) is designed but not yet shipped in v0.1.0. Today `rundown` runs from source via the
launcher's fallback (§4's local-dev path).

This ADR covers the CLI's binary packaging, distribution, and self-update. The skills-collection
inventory and CLI-wrapping decisions are in [ADR-0009](0009-skills-collection.md).

## Context

`rundown` ships as an agent-skills collection (like `mattpocock/skills`) that a coding agent installs
and drives. Two constraints shape distribution:

- The skills channel (`vercel-labs/skills`, `npx skills add`) only copies files: it runs no
  `bun install`, no build, and puts nothing on `PATH`. A bundled program works as-is only if it is
  zero-install and self-contained.
- The lockfile pins content (`computedHash`), not a commit; there is no `#ref`. So the default
  branch is the release surface for whatever the skills channel carries.

The skill folder therefore ships light: it points at an already-installed binary rather than
containing the CLI itself, which works around the file-copy-only channel's inability to carry a
runnable program. One might expect the security argument for compiling ("compiling seals the
untrusted hop") to matter here, but it is redundant.
[ADR-0008](0008-bounded-context-and-component-architecture.md) §6–7 already provides the structural
seal: the release surface has no raw-fetch command at all, and that holds regardless of whether the
release is a compiled binary or anything else.

Two properties shape the packaging:

1. `rundown` is a public repo. This enables GitHub Releases' unauthenticated
   `releases/latest/download/<asset>` URLs and the simple `curl | bash` install story.
2. Self-update runs in the background, the way Claude Code updates itself, rather than as a manual
   re-install or a blocking inline check.

The central trust rule (CLAUDE.md / AGENTS.md) must survive repackaging: untrusted source content
meets a model only in the sandboxed, tool-less summarizer. The self-updater operates on a different
trust axis. It fetches a first-party, trusted artifact (rundown's own signed releases), which is
separate from the untrusted work-source data the boundary defends against. The two never touch.

## Decision

### 1. The CLI is a standalone compiled binary; the skill only points at it

- `rundown` is compiled to a standalone, self-contained binary with `bun build --compile`. The
  runtime, dependencies, and TypeScript are folded into one executable, so the consumer needs no
  `bun install`.
- The skill does not contain the CLI. The skill folder ships light: `SKILL.md` plus reference files
  only ([ADR-0009](0009-skills-collection.md)). It teaches the agent to invoke an already-installed
  `rundown`.
- Local development uses no compile step. The launcher (§4) falls back to running source from the
  working tree, so the same invocation the SKILL.md teaches works both in dev and when installed.

### 2. Distribution — GitHub Releases assets + a `curl | bash` installer

- The release workflow uploads one binary per platform as GitHub Release assets (`gh release
  create vX.Y.Z rundown-darwin-arm64 …`), rather than committing them to any repo. GitHub Releases
  is the artifact store, so there is no distribution repo and no binary bloat in git history.
- Alongside each binary the workflow publishes a SHA-256 checksum asset (consumed by §5).
- Install is a small (~30-line) `install.sh`. It detects `uname -sm`, maps to the asset name, runs
  `curl -fsSL https://github.com/<owner>/rundown/releases/latest/download/rundown-<os>-<arch>`,
  verifies the checksum, runs `chmod +x`, installs into a user-writable directory
  (`~/.config/rundown/bin`, optionally symlinked onto `PATH`), and errors clearly on an unsupported
  platform.
- One-liner: `curl -fsSL https://<...>/install.sh | bash`. This is the standard rustup/deno/bun
  shape, and it relies on the public-repo unauthenticated release URLs from the decision above. The
  user can always download and inspect first.

### 3. Platform subset

- **v1:** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. More can be added later via
  additional `--target` flags; there is no universal binary. `install.sh` fails with a clear message
  on anything else.
- Out of scope: Windows and musl-libc Linux. Windows is a multi-section rework rather than a target
  flag: it needs a PowerShell installer, a non-shell launcher, and a different self-replace approach
  because there is no atomic `rename()` over a running binary for §5. musl-libc Linux (Alpine and
  similar) is an `install.sh` detection problem: `uname -sm` alone cannot distinguish glibc from
  musl, so the mapping would ship a broken binary.

### 4. Entry point — pure-shell launcher with a local-dev source fallback

- The one genuinely zero-install file is a pure-shell launcher (`rundown`). It `exec`s the installed
  `bin/rundown-<os>-<arch>`, and falls back to `bun "$dir/../src/cli.ts"` when no compiled binary is
  present (the local-dev path). This gives one entry point that is identical in dev and when
  installed.
- Path resolution uses the installed location or the harness-provided skill base directory. No
  `PATH` mutation is required for the agent path (a human-facing `PATH` symlink is optional).

### 5. Background self-update — Claude-Code-style

- On invocation, `rundown` checks a timestamp file (`~/.config/rundown/.last-update-check`). If it is
  stale (throttled to roughly once a day), `rundown` forks a detached background worker and returns
  to its normal work immediately.
- The worker queries GitHub Releases `latest`, compares it to the build-stamped `--version`, and if
  newer, downloads this platform's asset, verifies its SHA-256 checksum, and atomically replaces the
  binary on disk (write to a temp file, then `rename()` over itself, which is why §2 requires a
  user-writable install dir). The new version takes effect on the next invocation. The current run is
  never mutated mid-flight, so `brief`'s output stays deterministic and its summarizer path makes no
  version network call.
- Off-switch, default on: a config field plus `RUNDOWN_DISABLE_AUTOUPDATE`. This is required for CI,
  reproducibility, and vendor-pinning.
- No sixth command. Self-update is a behavior, not an agent-facing subcommand: the detached worker
  does the HTTP fetch and swap in-process, so
  [ADR-0008](0008-bounded-context-and-component-architecture.md) §6's five-command seal
  (`brief`/`login`/`status`/`init`/`--version`) is untouched. `rundown status` surfaces the
  installed-vs-latest version as its visible signal. `install.sh` remains the bootstrap path and the
  manual fallback when auto-update is off or fails.

### 6. Secrets and config stay machine-local; the SKILL.md owns first-run

- The binary and skill carry no secrets. Graph/Azure credentials and `ANTHROPIC_API_KEY` live in the
  environment or `~/.config/rundown/config.json`, env-first, which matters because the consumer may
  be a coding agent in CI or on a fresh box. `ANTHROPIC_API_KEY` is inherited from the environment
  when present, and `rundown status` reports its presence ([ADR-0009](0009-skills-collection.md)).
- The SKILL.md owns onboarding: the unavoidably manual Azure app registration and `rundown login`.
  Install does not mean ready to run. The onboarding steps are in
  [ADR-0009](0009-skills-collection.md), and config is the reuse point
  ([ADR-0007](0007-config-personalization-layer.md)).

### 7. Versioning — semver stamped in the artifact; vendoring is still the pin

- A semver is stamped into `rundown --version` (a build-time constant) from source-repo git tags.
  Consumers who disable auto-update pin by vendoring their installed binary. `computedHash` on the
  light skill folder is drift detection for the SKILL.md, not the binary.

### 8. Release pipeline — tag-triggered GitHub Actions

- SKILL.md files are source, authored and reviewed in the normal repo alongside the code they wrap.
- A workflow triggered on a `vX.Y.Z` tag runs the `bun build --compile` matrix for the v1 subset and
  uploads each binary and its checksum as release assets on that tag. There is no distribution repo
  and no hand-authored build output.

## Consequences

**Positive**
- The source repo stays a clean, normal codebase with no build artifacts in git; they live in
  Releases. This removes the original's two-repos-to-sync and disposable-history costs.
- The installed CLI is self-contained (no `bun install` on the consumer) and the skill stays tiny;
  the two concerns are cleanly separated.
- Background self-update keeps the CLI current without a self-checking inline path, preserving
  `brief` determinism. The update trust axis is separate from the untrusted-data-to-model boundary.
- One entry point (`rundown`) works identically in local dev (runs source) and installed (runs the
  binary).

**Negative / accepted costs**
- A public repo is required for the `curl | bash` install and unauthenticated release URLs.
- A self-mutating binary needs checksum verification, a user-writable install dir, and an
  off-switch, all specified above.
- A separate binary per platform; the v1 subset omits Windows and musl-libc Linux.
- Install does not mean ready: first run still needs manual Azure app registration and login, which
  the SKILL.md handles.

The structural trust boundary (no raw-fetch command in the release surface) is
[ADR-0008](0008-bounded-context-and-component-architecture.md) §6–7 and
[ADR-0004](0004-trust-boundary-enforcement.md).
