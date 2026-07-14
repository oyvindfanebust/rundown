# ADR 0007 — The config & personalization surface

**Status:** Accepted

Config is the **last piece** — the four components are fixed in [ADR-0002](0002-source-abstraction.md)
(Sources), [ADR-0003](0003-aggregation-model.md) (Aggregation),
[ADR-0004](0004-trust-boundary-enforcement.md) (Trust boundary), [ADR-0005](0005-planning-layer.md)
(Summarizer + Planner), [ADR-0006](0006-output-emission.md) (Emission).

## Context

Config is personalization: how the user's ritual becomes **config with defaults**, and how
that makes the four components reusable (someone else swaps config and reuses the rest).

The decisions above already narrowed config's job to exactly what **feeds the binary**. ADR-0006
retired sink-selection and vault-path (there are no output sinks; the agent owns
landing/rendering). So config owns precisely three inputs:

- **Source selection + per-source options** — which sources run and their options, handed to the
  Aggregator (which reads no config, ADR-0003). Per-source option *declarations* come from the
  Source abstraction (ADR-0002 §5).
- **Window construction** — a timezone and a span, resolved into the two absolute instants of the
  shared window handed to the Aggregator (ADR-0003). Timezone is a caller/config concern, never a
  source's (ADR-0002 §5).
- **The trusted planning-guidance seam** — freeform text → the summarizer's instruction region
  (ADR-0005 §5). The one steering knob; trusted because user-authored.

The crown-jewel rule constrains every decision: config is the **trusted** mirror of untrusted source
data. Nothing in the config path may weaken the untrusted→model boundary (ADR-0004).

## Decision

### 1. The reusability seam is a single declarative config file — no code module

ADR-0005 reduced the only logic-shaped personalization (prioritization / bespoke classification
rules) to freeform **text** on the planning-guidance seam. That leaves all three of config's inputs as plain
**data**: a selection map, a timezone + span, and a guidance string. None requires the reuser to
write code.

**"Reuse the four components, swap your config" concretely = point rundown at your own
`config.json`.** There is no swappable code module and no logic escape hatch — a hatch would have
to run in tool-capable code, and the trust rule keeps content interpretation in the summarizer, so
it cannot exist without breaching the boundary.

### 2. `config.json`: JSONC at `~/.config/rundown/config.json`, four fields

The file is **JSONC** (JSON with comments), keeping the `config.json` name and a mono-format
toolkit (Brief, emission, and config are all "JSON"); the only cost is a comment-tolerant parser
instead of bare `JSON.parse`. Comments are load-bearing for the `init` scaffold (§7) and let users
annotate their own config.

```jsonc
{
  // IANA timezone; window spans and all-day rendering resolve against it.
  "timezone": "Europe/Oslo",
  // Default span; overridable per-invocation with `rundown brief --window <span>`.
  "window": "this-week",
  // Selection = presence in this map. Options live under each source's registry key.
  "sources": {
    "graph": {
      "kinds": ["event", "message"] // source-level selection option (ADR-0002 §1)
    }
  },
  // The single planning-guidance seam → summarizer instruction region (ADR-0005 §5).
  "guidance": "Surface commitments I've made to others first, then anything time-sensitive or that people are waiting on me for. Keep the tone terse."
}
```

Each field maps to exactly one config input; there is nothing else (no sink, no vault-path, no
`--format` — all retired by ADR-0006).

- **`sources` is a map keyed by registry name**, so *selection = presence in the map* and per-source
  options sit under the key together. This is the same registry the Aggregator consults for
  selection — no
  second source-list to keep in sync.
- **`window` is a symbolic span** (`"this-week"`, `"today"`), resolved against `timezone` at read
  time — never two frozen instants (those go stale in a committed file).

### 3. Secrets are env-first and never in `config.json`

Credentials/tokens (`AZURE_TENANT_ID`, `ANTHROPIC_API_KEY`, source tokens) are **env-first**
(ADR-0001 §4) and stay out of `config.json`. This is what makes the config file safely copyable and
even committable: it is pure personalization, zero credentials. The ADR-0001 §4 option of an
in-file secrets *section* is rejected for the shared file — the moment the reuse seam is "copy my
`config.json`," an in-file secrets section invites pasting a token into a file that then gets
committed. Config and secrets have **two separate homes**: `config.json` (shareable personalization)
and env vars (machine-local secrets).

