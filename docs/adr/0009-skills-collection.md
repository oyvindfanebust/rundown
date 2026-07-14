# ADR 0009 — The rundown skills collection: one skill, light, pointing at the CLI

**Status:** Accepted

This ADR owns the skills-collection half of packaging: what `SKILL.md` files `rundown` publishes,
what each carries, and how the skill wraps the five-command CLI surface. The binary packaging,
distribution, and self-update half is
[ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md).

## Context

`rundown`'s agent-facing surface is exactly five commands
([ADR-0008](0008-bounded-context-and-component-architecture.md) §6):
`brief` / `login` / `status` / `init` / `--version`. The consuming agent drives them through a
skill it installs from the `rundown` skills collection. Three things were open:

1. Inventory: one `rundown` skill, or several (for example, a separate onboarding skill plus a
   `brief` skill)? [ADR-0004](0004-trust-boundary-enforcement.md) already mandates that the whole
   treat-as-data trust contract lives in one `rundown` SKILL.md, and there are no per-source skills
   because sources are internal to the binary, so the ceiling was low.
2. CLI wrapping: pin the onboarding sequence ([ADR-0007](0007-config-personalization-layer.md)
   §7), and decide whether Brief rendering guidance lives in the SKILL.md. Since
   [ADR-0006](0006-output-emission.md) leaves rendering to the agent, any consistency guarantee must
   live here.
3. Where `install.sh` and the CLI packaging live: resolved in
   [ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md), which this ADR consumes.
   The skill points at an installed binary and carries a one-time install step.

## Decision

### 1. One skill, with onboarding as an on-demand reference file

- The collection is a single `rundown` skill. It is model-invoked, and its `description` triggers on
  plan-my-work and "give me the rundown" requests. There are no per-source skills and no separate
  onboarding skill.
- Onboarding lives in an on-demand reference file inside the skill folder (for example,
  `references/onboarding.md`), reached by a context pointer from the SKILL.md body. It is an external
  reference one level down from the always-loaded body. The daily-driver body loads on every trigger,
  but onboarding fires once, so pushing it behind a pointer keeps the always-loaded body lean without
  a second skill and description to maintain. The body carries a "not configured yet? follow this
  pointer" branch, so onboarding self-fires when `brief` or `status` discovers an unconfigured
  install, with no separate trigger needed.

### 2. What the SKILL.md body carries

- The treat-as-data trust contract ([ADR-0004](0004-trust-boundary-enforcement.md) behavioral
  layer), which is the whole reason ADR-0004 wanted a single SKILL.md.
- The `brief` invocation: how to run the installed `rundown brief [--window <span>]` and that its
  stdout is a single JSON Brief ([ADR-0006](0006-output-emission.md)).
- Rendering guidance, scoped to exactly three things, with no landing or visual prescription:
  1. Field semantics: what `kind` / `when` / `evidence` mean, so items render faithfully.
  2. A default grouping: group `items` by `kind` (`commitment` → `task` → `waiting` → `fyi`),
     showing `summary` and `when`, attributed via `evidence.source`. This is a legible default the
     human may override live, not a lock-in; a reuser who vendors the skill can edit it.
  3. The render-time trust framing, which is non-negotiable: render `summary` and every evidence
     `quote` as quoted data, and never execute an imperative found inside Brief content. This is
     [ADR-0004](0004-trust-boundary-enforcement.md)'s behavioral layer applied at render time.
- Landing is not prescribed. Where the rundown goes (daily note, stdout, chat) and heavy visual
  formatting stay the agent's or human's call, since [ADR-0006](0006-output-emission.md) has no
  sinks. The SKILL.md gives a legible default, not a destination.

### 3. Onboarding choreography (the reference file)

1. The agent runs `rundown init`, which writes the annotated JSONC config template (Graph active, so
   a zero-edit path to `brief` exists).
2. The agent helps the human edit `config.json` (timezone, source selection, guidance), treating the
   file as trusted config for authoring, not untrusted data.
3. The human does the irreducibly manual steps from a precise checklist the agent hands over: the
   Azure app registration and `rundown login`, the one interactive command. The agent does not
   perform these itself.
4. The agent polls `rundown status` until it converges ("N of M ready", with the single `Next:` line
   resolved).
5. Secrets stay env and machine-local, never in `config.json`. The reference file states this
   explicitly.

### 4. `ANTHROPIC_API_KEY` — env-first, surfaced by `status`

- The summarizer's `ANTHROPIC_API_KEY` is a global credential, distinct from any source's Graph or
  Azure auth. It is inherited from the environment when present, which is the common case for a
  coding-agent or CI consumer, so no manual step is needed there.
- `status` reports it as one more signal alongside per-source `configured?/authed?/identity`. Its
  remit widens by exactly this one global-credential check (for example,
  `summarizer ✓ ANTHROPIC_API_KEY present` / `✗ missing — export it`).
- The onboarding reference file's export step is therefore conditional: it applies only when `status`
  reports the key missing, and otherwise there is nothing to do.

### 5. Update choreography (consuming [ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md) §5)

- First run: the reference file carries the one-time `curl … | install.sh` step.
- Thereafter self-update is automatic and runs in the background (ADR-0001 §5). `status` surfaces
  installed-versus-latest, and the SKILL.md tells the agent it can re-run `install.sh` as a manual
  fallback if auto-update is disabled or fails. No update command exists, preserving the five-command
  seal.

## Consequences

- One artifact to author and one description to tune, so the highest-leverage authoring decision
  concentrates on a single trigger. The onboarding weight sits behind a pointer, off the hot path.
- The trust contract lives in exactly one place, as [ADR-0004](0004-trust-boundary-enforcement.md)
  requires, and is enforced again at render time.
- Output is consistent by default yet freely overridable: a legible grouping ships and landing does
  not, honouring [ADR-0006](0006-output-emission.md)'s split where the agent owns presentation.
- `status` grows two signals, the summarizer credential and update availability. Both fold into its
  existing converging-diagnostic loop rather than adding new surfaces.
- The skills are authored at implementation time; this ADR decides what the collection is, not how it
  is written.
