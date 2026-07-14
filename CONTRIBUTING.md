# Contributing to rundown

Thanks for considering a contribution. This doc assumes you've never seen the codebase before —
start here, and follow the pointers at the end for more depth.

## The model: reviewed-hard, solo maintainer

`rundown` is maintained by one person. Every PR is reviewed by the maintainer before merge; there
are no other committers and no merge rights beyond the maintainer.

Reviews and responses are best-effort — there is **no SLA**. A PR may sit before it's looked at;
that's expected, not neglect.

Small, focused PRs get reviewed fastest. **Open an issue to discuss anything non-trivial before
writing code**, so effort isn't spent on a change that won't land.

## Dev setup

`rundown` is built on [Bun](https://bun.sh), not Node.

```sh
git clone https://github.com/oyvindfanebust/rundown
cd rundown
bun install
```

Before opening a PR, run:

```sh
bun test              # unit tests — every component is covered
bun x tsc --noEmit     # typecheck — the hard gate, see below
```

**`bun x tsc --noEmit` is a hard gate, not a style nicety.** It is load-bearing for the trust
boundary: the `Untrusted<T>` "sole unwrap site" guarantee (below) is enforced at typecheck time,
not at runtime. A PR that doesn't pass `tsc --noEmit` cannot be merged, no exceptions.

`scripts/e2e.sh` runs an end-to-end acceptance pass against live Microsoft Graph. It's useful for
dogfooding a change but **is not required** to open or land a PR — it needs your own Graph
credentials and a completed `rundown login`.

## The one rule that cannot be broken

`rundown` reads content from your work sources — meeting titles, email and message bodies, issue
titles — and text like that can be authored by anyone: a coworker, an external sender, anyone who
can put a word into your calendar or inbox. That means it's **untrusted**: it might contain
instructions someone hid there, hoping a model or an agent acting on your behalf would follow
them instead of just reporting on them.

The rule that keeps that from being a problem:

> **Untrusted source content meets a model in exactly one place — the sandboxed, tool-less
> Summarizer (`src/summarize.ts`), a direct Anthropic call with zero tools.**

Three things follow from that rule, and a contributor must never do any of them:

1. **Never add tools to the Summarizer.** It stays a plain text-in/text-out call, permanently.
   Give it a tool and any injected instruction hiding in the content it reads gains something to
   act with.
2. **Never add an `unwrap()` call site outside `src/plan.ts`'s prompt assembly.** Every untrusted
   field is wrapped in the `Untrusted<T>` type (`src/trust.ts`). `unwrap()` is the sole primitive
   that extracts the raw value, and `src/plan.ts`'s prompt assembly is its only legitimate caller.
   The full set of unwrap call sites *is* the project's security audit — keeping it to one site is
   the whole point. (CI mechanically checks this — see the unwrap-gate check in the workflow.)
3. **Never add a command or code path that emits raw source data to the caller.** The only
   agent-facing commands are `brief`, `login`, `status`, `init`, and `--version`, and every one of
   them is post-summarizer. There is no raw-fetch command, by design — don't add one, and don't add
   a debug flag that behaves like one.

**A PR that weakens this boundary is rejected regardless of how valuable the feature is. This is
the one rule with no exceptions.**

If you're planning a change anywhere near the Summarizer, `Untrusted<T>`, source adapters, or the
CLI surface, read [`SECURITY.md`](SECURITY.md) for the full threat model and
[ADR-0004](docs/adr/0004-trust-boundary-enforcement.md) (with
[`CONTEXT.md`](CONTEXT.md) for the surrounding vocabulary) before you start — it'll save you a
review round-trip.

## Reporting security issues

Security reports — anything that touches the boundary above — go through private reporting, not a
public issue. See [`SECURITY.md`](SECURITY.md) for how.