### 4. Defaults & override: whole-file, scalar defaults, `sources` mandatory, missing = error

- **Whole-file, no cross-file merge.** `~/.config/rundown/config.json` is a complete, self-contained
  statement; rundown reads exactly one file. No deep-merge layering (which would force reasoning
  about how two `sources` maps or two `kinds` arrays combine).
- **Omitted *scalar* fields fall back to a built-in default**: `timezone` → system tz, `window` →
  `"this-week"`, `guidance` → none. This is not cross-file layering — just "unspecified scalar ⇒
  sensible default."
- **`sources` is the one mandatory field** — nothing to plan without at least one source, and no
  source is universally sensible to default-on. Minimum viable config: `{"sources": {"graph": {}}}`.
- **A missing config file is a hard error**, pointing at the template — not a silent fallback
  (matches the fail-hard ethos of ADR-0003/0005/0006).
- **The shipped default is a generic, invented example — not the maintainer's real ritual.** The
  maintainer is just the first reuser: their real config — e.g. "prioritise board- and
  legal-related items" — lives only in their machine-local `~/.config/rundown/config.json`, never
  in the repo or distribution. There is no privileged "maintainer's ritual" baked into the shipped
  artifact.

### 5. The config reader is the entrypoint's composition root — not a new component

Reading `config.json`, resolving the symbolic window against `timezone` into two instants, and
handing `(selection, window, guidance)` to the Aggregator/Planner is a **thin config-resolution
step inside the `rundown brief` entrypoint (the composition root)** — not its own component with a
module boundary. ADR-0003/0005 deliberately kept the Aggregator/Planner free of config knowledge;
this wiring belongs at the entrypoint, not in a new abstraction. Config *is* "the config file + the
small resolver that loads it."

- **`window` is a config default overridable per-invocation** via `rundown brief --window today` —
  the coding-agent consumer triggers on demand and must scope a run without editing config. The
  entrypoint layers the flag over the config default, then resolves against `timezone`.
- **`timezone` is config-only** — a stable machine property, not a per-call argument.
- **`RUNDOWN_CONFIG` env var overrides the file path** (default `~/.config/rundown/config.json`),
  consistent with the env-first ethos and useful for a headless/CI agent. Path aside, contents are
  trusted the same way.

`RUNDOWN_MODEL` joins `RUNDOWN_CONFIG` as an env-first knob — it overrides the Summarizer's
default model ([ADR-0005](0005-planning-layer.md) §8). It is deliberately **not** a fifth
`config.json` field: the model is an internal engineering choice, not part of the user's ritual /
personalization, so it stays off the shareable config surface (§2's four fields hold) and
env-first (§3). Same trust basis as any other env var.

### 6. Per-source option schemas are source-declared; validation is strict fail-hard

- **Each Source module exports an option-schema declaration** alongside its registry key (ADR-0002
  §5). The resolver validates each `sources` entry against the *declaring source's* schema (e.g.
  Graph declares `kinds` ⊆ `{event, message}`), reusing the same registry the Aggregator uses for
  selection.
- **Validation is strict and fail-hard, up front**, before any source runs: malformed JSONC, missing
  the mandatory `sources`, an unknown source key, an unknown/invalid option for a source, an invalid
  `timezone`, or an unparseable `window` → non-zero exit with a targeted message. This surfaces
  *before* the Aggregator's `status()` pre-flight, so config errors precede auth errors.
- **Strict-reject, not warn-and-continue** — a typo (`"kind"` for `"kinds"`) should fail loudly, not
  silently drop mail; a coding-agent consumer wants a clear error over a quietly-degraded brief.
- Strict validation here is a **usability/correctness guard, not a security control** — config is
  trusted; the boundary does not lean on it.

### 7. Config authoring: non-interactive `init` + `status` diagnostics, not a wizard

The consumer is a coding agent, so an interactive TUI wizard is the wrong primary UX (agents can't
answer live prompts; env-first exists precisely so rundown can run headless). Config provides
three **non-interactive** primitives, and the SKILL.md choreographs onboarding from them:

1. **`rundown init`** — writes an *annotated JSONC template* to `~/.config/rundown/config.json` (only
   if absent), listing every registered source commented-out with its declared options, generated
   from the same source-declaration registry as §6. "Emit the schema as a fill-in-the-blanks file,"
   not "interview me."
