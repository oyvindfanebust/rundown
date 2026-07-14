# ADR 0002 — The Source abstraction

**Status:** Accepted

This ADR fixes the Source abstraction that the multi-source aggregation model
([ADR-0003](0003-aggregation-model.md)) and the trust-boundary enforcement
([ADR-0004](0004-trust-boundary-enforcement.md)) build on.

## Context

`rundown` summarizes work from many systems (Microsoft Graph calendar/mail, Slack, Jira,
Linear, Claude Code logs, …) to help plan. **Sources** is the pluggable, read-only component per
work system. This ADR fixes the abstraction every such client implements: its interface, the
normalized item it emits, and its contracts.

The crown-jewel rule (CLAUDE.md / AGENTS.md) constrains every decision: untrusted
calendar/mail/source content meets a model **only** in the sandboxed, tool-less summarizer;
tool-capable code never reasons over raw source content. The abstraction's ultimate consumer is
therefore the **Summarizer** (a text model), while the **Aggregator** (tool-capable code)
only groups, orders, and attributes items — it never interprets their content.

Graph is the reference source (`src/sources/graph/`): calendar events and sent/inbox mail via
Microsoft Graph, one MSAL login.

## Decision

### 1. A Source is one backend / one auth boundary, emitting kind-tagged items

A **Source** is a read-only adapter for **one backend system / one auth boundary**. Graph is
*one* source (not calendar + mail as two), because auth is inherently per-backend — one Graph
login covers both. `read` returns a **heterogeneous list**, each item tagged with a `kind`
(`event` | `message` | `issue` | `session` | …). "Just calendar, not mail" is a source-level
selection option, not a separate source.

### 2. The interface: required `read` + `status`, optional `login`

- **`read(window) → NormalizedItem[]`** — required, the sole data operation.
- **`status() → SourceStatus`** — **required**; reports readiness and identity. Generalizes
  today's `whoami` and backs the agent-facing `rundown status`.
- **`login()`** — optional; only sources with interactive auth (Graph/MSAL) implement it.
  Token-paste sources (Jira/Linear) and local sources (Claude Code logs) do not.

**The governing principle** (which method is total vs. optional): *require a method when every
source has a meaningful **total** answer — the concept is universal; keep it optional when the
capability genuinely varies and absence is the honest, type-checked signal.* Readiness is
universal — every source can answer "can I read you right now?" (a local source: "yes, always") —
so `status()` is required. Interactive login is a capability that **varies**; forcing it total would
need a throwing stub or a redundant capability flag, both worse than letting the method's presence
be the typed declaration — so `login?()` stays optional.

`SourceStatus` is a **discriminated union**, not a boolean pair, so nonsensical combinations are
unrepresentable and the Aggregator pre-flight is exhaustive (see [ADR-0007](0007-config-personalization-layer.md) §7):

```ts
type SourceStatus =
  | { state: "ready"; identity?: string }
  | { state: "not-authenticated" }              // configured, interactive, not yet logged in
  | { state: "not-configured"; detail?: string };
```

There is no separate `interactiveAuth` flag — `login`'s presence on the interface is itself the
capability signal, so a source cannot report a nonsensical "not configured, but authenticated"
combination. This is internal readiness modeling only; the trust boundary and the five-command
CLI surface are untouched.

### 3. `read` takes one absolute time window; standing items may exceed it

There is **one** read operation — a time-windowed read, no separate `state()` operation. The
`window` is an **absolute time window**: two ISO-8601 instants. Each source maps it to its
native time field (calendar overlap, mail `receivedDateTime`, issue `updatedAt`). The window is
a **scope hint, not a strict filter**: a source whose items are stateful (open Jira/Linear
issues) **may return standing/open items whose last activity predates the window**, because they
are commitments to plan around even if untouched. Every emitted `timestamp` is an absolute
instant.

### 4. The NormalizedItem: thin structural core + untrusted `extras` bag

```
source:    string   // registry key / provenance          — STRUCTURAL (trusted)
kind:      string   // "event" | "message" | "issue" | …   — STRUCTURAL (trusted)
timestamp: string   // primary instant, ISO w/ offset;
                    //   the ordering key                  — STRUCTURAL (trusted)
end?:      string   // optional interval end (events,
                    //   sessions)                         — STRUCTURAL (trusted)
id:        string   // source-native id                    — UNTRUSTED
title:     string   // one-line label                      — UNTRUSTED
url?:      string   // permalink back to the item          — UNTRUSTED
extras?:   object   // ALL source-specific fields:
                    //   people/roles, body/preview,
                    //   status, importance, channel,
                    //   location, categories, …            — UNTRUSTED
```

The core carries only what the **aggregator** touches to group / order / attribute; everything
else lives in `extras`, which the source shapes into a readable sub-object for the summarizer.
Deliberately **not** in the core:

- **People/participants** — organizer, attendees, from/to, assignee, author. Almost as universal
  as time, but the *roles* differ per source and don't flatten without loss. Each source shapes
  them in `extras` with correct role labels.
- **Body/preview** — only a one-line `title` is core; bulk text is source-specific and lives in
  `extras`.

### 5. Contracts

