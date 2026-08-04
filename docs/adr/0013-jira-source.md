# ADR 0013 — The Jira source

**Status:** Accepted

This ADR fixes the design of the Jira (Cloud) source: a read-only adapter under `src/sources/jira/`
that follows the Source pattern in [ADR-0002](0002-source-abstraction.md), brands all backend
content `Untrusted<T>` at the normalizer per [ADR-0004](0004-trust-boundary-enforcement.md), and
receives its resolved per-source config by constructor injection per the seam decided in
[#27](https://github.com/oyvindfanebust/rundown/issues/27) (amending ADR-0002 §5 and ADR-0008 §5).
It is a design, not an implementation — the source code lands in a separate execution effort.

The read API and auth facts are established and verified against primary docs in the research for
[#16](https://github.com/oyvindfanebust/rundown/issues/16); this ADR does not restate them, it
locks the design choices they left open.

## Context

Jira is the fourth remote source after Graph, Linear, and Claude Code logs, and the second issue
tracker. Linear (`src/sources/linear/`) is the closest existing template: both are issue trackers
with token-only non-interactive auth and one paginated query, both emit `kind:"issue"` items, and
both curate a small set of structured scope options rather than exposing a raw query language. The
source mechanics are a known path; this ADR settles only the Jira-specific decisions.

Two structural facts from Jira Cloud shape the design and separate it from Linear:

- Auth is Basic auth over `base64("<email>:<api_token>")`, and every request needs the site base
  URL (`https://<your-domain>.atlassian.net`), which the token does not carry. Jira is therefore
  the first source with a required per-source option.
- The current search endpoint is `POST /rest/api/3/search/jql` with `nextPageToken`/`isLast` token
  pagination and no total count; the old `/search` is removed. Fields must be requested explicitly.

## Decision

### 1. Curated structured options, no raw JQL escape hatch

The source exposes a small set of curated scope options and builds the JQL itself, mirroring
Linear's `IssueFilter` construction. It does not expose a raw `jql` option in v1. rundown's value
is one uniform planning surface; a per-source query dialect in config leaks backend complexity and
breaks the uniform item shape. A raw `jql` string is user-authored (not an `Untrusted` injection
vector), but it is a way for config to silently pull an unbounded result set the summarizer must
then reason over. Adding a `jql` escape hatch later is a pure additive option, so starting curated
is the reversible choice.

### 2. Options: `site`, `relationships`, `statuses`, `projects`

| Option | Type | Enum / shape | Default | Notes |
|---|---|---|---|---|
| `site` | `string` | — | none (required) | `your-domain.atlassian.net` or full origin. Non-secret site identifier; also feeds the permalink. |
| `relationships` | `string[]` | `assigned` / `created` / `watching` | `["assigned"]` | JQL fragments below. |
| `statuses` | `string[]` | `new` / `indeterminate` / `done` | all three | Filters on `statusCategory.key`, not per-project status names. |
| `projects` | `string[]` | project keys (e.g. `OYV`) | all projects | JQL `project in (...)`. |

- `relationships` maps to JQL: `assigned` → `assignee = currentUser()`, `created` →
  `reporter = currentUser()`, `watching` → `watcher = currentUser()`. The third value is named
  `watching` for Jira's own noun (the UI and JQL call them watchers), not Linear's `subscribed` —
  the option should read truthfully rather than imply an exact cross-source parity. Default is
  `assigned` only, matching Linear.
- `statuses` keys on `statusCategory.key` (`new`/`indeterminate`/`done`) because individual status
  names are per-project and unbounded, while the category rollup is a fixed Jira-wide vocabulary —
  the direct analog of Linear's normalized state types. Default is all three, so recently-resolved
  work still surfaces (the Linear default likewise includes `completed`); the recent-window bound
  keeps `done` issues from flooding.
- There is no `teams` option: Jira has no team concept above the project, so `projects` is the sole
  container filter.

### 3. The "open" predicate and standing items

An issue is open while `statusCategory.key !== "done"`, the direct parallel of Linear's
`state.type not in {completed, canceled}`. Open issues are standing commitments: like Linear
(ADR-0002 §3), the source may return open items whose last activity predates the window. The read
runs each relationship as both a standing query (no `updated` bound) and a recent query (bounded by
the window), unioned and deduped by issue id, first-seen relationship winning — the same shape as
the Linear source.

### 4. Normalization

A Jira issue maps to a `NormalizedItem` with `kind:"issue"`. The timestamp rule mirrors Linear
exactly: if the issue is open and has a `fields.duedate` (a bare `YYYY-MM-DD`), the timestamp is
that due date anchored at UTC end-of-day (`T23:59:59Z`), so future due dates bucket as upcoming and
overdue ones as standing; otherwise the timestamp is `fields.updated`. Jira due dates are populated
less often than Linear's, and the fallback to `updated` handles the undated majority — the rule
degrades gracefully.

Structural (trusted) fields are exactly `{source, kind, timestamp}`. Everything else is branded
`Untrusted<T>` at the normalizer (`src/sources/normalize.ts`), never unwrapped in the source (the
sole unwrap site is `plan.ts`):

- `id` = issue `id`; `title` = `fields.summary`; `url` = the constructed permalink
  `https://<site>/browse/<key>` (there is no permalink field; `self` is an API URL).
- `extras`: `key`, `status` (`{ name, category }` from `fields.status.name` and
  `statusCategory.key`), `assignee` (`fields.assignee.displayName`), `reporter`
  (`fields.reporter.displayName`), `priority` (`fields.priority.name`), `project`
  (`fields.project.key`/`name`), `issuetype` (`fields.issuetype.name`), `duedate`, `labels`
  (`fields.labels`), `relationship`, and `description` (`fields.description`, truncated as Linear
  truncates its description). The `fields` list is requested explicitly on the search call.

Sprint is omitted from v1. It is a per-site custom field (`customfield_XXXXX`) whose id must be
resolved at runtime via an extra `GET /rest/api/3/field` call — a round-trip plus per-site fragility
for a nice-to-have, and purely additive to add later.

### 5. Auth and transport

Credentials are `JIRA_EMAIL` and `JIRA_API_TOKEN`, both env-only secrets: the email is part of the
Basic-auth credential, so it lives beside the token in the env, never in the shareable config.json
(ADR-0001 §4, ADR-0007 §3). The `site` is a non-secret option in config.json (§2), so Jira is the
first source whose `read()` needs a required option to function.

Transport is raw `fetch` — there is no official Atlassian JS SDK, and the community `jira.js` is a
large surface for a two-endpoint read-only adapter. `read()` builds the one `Authorization: Basic`
header, POSTs the JQL body to `/rest/api/3/search/jql`, and loops on `nextPageToken` while `!isLast`
— structurally the same as Linear's `pageInfo` loop, different field names. The injectable-transport
seam Linear uses is kept (`transport?: () => JiraRequest | null`, returning `null` when
unconfigured) so the source stays unit-testable and auth stays an OAuth-swappable seam.

The REST calls route through the Atlassian gateway `https://api.atlassian.com/ex/jira/{cloudId}`,
not the instance URL `https://<site>/rest/api/3/…`. Atlassian scoped (least-privilege) API tokens
authenticate only through the gateway; against the instance URL they get a 401 with
`x-seraph-loginreason: AUTHENTICATED_FAILED` on `/myself`, and `/search/jql` returns 200 but treats
the caller as anonymous (empty results). Classic (unscoped) tokens authenticate against the instance
URL. Routing through the gateway makes scoped tokens work and is what a least-privilege setup
requires.

`cloudId` is not carried by the token or the config. The default transport resolves it once, lazily,
from the unauthenticated `GET https://<site>/_edge/tenant_info` endpoint (`{"cloudId":"<uuid>"}`) and
caches it in the transport closure, so `status()` and `read()` share one resolution. The response is
backend content: only a UUID-shaped `cloudId` is read out, and any failure — non-ok response, or a
malformed or absent `cloudId` — reduces to the shared status-only scrub (§6), so no body bytes enter
an error or log. `cloudId` is a non-secret structural identifier, not a credential.

The routing decision is prefer the gateway, fall back to the instance URL on a 401. The transport
tries the gateway first; a 401 there flips it to the instance URL for the rest of the source's life,
and any other non-ok status is a real failure scrubbed to status-only. This works for scoped tokens
(proven: gateway returns 200) and cannot regress classic-token support (proven earlier by QA against
the instance URL): if the gateway rejects a classic token with a 401, the source falls back to the
instance URL, which classic tokens authenticate against. Whether the gateway also accepts classic
tokens directly is untested here — no classic token was available — but the design does not depend on
the answer: if the gateway accepts it, the gateway path serves it; if it 401s, the fallback serves
it. An explicit `cloudId` config override to skip the resolver call is a possible later refinement;
it is not needed while `/_edge/tenant_info` resolves reliably.

The permalink stays instance-based (`https://<site>/browse/<key>`, §4). The gateway is an API host,
not a browser URL, so the item `url` keeps using the human instance origin, derived separately from
the gateway base.

`status()` verifies the credential with a live `GET /rest/api/3/myself` call (Jira's `viewer`
analog), reporting `identity` from `displayName`. It returns `not-configured` when either env secret
or the `site` option is missing, and `not-configured` with a rejected-credential detail when the
live call fails — the source is non-interactive (no `login()`) and never emits `not-authenticated`,
matching Linear.

### 6. Error scrubbing

Jira error bodies (`{ errorMessages, errors }`) are backend content and can carry
attacker-influenced text, so the transport reduces any transport error to a status-only message,
`Jira request failed[: <status>]`, emitting only the numeric HTTP status (a trusted scalar) and
never any `errorMessages` bytes — the Jira analog of Linear's `scrubbedTransportError` (ADR-0004
§5). A 429 fails cleanly through this same path (`Jira request failed: 429`) with no retry loop;
for a once-per-invocation manual read a retry adds state for little gain. A Retry-After-bounded
single retry is a possible later refinement.

### 7. Config, status, and init deltas

Under the constructor-injection seam ([#27](https://github.com/oyvindfanebust/rundown/issues/27)),
adding Jira is a static descriptor entry (`key: "jira"`, `label: "Jira"`, the `options` schema of
§2, `interactive: false`, and a `build(options, deps)` that constructs `JiraSource` with the
resolved `site` config) plus its registration. No change to the shared config schema, `status`
narration structure, or `init` template beyond this per-source entry and its options is needed
(ADR-0008 §4–5) — the required `site` option and the two env secrets are the only additions the init
template documents.

## Consequences

**Positive**
- Jira behaves identically to Linear in the brief: two issue trackers, one uniform item shape, one
  timestamp rule, so a Jira issue and a Linear issue due the same day sort together.
- Curated options keep the query shape bounded and the config uniform across sources.
- Raw `fetch` adds no dependency and keeps the transport a thin, OAuth-swappable, testable seam.
- The trust boundary is unchanged: all backend content is `Untrusted` at the normalizer, errors are
  scrubbed to status-only, and the source has no unwrap site.

**Negative / accepted costs**
- The required `site` option makes Jira the first source that can be half-configured (secrets set,
  `site` missing); `status()` handles this explicitly.
- Sprint and any raw-JQL power use are deferred; both are additive later.
- Filtering on `statusCategory` rather than status names means a site's bespoke status names are not
  individually selectable — accepted, since the category rollup is the stable planning-relevant axis.

**Follow-ups**
- Slack is the next source ([#21](https://github.com/oyvindfanebust/rundown/issues/21)); its design
  is a separate ADR.
- Building, testing, and merging the Jira source code is a separate execution effort (out of scope
  for this map).