2. **strict validation** (§6) — editing the file wrong fails loudly.
3. **`rundown status`** — the feedback loop: **one readiness phrase per source** (`ready` /
   `not authenticated` / `not configured`, with identity or a fix-it detail), so after editing you
   run `status` and it reports exactly what is still missing. The "guided" part is a converging
   diagnostic, not a front-loaded questionnaire.

`status()` returns the `SourceStatus` **discriminated union** (`{ state: "ready" |
"not-authenticated" | "not-configured" }`; [ADR-0002](0002-source-abstraction.md) §2), so
`rundown status` reports a single readiness phrase per source rather than separate `configured?` /
`authed?` columns. A nonsensical combination (`!configured && authenticated`) is unrepresentable,
and the Aggregator pre-flight is an exhaustive switch. Trust surface unchanged — status never
reaches the model.

Onboarding flow the SKILL.md teaches: `init` → edit (the agent can do this for the human — config is
trusted JSONC) → `login` for interactive-auth sources → `status` until green. **Interactivity is
reserved for exactly `rundown login`** (inherently browser/MSAL-interactive, isolated there by
ADR-0002). Config owns the *primitives*; the *choreography* of first-run stays with the SKILL.md
([ADR-0009](0009-skills-collection.md) §3).

### 8. Trust: config is the trusted mirror; no new leak path; hostile-local-config is out of scope

Config's entire trust surface:

| Config value | Reaches the model? | How |
|---|---|---|
| source selection + options | **No** | control values consumed by the resolver/Aggregator as flow; never enter the model's data region |
| window (tz + span → instants) | **No** | control values for the Aggregator; window scalars appear in the Brief's trusted envelope by structural copy (ADR-0005), never laundered through the model |
| **planning-guidance** | **Yes** | trusted text → the **instruction region** (ADR-0005 §5), never the `<untrusted-data>` block |

- Guidance is the only config value that touches the model, and it does so **as instructions, by
  design** — the sanctioned mirror of untrusted data, not a weakening. The boundary rule is
  "untrusted content meets the model only in the summarizer, only as data"; trusted config meeting
  it as *instructions* is the intended complement.
- **Guidance is a plain string, not `Untrusted<T>`** — structurally distinct from the branded
  untrusted fields; the `<untrusted-data>` delimiter keeps the instruction region and data block
  from cross-contaminating in either direction.
- **The whole design rests on config being genuinely trusted** — user-authored, machine-local. **An
  attacker who can write your `~/.config/rundown/config.json` is explicitly out of the threat model**
  — it is equivalent to full machine compromise (they own your dotfiles, env, and binary). rundown's
  boundary defends against *hostile remote backends*, not a hostile local filesystem — the same
  trust basis as `~/.ssh/config` or `.env`.

## Consequences

**Positive**
- The reuse seam is one readable file: adapt rundown to a new life by editing `config.json`, no code.
- Secrets stay out of the shareable file, so `config.json` is safe to copy and commit.
- No new component or abstraction — config is a config file plus a thin resolver at the composition
  root, honoring ADR-0003/0005's config-free Aggregator/Planner.
- Config authoring is agent-drivable (declarative, file-based) and headless-friendly (env-first,
  `RUNDOWN_CONFIG`), matching the coding-agent consumer.
- The trust boundary is untouched: only trusted guidance reaches the model, and only as instructions.

**Negative / accepted costs**
- JSONC needs a comment-tolerant parser (not bare `JSON.parse`) — trivial.
- No cross-file merge means a reuser writes a whole file rather than a diff — accepted for a 4-field
  file; whole-file readability beats merge convenience.
- Strict fail-hard validation means a small config typo aborts the run — accepted; loud beats
  silently-degraded for an agent consumer.
- Hostile-local-config is out of scope — accepted; it is equivalent to machine compromise.

The component vocabulary and module/repo layout this ADR assumes are canonicalized in
[CONTEXT.md](../../CONTEXT.md) and [ADR-0008](0008-bounded-context-and-component-architecture.md);
how the SKILL.md sequences `init` → edit → `login` → `status` for onboarding is
[ADR-0009](0009-skills-collection.md) §3.
