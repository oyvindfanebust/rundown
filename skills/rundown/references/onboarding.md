# rundown onboarding

One-time setup. You (the agent) handle the mechanical parts; the human does only the steps that
can't be automated (Azure app registration and `rundown login`). Config is trusted JSONC — you may
edit it directly. Secrets go in the environment, never in the config file.

## First run: install the CLI

If `rundown` is not installed, run the one-time installer (public repo):

```
curl -fsSL https://github.com/oyvindfanebust/rundown/releases/latest/download/install.sh | bash
```

After that the binary keeps itself current: at most once a day a run checks for a newer release in a
detached worker, verifies it, confirms it starts, and replaces itself, taking effect on the next
invocation. `rundown status` prints a version line — the running version, a newer known version when
there is one, and the reason an update is being refused if it is — read from cached state with no
network call. Set `"autoUpdate": false` in the config to turn updating off durably, or
`RUNDOWN_DISABLE_AUTOUPDATE=1` for one command; it is skipped automatically under `CI`. Distribution
and self-update are ADR-0001. To work in the repo instead, run from source with `./rundown`.

## Setup flow

1. **`rundown init`** — writes `~/.config/rundown/config.json`, an annotated template listing
   every registered source. A zero-edit config already works for `brief`.
2. **Edit the config** for the human — set `timezone`, keep or adjust `sources`, and write
   `guidance` from what they tell you they care about (e.g. "surface board- and Legal-related
   items first; terse"). The config carries no secrets.
3. **The human does the manual steps** — hand them this checklist, keeping only the sources they
   enabled in step 2:
   - Export `ANTHROPIC_API_KEY` (the Summarizer's key) — only if `rundown status` reports it
     missing; it is inherited from the environment when already present.
   - Microsoft Graph: register an Azure app (delegated `Calendars.Read`, `Mail.Read`,
     `User.Read`); note its tenant ID and client ID, and export them as `AZURE_TENANT_ID` and
     `AZURE_CLIENT_ID`. Graph then authenticates through `rundown login`.
   - Slack: create an app at api.slack.com/apps, add `http://localhost:53912` as a redirect URL,
     add the user token scopes `search:read` and `users:read` (the `threads` config option also
     needs the `*:history` family), and export the app's credentials as `SLACK_CLIENT_ID` and
     `SLACK_CLIENT_SECRET`. Slack then authenticates through `rundown login`.
   - Linear: create a read-only personal API key in Linear → Settings → Security & access →
     Personal API keys, and export it as `LINEAR_API_KEY`. Linear is not part of `login` — the key
     alone is the credential; `rundown status` verifies it with a live call and tells you if it is
     missing or rejected.
   - Jira: create an API token at id.atlassian.com → Security → API tokens, and export
     `JIRA_EMAIL` (the Atlassian account email) and `JIRA_API_TOKEN`. Jira also needs the `site`
     option in `config.json` (e.g. `"your-domain.atlassian.net"`) — that one is config, not a
     secret, so set it yourself in step 2. Jira is not part of `login` either.
   - Claude Code session logs need nothing: no credentials, no login.
   - Run `rundown login` — the one interactive command. It opens a browser for each interactive
     source (Microsoft, Slack) and is safe to re-run; it skips sources that are already
     authenticated. `rundown login <source>` targets a single one.

   Every secret above lives only in the environment, never in `config.json`.
4. **Poll `rundown status`** until it converges — it prints `N of M ready` and a single `Next:`
   line saying what remains. When it says `Next: rundown brief`, onboarding is done.

## Notes

- Secrets stay in the environment, never in `config.json` — the file is safe to copy or commit.
- Everything except `rundown login` is non-interactive and agent-drivable; reserve interactivity
  for `login`.
