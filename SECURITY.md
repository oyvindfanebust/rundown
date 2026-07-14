# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: go to this repo's **Security** tab and click
**"Report a vulnerability."** That opens a private draft security advisory that only the
maintainer can see — nothing you write there becomes a public issue.

**Do not open a public GitHub Issue for a security report.** If you're not sure whether something
is a security issue or a regular bug, see [What counts as a vulnerability](#what-counts-as-a-vulnerability)
below; when in doubt, use private reporting — it costs you nothing to be cautious.

`rundown` is a personal, solo-maintained project. Reports are triaged and responded to
**best-effort, with no SLA**. There is no dedicated security team and no numeric response-time
guarantee — just one person looking at it when they can. That said, reports that clearly land on
the trust boundary described below will get priority attention.

## Threat model

`rundown` reads from work sources — calendar, mail, issue trackers, chat — and has a model
summarize what it finds into a plain-language Brief. The content it reads is **untrusted**: a
meeting title, an email body, a message, an issue title can all be authored by someone other than
you, and that someone could try to hide instructions in it aimed at a model or an agent acting on
your behalf. That's the threat this project defends against: **prompt injection carried in
untrusted work-source content**, aimed at making a tool-capable agent do something its user didn't
ask for.

### The three enforcement layers

1. **Structural seal.** The entire read → aggregate → summarize pipeline runs sealed inside the
   compiled `rundown` binary. The only commands the binary exposes are `brief`, `login`, `status`,
   `init`, and `--version` — every one of them post-summarizer. There is **no raw-fetch command**
   in the release build; raw source content never crosses the CLI surface at all.
2. **Sole-unwrap-site typing.** Every field that carries untrusted content is branded with a
   type (`Untrusted<T>`) that forces an explicit, greppable "unwrap" to get at the raw bytes.
   Exactly one place in the codebase is allowed to unwrap — the prompt assembly that feeds the
   Summarizer. Every other output channel (status text, logs, error messages, the source manifest)
   structurally cannot touch raw untrusted bytes. If an unwrap ever happens somewhere else by
   accident, the wrapper itself redacts to a fixed `[untrusted]` marker on every common accidental-
   serialization path, rather than printing the real content.
3. **Brief-as-data.** The model that actually reads untrusted content — the Summarizer — has
   **zero tools**. It can only produce text; it cannot act on anything it's told to do. Its output
   (the Brief) is never treated as fully trusted: any agent consuming it is expected to treat every
   field as quoted data describing your work, never as an instruction to follow.

Together: injection against the Summarizer is inert (it has nothing to act with), a leak that
somehow escapes the Summarizer's prompt boundary is confined to labeled, structured fields rather
than a bare imperative, and the one component with tools (the agent driving `rundown`) never sees
raw content in the first place.

### What's explicitly *not* in this threat model

- **A compromised Anthropic API.** The model endpoint the Summarizer calls is treated as trusted
  infrastructure, not part of the injection surface.
- **A malicious local user, or a compromised local machine.** If an attacker already controls the
  machine `rundown` runs on, they already have your credentials and your data; that's a different
  problem than injection via source content.
- **The self-update mechanism and the shipped binaries themselves.** Their integrity (code
  signing, release provenance, checksum verification) is a distribution-security concern, not the
  untrusted-content injection boundary this policy is about.
- **Your own Microsoft Graph / Azure app registration.** Getting your first-party OAuth setup
  right is on you; `rundown` doesn't second-guess credentials you've configured for yourself.

## What counts as a vulnerability

**Is a security vulnerability** — please report privately:

- Any path where untrusted source bytes reach a tool-capable context, or reach any output channel
  other than the Summarizer's prompt — e.g., an `unwrap()` call (or equivalent leak) outside
  `src/plan.ts`'s prompt assembly that lets untrusted content reach status output, logs, error
  messages, or the source manifest.
- A "delimiter breakout" — a way to make source content escape the untrusted-data region of the
  Summarizer's prompt and land in the trusted-instruction region, where it would be followed
  instead of described.
- A new agent-facing command, flag, or code path that emits pre-summarizer or otherwise raw source
  content.
- An exfiltration vector carried in Brief fields — for example, a source-influenced URL or
  markdown image reference that survives into rendered output and could be used for zero-click
  tracking or data exfiltration.
- Any change that would add tools to the Summarizer, or otherwise give it the ability to act
  rather than merely describe.

**Is a regular bug, not a vulnerability** — please use a normal GitHub Issue:

- Crashes, incorrect bucketing or sorting, formatting glitches, auth-flow UX rough edges, config
  parsing errors, missing or incomplete source data.
- Anything that doesn't cross the untrusted-content → trusted-output boundary described above.

If you're unsure which bucket something falls into, treat it as a vulnerability and report it
privately — it's easy to redirect a private report to a public issue afterward, and much harder to
undo the reverse.

## Supported versions

Only the **latest release** is supported. `rundown` self-updates (see
[ADR-0001](docs/adr/0001-package-rundown-cli-as-compiled-binaries-in-skills.md)), so every user can
move to the latest version with no more effort than running the CLI again. There's no backport
policy and no support matrix for older releases — upgrading is always the fix.

## Scope and safe harbor

This is a personal project with no bug bounty program. Good-faith security research is welcome.
Please:

- Don't run destructive tests against anyone else's data, accounts, or infrastructure.
- Don't access, modify, or exfiltrate data beyond what's needed to demonstrate a finding.
- Report through the private channel above rather than disclosing publicly first.

Reports made in good faith, within this scope, won't be treated as hostile activity.

---

*Maintainer note: private vulnerability reporting must be enabled on this repo before the above
works — repo **Settings → Security → Advanced Security → Private vulnerability reporting →
Enable** (or `gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting`). This is a
repo-admin, post-creation step, not something committed in this file.*
