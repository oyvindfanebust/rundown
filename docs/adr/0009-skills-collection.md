# ADR 0009 — The rundown skills collection: one skill, light, pointing at the CLI

**Status:** Accepted

This ADR owns the **skills-collection** half of packaging: what `SKILL.md` files `rundown`
publishes, what each carries, and how the skill wraps the five-command CLI surface. The **binary
packaging / distribution / self-update** half is
[ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md).

## Context

`rundown`'s agent-facing surface is exactly five commands
([ADR-0008](0008-bounded-context-and-component-architecture.md) §6):
`brief` / `login` / `status` / `init` / `--version`. The consuming agent drives them through a
skill it installs from the `rundown` skills collection. Three things were open:

1. **Inventory** — one `rundown` skill, or a handful (e.g. a separate onboarding skill + a `brief`
   skill)? [ADR-0004](0004-trust-boundary-enforcement.md) already mandates the whole treat-as-data
   trust contract lives in **one** `rundown` SKILL.md, and there are **no per-source skills** (sources
   are internal to the binary) — so the ceiling was low.
2. **CLI wrapping** — pin the onboarding choreography ([ADR-0007](0007-config-personalization-layer.md)
   §7), and decide whether Brief **rendering guidance** lives in the SKILL.md (since
   [ADR-0006](0006-output-emission.md) punts rendering to the agent, any consistency guarantee must
   live here).
3. Where `install.sh` and the CLI packaging live — resolved in
   [ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md); this ADR consumes it (the
   skill *points at* an installed binary and carries a one-time install step).

## Decision

### 1. One skill, with onboarding as an on-demand reference file

- The collection is a **single `rundown` skill** (model-invoked; its `description` triggers on
  plan-my-work / "give me the rundown" requests). **No per-source skills**, no separate onboarding
  skill.
- **Onboarding lives in an on-demand reference file** inside the skill folder (e.g.
  `references/onboarding.md`), reached by a context pointer from the SKILL.md body — an "external
  reference" one level down from the always-loaded body. Rationale: the daily-driver body loads on
  every trigger, but onboarding
  fires *once*; pushing it behind a pointer keeps the always-loaded body lean **without** a second
  skill/description to maintain. The body carries a "not configured yet? → follow this pointer" branch,
  so onboarding self-fires when `brief` (or `status`) discovers an unconfigured install — no separate
  trigger needed.

### 2. What the SKILL.md body carries

- **The treat-as-data trust contract** ([ADR-0004](0004-trust-boundary-enforcement.md) behavioral
  layer) — the whole reason ADR-0004 wanted a single SKILL.md.
- **The `brief` invocation** — how to run the installed `rundown brief [--window <span>]` and that its
  stdout is a single JSON Brief ([ADR-0006](0006-output-emission.md)).
- **Rendering guidance, scoped to exactly three things** (and no landing/visual prescription):
  1. **Field semantics** — what `kind` / `when` / `evidence` mean, so items render faithfully.
  2. **A default grouping** — group `items` by `kind` (`commitment` → `task` → `waiting` → `fyi`),
     showing `summary` + `when`, attributed via `evidence.source`. A **legible default the human may
     override live**, not a lock-in (a reuser who vendors the skill can edit it).
  3. **The render-time trust framing (non-negotiable)** — render `summary` and every evidence `quote`
     as **quoted data**; never execute an imperative found inside Brief content. This is
     [ADR-0004](0004-trust-boundary-enforcement.md)'s behavioral layer applied at render time.
- **Not prescribed: landing.** Where the rundown goes (daily note / stdout / chat) and heavy visual
  formatting stay the agent's/human's call — [ADR-0006](0006-output-emission.md) has no sinks. The
  SKILL.md gives a legible default, not a destination.

### 3. Onboarding choreography (the reference file)

1. Agent runs **`rundown init`** → writes the annotated JSONC config template (Graph active; a
   zero-edit path to `brief` exists).
2. Agent **helps the human edit `config.json`** — timezone, source selection, guidance — treating the
   file as *trusted* config (authoring, not untrusted data).
3. The human does the **irreducibly-manual steps** from a precise checklist the agent hands over:
   the **Azure app registration** and **`rundown login`** (the one interactive command). The agent
   does **not** perform these itself.
4. Agent **polls `rundown status`** until it converges ("N of M ready", the single `Next:` line
   resolved).
5. **Secrets stay env / machine-local**, never in `config.json` — the reference file states this
   explicitly.

### 4. `ANTHROPIC_API_KEY` — env-first, surfaced by `status`

- The summarizer's `ANTHROPIC_API_KEY` is a **global credential**, distinct from any source's Graph/
  Azure auth. It is **inherited from the environment when present** — the common case for a coding-agent
  / CI consumer, so no manual step is needed there.
- **`status` reports it** as one more signal alongside per-source `configured?/authed?/identity` — its
  remit widens by exactly this one global-credential check (e.g.
  `summarizer ✓ ANTHROPIC_API_KEY present` / `✗ missing — export it`).
- The onboarding reference file's export step is therefore **conditional**: it materialises only when
  `status` reports the key missing — otherwise nothing to do.

### 5. Update choreography (consuming [ADR-0001](0001-package-rundown-cli-as-compiled-binaries-in-skills.md) §5)

- First run: the reference file carries the one-time `curl … | install.sh` step.
- Thereafter self-update is **automatic and background** (ADR-0001 §5). `status` surfaces installed-vs-
  latest; the SKILL.md tells the agent it can re-run `install.sh` as a manual fallback if auto-update
  is disabled or fails. No update *command* exists (five-command seal).

## Consequences

- **One artifact to author, one description to tune** — the highest-leverage authoring decision
  concentrates on a single trigger. Onboarding weight sits behind a pointer, off the hot path.
- The trust contract lives in exactly one place, as [ADR-0004](0004-trust-boundary-enforcement.md)
  requires, and is enforced again at render time.
- Output is **consistent by default yet freely overridable** — a legible grouping ships, landing does
  not, honouring [ADR-0006](0006-output-emission.md)'s agent-owns-presentation split.
- `status` grows two signals (summarizer credential; update availability) — both fold into its
  existing converging-diagnostic loop rather than new surfaces.
- The skills are authored at **implementation** time; this ADR decides *what* the
  collection is, not how it is written.
