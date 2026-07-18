# ADR 0015 — The debug logging channel

**Status:** Proposed

This ADR fixes the design of a debug logging channel for the CLI: an opt-in `--debug` /
`RUNDOWN_DEBUG` switch that emits structural diagnostic signal to stderr, carried by a closed,
trusted-scalar-only event union so it cannot become a leak path. It extends, and operates under,
[ADR-0004](0004-trust-boundary-enforcement.md) §5 (the status-only scrub) and
[ADR-0006](0006-output-emission.md) (the stdout/stderr split); it does not amend them. It is a
design, not an implementation — the code lands after sign-off.

## Context

Setting up the Jira source against a live site took a long diagnosis loop that better logging
would have collapsed. `rundown status` reported `jira ○ not configured  JIRA_EMAIL/JIRA_API_TOKEN
was rejected — check the credentials`. That message discards the HTTP status code and names neither
the request that failed nor the host it called. The real cause was a scoped API token, which
authenticates only through the `api.atlassian.com/ex/jira/{cloudId}` gateway and not the instance
URL — a distinction visible only by dropping to raw `curl` to read the 401, the
`x-seraph-loginreason: AUTHENTICATED_FAILED` header, and the gateway-vs-instance difference. None
of that was observable through the CLI. A debug mode surfacing safe structural signal (method +
status + host, the auth-verify outcome, later the cloudId resolution and gateway-vs-instance
choice) would have pointed at the answer in one `rundown status --debug` instead of many manual
probes.

The constraint that shapes the whole design is the trust boundary. Untrusted source content —
issue and message titles, bodies, and backend error-response bytes — must never reach logs, status,
errors, or stdout (`CLAUDE.md`; ADR-0004 §3, §5). Three facts follow:

- `src/sources/errors.ts` (`statusOnlyError`) already scrubs transport errors to status-only
  (`<name> request failed[: <status>]`) — no backend body bytes. Any logging design must preserve
  this.
- `src/trust.ts` warns that even a `console.error(JSON.stringify(item))` can leak an
  `Untrusted<T>`. Logging is itself a leak channel to reason about, not a free side channel.
- stdout is reserved for the Brief JSON (ADR-0006); all logging goes to stderr, and the
  sources→aggregate→summarizer hop is sealed in the compiled binary. Verbose logging must not
  become a raw-data escape hatch that defeats that seal.

So the question this ADR answers is narrow: what is safe to log (trusted and structural only), and
how to make it useful without opening a leak path.

There is a low-cost fix independent of the larger design. `statusOnlyError` already carries the
HTTP status in the error it throws, but each remote source's `status()` catches that transport
error and replaces it with a generic `"… was rejected"` detail that drops the code. The Jira case
is `src/sources/jira/index.ts:265`. Surfacing the status in the `status()` detail would have
immediately separated 401 (auth) from 403 (scope) from 5xx.

## Decision

### 1. The quick win: surface the HTTP status in `status()`, shipped separately

Independent of the debug channel, each remote source's `status()` catch surfaces the HTTP status
already present on the caught transport error (e.g. `rejected (HTTP 401)`), reusing `statusOf` from
`src/sources/errors.ts`. This crosses no boundary: an HTTP status is a trusted structural scalar,
which is the premise `statusOnlyError` already relies on. It lands as its own `fix:` change, before
and independent of the channel, because it delivers most of the status-diagnosis value on its own
and carries no trust-boundary risk.

### 2. Mechanism: one switch, a flag and an env var

Debug is turned on by a per-command `--debug` flag or a global `RUNDOWN_DEBUG=1` env var, OR-ed
together (either enables it). The env var matches the existing `RUNDOWN_MODEL` / `RUNDOWN_CONFIG`
convention, survives across a sequence of commands, and is the natural way to capture debug from a
piped or CI run. The flag is the discoverable, per-invocation form; since args are parsed
per-command (issue #30), `--debug` is declared on each command that accepts it, not globally.

It is a single on/off switch, not levels. The payload is structured events (§5), so on/off is
enough signal; if granularity is ever needed it should arrive as named event categories
(`RUNDOWN_DEBUG=http,auth`), not numeric `-vvv` levels. A `-v` short form is not offered: `-v` is
already `--version` (cli.ts:260), and reusing it would be a breaking change.

### 3. Scope: all four config-touching commands

`status`, `brief`, `login`, and `init` all honor debug. `status` is the highest-value surface (the
auth/config diagnosis where the Jira loop hurt); `brief` traces source reads; `login` traces the
interactive OAuth flow. `init` does no remote I/O, but config-path resolution is a cross-cutting
concern — it emits the shared `config-path` event (the resolved path and whether it came from the
default or `RUNDOWN_CONFIG`), so `RUNDOWN_DEBUG=1 rundown init` is never silently confusing when the
override is set in a forgotten shell profile. Keeping the switch uniform across all four commands is
cleaner than a three-of-four asymmetry where `rundown init --debug` would error. `--version` reads
no config and does no I/O, so it stays out.

### 4. Sink: a separate typed sink, injected into sources, not TTY-gated

Debug uses a sink distinct from the existing `onProgress`. `onProgress` carries human-facing
strings and is documented "trusted status only" (`src/brief.ts`); debug carries typed structured
events, and that typing is the guarantee (§5), so overloading the string sink would throw the
protection away before it exists.

The sink reaches sources by constructor injection, mirroring the seam adopted in #27 (sources
receive their resolved config the same way). `buildRegistry` passes the debug sink into each source
at build time — it is known per-invocation, since `--debug` is fixed for the run — so `read(window)`
and `status()` signatures are untouched and no ADR-0002 interface change is needed. A source emits
its events through the injected sink.

