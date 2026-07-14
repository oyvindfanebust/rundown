# ADR 0003 — The multi-source aggregation model

**Status:** Accepted

Builds directly on the Source abstraction ([ADR-0002](0002-source-abstraction.md)) and
coordinates with — but does not decide — the trust-boundary enforcement mechanism
([ADR-0004](0004-trust-boundary-enforcement.md)).

## Context

The **Aggregator** turns *N* Sources' item lists into **one normalized bundle** that the
tool-less Summarizer consumes. ADR-0002 fixed the per-source contract — `read(window) →
NormalizedItem[]`, a thin trusted core `{source, kind, timestamp, end}` plus an untrusted
`{id, title, url, extras}` — and explicitly handed three things to this ADR: how the lists
combine, how standing/recent/upcoming bucketing is *derived*, and cross-source ordering.

The crown-jewel rule (CLAUDE.md / AGENTS.md) governs every decision: untrusted source content
meets a model **only** in the sandboxed, tool-less Summarizer; the Aggregator is tool-capable
code and therefore **never interprets item content** — it groups, orders, and attributes by the
trusted structural fields alone.

## Decision

### 1. One shared window; sources pulled concurrently

A single rundown uses **one absolute window** (two ISO-8601 instants, constructed during config
resolution from the user's timezone + ritual) applied to **every** selected source. Sources are pulled
**concurrently** — they are independent I/O and one slow backend must not serialize the rest. The
single window is what makes cross-source bucketing coherent: one `from`/`to`/`now` yardstick
means "standing vs. recent vs. upcoming" is defined identically for a calendar event and a Jira
issue.

### 2. Selection is config's decision; the Aggregator receives a resolved list

ADR-0002 left selection to "the Aggregator / config". It resolves here: **config resolution (the
caller) decides which sources run and with what options; the Aggregator just pulls.** The
Aggregator's input contract is:

```
aggregate(window, selection) → Bundle
   selection: { sourceKey: string, options?: object }[]   // resolved by config resolution
```

The Aggregator is pure mechanism — pull the named sources, merge, bucket, sort. It reads no config
and makes no policy choice (mirrors how ADR-0002 lifted timezone out of Sources). Source-level
trims ("calendar only, not mail") ride in `options` and are honoured by the source, not the
Aggregator.

### 3. The bundle is a flat, annotated list — grouping deferred to rendering

```
Bundle = {
  window:  { from: string, to: string },      // the shared absolute window
  sources: { source: string, itemCount: number }[],   // manifest / provenance
  items:   AnnotatedItem[]                     // flat, deterministically sorted
}

AnnotatedItem = NormalizedItem & {
  bucket: "standing" | "recent" | "upcoming"   // DERIVED, structural-trusted
}
```

The Aggregator emits a **single flat merged list**, not a pre-grouped tree. Grouping for
presentation (by source? by bucket? by project?) is a **rendering decision owned by the Planner /
config**, not baked into the bundle — baking one hierarchy in would be the Aggregator making a
*format* choice, which is interpretation it must not do. The real consumer is a text model reading rendered text; a flat
list + `bucket` tag carries everything needed to render *any* grouping at template time.

### 4. Bucketing is derived from the window

Each item's `bucket` is computed by comparing its trusted `timestamp` to the shared window (per
ADR-0002 §7):

- `timestamp` **before `window.from`** yet still returned (a standing/open item) ⇒ **`standing`**.
- `timestamp` **inside the window** ⇒ **`recent`**.
- `timestamp` **after `now`** ⇒ **`upcoming`**.

`bucket` is a **derived, structural-trusted** label (it is a pure function of trusted fields), not
a stored source field — so it is safe to surface structurally.

### 5. Ordering: chronological, deterministic

Items are sorted **ascending by `timestamp`**, tie-broken by `source`, then by a **stable
structural insertion index** (source-pull order, then position within a source) — never by `id`,
since `id` is `Untrusted<T>` ([ADR-0004](0004-trust-boundary-enforcement.md) §3) and the
Aggregator, as tool-capable code, must not unwrap it. Rationale:

- Uses **only trusted structural fields** — sorting never touches untrusted content.
- **Fully deterministic** — same inputs → byte-identical bundle. The downstream consumer is an
  LLM, so stable ordering aids prompt caching and makes runs reproducible; the tiebreak removes
  ambiguity when two items share an instant.
- Reads as a timeline (past → now → future) — a sensible default if a template renders the list
  as-is.

The bundle order is a deterministic **default/tiebreak**, not the final reading order: standing
items carry old timestamps and sort to the top, but the Planner groups by `bucket` for
presentation, so this is harmless. A "standing → recent → upcoming" reading order is a
*presentation* choice left to the Planner, deliberately not pre-baked into the bundle order.

