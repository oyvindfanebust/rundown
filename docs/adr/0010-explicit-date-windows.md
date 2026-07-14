# ADR 0010 — Explicit date windows: `--window from..to`, CLI-only and end-inclusive

**Status:** Accepted

Extends the window surface fixed by [ADR-0007](0007-config-personalization-layer.md) §2/§5: a run may
scope its window to arbitrary calendar dates, not just the four symbolic spans.

## Context

The window handed to the Aggregator has, until now, only ever come from a **symbolic span**
(`today` / `this-week` / `next-week` / `last-week`) — a config default ([ADR-0007](0007-config-personalization-layer.md)
§2), overridable per-invocation with `rundown brief --window <span>` ([ADR-0007](0007-config-personalization-layer.md)
§5). Spans keep timezone and week-start date math sealed inside the binary and are the paved path for
the recurring rituals, but they cannot express "the first week of June" or "June 3rd–9th" — a
concrete stretch of the calendar the agent's user genuinely asks for. The open question was how to
admit arbitrary dates **without** weakening the trust boundary or the "never frozen instants" rule.

Window strings are **trusted control values** (they come from the CLI / config, never from a
backend), so this feature does not touch the [trust boundary](../../CONTEXT.md#trust-boundary): no
`Untrusted<T>`, no new `unwrap()` site. It is a parsing/resolution change, confined to config
resolution and the CLI surface.

## Decision

### 1. Explicit windows are CLI-only; `config.json`'s `window` stays symbolic-only

The `--window` flag gains two new forms; the `config.json` `window` field does **not**. A committed
config with frozen instants goes stale — exactly the failure [ADR-0007](0007-config-personalization-layer.md)
§2 named ("never two frozen instants"). Symbolic spans remain config's only window vocabulary and the
paved path for recurring rituals; explicit dates are a **per-invocation escape hatch** on the flag,
where staleness cannot accrue. Config-file date windows are explicitly rejected — ADR-0007 holds.

### 2. Two new `--window` forms: a single date and an inclusive range

```
rundown brief --window 2026-07-06..2026-07-12   # explicit range, end inclusive
rundown brief --window 2026-07-14               # single day  (= 2026-07-14..2026-07-14)
rundown brief --window this-week                # symbolic spans unchanged
```

- **Dates only** (`YYYY-MM-DD`), no datetimes — the window is a whole number of calendar days,
  matching the day-granularity of the spans and of all-day rendering.
- **A single date is the only shorthand**, resolving to `date..date` (that one calendar day).
- **No half-open ranges.** `2026-07-01..` and `..2026-07-01` are invalid; both ends are always
  required. A half-open range has no honest day-granular meaning without an implicit "now", and
  "now" is what the spans are for.

### 3. The end date is inclusive; the internal `Window` keeps its exclusive `to`

`from..to` resolves to `[midnight(from), midnight(to + 1 day))` in the configured `timezone`. The
**end date is inclusive** — the human calendar convention ("the 6th through the 12th" means the 12th
is in). The +1-day rollover happens at resolution time via the existing `zonedMidnight`/`addDays`
helpers, so the internal [`Window`](../../src/domain.ts) type keeps its **exclusive `to`** contract
untouched — no downstream component learns a second convention. Timezone comes from config (never a
source's job, [ADR-0002](0002-source-abstraction.md) §5), the same input the spans resolve against.

### 4. Validation is fail-hard, as a `ConfigError`

Consistent with [ADR-0007](0007-config-personalization-layer.md) §6 (strict, up-front, targeted
messages; a usability guard, not a security control):

- **Real calendar dates only** — `2026-02-30` and `2026-13-01` are rejected (a round-trip through a
  UTC date catches the rollover).
- **`from <= to`** — a reversed range is rejected.
- **No size cap.** An oversized window is *not* rejected here; it fails downstream in the Summarizer
  (consistent with the no-partials ethos — the run fails whole, not silently truncated). A cap may be
  added later from evidence, not speculatively.

Window-selector validation fails as a dedicated `WindowError` (`src/temporal.ts`), not a
`ConfigError` — window parsing lives in `temporal.ts`, outside config loading, but is otherwise
just as strict, fail-hard, and targeted-message as ADR-0007 §6.

### 5. `windowSpan` widens to a display label; retrospective-vs-plan already falls out

- The resolved config's `windowSpan` field widens from the `WindowSpan` enum to a **display string**:
  a span name for spans, or the literal range string (`"2026-07-06..2026-07-12"`, `"2026-07-14"`) for
  explicit windows. It is used only for progress/`status` display, never as control flow.
- A **wholly-past explicit window** (e.g. `--window 2026-06-01..2026-06-07`) automatically gets the
  retrospective task: the config resolver already reconciles `window.to <= now` into the neutral
  `windowIsPast` boolean that the [Planner](../../src/plan.ts) maps to the review-vs-plan prompt
  switch, so no new logic is needed — the past-window review behavior extends to explicit dates for
  free. (Single-clock reconciliation lives in config, per [ADR-0005](0005-planning-layer.md).)

## Consequences

**Positive**
- The agent can honor a user's concrete calendar ask ("the first week of June") by translating it to
  an explicit window, while spans stay the paved path for the recurring rituals.
- The trust boundary is untouched — window strings are trusted control values; no `Untrusted<T>`, no
  new `unwrap()` site, no change to the Summarizer or Planner prompts.
- The internal `Window`'s exclusive-`to` contract is preserved; inclusivity lives only in the
  CLI-facing syntax, converted once at resolution.
- `config.json` stays copyable and non-stale — no frozen instants ever enter the committed file.

**Negative / accepted costs**
- `windowSpan` is now a display string, not the `WindowSpan` enum — a slight widening of the
  resolved-config type, accepted because the field was already display-only.
- No size cap means a huge explicit range fails late (in the Summarizer) rather than up front —
  accepted; a cap is deferred until evidence justifies its exact value.

**Follow-ups**
- A window **size cap** may be added later from evidence (§4) — deliberately not specified now.
