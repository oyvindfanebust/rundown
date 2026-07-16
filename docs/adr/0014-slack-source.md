# ADR 0014 — The Slack source

**Status:** Accepted

This ADR fixes the design of the Slack source: a read-only adapter under `src/sources/slack/` that
follows the Source pattern in [ADR-0002](0002-source-abstraction.md), brands all backend content
`Untrusted<T>` at the normalizer per [ADR-0004](0004-trust-boundary-enforcement.md), and receives
its resolved per-source config by constructor injection per the seam decided in
[#27](https://github.com/oyvindfanebust/rundown/issues/27) (amending ADR-0002 §5 and ADR-0008 §5).
It is a design, not an implementation — the source code lands in a separate execution effort.

The read API surface, token types, scopes, and rate limits are established and verified against
primary docs in the research for [#18](https://github.com/oyvindfanebust/rundown/issues/18). The
work-item unit is decided in [#19](https://github.com/oyvindfanebust/rundown/issues/19) and the auth
model and scopes in [#20](https://github.com/oyvindfanebust/rundown/issues/20); this ADR does not
restate those, it locks the normalization and config design they left open.

## Context

Slack is the fifth source after Graph, Linear, Claude Code logs, and Jira, and the first that is
neither a calendar/mail store nor an issue tracker. Two decisions from earlier tickets frame the
normalization design:

- The source is retrospective — "what was I doing this period" — so items anchor on the user's own
  participation, not on messages addressed to them (#19). The unit is one message = one item
  (`kind:"message"`); the summarizer reassembles discussions into themes. A source is tool-less and
  model-less by design, so it cannot itself synthesize a theme — that is a summarization act, and
  the trust boundary confines it to the sandboxed Summarizer (`CLAUDE.md`, ADR-0004). The source's
  job is therefore to emit dumb per-message items plus the grouping keys the summarizer clusters on.
- Reads run through `search.messages` under a per-user `xoxp-` token minted by an interactive
  `login()` (#20), with shipped scopes `search:read` + `users:read`. `search.messages` mirrors the
  user's own visibility, so `authored`/`mentions`/`dms` are all one search query family with no
  per-channel bot invite.

## Decision

### 1. The work-item unit and relationships

One message is one item, `kind:"message"` (#19). The `relationships` option selects which
`search.messages` queries run — `authored` (`from:me`), `mentions` (`@me`), `dms`
(direct-message conversations) — default `["authored", "mentions"]`, with `dms` opt-in. This mirrors
Linear's and Jira's `relationships` shape exactly, so the three sources curate scope the same way.
Each query is tagged with the relationship that surfaced it; results are unioned and deduped by
message identity (`channel.id` + `ts`), first-seen relationship winning — the same union-and-dedup
shape as Linear and Jira.

### 2. Buckets: retrospective only

A Slack message has already happened, so items land in `recent` or `standing` and never `upcoming`
(#19). There is no synthesized-instant rule — nothing analogous to Linear's or Jira's open+due-date
end-of-day anchor. The timestamp is simply when the message was sent (§4).

### 3. Themes are a summarizer output, not a source field

The source never titles an item by theme, because a theme requires reading a cluster of message
bodies and synthesizing what they were about — a model's job, and the source is the one place
forbidden from calling one. Every title the source writes is mechanical (§4). The theme emerges one
layer up: a Brief item's `summary` is where the Summarizer, seeing the sibling messages of a thread
or DM, writes the themed line. The source's contribution to that is the grouping keys in `extras`
(§4), which let the model cluster messages into a conversation before summarizing it.

### 4. Normalization

A Slack message maps to a `NormalizedItem` with `kind:"message"`. Structural (trusted) fields are
exactly `{source, kind, timestamp}`. Everything else is branded `Untrusted<T>` at the normalizer
(`src/sources/normalize.ts`), never unwrapped in the source (the sole unwrap site is `plan.ts`).

- `timestamp` = the message `ts`, converted from Slack's epoch string (`"1749047412.123456"`) to a
  strict ISO-8601 instant (`new Date(seconds * 1000).toISOString()`) before it reaches the
  normalizer. The normalizer's `instant()` guard hard-rejects the raw `ts` format (ADR-0007 §6), so
  the conversion is the source's responsibility, done once at the call site. There is no `end`.
- `title` = the message `text`. A Slack message has no title field, so the body itself is the
  item's content line. The body is the archetypal injection vector, so it flows as an ordinary
  `Untrusted` title through the normalizer's `text()` marker — truncated to `TEXT_MAX` and quarantined
  on the one marked path, exactly like every other source's title. One message = one item (§1), so a
  truncated single message carries enough signal for the retrospective summary; the full thread is
  the opt-in concern of §5.
- `url` = the message `permalink`, which `search.messages` returns directly in each result — no
  separate `chat.getPermalink` round-trip (unlike the Jira permalink, which had to be constructed).
- `id` = `channel.id` + `ts` (the message's stable identity, also the dedup key of §1).
- `extras`, the grouping keys and minimal signal the summarizer clusters and renders on:

  | Field | Shape | Role |
  |---|---|---|
  | `channel` | `{ id, name, type }`, `type` ∈ `public` / `private` / `dm` / `group_dm` | Grouping key + human label; `type` derived from `is_channel`/`is_private`/`is_im`/`is_mpim`. Clustering on `channel.id` groups a channel or a DM conversation. |
  | `threadTs` | string, present only when the message is in a thread | Grouping key; `channel.id` + `threadTs` uniquely identifies one thread. |
  | `author` | display name | `search.messages` returns a user id + `username`; the `users:read` scope resolves it to a real name via `users.info`. For `authored` this is the user; for `dms`/`mentions` the counterpart. |
  | `relationship` | `authored` / `mentions` / `dms` | The query that surfaced the item, mirroring Linear's and Jira's `relationship` extra. |

  Reactions, edited-markers, attachment lists, unreads, and saved-for-later are omitted — #19 ruled
  them out of the first design, and none is a grouping key.

### 5. The `threads` option: opt-in full-thread reconstruction

`search.messages` matches individual messages, so a hit deep in a thread reaches the summarizer as
one isolated line with no conversation around it to theme from. The `threads` option
(boolean, default `false`) closes that gap: when on, for each distinct `(channel.id, threadTs)`
among the search hits the source calls `conversations.replies` once and emits each reply as an
ordinary `kind:"message"` item — same `extras` shape, deduped by `ts` against what `search.messages`
already returned. The summarizer then clusters the full thread by `threadTs` exactly as it clusters
any thread.

The reconstruction emits sibling items rather than bundling the thread's text into the matched
item's `extras`: a text blob would create a second content-bearing shape and stuff a large untrusted
value into one field, whereas emitting items keeps the shape uniform and the trust boundary
unchanged.

`threads` requires the `*:history` scope family (`conversations.history`/`.replies`), which #20
deliberately left outside the shipped `search:read` + `users:read` ceiling. Enabling `threads` is
therefore a user re-login against the admin-approved `user_scope` ceiling, not an admin
re-approval. The Slack app is an internal single-workspace install (#20), so `conversations.replies`
keeps Tier 3 and is not subject to the ~1 req/min cap that hits non-Marketplace distributed apps
(#18). A bound on runaway threads (a 500-reply thread must not flood the brief) is an accepted
execution detail — paginate `replies` with a sane cap — not an ADR-level design choice.

### 6. Auth, transport, and status

Auth is the interactive `login()` decided in #20, following the Graph pattern rather than an env
token: enterprise users cannot self-mint a `xoxp-` user token, and the search-driven design needs
one. One admin-registered and admin-approved Slack app; each user runs `rundown login`, which does
the OAuth v2 code exchange over a localhost callback (Slack OAuth v2 has no PKCE, so the
`client_secret` is presented at the exchange) and caches the minted `xoxp-` in the Graph token
store — never in env or config.json. App credentials `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`
are an env-only pair, org-provisioned; behavior options (§7) stay in config.json.

Transport is raw `fetch` against the Web API (`search.messages`, `users.info`, and — under
`threads` — `conversations.replies`), with standard cursor pagination on
`response_metadata.next_cursor` and 429 handling bounded by `Retry-After` (#18). The
injectable-transport seam Linear and Jira use is kept so the source stays unit-testable.

`status()` is a live `auth.test` call reporting four states: `ok` (token valid, `identity` from the
returned user), `not-configured` (no cached token or missing app credentials), `not-authenticated`
(cached token rejected — the source is interactive, so unlike Linear/Jira it does emit this, telling
the user to re-run `login`), and a scrubbed transport-error state.

### 7. Error scrubbing

Slack error responses (`{ ok: false, error: "<code>" }`) and any message content in a transport
failure are backend-influenced, so the transport reduces any transport error to a status-only
message emitting only the numeric HTTP status (a trusted scalar) and never any response bytes — the
Slack analog of Linear's `scrubbedTransportError` and Jira's status-only reduction (ADR-0004 §5). A
429 that survives the `Retry-After` bound fails cleanly through this same path.

### 8. Config, status, and init deltas

Under the constructor-injection seam ([#27](https://github.com/oyvindfanebust/rundown/issues/27)),
adding Slack is a static descriptor entry (`key: "slack"`, `label: "Slack"`, the `options` schema of
§1 and §5 — `relationships`, `threads` — `interactive: true`, and a `build(options, deps)` that
constructs `SlackSource` with the resolved config) plus its registration. `interactive: true` is
what routes Slack through `login()`. No change to the shared config schema, `status` narration
structure, or `init` template beyond this per-source entry and its options is needed (ADR-0008
§4–5); the `init` template documents the `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` env pair and that
the source is enabled by running `rundown login`.

## Consequences

**Positive**
- Slack items share the uniform shape: `kind:"message"` with the same `relationships` curation and
  union-and-dedup as Linear and Jira, so a Slack message and a Jira issue from the same period sort
  and render together.
- The trust boundary is unchanged: message bodies — the archetypal injection vector — ride the one
  marked `Untrusted` title path, all `extras` are branded, errors are scrubbed to status-only, and
  the source has no unwrap site.
- Themes are computed where they legally can be — in the Summarizer — and the source hands over
  exactly the grouping keys that make that possible.
- Least-privilege by default: the shipped scopes are just `search:read` + `users:read`; the
  heavier `*:history` family is gated behind the opt-in `threads` re-login.

**Negative / accepted costs**
- Without `threads`, a message matched deep in a thread reaches the summarizer as an isolated line;
  reconstructing the surrounding conversation is a deliberate opt-in with a scope cost, not the
  default.
- `search.messages` visibility is exactly the user's own, so the source cannot see channels the user
  is not in — correct for a "reads a user's Slack" source, but it means shared-channel context the
  user has not joined is invisible.
- A runaway-thread cap under `threads` is left to the execution effort rather than fixed here.

**Follow-ups**
- Slack is the last source in this map; the design work
  ([#15](https://github.com/oyvindfanebust/rundown/issues/15)) is complete with this ADR.
- Building, testing, and merging the Slack source code is a separate execution effort (out of scope
  for this map).