### 6. Fail-hard — no partial bundles ever

If any **selected** source is unauthenticated or errors, the **entire rundown aborts**; a partial
bundle is never produced or summarized.

- **Pre-flight `status()` before any `read`.** Sources exposing `status()` (ADR-0002) are checked
  first; if one reports unauthenticated, the run aborts *before* pulling anything, with a clean,
  actionable error ("Slack not authenticated — run `rundown login`"). No-auth sources (Claude
  Code logs) skip the check.
- **Any read error aborts** the run.
- **Zero items is success**, not failure — a source that authenticates and reads cleanly but finds
  nothing in the window contributes an empty list.

Because a bundle exists **only** when every selected source succeeded, the `sources` manifest
records provenance + counts, never a per-source status field — error/unauth cases live in the
*failure path*, not in the bundle. This is also a security property: no partially-formed untrusted
bundle is ever half-interpreted by the model.

### 7. No dedup, no correlation

The aggregator emits the **union of all items** — no deduplication, no cross-source correlation.
This is forced, not deferred:

- **Correlation is content-based, and content is untrusted.** Matching a Linear issue to a Slack
  mention requires parsing the message body/url — untrusted `extras`. The aggregator is forbidden
  to interpret untrusted content, so it *structurally cannot* correlate without breaking the rule.
- **The trusted core cannot support it** — `{source, kind, timestamp, end}` shares no entity key
  across backends.
- **The summarizer is the right place, for free** — the one component that *may* read content sees
  the whole bundle at once and observes connections ("this thread is about that issue") as an
  emergent part of summarizing. It is not a generic Aggregator feature.

Even same-source `{source, id}` collisions are left alone — dropping a "duplicate" is itself an
interpretation, and the cost of a stray dupe is negligible. Keep the Aggregator stupid.

### 8. The bundle is untrusted and never crosses to the agent

The whole bundle (it is full of `extras`) is untrusted. This ADR fixes the **data flow**; the
*enforcement mechanism* — the `Untrusted<T>` type — is [ADR-0004](0004-trust-boundary-enforcement.md).

- **Aggregator → Summarizer is a sealed in-process pipe** — both are steps inside `rundown brief`
  (ADR-0001 §3 keeps raw read output internal to that command). The bundle is an in-process value
  passed Aggregator → Summarizer; it is **never serialized to stdout** for the agent to read.
- **No agent-facing "dump the bundle" command exists.** A dev-only debug path may exist locally,
  but the SKILL.md forbids the agent to invoke it (enforced per [ADR-0004](0004-trust-boundary-enforcement.md)).
- **The agent receives only the summarizer's output** — a safe brief, potentially with extracted
  intent/tasks — never the raw bundle. The summarizer's output is the trust-laundering point.
- **The only aggregation output safe to surface to the agent is the trusted manifest scalars** —
  `source`, `itemCount`, `window` (e.g. a "pulled 4 sources, 37 items" status line). The `items`
  never cross the boundary.

## Consequences

**Positive**
- A flat annotated list keeps the Aggregator pure mechanism (pull / merge / bucket / sort) and
  defers all format choices to the Planner — the Aggregator never interprets content, satisfying
  the crown-jewel rule.
- Deterministic ordering makes bundles reproducible and prompt-cache-friendly.
- Fail-hard guarantees the model never reasons over a silently-partial week, and gives the
  trust-boundary enforcement a simpler surface (a bundle is always complete-or-absent).
- "No correlation" removes the single largest temptation to read untrusted content in tool-capable
  code; correlation still happens, but only where content may legitimately be read (the summarizer).

**Negative / accepted costs**
- **One flaky source blocks the whole rundown.** Accepted: an on-demand personal planning tool
  should fail loudly and tell you to fix auth, not quietly hand you a partial plan. Revisit if
  usage shows a source is chronically flaky and a "skip on error" opt-in becomes worth the
  partial-bundle honesty cost.
- **No cross-source dedup** means a topic touched in three systems appears three times in the
  bundle — but the summarizer collapses that in prose, so the cost is tokens, not correctness.
- The bundle order is not the reading order, so the Planner must group by `bucket` to present
  sensibly.

How the bundle becomes a plan-my-week brief — grouping/format at render time, and the shape of the
summarizer's structured output — is [ADR-0005](0005-planning-layer.md)'s concern. The mechanism
enforcing that the untrusted bundle never leaves the Aggregator→Summarizer in-process pipe is
[ADR-0004](0004-trust-boundary-enforcement.md).
