# rundown

> Give me the rundown.

A readout of your mail, chat and calendar over a window. `rundown` reads your work systems, groups
what it finds into one entry per meeting, mail thread and chat conversation, has a sandboxed Claude
call summarize them, and prints the result as a digest in JSON on stdout. Nothing is curated out,
ranked or turned into tasks. A coding agent installs the `rundown` skill, drives it on demand and
answers your question from the digest; planning, landing and rendering are the agent's job.

Today `rundown` reads two sources: Microsoft Graph (calendar and mail) and Slack (messages you were
part of).

## The trust boundary

This is the design decision the rest of the project hangs on. Untrusted source content — meeting
titles, email and message bodies, names from any backend, anywhere an external party can
hide instructions — meets a model only in the sandboxed, tool-less Summarizer. And no command
emits raw source data: the whole read → aggregate → summarize pipeline runs sealed inside the
`rundown` binary, and the only thing that ever crosses the CLI surface is the post-summarizer
digest.

That gives you two guarantees:

- Injection is inert and confined. The Summarizer has no tools, so a hidden instruction has
  nothing to act with. Every string in the digest is either a short model summary or a label
  (a subject, title, name or channel) that code copied from the source, defanged and clamped.
  Bodies, addresses, handles, backend ids and URLs never leave the binary.
- A tool-capable agent never sees raw content. It sees only the digest, which it is instructed to
  treat as data, and there is no raw-fetch command for it to reach for.

The full enforcement model — structural, in-code (`Untrusted<T>`), and behavioral — is in
[`AGENTS.md`](AGENTS.md).

## How it works

`rundown` is one bounded context with a single external surface, the CLI. Inside are four
components (see [`CONTEXT.md`](CONTEXT.md)):

- **Sources**: read-only adapters, one per backend/auth boundary (Graph, Slack), each returning
  typed records.
- **Aggregator**: pulls the selected sources concurrently into one Bundle of typed records in the
  window.
- **Summarizer**: the tool-less Anthropic call; the only place untrusted content meets a model.
- **Digester**: groups the records into digest entries, makes one Summarizer call for the window,
  and builds the digest.

## Install

The primary install is a one-liner:

```sh
curl -fsSL https://github.com/oyvindfanebust/rundown/releases/latest/download/install.sh | bash
```

It fetches the compiled `rundown` binary and puts it on your `PATH`.

After that the binary keeps itself current on its own. At most once a day a run checks GitHub for a
newer release in a detached background worker and, when it finds one, verifies its checksum, confirms
the downloaded binary starts and reports the expected version, and replaces itself. The new version
takes effect the next time you run `rundown`, never mid-run. There is no update command: `rundown
status` reports which version you are on, whether a newer one is known, and why an update is being
refused if one is.

To turn it off, set `"autoUpdate": false` in `~/.config/rundown/config.json` — that is the durable
switch, and the only one that also makes an install-time version pin stick. For a single command,
`RUNDOWN_DISABLE_AUTOUPDATE=1` does the same. Updating is skipped automatically when `CI` is set in
the environment, so a vendored binary never mutates itself mid-pipeline, and a run from source never
updates anything.

### Run from source

```sh
git clone https://github.com/oyvindfanebust/rundown
cd rundown
bun install
```