Debug is not TTY-gated. `onProgress` is ambient cosmetic noise, so gating it on `stderr.isTTY`
(cli.ts:248) is correct. Debug is explicitly requested, and its main use is capturing signal from a
piped or CI run (`rundown status --debug 2> debug.log`), so it emits to stderr whenever the switch
is on, TTY or not. stdout stays Brief-only regardless.

### 5. The guarantee: a closed union of trusted-scalar events

The guarantee is inherited, not newly invented. `Untrusted<T>` is nominally opaque — its
`private raw` field makes it non-assignable to `string` or `number` (`src/trust.ts`). So if the
debug sink takes typed events whose fields are plain scalars, passing a boxed untrusted value into
one is already a compile error. The only escape is `unwrap()`, which stays sole-site in `plan.ts`
and which debug code never imports. The leak-path audit surface is unchanged: the `unwrap()` sites,
plus one new debug module.

The payload is a closed discriminated union of trusted-scalar-only events — not a free-form string,
and not a `Record<string, unknown>` bag. The variants are source-agnostic and parameterized by a
`source` key, so every remote source emits the same `http` event and the union does not grow per
source. It grows only when a genuinely new kind of structural signal appears, and that growth is
the boundary-review moment the closed shape is meant to force — the same discipline as the
sole-unwrap-site rule. The event is rendered to a stderr line in one place (cli.ts), not at call
sites.

Two rules harden the union against the two realistic leaks:

- No free `error` / `message` / `detail` string field. That field is where a caught backend error
  gets stringified (`String(e)`), which is exactly the leak `statusOnlyError` exists to prevent.
  Where an event wants a code from a caught error it reuses `statusOf` from `errors.ts` — the same
  audited scrub — so the debug channel and the thrown-error channel share one definition of "status
  only."
- Host and path-shape only, never a full URL or query string. A URL can carry user or query
  content; an event carries the `host` and a structural path shape (`/rest/api/3/search/jql`),
  never a populated URL. A config or scan `path` is a control-plane filesystem path. `identity` may
  appear only where `status()` already surfaces it (the user's own display name), consistent with
  existing output.

The event type and its single renderer live beside `trust.ts` and `errors.ts`, so the whole
boundary reads in a few files.

### 6. The event vocabulary and per-source contribution

The initial closed union (illustrative field lists, not final signatures):

| Variant | Fields | Emitted by |
|---|---|---|
| `config-path` | `path`, `provenance: "default" \| "env"` | composition root (all commands) |
| `http` | `source`, `method`, `status`, `host`, `pathShape` | graph, linear, jira |
| `auth-verify` | `source`, `outcome: "ready" \| "rejected"`, `httpStatus?` | graph, linear, jira |
| `source-run` | `source`, `ms`, `itemCount` | all sources |
| `pagination` / `retry` | `source`, page/attempt counts | jira (and any paginating source) |
| `scan` | `source`, `path`, `fileCount` | claude-code-logs |

Per source:

- Graph, Linear, Jira emit `http`, `auth-verify`, and `source-run`. Jira adds `pagination`, and —
  once the scoped-token gateway support lands (the draft that motivates this ADR) — the cloudId
  resolution outcome and the gateway-vs-instance choice, expressed as `http` events plus a small
  structural marker, never a raw URL.
- `claude-code-logs` is local and always `ready`: no `http`, no `auth-verify`. It emits `scan` (the
  log directory it read and the session-file count) and `source-run`, so "why did I get zero
  Claude-Code items?" (wrong directory, or no sessions in the window) is diagnosable. A filesystem
  path is control-plane, so this stays trusted.

### 7. Phasing

1. The quick win (§1) as a standalone `fix:`.
2. The debug module (the event union, the sink type, the single renderer) beside `trust.ts` /
   `errors.ts`, wired into the four commands and injected into sources; the source-agnostic events
   (`config-path`, `http`, `auth-verify`, `source-run`, `scan`) implemented across the existing
   sources.
3. The Jira gateway/cloudId tracing, landing with the scoped-token gateway work (not present in the
   base Jira source today).

## Consequences

**Positive**

- The Jira gateway diagnosis, and the general class of "which request failed, against which host,
  with what status" questions, become a single `rundown status --debug` instead of a manual `curl`
  loop.
- The trust boundary is unchanged in substance: the debug channel is a third audited surface
  alongside `unwrap()` (trust.ts) and `statusOnlyError` (errors.ts), and it reuses the latter's
  status-only scrub rather than inventing a second one.
- The quick win delivers most of the status-diagnosis value immediately, with no new mechanism and
  no boundary risk.

**Negative / accepted costs**

- The closed union costs a boundary-reviewed edit for each genuinely new event kind. That friction
  is the audit, not an accident.
- Debug reaches sources by widening the constructor-injection seam (#27) with one more dependency;
  sources that emit nothing still receive the sink.
- The event vocabulary in §6 is a starting set, not exhaustive; it will grow as diagnosis needs
  surface, each addition through the same boundary review.

**Risks**

- The main residual risk is an unbranded backend string reaching an event field — `identity` and
  any value not branded by the normalizer. The two rules (§5) close the known vectors (caught-error
  stringification and full URLs); review of each new event field against the never-log list
  (titles, bodies, descriptions, backend error bodies, secrets, third-party people names) is the
  ongoing control.

**Follow-ups**

- Two tracker issues: a `fix:` for the quick win (§1) and a `feat:` for the channel (§2–§6), the
  latter referencing this ADR.
- Named event categories (`RUNDOWN_DEBUG=http,auth`) are a possible later refinement if a single
  switch proves too noisy; deferred as purely additive.