- **Read-only.** No mutating operation exists on the interface; sources request read-only scopes
  where the backend distinguishes them (Graph already uses `Calendars.Read` / `Mail.Read`).
  Writing back is a different tool, out of scope.
- **Trust split.** The structural-trusted field set is **exactly** `{source, kind, timestamp,
  end}` — produced/constrained by rundown's own source module, safe to template into an
  agent-facing context. **Everything else — including `id` and `url` — is untrusted backend
  content** (a hostile backend controls its bytes). Only the summarizer may reason over untrusted
  content; the aggregator/planner treat it as opaque strings. This ADR fixes the *contract*; the
  *enforcement mechanism* — the `Untrusted<T>` type — is
  [ADR-0004](0004-trust-boundary-enforcement.md).
- **Config.** Each source **declares** its credential + option needs so `status()` can answer
  "configured?" and config resolution has a per-source schema to target. Secrets are
  machine-local, **env-first** (`~/.config/rundown/config.json` section + env-var fallback, per
  ADR-0001 §4). Config resolution is composition-root plumbing, not invented here.
- **Selection.** Not the source's concern. A source owns only a stable **name/key** (its registry
  key); which sources run is decided upstream by the Aggregator / config resolution.
- **Timezone.** Not a `read` parameter. Applied when *constructing* the window ("this week in
  Oslo" → two instants) and when *displaying* the brief — both config concerns. A source needing a
  display tz (e.g. Graph all-day events) reads it from its own config options. This lifts today's
  hardcoded `TIMEZONE = "Europe/Oslo"` out of Sources.

### 6. Invocation: in-process modules in the one binary, interface kept process-shaped

Sources are **in-process modules** registered by name in the one compiled `rundown` binary
(matches ADR-0001's sealed-binary model; a new source = new module + recompile + release). The
`read` contract is deliberately **serialization-friendly** — `window` and items are plain
serializable values, identical to what would cross a process boundary — so out-of-tree /
third-party sources can graduate to **subprocess plugins** later without redesign.

- **Revisit trigger:** the project becoming popular and users wanting to add their own sources.
- **No agent-facing per-source subcommand.** Raw `read` output stays internal to `rundown brief`
  (ADR-0001 §3). A dev-only debug command may exist locally, but the SKILL.md forbids the agent
  to invoke it (enforced per [ADR-0004](0004-trust-boundary-enforcement.md)). "CLI-first" holds
  at the level that matters: `rundown` *is* the CLI the skill drives; sources are internal modules
  of it.

### 7. Pressure-test — the abstraction holds across five sources

| Source | `read(window)` maps to | `kind` | `timestamp` | Auth | Fit |
|---|---|---|---|---|---|
| **Graph** (reference) | calendarView overlap / mail `receivedDateTime` | `event`, `message` | start / received | `login` + `status` | it *is* the model |
| **Slack** | messages/mentions by `ts` | `message` (maybe `mention`) | message ts | token | holds |
| **Jira** | issues `updatedAt` in window **+ open assigned** | `issue` | updated/created | token | holds |
| **Linear** | issues `updatedAt` **+ assigned** | `issue` | updated | token | holds (rundown's own tracker — dogfood) |
| **Claude Code logs** | sessions with start in window | `session` | session start (`end` = end) | **none** | holds — validates the no-auth path |

Residual strains are **downstream, not abstraction-breakers**:

- **Source-implementation details** (out of scope here): thread-vs-message granularity (Slack);
  title synthesis + transcript truncation (Claude Code — a session has no natural title, and
  transcripts are large, so `read` synthesizes a `title` and truncates content into `extras`,
  as `graph` already truncates `bodyPreview`).
- **Aggregation concern** ([ADR-0003](0003-aggregation-model.md)): **standing / recent / upcoming
  bucketing is *derived*, not a core field.** The Aggregator knows the requested window, so it
  buckets each item by
  comparing `timestamp` to it: before `window.from` yet still returned ⇒ **standing commitment**;
  inside the window ⇒ **recent activity**; after *now* ⇒ **upcoming**. Thin core preserved.

## Consequences

**Positive**
- One uniform item shape lets the Aggregator treat calendar events, emails, chat messages,
  issues, and sessions identically — group/order/attribute by four trusted structural fields.
- The trust split gives [ADR-0004](0004-trust-boundary-enforcement.md) a precise foundation:
  exactly four fields are safe to surface structurally; everything else is opaque-untrusted.
- The `extras` bag absorbs source variety without schema churn — a fifth source (Claude Code
  sessions) with fields nothing else has costs nothing.
- Auth is an opt-in capability, so a no-auth local source (Claude Code logs) is a first-class
  citizen, not a special case.
- In-process now, process-shaped contract → a clean, pre-planned evolution to plugins later.

**Negative / accepted costs**
- A new source requires a recompile + release (no drop-in third-party sources in v1) — accepted;
  revisit on popularity.
- The `extras` bag is loosely typed, so per-source shapes are a convention, not a compiler-checked
  schema. Acceptable because its consumer is a text model, not branching code.
- Standing-vs-recent is derived, so the aggregator must always know the requested window to bucket
  correctly (see [ADR-0003](0003-aggregation-model.md)).

**Follow-ups**
- Detailed per-source integration for Slack and Jira remains out of scope here; this ADR only
  validates that the abstraction generalizes across backends.
