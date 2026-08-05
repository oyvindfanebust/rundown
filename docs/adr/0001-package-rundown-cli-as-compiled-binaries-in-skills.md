# ADR 0001 — Distribute the rundown CLI as a self-updating standalone binary via GitHub Releases

**Status:** Accepted

The compiled-binary distribution described below (the release workflow and `install.sh`) ships as of
v0.1.0; releases carry the nine assets (§2). Background self-update (§5) and §8's build-provenance
attestation are designed but not yet wired. The launcher still falls back to running from source in
local dev (§4's local-dev path).

This ADR covers the CLI's binary packaging, distribution, and self-update. The skills-collection
inventory and CLI-wrapping decisions are in [ADR-0009](0009-skills-collection.md).

## Context

`rundown` ships as an agent-skills collection that a coding agent installs and drives. Two
constraints shape distribution:

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
trust axis. It fetches a first-party artifact (rundown's own GitHub Releases, over TLS — §5 states
that channel's trust anchor), which is separate from the untrusted work-source data the boundary
defends against. The two never touch.

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
  (`~/.config/rundown/bin` — self-update's atomic-rename home), symlinks the binary into the
  standard XDG user bin dir `~/.local/bin` (created if absent; never clobbering a foreign file,
  the uv/pipx pattern), prints a PATH hint only when neither dir is on `PATH`, and errors clearly
  on an unsupported platform.
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

- One gate runs at the top of CLI dispatch, above the `--version` branch, so all five commands and
  the usage fallback arm it. Placing it above `--version` means the installer's own post-install
  version probe counts as the day's check. The gate refuses in this order:
  1. the running version is the source-run dev marker (§7's `0.0.0-dev`), so a working tree is never
     overwritten by a release binary;
  2. the internal worker mode is active;
  3. `RUNDOWN_DISABLE_AUTOUPDATE` is truthy;
  4. `CI` is present in the environment;
  5. the config field is `false`;
  6. the recorded check is less than roughly a day old;
  7. the directory holding the binary is not writable.

  Otherwise it records the check time, forks a detached worker, and returns to the work it was asked
  to do immediately. The check time is recorded before the worker is spawned, so a worker that
  crashes on startup cannot respawn on every invocation. The gate emits one debug event
  ([ADR-0015](0015-debug-logging.md)) recording its decision.
- The `CI` skip is implicit and has no override. An opt-out switch does not protect a vendored binary
  in a pipeline that never sets it, and `CI` is set by every major CI provider. A binary that mutates
  itself mid-pipeline is not a use case worth an escape hatch.
- The worker is an env-gated internal mode of the same binary, not an argv command, so
  [ADR-0008](0008-bounded-context-and-component-architecture.md) §6's five-command seal
  (`brief`/`login`/`status`/`init`/`--version`) is untouched. There is no sixth command. It returns
  before any argument handling, which is what guarantees it cannot reach config resolution, Sources,
  or the Summarizer: no untrusted byte is ever in scope while it runs. Because it is neither
  agent-invocable nor part of the injection boundary, it is documented here and at its own call site
  rather than added to the exhaustive-surface lists in `CLAUDE.md` and `SECURITY.md`, whose claims
  stay true as written. A detached shell script doing `curl` and `shasum` was rejected: it would keep
  the binary's surface untouched but move the most safety-critical logic into shell that no unit test
  can reach.
- Latest-version discovery reads the redirect, not the JSON API. A request to the
  `releases/latest` URL with manual redirect handling returns the tag in the `Location` header: no
  token, no rate limit, a few hundred bytes, and the same `latest` pointer that already excludes
  drafts and pre-releases. The JSON API's unauthenticated 60-per-hour-per-IP limit is reachable
  behind a shared corporate egress address, and its failure mode is a silent refusal that stops
  updates for an unknown set of users. Nothing in the response is needed beyond the tag, because
  asset names are deterministic from the platform (§2–§3).
- Version comparison is strict and refuses on anything unexpected. The tag is parsed against an exact
  three-part semver pattern; anything that does not match aborts the update rather than being
  interpreted. The update proceeds only when the latest version is strictly greater than the running
  one — never on equal, never downward, so a mispublished `latest` cannot downgrade an install. The
  comparator is written in-repo with no dependency, because this is the one code path where adding a
  supply-chain edge would be self-defeating.
- The swap is verify-then-replace, with a liveness check in the middle. The worker downloads this
  platform's asset and its SHA-256 checksum (§2), verifies the checksum before making the file
  executable, then runs the candidate once with the version flag; it must exit zero and report the
  expected version. Only then is it renamed over the target. The candidate is written to a
  fixed-name temporary file in the same directory as the target, so the rename is a
  same-filesystem atomic swap (which is why §2 requires a user-writable install dir) and a killed
  worker leaves at most one stale file that the next run overwrites rather than accumulating debris.
  The target is resolved through symlinks first, so the installer's convenience symlink is never
  replaced by a regular file. Network reads carry an abort timeout, so a hung worker cannot linger as
  an orphaned process.
- The liveness check is what stops a bad release, and it is the reason self-update can ship enabled
  by default in its first release. A binary that does not start would otherwise reach every install
  within a day and leave users on a `rundown` that cannot update out of the problem; the causes are
  ordinary ones, such as a wrong target flag in the compile matrix, a bad version stamp, or an asset
  whose checksum was generated from an already-corrupt file. The check turns that into a silent
  no-op on a working old binary. It is liveness, not correctness: a binary that starts and is wrong
  in some other way is still installed, and the version assertion narrows that without eliminating
  it.
- The new version takes effect on the next invocation. The current run is never mutated mid-flight,
  so `brief`'s output stays deterministic and its summarizer path makes no version network call.
- Update state is a small JSON document in the config directory (`update-state.json`), named for what
  it is rather than for the throttle timestamp alone, because it is the diagnostic channel as well as
  the throttle. It lives beside config rather than in the home directory, so the config-path override
  moves config and its companion state together the way the token cache already does:
  ```
  { "checkedAt": <instant>, "latest": <semver>,
    "outcome": "updated" | "current" | "refused" | "failed",
    "reason": <short structural string, absent when not applicable>,
    "consecutiveFailures": <count> }
  ```
- Every refusal is recorded rather than silent. The path that declined names its reason in that
  document: an unwritable directory, a checksum mismatch, a failed liveness check, an unparseable
  tag, auto-update disabled. `rundown status` renders a version line from the document with no
  network call: the running version, the latest known version when one is newer, and the recorded
  reason when an update is being refused. A daily-stale number is the correct trade for a diagnostic
  command that must never hang. After a threshold of consecutive failures, `brief` writes one line to
  stderr, gated on stderr being a terminal, so a permanently broken updater does not stay invisible
  to a human while a piped or agent-driven run stays byte-for-byte silent on both streams.
- Off-switch, default on: the config field for a durable choice, `RUNDOWN_DISABLE_AUTOUPDATE` for a
  single command. This is required for reproducibility and vendor-pinning; CI is handled implicitly
  above. `install.sh` remains the bootstrap path and the manual fallback when auto-update is off or
  fails, and its version pin only sticks when the config field is already set.
- The update channel's trust anchor is TLS plus the maintainer's GitHub account. The checksum asset
  is served from the same origin as the binary, so verifying it detects corruption and gives no
  tamper resistance. That is already true of `install.sh`, so it is not a regression, but the shape
  of the risk changes: the installer runs when a human deliberately typed a command, and the updater
  runs unattended and daily. A compromise of the release pipeline becomes code execution on every
  install within a day with no human in the loop. `SECURITY.md` records that as an accepted risk, and
  §8's build provenance is the first step toward narrowing it.

### 6. Secrets and config stay machine-local; the SKILL.md owns first-run

- The binary and skill carry no secrets. Graph/Azure credentials and `ANTHROPIC_API_KEY` live in the
  environment or `~/.config/rundown/config.json`, env-first, which matters because the consumer may
  be a coding agent in CI or on a fresh box. `ANTHROPIC_API_KEY` is inherited from the environment
  when present, and `rundown status` reports its presence ([ADR-0009](0009-skills-collection.md)).
- The SKILL.md owns onboarding: the unavoidably manual Azure app registration and `rundown login`.
  Install does not mean ready to run. The onboarding steps are in
  [ADR-0009](0009-skills-collection.md), and config is the reuse point
  ([ADR-0007](0007-config-personalization-layer.md)).

### 7. Versioning — release-please owns the bump; the tag stamps the artifact

- The next semver is **derived, not hand-picked**: [release-please](https://github.com/googleapis/release-please)
  reads the Conventional Commits since the last release (`fix:` → patch, `feat:` → minor, `!`/
  `BREAKING CHANGE` → major) and keeps an open "release PR" that bumps `package.json`, updates the
  `.release-please-manifest.json` version, and writes the `CHANGELOG.md` entry. The version lives in
  the manifest as the source of truth; `package.json` mirrors it.
- Below 1.0.0 a breaking change bumps the minor rather than the major: `bump-minor-pre-major` is set
  in `release-please-config.json`. Reaching 1.0.0 is a decision the maintainer makes deliberately, by
  releasing it, and not a side effect of the first `feat!:` to land during pre-1.0 development, where
  the contract is still moving and breaking changes are expected. The changelog still carries the
  BREAKING CHANGES section either way, so the break stays visible to a consumer.
- Only commit types that change the compiled binary cut a release: `feat`, `fix`, `perf`, `refactor`.
  `docs`, `chore`, `ci`, and `test` are marked `hidden` in `release-please-config.json`, which in
  release-please means both hidden from the changelog and non-release-triggering — a doc-only change
  must not ship a new binary that is byte-identical bar the version stamp.
- Merging that release PR creates the `vX.Y.Z` git tag, and that tag semver is what gets stamped into
  `rundown --version` (a build-time constant via `--define`). Source runs print `0.0.0-dev`.
- Consumers who disable auto-update pin by vendoring their installed binary. `computedHash` on the
  light skill folder is drift detection for the SKILL.md, not the binary.

### 8. Release pipeline — release-please on push to main

- SKILL.md files are source, authored and reviewed in the normal repo alongside the code they wrap.
- `release.yml` runs on every push to `main`. The `release-please` job maintains the release PR
  (§7); when that PR merges it cuts the tag and the GitHub Release from the accumulated changelog.
- Gated on `release_created`, the same run's `assets` job runs the `bun build --compile` matrix for
  the v1 subset and uploads each binary and its checksum onto that release. The build hangs off this
  run by necessity: a release/tag created with the default `GITHUB_TOKEN` does not trigger a
  separate tag-triggered workflow. There is no distribution repo and no hand-authored build output.
- The same job attests build provenance for each binary it uploads, so a release asset carries a
  verifiable record of the workflow and commit that produced it. It costs almost nothing and starts
  accumulating history from the release it lands in, which is what lets a suspicious human verify a
  binary by hand. Verification inside the updater is deliberately deferred: there is no usable
  verification library for a compiled binary, and shelling out to the GitHub CLI would make it a
  runtime dependency of the updater, which it cannot be. Consuming attestations becomes its own
  decision when a library exists.

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
