# ADR 0008 — rundown as one bounded context: components, repo layout, and CLI surface

**Status:** Accepted

This ADR assembles the decisions made across [ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md)–[ADR-0007](0007-config-personalization-layer.md)
into one coherent architecture: it fixes the vocabulary, how the components sit in `src/`, and the
agent-facing CLI surface (which ADR-0001/0002/0006/0007 assume but do not nail down).

## Context

`rundown`'s design decisions each cover one piece of the system. This ADR assembles them into one
architecture and canonicalizes the vocabulary.

The pieces are **not** a strict linear stack. `read → aggregate → summarize → plan` is a pipeline, but
emission and config resolution are not pipeline stages — they are the process boundary and the
composition-root setup that wrap the pipeline. And only the config file is meant to be swapped, and it
is data, not code. So the architecture is a **bounded context with components**, not a stack of
swappable strata.

## Decision

### 1. `rundown` is one bounded context; its only external surface is the CLI

`rundown` is a **single bounded context** — the whole application. It has exactly one external
surface: the **CLI**. Everything untrusted lives *inside* this context; nothing pre-summarizer ever
crosses the CLI surface. This states the crown-jewel rule cleanly: **the bounded context's only
external surface never emits untrusted content** (ADR-0004).

The context's edges, concretely: command-line arguments and `~/.config/rundown/config.json` +
environment secrets are the inputs; a single Brief as JSON on stdout (or an error on stderr) is the
output. All of it is the CLI.

### 2. Four components; config and emission are composition-root plumbing

Inside the context are **four components**, named by role:

| Component | Contract | Role |
|---|---|---|
| **Sources** | `read(window) → NormalizedItem[]` per source | read-only adapters, one per backend/auth boundary; a registry maps name → source |
| **Aggregator** | `aggregate(window, selection) → Bundle` | pulls the selected sources concurrently, merges/buckets/sorts into one Bundle; pure mechanism, never reads content |
| **Summarizer** | `summarize({instructions, data, schema}) → structured` | the tool-less model call; the sole point untrusted content meets a model; owns the security invariants |
| **Planner** | `plan(bundle, windowIsPast, guidance) → Brief` | the plan-my-week task; renders the Bundle into the prompt (the sole `Untrusted<T>` unwrap site) and attaches the trusted envelope |

Two things are **not** components — they are **composition-root plumbing**, code that exists but is
not a pipeline stage you would swap:

- **config resolution** — load + validate `~/.config/rundown/config.json`, resolve the symbolic
  window against the timezone, and hand `(selection, window, guidance)` to the Aggregator and Planner.
  ADR-0007 frames this as "not a new layer — a thin config-resolution step in the entrypoint."
- **emission** — serialize the Brief to stdout, or an error to stderr with a non-zero exit. A handful
  of lines at the process edge (ADR-0006). Nothing pluggable to name.

The shape is: a **composition root** (the `brief` command) that runs *resolve config → Aggregator →
Planner (which calls the Summarizer) → emit*. Four components, threaded by one root, with config at
the entry and emission at the exit.

### 3. The vocabulary of record

The canonical vocabulary is: *bounded context*, *component*, *composition root*, *plumbing*. Terms
below the component level — `NormalizedItem`, `Bundle`, `bucket`, `Brief`, `ExtractedItem`,
`Untrusted<T>`, `untrusted-derived`, `planning-guidance`, `Trust boundary` — each keep their meanings
as defined in `CONTEXT.md`.

### 4. Repo layout — one flat `src/`, Sources as the one pluggable directory

```
src/
  cli.ts            external surface: parse args, dispatch brief/login/status/init/--version;
                    emission (serialize Brief → stdout, errors → stderr, exit codes) lives here
  brief.ts          composition root for `brief`: resolve config → aggregate → plan → return Brief
  config.ts         load + validate ~/.config/rundown/config.json → { selection, window, guidance, timezone }
  trust.ts          Untrusted<T> brand + the single unwrap primitive
  domain.ts         shared vocabulary types: NormalizedItem, Bundle, bucket, Brief, ExtractedItem
  sources/
    source.ts       the Source interface (read, optional login/status) + option-schema declaration
    registry.ts     static map: source name → Source instance
    graph/
      index.ts      the Graph reference source (calendar + mail kinds)
      auth.ts       device-code / MSAL auth
  aggregate.ts      Aggregator
  summarize.ts      Summarizer — owns the security invariants (hardening, delimiting, tool-less, structured output, retries)
  plan.ts           Planner — Brief schema, prompt assembly = sole Untrusted<T> unwrap site
```

Rationale for the structure:

