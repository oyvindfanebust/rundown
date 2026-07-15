# rundown

> Give me the rundown.

A readout of where you stand across your work sources: what you've committed to, what's coming
up, and what you've been working on. `rundown` reads your work systems, has a sandboxed Claude
call summarize them, and prints a structured Brief as JSON on stdout. A coding agent installs the
`rundown` skill and drives it on demand; landing and rendering the Brief are the agent's job.

Today `rundown` reads three sources: Microsoft Graph (calendar and mail), Linear (issues you're
involved in), and Claude Code logs (local session transcripts). Slack and Jira can be added later
against the same abstraction.

## The trust boundary

This is the design decision the rest of the project hangs on. Untrusted source content — meeting
titles, email and message bodies, issue titles from any backend, anywhere an external party can
hide instructions — meets a model only in the sandboxed, tool-less Summarizer. And no command
emits raw source data: the whole read → aggregate → summarize pipeline runs sealed inside the
`rundown` binary, and the only thing that ever crosses the CLI surface is the post-summarizer
Brief.

That gives you two guarantees:

- Injection is inert and confined. The Summarizer has no tools, so a hidden instruction has
  nothing to act with, and the structured output frames any leaked text as a quoted, attributed
  snippet rather than a command.
- A tool-capable agent never sees raw content. It sees only the reduced Brief, which it is
  instructed to treat as data, and there is no raw-fetch command for it to reach for.

The full enforcement model — structural, in-code (`Untrusted<T>`), and behavioral — is in
[`AGENTS.md`](AGENTS.md).

## How it works

`rundown` is one bounded context with a single external surface, the CLI. Inside are four
components (see [`CONTEXT.md`](CONTEXT.md)):

- **Sources** — read-only adapters, one per backend/auth boundary (Graph, Linear, Claude Code logs).
- **Aggregator** — pulls the selected sources concurrently into one normalized, bucketed Bundle.
- **Summarizer** — the tool-less Anthropic call; the only place untrusted content meets a model.
- **Planner** — turns the Bundle into a plan-my-week Brief.

## Install

The primary install is a one-liner:

```sh
curl -fsSL https://github.com/oyvindfanebust/rundown/releases/latest/download/install.sh | bash
```

It fetches the compiled `rundown` binary and puts it on your `PATH`; after that the binary
self-updates in the background. This is the intended path, available from the v0.1.0 release —
until that ships, run from source.

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
- **Phase 2 — per user.** Each user either runs `rundown login` once or exports an env var.

Secrets are read from the environment and never live in the config file. The config carries only
what feeds the binary (timezone, sources, guidance), so it is safe to copy or commit.

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

### Phase 1: Linear — get your key

Linear doesn't use `rundown login`; the API key alone is the credential:

1. In Linear, go to **Settings → Security & access → Personal API keys** and create a **read-only**
   personal API key.
2. Export it:

   ```sh
   export LINEAR_API_KEY=...
   ```

`rundown status` verifies the key against the API and reports if it's missing or rejected.

Note that some workspaces disable personal API keys by policy. In that case the Linear source is
unavailable until the policy allows it. OAuth (via the same `login()` interface Graph already
uses) is the planned way around this.

### Phase 1: Claude Code logs

A local source that reads your Claude Code session transcripts. No auth, nothing to configure —
it's always ready.

## Commands

Five commands make up the whole surface:

```
rundown brief [--window <span|date|range>]   compose the pipeline; emit one Brief as JSON on stdout
rundown login [<source>]                     interactively authenticate configured sources
rundown status                               per-source configured/authed diagnostic + next step
rundown init                                 write the annotated config template (if absent)
rundown --version                            print the version
```

Onboarding runs them in order:

```sh
rundown init      # writes ~/.config/rundown/config.json (annotated JSONC, zero secrets)
# edit the config — timezone, source selection, planning guidance
rundown login     # opens a browser for Microsoft sign-in (once; tokens refresh silently)
rundown status    # poll until it prints `Next: rundown brief`
```

`rundown status` prints one readiness phrase per source plus an `N of M ready` line and a single
`Next:` line telling you what remains; when it says `Next: rundown brief`, you're done. It also
reports whether the Summarizer's `ANTHROPIC_API_KEY` is present:

```sh
export ANTHROPIC_API_KEY=...   # the Summarizer credential, read from the env like every secret
```

`rundown login` authenticates every configured interactive source and prints an exit summary of
what it did and what still needs an env var. Pass an optional source name — `rundown login graph`
— to authenticate just one. Linear is never part of `login`; it authenticates from
`LINEAR_API_KEY` alone.

The config file `~/.config/rundown/config.json` (override the path with `RUNDOWN_CONFIG`) owns
only `timezone`, `window`, `sources` (selection = presence; the one mandatory field), and freeform
`guidance` for the planner. No secrets, ever.

## Usage

```sh
rundown brief                                  # this week's rundown as JSON on stdout
rundown brief --window today                   # a symbolic span
rundown brief --window 2026-07-14              # a single calendar day
rundown brief --window 2026-07-06..2026-07-12  # an explicit, end-inclusive range
```

`--window` accepts a symbolic span (`today` | `this-week` | `next-week` | `last-week`), a single
`YYYY-MM-DD` date, or an explicit end-inclusive date range. Spans are the recommended form and the
only form the config file's `window` accepts; explicit dates are for one-off invocations.

stdout is either a valid Brief or empty; errors and refusals go to stderr with a non-zero exit.
An empty window emits an empty Brief and exits 0.

## Using it from a coding agent

`rundown` is published as a single-skill collection. A coding agent installs the `rundown` skill
(`SKILL.md` + `references/onboarding.md`) and drives the CLI: the skill carries the treat-as-data
trust contract and the rendering guidance, while the CLI is installed separately. The skill walks
the agent through onboarding and renders each Brief; where the output lands is the agent's call.

## Development

```sh
bun x tsc --noEmit    # typecheck — a hard gate; part of the trust boundary
bun test              # unit tests for every component
scripts/e2e.sh        # end-to-end acceptance against live Graph (needs BYO credentials + login)
```

The typecheck is not optional: the `Untrusted<T>` sole-unwrap-site guarantee is enforced at
typecheck time, so a green `tsc` run is part of the trust boundary.

Design record: [`CONTEXT.md`](CONTEXT.md) (the domain glossary) and [`docs/adr/`](docs/adr/) (the
decision record).
