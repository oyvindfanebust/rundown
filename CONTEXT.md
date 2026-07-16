# CONTEXT

The domain glossary for this repo. When output names a domain concept, use the term as defined here.

## Architecture

`rundown` is one bounded context — the whole application. Its single external surface is the CLI.
Everything untrusted lives inside the context; nothing pre-summarizer ever crosses the CLI
surface. That is the [trust boundary](#trust-boundary) stated structurally: the bounded context's
only external surface never emits untrusted content (see [ADR-0004](docs/adr/0004-trust-boundary-enforcement.md), [ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md)).

Inside the context are four components, named by role — there is no "layer" and no L-numbering
(see [ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md)):

- **[Sources](#source)** — read-only adapters, one per backend/auth boundary. `read(window) → NormalizedItem[]`.
- **[Aggregator](#aggregator)** — pulls the selected sources into one [Bundle](#bundle). `aggregate(window, selection) → Bundle`.
- **[Summarizer](#summarizer)** — the tool-less model call; the only place untrusted content meets a model. `summarize({instructions, data, schema}) → structured`.
- **[Planner](#planner)** — turns a Bundle into a [Brief](#brief). `plan(bundle, windowIsPast, guidance) → Brief`.

Two things are composition-root plumbing, not components: **[config resolution](#config)**
(load/validate the config file, resolve the window, hand values to the Aggregator/Planner) and
**[emission](#emission)** (serialize the Brief to stdout, errors to stderr). They wrap the
pipeline; they are not pipeline stages.

The composition root is the `brief` command: resolve config → aggregate → plan (which calls the
summarizer) → emit.

### Repo layout (`src/`)

```
src/
  cli.ts            external surface: parse args, dispatch commands; emission lives here
  brief.ts          composition root for `brief`: resolve config → aggregate → plan → Brief
  config.ts         load + validate ~/.config/rundown/config.json; delegate window resolution to temporal.ts → { selection, window, windowIsPast, guidance, timezone }
  temporal.ts       window selector parsing + timezone resolution → absolute Window (span/date/range → instants)
  trust.ts          Untrusted<T> brand + the single unwrap primitive
  domain.ts         shared vocabulary types: NormalizedItem, Bundle, bucket, Brief (re-exports the Brief-contract types)
  brief-contract.ts the Brief output contract — Zod source of truth: schema (→ JSON Schema), kinds + descriptions, inferred types
  sources/
    source.ts       the Source interface + option-schema declaration + the option validate/default helpers
    registry.ts     static map: source name → Source instance
    <name>/         one folder per source (e.g. graph/, claude-code-logs/)
  aggregate.ts      Aggregator
  summarize.ts      Summarizer (owns the security invariants)
  plan.ts           Planner (task prose from the Brief contract, prompt assembly = sole Untrusted<T> unwrap site)
```

Sources is the one pluggable directory: a new source is a sibling folder under `sources/` plus one
entry in the static `registry.ts` (see [ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §4–5).

### CLI surface

Exactly five agent-facing commands, and no more (see [ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §6):

- `rundown brief [--window <span|date|range>] [--source <name>]…` — the composed pipeline; emits one
  Brief as JSON on stdout. `--window` takes a symbolic span, a single `YYYY-MM-DD` date, or an
  explicit end-inclusive `YYYY-MM-DD..YYYY-MM-DD` range ([ADR-0010](docs/adr/0010-explicit-date-windows.md)).
  `--source` narrows this run to a subset of the configured sources (repeatable); each name must be
  one the config selects — the flag only narrows the configured selection, it never reaches past
  config to the registry. Omit it to run every configured source.
- `rundown login` — interactive auth (the only command where interactivity is allowed).
- `rundown status` — one readiness phrase per source (`ready` / `not authenticated` /
  `not configured`, with identity or a fix-it detail), plus the global summarizer
  credential (`ANTHROPIC_API_KEY` present?). An installed-vs-latest version signal is designed
  ([ADR-0009](docs/adr/0009-skills-collection.md), [ADR-0001](docs/adr/0001-package-rundown-cli-as-compiled-binaries-in-skills.md) §5)
  but not yet implemented.
- `rundown init` — write the annotated JSONC config template (only if absent).
- `rundown --version` — the CLI version (today a hardcoded constant; tag-stamped semver arrives
  with the release workflow).

Internal components are never subcommands — there is no `fetch`, `aggregate`, or `summarize`
command. Raw source-fetch, aggregation, and summarization are internal steps of `brief`. The
release binary contains no command, flag, or code path that emits pre-summarizer source content
([ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §7); a developer inspects
raw output only by running from source. This is what seals the trust boundary.

## Glossary

### rundown

The name of the toolkit. A rundown is a readout of where you stand across every work source —
your commitments (what you've agreed to, what's coming) and what you've been working on —
synthesized to help you plan. "Give me the rundown."

The name covers the whole toolkit: the repo, the package, the config directory
(`~/.config/rundown/`), the single launcher binary, and the published skills collection all take
it. It is also the user-facing entry point the consumer invokes.

Naming conventions:

- The umbrella name is `rundown` everywhere the toolkit is referred to as a whole.
- The internal components (Sources, Aggregator, Summarizer, Planner) are never exposed as
  subcommands or separate bins — they are code boundaries, not CLI boundaries. The agent-facing
  surface is the five commands above ([ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §6).
- The single `rundown` launcher is the one entry point — there is no per-component bin split
  ([ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §7–8).

### skills collection

How `rundown` is published and consumed (see [ADR-0009](docs/adr/0009-skills-collection.md) for the
skill, [ADR-0001](docs/adr/0001-package-rundown-cli-as-compiled-binaries-in-skills.md) for the binary).
The collection is a single `rundown` skill — no per-source skills (sources are internal to the
binary), no separate onboarding skill. Its `SKILL.md` carries the [treat-as-data trust contract](#trust-boundary),
the `brief` invocation, and scoped rendering guidance (field semantics, a default grouping by
[`kind`](#extracteditem), and the render-time trust framing); landing is left to the agent
([ADR-0006](docs/adr/0006-output-emission.md)). Onboarding lives in an on-demand reference file
inside the skill folder, reached by a context pointer, so the always-loaded body stays lean.

The skill ships light — `SKILL.md` plus reference files only; it does not contain the CLI. The
distribution story is designed ([ADR-0001](docs/adr/0001-package-rundown-cli-as-compiled-binaries-in-skills.md))
but not yet implemented: a standalone `bun build --compile` binary distributed as GitHub Release
assets, installed by a `curl | bash` `install.sh` into a user-writable dir (`rundown` as a public
repo), self-updating in the background (Claude-Code-style: detached, throttled, checksum-verified,
atomic self-replace, effect next-invocation) with a config/`RUNDOWN_DISABLE_AUTOUPDATE` off-switch.
Today only the `rundown` launcher's run-from-source fallback exists — no release workflow, no
installer, no self-update code. In the design, self-update is a behavior, not a sixth command, so
the [five-command surface](#architecture) holds; its trust axis (first-party signed releases) is
orthogonal to the untrusted-data→model [boundary](#trust-boundary).

### Source

A **Source** is the [Sources](#architecture) component's unit: a read-only adapter for one backend
system / one auth boundary — Microsoft Graph, Slack, Jira, Linear, Claude Code logs. Graph is one
source (calendar and mail are `kind`s within it, not separate sources), because auth is
per-backend. A Source's job is to `read` a time window and emit a list of
[normalized items](#normalizeditem). It never writes back.

Interface (see [ADR-0002](docs/adr/0002-source-abstraction.md)):

- `read(window) → NormalizedItem[]` — required. `window` is an absolute time window (two ISO-8601
  instants); the source maps it to its native time field. Standing/open items (e.g. open Jira
  issues) may be returned even when their activity predates the window.
- `status()` — required; reports readiness as a discriminated union
  `{ state: "ready" | "not-authenticated" | "not-configured" }` (identity on `ready`, a fix-it
  `detail` on `not-configured`). Every source has a total answer — a local source is always
  `ready`.
- `login()` — optional; only sources with interactive auth (Graph, Slack) implement it. Its presence is
  the source's interactive-auth declaration; there is no separate flag.

A Source owns a stable name/key (its registry key) and declares its config/credential needs. It
does not decide selection (which sources run is the config resolver's decision, handed to the
Aggregator) or timezone (a caller/config concern). Secrets are machine-local and read from the
environment. Sources register in a static map, `sources/registry.ts`
([ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §5).

### NormalizedItem

The common shape every Source emits, so the [Aggregator](#aggregator) can treat events, emails,
chat messages, issues, and sessions uniformly. It is a thin structural core the aggregator uses to
group, order, and attribute, plus an `extras` bag of source-specific fields for the summarizer.

- Structural (trusted) — `source`, `kind` (`event` | `message` | `issue` | `session` | …),
  `timestamp` (primary instant, the ordering key), `end?` (interval end). Produced by rundown's
  own source module; safe to surface structurally.
- Untrusted (backend content) — `id`, `title`, `url?`, and everything in `extras` (people/roles,
  body/preview, status, importance, channel, location, …). Only the summarizer reasons over these;
  tool-capable code treats them as opaque. See the trust rule in `CLAUDE.md`; enforcement is the
  [`Untrusted<T>`](#untrustedt) brand, applied by the normalizer
  ([ADR-0004](docs/adr/0004-trust-boundary-enforcement.md) §3).

Standing / recent / upcoming is derived by the Aggregator by comparing `timestamp` to the
requested window, not stored as a field.

Branding and compaction are owned by the normalizer (`sources/normalize.ts`), the sole `trust.ts`
importer among sources and the only way a Source constructs a NormalizedItem. Each source module
makes one via `normalizer(source, {untitled})` and hands it each item's extracted fields; it
brands the backend content Untrusted, truncates every title, falls back on absent titles, and
compacts `extras` by the union policy — presence is signal: `undefined`/`null`/`""`/`false`/empty
arrays vanish, `0`/`true` stay. The `text()` marker (truncate to 200, empty → absent) is applied
by sources to free-text extras; only domain judgment stays at call sites.

### Aggregator

The **Aggregator** component turns *N* [Sources](#source) into one [Bundle](#bundle). Its contract
is `aggregate(window, selection) → Bundle` (see [ADR-0003](docs/adr/0003-aggregation-model.md)).
It is pure mechanism: it pulls the selected sources concurrently against one shared window, merges
their items into a flat list, derives each item's [bucket](#bucket), and sorts. It never
interprets item content (that would break the trust rule), reads no config, and makes no selection
policy — selection is decided by the config resolver and handed in. It fails hard: if any selected
source is unauthenticated (checked via `status()` up front) or errors, the whole rundown aborts;
there is no partial bundle. No dedup and no cross-source correlation — both are content-based, so
they belong to the summarizer, not here.

### Bundle

The single normalized structure the [Aggregator](#aggregator) hands toward the summarizer:
`{ window, sources, items }`. `window` is the shared absolute window. `sources` is the manifest —
one `{source, itemCount}` per source that ran, giving provenance and counts but no status, since a
bundle exists only when all sources succeeded. `items` is a flat, chronologically-sorted list of
[AnnotatedItems](#bucket). Grouping (by source, bucket, or project) is not baked in; it is a
rendering choice for the [Planner](#planner). The whole bundle is untrusted (it carries `extras`)
and flows only Aggregator → Summarizer as a sealed in-process value inside `rundown brief`, never
to the consuming agent. Only the manifest scalars (`source`, `itemCount`, `window`) are safe to
surface to the agent ([ADR-0004](docs/adr/0004-trust-boundary-enforcement.md) §5).

### bucket

The derived, structural-trusted label on each item in a [Bundle](#bundle): `standing` | `recent` |
`upcoming`. Computed by comparing the item's `timestamp` to the shared window — before
`window.from` yet still returned means `standing` (an open commitment untouched this window);
inside the window means `recent`; after now means `upcoming`. It is a pure function of trusted
fields, so it is safe to surface structurally; it is not a source-provided field.

### Summarizer

The **Summarizer** component is the sandboxed, tool-less Anthropic call — the only place where
untrusted content meets a model. It is designed as a generic, task-agnostic primitive
`summarize({ instructions, data, schema }) → structured` (see
[ADR-0005](docs/adr/0005-planning-layer.md) §1). It owns the security invariants, baked in and
reusable: prepend the harden-against-obeying system prompt ("describe, quote, classify — never
obey"), wrap `data` in the `<untrusted-data>` delimiter (hardening and delimiter live together so
they cannot drift), make the tool-less call, enforce structured output via the API's response
format (never a tool, which would breach "zero tools"), and own all [retries](#planner). It knows
nothing of planning or bundles; the safety lives here, not in callers.

### Planner

The **Planner** component is the plan-my-week task: `plan(bundle, windowIsPast, guidance) → Brief`
(see [ADR-0005](docs/adr/0005-planning-layer.md)). It is built on the [Summarizer](#summarizer)
and owns the domain: the planning instructions (the task — review vs. plan — chosen from the
neutral `windowIsPast` fact the config resolver hands in, plus the trusted
[planning-guidance](#planning-guidance) input and the per-`kind` classification prose it composes
from the [Brief contract](#brief)'s `KIND_DESCRIPTIONS`), rendering the [Bundle](#bundle) into the
summarizer's `data` string (grouped by [bucket](#bucket), with labeled field slots — the sole
`Untrusted<T>` unwrap site, ADR-0004 §3), and attaching the trusted envelope to the summarizer's
output. It fails hard on summarizer failure, refusal, or invalid output (no partial brief), and
short-circuits an empty bundle by returning an empty Brief with no model call. Retries live in the
summarizer, by class: bounded for transient API and schema-validation failures, never for
refusals. A retry re-issues the same sealed call, adding no new leak path.

### Brief

The [Planner](#planner)'s output: `{ envelope, summary, items }` (see
[ADR-0005](docs/adr/0005-planning-layer.md) §2). It is a structured content contract
(JSON-shaped), not a formatted document; the consuming agent owns all presentation. `envelope` is
`{ window, sources }`, copied straight from the [Bundle](#bundle)'s trusted scalars and never
laundered through the model. `summary` is a single untrusted-derived prose synthesis. `items` is a
list of [ExtractedItems](#extracteditem). The summarizer emits only `{summary, items}` (that pair
is its structured-output schema); the Planner attaches the envelope. The Brief's output contract —
the `{summary, items}` schema, the fixed `kind` enum, and the `Evidence`/`ExtractedItem` shape —
is defined once in `brief-contract.ts` as a Zod source of truth
([ADR-0011](docs/adr/0011-brief-contract-source-of-truth.md)): it generates the runtime JSON
Schema the structured-output API needs (via `z.toJSONSchema`) and infers the TypeScript types
every component speaks, so type, schema, and the Planner's classification prose cannot drift.
Everything the summarizer emits is [untrusted-derived](#untrusted-derived) (treat-as-data);
everything in the envelope is structurally trusted. The Brief is a curated summary, not a system
of record — the summarizer may drop a salient item (the Bundle is sealed, so an omission is
invisible), and the envelope's per-source counts are what keep the curation honest.

### ExtractedItem

One salient work-item in a [Brief](#brief), curated by the [Summarizer](#summarizer) for planning.
It spans commitments worth knowing about and derived actionables; it is not a faithful
reproduction of the Bundle. Shape: `{ kind, summary, when?, evidence }` (see
[ADR-0005](docs/adr/0005-planning-layer.md) §3–4).

- `kind` — a fixed enum on the nature-of-attention axis (distinct from `NormalizedItem.kind`,
  which is structural and never reaches the agent, and from [bucket](#bucket), which is temporal):
  `commitment` (expected somewhere at a time) | `task` (an action you owe — collapses replies,
  decisions, prep) | `waiting` (blocked on someone else, the GTD "waiting-for") | `fyi` (worth
  knowing, no action). Fixed rather than free-text, so it carries no injected bytes; the
  summarizer classifies, since interpretation is its job. Richer classification (by project, named
  sections) is personal/render territory.
- `summary` — the summarizer's own description of the item.
- `when?` — optional, human-phrased timing ("Thu 9am", "due Fri"). Free-text, not a machine
  timestamp (there is no clean trusted linkage back to the sealed Bundle times), so it is
  approximate, not authoritative.
- `evidence` — a list of `{ source, quote }` attributed snippets. The list is where cross-source
  correlation surfaces (one item can cite a mail, a Slack thread, and an issue) without the
  Aggregator ever reading content. `quote` (verbatim source text, framed as quoted evidence) is
  the injection quarantine: an injected imperative in a meeting title lands there labeled as data.

The distinct typed fields — rather than one free-text blob — are deliberate: a leaked instruction
arrives as "a quote from an email titled X", never a bare imperative (ADR-0004, the output-side
confinement of leaked content).

### Emission

The composition-root step where the [Brief](#brief) leaves `rundown`. `rundown brief` serializes
the Brief as a single JSON object to stdout and stops — one Brief per invocation, nothing
rendered, no `--format` switch (see [ADR-0006](docs/adr/0006-output-emission.md)). There are no
output sinks: `rundown` never writes to a vault or file. Landing and rendering the Brief are
entirely the consuming agent's job, per [ADR-0005](docs/adr/0005-planning-layer.md) (the agent
owns all presentation). stdout is either a valid Brief or empty; failures and refusals go to
stderr with a non-zero exit, and an empty [Bundle](#bundle) emits an empty Brief with exit 0. This
is the accepted [trust](#trust-boundary) crossing out of the compiled binary
([ADR-0004](docs/adr/0004-trust-boundary-enforcement.md) §5): stdout carries only the
post-summarizer Brief — no `extras`, no Bundle, no raw source content.

Emission is composition-root plumbing, not a component
([ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §2); it lives at the
`cli.ts` process edge. The domain term is *emission*; there is nothing pluggable to name.

### planning-guidance

The single personalization input of the [Planner](#planner) (see
[ADR-0005](docs/adr/0005-planning-layer.md) §5): a trusted freeform text block, sourced from
[config](#config), injected into the instruction region of the summarizer prompt (never the data
block) — e.g. "prioritise board- and Legal-related items; keep the tone terse." Everything
structural in the Planner is fixed and generic; this is the only knob. It embodies the clean
split: instructions come from the user (trusted config → instruction region); data comes from
sources (untrusted → data block). It is allowed to steer the model precisely because it is
user-authored and trusted — the mirror of the untrusted data it steers the model to describe.
Render-time personalization (sections, ordering, format) is applied after the Brief by the agent,
not here.

### Config

Personalization is config with defaults (see [ADR-0007](docs/adr/0007-config-personalization-layer.md)).
The user's whole setup is a single declarative file — `~/.config/rundown/config.json` (path
overridable via `RUNDOWN_CONFIG`) — in JSONC (JSON with comments). There is no swappable code
module: reusing the toolkit for a different life concretely means pointing rundown at your own
`config.json` while reusing all four components unchanged.

The file owns exactly what feeds the binary — four fields:

- **`timezone`** — IANA tz; the sole input to window construction and all-day rendering.
  Config-only (a stable machine property), never a source's job
  ([ADR-0002](docs/adr/0002-source-abstraction.md) §5).
- **`window`** — a symbolic span (`"this-week"`, `"today"`), resolved against `timezone` into the
  two absolute instants handed to the Aggregator — never frozen instants. A config default,
  overridable per-invocation with `rundown brief --window <span>`. In `config.json` the field is
  symbolic-only (ADR-0007's "never frozen instants" rule); the `--window` flag also accepts an
  explicit end-inclusive calendar-date range (`2026-07-06..2026-07-12`) or a single date, for
  one-off invocations ([ADR-0010](docs/adr/0010-explicit-date-windows.md)). A range resolves to
  `[midnight(from), midnight(to + 1 day))` in `timezone`, so the internal [Window](#source)'s
  exclusive `to` is untouched; its literal string is the window label shown by `status`/progress.
- **`sources`** — a map keyed by [Source](#source) registry name; selection = presence; per-source
  options under each key (e.g. Graph's `kinds`). The one mandatory field.
- **`guidance`** — the freeform [planning-guidance](#planning-guidance) text (trusted → summarizer
  instruction region).

Defaults and override: whole-file, no cross-file merge; omitted scalars take built-in defaults
(`timezone` → system tz, `window` → `this-week`, `guidance` → none); a missing file is a hard
error. The shipped default is a generic, invented template, not the author's real config — the
author is just the first reuser.

The reader is not a component: it is a thin config-resolution step in the `rundown brief`
entrypoint (composition root) that hands `(selection, window, windowIsPast, guidance)` to the
Aggregator/Planner, which read no config. Window resolution (symbolic span / explicit range →
absolute instants) is delegated to `temporal.ts`. It reconciles the single `now` against the
resolved window once, emitting the neutral `windowIsPast` boolean so the Planner needs no clock.
Validation is strict fail-hard: per-source options are validated against each Source's declared
option schema ([ADR-0002](docs/adr/0002-source-abstraction.md) §5), and any malformed, unknown, or
invalid config aborts up front with a targeted message (a usability guard, not a security
control).

Authoring surface (non-interactive): `rundown init` writes an annotated JSONC template of all
registered sources; `rundown status` reports one readiness phrase per source
([ADR-0002](docs/adr/0002-source-abstraction.md) §2) as the converging feedback loop.
Interactivity is reserved for `rundown login`. The SKILL.md walks agents through onboarding using
these primitives ([ADR-0001](docs/adr/0001-package-rundown-cli-as-compiled-binaries-in-skills.md) §4).

Trust: config is the trusted mirror of untrusted source data. Selection, options, and window are
control values that never reach the model's data region; only `guidance` reaches the model, and
only in the instruction region by design — so it is a plain string, not
[`Untrusted<T>`](#untrustedt). Secrets are never in `config.json`; they live in the environment
([ADR-0001](docs/adr/0001-package-rundown-cli-as-compiled-binaries-in-skills.md) §4), two separate
homes. A hostile local config file is out of the threat model (equivalent to machine compromise);
the boundary defends against hostile remote backends.

### Trust boundary

The central rule made architectural: untrusted source content meets a model only in the tool-less
[Summarizer](#summarizer). Enforced three ways (see
[ADR-0004](docs/adr/0004-trust-boundary-enforcement.md)): structural — the whole
sources→aggregate→summarizer hop is sealed inside the compiled `rundown` binary; the bounded
context's only external surface (the CLI) is post-summarizer only (`brief`/`login`/`status`/`init`),
with no raw-fetch command in the release build
([ADR-0008](docs/adr/0008-bounded-context-and-component-architecture.md) §6–7). In-code —
untrusted fields carry [`Untrusted<T>`](#untrustedt); the summarizer-prompt assembly is the sole
unwrap site. Behavioral — the summarizer's output (the brief) is
[untrusted-derived](#untrusted-derived), so the consuming agent treats it as data, never
instructions. The only trusted data anywhere is the structural fields (`source`, `kind`,
`timestamp`, `end`, derived `bucket`, manifest scalars).

The output-side corollary — a failed remote request must throw only its HTTP status, never a
backend-authored body byte, since the message reaches stderr, an agent-readable channel (ADR-0004
§5) — is centralized in `statusOnlyError` (`src/sources/errors.ts`); every remote source throws
through it. The OAuth-redirect scrub (`redirectError` in `sources/graph/auth.ts`) shares the motive
but validates a code against an allowlist rather than extracting a status, so it stays local.

### Untrusted&lt;T&gt;

The branded wrapper type every untrusted field carries (`id`, `url`, `title`, all of `extras`),
defined in `src/trust.ts`. Getting the raw bytes requires an explicit `unwrap()`, and the
summarizer-prompt assembly is the sole unwrap site — every other sink (manifest, `status`, logs,
error formatting) structurally cannot touch untrusted bytes. The unwrap call sites are the
leak-path audit. It is a dev-time guarantee (editor / CI typecheck), since Bun does not typecheck
at runtime; the runtime seal is the compiled binary. See
[ADR-0004](docs/adr/0004-trust-boundary-enforcement.md) §3.

### untrusted-derived

The trust status of the [Summarizer](#summarizer)'s output (the brief plus extracted
intent/tasks): never fully trusted. A tool-less model can still relay an injected instruction into
its summary, so the boundary does not sanitize injection away — it makes injection inert (the
summarizer has no tools to act with) and confined (structured output labels any leaked content as
quoted data). The consuming agent therefore treats all brief content as data, never instructions.