The repo's `./rundown` launcher runs the compiled binary when one is present and otherwise falls
back to running from source ([Bun](https://bun.sh) required), so every command below works with
`./rundown` today.

## Setup is two phases

Installing the binary doesn't make a source ready to run. Getting a source live takes two phases:

- **Phase 1 — once per org, manual.** Provider-side setup: registering an app, granting scopes,
  creating a key. A human does this once for the whole organization.
- **Phase 2 — per user.** Each user runs `rundown login` once.

Secrets are read from the environment and never live in the config file. The config carries only
what feeds the binary (timezone, window, sources), so it is safe to copy or commit.

### Phase 1: Microsoft Graph (Azure)

Graph is the reference source. Register an app once:

1. In the [Azure portal](https://portal.azure.com), go to **Entra ID → App registrations → New
   registration**.
2. Under **Authentication**, add a **redirect URI** of type *Mobile and desktop applications* using
   the **loopback** address (`http://localhost`) — this is the desktop/native OAuth flow `rundown
   login` drives.
3. Under **API permissions**, add **delegated** Microsoft Graph read scopes: `Calendars.Read`,
   `Mail.Read`, `User.Read`.
4. From the app's **Overview**, note the **Directory (tenant) ID** and **Application (client) ID**,
   and export them:

   ```sh
   export AZURE_TENANT_ID=...
   export AZURE_CLIENT_ID=...
   ```

Phase 2 is `rundown login`: it opens a browser for Microsoft sign-in once, and tokens refresh
silently after that.

### Phase 1: Slack

Slack uses `rundown login`, like Graph. Register one app once for the whole workspace:

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app in your workspace.
2. Under **OAuth & Permissions**, add a **redirect URL** of `http://localhost:53912` — the loopback
   address `rundown login` listens on.
3. Under **User Token Scopes** (not bot scopes), add `search:read` and `users:read`.
4. From **Basic Information**, note the **Client ID** and **Client Secret**, and export them:

   ```sh
   export SLACK_CLIENT_ID=...
   export SLACK_CLIENT_SECRET=...
   ```

Phase 2 is `rundown login`: it opens a browser to authorize the app once and caches your user
token. `rundown` reads only what your own account can see, via `search.messages`.

## Commands

Five commands make up the whole surface:

```
rundown digest [--window <span|date|range>]  compose the pipeline; emit one digest as JSON on stdout
rundown login [<source>]                     interactively authenticate configured sources
rundown status                               per-source configured/authed diagnostic + next step
rundown init                                 write the annotated config template (if absent)
rundown --version                            print the version
```

Onboarding runs them in order:

```sh
rundown init      # writes ~/.config/rundown/config.json (annotated JSONC, zero secrets)
# edit the config: timezone, source selection, source options
rundown login     # opens a browser for Microsoft sign-in (once; tokens refresh silently)
rundown status    # poll until it prints `Next: rundown digest`
```

`rundown status` prints one readiness phrase per source plus an `N of M ready` line and a single
`Next:` line telling you what remains; when it says `Next: rundown digest`, you're done. It also
reports whether the Summarizer's `ANTHROPIC_API_KEY` is present:

```sh
export ANTHROPIC_API_KEY=...   # the Summarizer credential, read from the env like every secret
```

`rundown login` authenticates every configured source and prints an exit summary of
what it did. Pass an optional source name — `rundown login graph` — to authenticate just one.

The config file `~/.config/rundown/config.json` (override the path with `RUNDOWN_CONFIG`) owns
only `timezone`, `window`, `autoUpdate` and `sources` (selection = presence; the one mandatory
field). No secrets, ever.

The `guidance` and `suppress` keys were removed. A config that still has either fails with an error
naming the key; delete it.

## Usage

```sh
rundown digest                                  # this week's digest as JSON on stdout
rundown digest --window today                   # a symbolic span
rundown digest --window 2026-07-14              # a single calendar day
rundown digest --window 2026-07-06..2026-07-12  # an explicit, end-inclusive range
```

`--window` accepts a symbolic span (`today` | `this-week` | `next-week` | `last-week`), a single
`YYYY-MM-DD` date, or an explicit end-inclusive date range. Spans are the recommended form and the
only form the config file's `window` accepts; explicit dates are for one-off invocations.

stdout is either a valid digest or empty; errors and refusals go to stderr with a non-zero exit.
An empty window emits an empty digest and exits 0. A window too large for one Summarizer call fails
with a message asking for a shorter window.

## Using it from a coding agent

`rundown` is published as a single-skill collection. A coding agent installs the `rundown` skill
(`SKILL.md` + `references/onboarding.md`) and drives the CLI: the skill carries the treat-as-data
trust contract, a reference for every digest field and its trust class, and how to drive the CLI,
while the CLI is installed separately. The skill walks the agent through onboarding; the agent then
answers the user's question from the digest rather than reproducing it, and decides where any
output lands.

## Development

```sh
bun x tsc --noEmit    # typecheck — a hard gate; part of the trust boundary
bun test              # unit tests for every component
scripts/e2e.sh        # end-to-end acceptance against live Graph (needs BYO credentials + login)
```

The typecheck is not optional: the `Untrusted<T>` two-unwrap-site guarantee is enforced at
typecheck time, so a green `tsc` run is part of the trust boundary. `scripts/check-unwrap-sites.sh`
checks that only the Digester and `label()` call `unwrap()`.

Design record: [`CONTEXT.md`](CONTEXT.md) (the domain glossary) and [`docs/adr/`](docs/adr/) (the
decision record).