- **`cli.ts` is thin dispatch and owns emission.** It parses arguments, routes to a command handler,
  and does the `JSON.stringify(brief)` → stdout / error → stderr / exit at the true process boundary.
  It holds no domain logic.
- **`brief.ts` is a separate composition root** so the wiring (config → aggregate → plan) is
  independently testable without going through argument parsing or the process boundary.
- **Sources is the one directory** (`sources/`) with an explicit `registry.ts`. It is the only place
  the "pluggable" claim has to be real in the file structure: a second source (Slack, later) is a
  sibling folder under `sources/` plus one line in `registry.ts`, never a change to the core. Graph is
  the reference adapter.
- **The Aggregator, Summarizer, and Planner are single files** (`aggregate.ts`, `summarize.ts`,
  `plan.ts`) — each one deep module with a small contract. They grow to directories only if they earn
  it.
- **Shared vocabulary types live in one `domain.ts`** — the ubiquitous language in one readable place,
  rather than colocated with each producer. `trust.ts` is separate because `Untrusted<T>` is a
  cross-cutting security primitive, not a domain noun.

### 5. Sources register via a static map

`sources/registry.ts` holds a **static map literal** — `{ graph: new GraphSource() }`. Adding a source
later is one import plus one entry: explicit, typed, greppable. No self-registration side-effects, no
dynamic discovery. This matches ADR-0002's "in-process modules in the one binary"; the
serialization-friendly `read` contract already reserves the *subprocess-plugin* future for when
third-party sources arrive, so dynamic registration buys nothing now.

### 6. The CLI surface — five agent-facing commands, nothing else

The agent-facing surface is **exactly five commands**, and no more:

| Command | Purpose |
|---|---|
| `rundown brief [--window <span>]` | the composed pipeline; emits one Brief as JSON on stdout |
| `rundown login` | interactive auth (the one command where interactivity is allowed, ADR-0007 §7) |
| `rundown status` | one readiness phrase per source (`ready` / `not-authenticated` / `not-configured`) — the converging onboarding diagnostic |
| `rundown init` | write the annotated JSONC config template (only if absent) |
| `rundown --version` | build-time semver (ADR-0001 §7) |

- **Internal components are never subcommands.** There is no `rundown fetch`, no `rundown graph
  calendar`, no `rundown aggregate`, no `rundown summarize`. Raw source-fetch, aggregation, and
  summarization exist only as internal steps of `brief`. The Sources/Aggregator/Summarizer/Planner
  seams are code boundaries, not CLI boundaries.
- **This is what seals the trust boundary.** The bounded context's only external surface exposes
  post-summarizer output only; the untrusted hop is sealed inside `brief` (ADR-0004 §4).

### 7. No raw-dump in the release binary — the structural guarantee wins

The release binary contains **no command, flag, or code path** that emits pre-summarizer source
content:

> A developer who needs to inspect raw source output runs the pipeline from source in the working tree
> (the launcher's `bun src/cli.ts` dev path, ADR-0001 §2), optionally behind a dev-only flag that is
> never compiled into a shipped binary.

Relying on the agent obeying a SKILL.md prohibition is a behavioral control; for the crown-jewel
boundary, "not in the binary at all" is strictly stronger and is the one we commit to. The behavioral
treat-as-data contract (ADR-0004 §6) still stands — it guards the *accepted* residual (the Brief
itself crossing), not raw content, which is structurally absent.

### 8. The `rundown` name, applied across the toolkit

The name applies across the whole toolkit:

- **Repo / package:** `rundown`.
- **Binary + launcher:** a single pure-shell launcher `rundown` selecting `bin/rundown-<os>-<arch>`
  (ADR-0001 §2).
- **Config:** `~/.config/rundown/config.json` (`RUNDOWN_CONFIG` overrides the path).
- **CLI:** `rundown <command>` as fixed in Decision 6.
- **Skills collection:** published under the `rundown` name.

## Consequences

**Positive**
- One coherent vocabulary — bounded context + four components + composition root. The trust boundary
  reads as a single sentence about the context's external surface.
- The `src/` layout is small, flat, and greppable; the one directory (`sources/`) is exactly the one
  place pluggability must be real.
- The five-command CLI surface *is* the trust boundary, stated exhaustively — the SKILL.md contract
  (ADR-0004 §6) has a closed list to point at.
- The raw-dump question is closed structurally, removing a behavioral dependency from the strongest
  layer of the trust model.

**Negative / accepted costs**
- A flat `src/` puts several single-file components at the top level; if one grows, it is promoted to a
  directory later. Accepted — premature nesting is worse than a later promotion.
