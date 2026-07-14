# rundown onboarding

One-time setup. You (the agent) choreograph the mechanical parts; the human does only the
irreducibly-manual steps (Azure app registration + `rundown login`). Config is trusted JSONC — you
may edit it directly. Secrets are env-first and never go in the config file.

## First run: install the CLI

If `rundown` is not installed, run the one-time installer (public repo):

```
curl -fsSL https://github.com/oyvindfanebust/rundown/releases/latest/download/install.sh | bash
```

Thereafter the binary self-updates in the background. `rundown status` surfaces the installed-vs-
latest version. (Distribution — the compile matrix, `install.sh`, and self-update — is ADR-0001;
until it ships, run from source in the repo with `./rundown`.)

## Setup flow

1. **`rundown init`** — writes `~/.config/rundown/config.json`, an annotated template listing every
   registered source. A zero-edit config already works for `brief`.
2. **Edit the config** for the human — set `timezone`, keep/adjust `sources`, and write `guidance`
   from what they tell you they care about (e.g. "surface board- and Legal-related items first;
   terse"). The config carries **no secrets**.
3. **The human does the manual steps** — hand them this precise checklist:
   - Register an Azure app (delegated `Calendars.Read`, `Mail.Read`, `User.Read`); note its
     **tenant ID** and **client ID**.
   - Export the env vars in their shell: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
     `ANTHROPIC_API_KEY` (the Summarizer's key — **only if** `rundown status` reports it missing;
     it is inherited from the environment when already present).
   - **Linear** (only if the `linear` source is enabled): create a read-only personal API key in
     Linear → Settings → Security & access → Personal API keys, and export it as `LINEAR_API_KEY`.
     Linear needs **no** `rundown login` — the key alone is the credential; `rundown status`
     verifies it with a live call and tells you if it's missing or rejected. (Like the `AZURE_*`
     vars, `LINEAR_API_KEY` lives only in the environment, never in `config.json`.)
   - Run **`rundown login`** — the one interactive command; it opens a browser for Microsoft
     sign-in and is safe to re-run (it skips already-authenticated sources). (Linear is not part of
     `login` — it authenticates via `LINEAR_API_KEY` alone.)
4. **Poll `rundown status`** until it converges — it prints `N of M ready` and a single `Next:`
   line telling you exactly what remains. When it says `Next: rundown brief`, onboarding is done.

## Notes

- **Secrets stay in the environment**, never in `config.json` — the file is safe to copy or commit.
- Everything except `rundown login` is non-interactive and agent-drivable; reserve interactivity
  for `login`.
