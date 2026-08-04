# Handoff: #54 — structural attribution on Brief evidence

For a fresh agent picking up
[#54](https://github.com/oyvindfanebust/rundown/issues/54). Read the issue first; this covers what
the issue does not — the code map, the constraints that will bite, the one architectural obstacle,
and what has already been tried.

## The problem in one paragraph

A Brief item's evidence entries are `{source, quote}`. `source` is a string the model writes, and
until recently it was documented to the model as "its source key", so it emitted `"slack/message"`.
The channel and author reach the summarizer — `renderItem` renders every `extras` key — but the
output contract has nowhere to carry them back out, so attribution is discarded at the output
boundary. This is latent for every source and acute for Slack: a calendar event's title describes
itself, a chat message's body does not.

## Current state

An interim mitigation already shipped on the Slack branch (PR #43): `ITEM_RULES` in `src/plan.ts`
now asks the model to attribute the quote in `source` (`"slack/#eng-platform"`,
`"slack/DM with Ada Lovelace"`). It works — a live Brief went from `slack/message` on every entry
to naming real channels and DM counterparts.

It is not the fix. The attribution is model-supplied free text, and `verifyEvidence` checks the
`quote` only, never the attribution, so a wrong or invented channel name passes through undetected.
There is a comment at the `ITEM_RULES` definition pointing here.

Do not treat the prompt wording as sacred — replacing it with a structural field is the point. Keep
it until the structural field is populated, so attribution never regresses to nothing.

## The one architectural obstacle

The obvious plan is "match each verified quote back to the item that produced it, then copy that
item's `extras` values". The obstacle is that nothing currently does that mapping:

```ts
function verifyEvidence(items: ExtractedItem[], renderedBundle: string): ExtractedItem[] {
  const haystack = normalizeWhitespace(renderedBundle);
  return items.map((item) => ({
    ...item,
    evidence: item.evidence.filter((e) => haystack.includes(normalizeWhitespace(e.quote))),
  }));
}
```

`renderedBundle` is the whole bundle flattened into one string, so this is a global substring test:
it answers "does this quote exist anywhere in the data" and never learns which item it came from.

So the work is to render per item and search per item — which also strengthens verification, since
a quote currently passes if it appears anywhere, including in a different item than the one the
model attributed it to. Decide deliberately what happens when a quote matches more than one item
(a short quote like "sounds good" will), and when it matches none (today the entry is dropped —
keep that).

`plan()` has `bundle` in scope, so the items are available where you need them.

## Code map

| File | What matters |
|---|---|
| `src/brief-contract.ts` | `Evidence` (~line 45) is the Zod source of truth (ADR-0011). Adding a field here regenerates `BRIEF_OUTPUT_SCHEMA`, which is handed to the model — think about whether the model should see the field at all (see below). Note the `.max()` caps: they are injection hardening, so any new string field needs one. |
| `src/plan.ts` | `ITEM_RULES` (the interim prompt text), `renderItem` (the sole unwrap site), `verifyEvidence`, `defangOutput`, and `plan()` which sequences them. All the work lands here. |
| `src/domain.ts` | `Brief` composes the contract's `ExtractedItem` with the trusted envelope. |
| `skills/rundown/SKILL.md` | The consumer. Documents the Brief shape and says to group items "attributed via `evidence[].source`". Update it in the same change, or the renderer will not show the new field. |
| `tests/plan.test.ts`, `tests/injection-corpus.test.ts` | Where the verification and defang behaviour is pinned. The corpus drives hostile payloads through the real pipeline — a new output field belongs in it. |

## Constraints that will bite

These are not style preferences; they are the project's load-bearing rules (`CLAUDE.md`, ADR-0004).

1. **The sole unwrap site is `src/plan.ts`.** `scripts/check-unwrap-sites.sh` fails the build on an
   `unwrap` anywhere else under `src/`, including a bare import. This works in your favour: copying
   `extras` values in `plan.ts` is legal exactly where you need it, and needs no new unwrap site.
   Do not try to do it in the aggregator or a source.
2. **Attribution values are untrusted source bytes.** A channel name and a display name come from
   the backend. Whatever you add must go through `defangOutput` like every other output string, and
   must not bypass the truncation caps. "Code-copied" makes it unfabricated, not trusted.
3. **The Brief is the external CLI surface.** ADR-0005 §4 defines the item shape and ADR-0011 makes
   `brief-contract.ts` its single source of truth, so this change wants an ADR amendment beside the
   code. Follow the amendment style used in ADR-0002 §5 / ADR-0008 §5 (amended by #27) and the
   §4 amendment at the end of ADR-0014.
4. **Do not obtain raw source data to debug this.** There is no raw-fetch command by design; do not
   add one, and do not run from source to dump a bundle. Verify through the Brief.

## The design decision to make first

Whether attribution is a field the **model fills** or a field **code fills**:

- Code-filled is the point of the issue — unfabricable, verifiable. But then it should probably not
  appear in `BRIEF_OUTPUT_SCHEMA` at all (the model should not be asked for something code
  supplies), which means `Evidence` as emitted by the summarizer and `Evidence` as emitted in the
  Brief diverge slightly. Look at how the schema is generated before assuming that is free.
- Also decide the shape: discrete `channel`/`author` fields, or one opaque `where` string. Discrete
  is more useful to a renderer; one string is less coupled to Slack's vocabulary and degrades better
  for sources that have no channel concept (mail folders, issue projects, log sessions).

Both readings are defensible and they lead to materially different diffs. Settle it with the human
before writing code.

## Verifying

```sh
export PATH="$HOME/.bun/bin:$PATH"        # bun is not on the default PATH in this environment
bun x tsc --noEmit                        # hard gate
bun test                                  # 310 pass / 9 skip at time of writing
bash scripts/check-unwrap-sites.sh        # trust-boundary gate
```

For a live check against real Slack data there is a side config selecting Slack only at
`~/.config/rundown/config.slack-test.json` (it must live in that directory — `RUNDOWN_CONFIG`
relocates the token caches too, so a config elsewhere will not find the cached token):

```sh
RUNDOWN_CONFIG=~/.config/rundown/config.slack-test.json ./rundown brief
```

A live run costs a real Anthropic call over the user's real messages. Ask before running one.

## Branch note

The Slack work sits on `worktree-slack-source` (PR #43), based on `174e840`, which predates the
Jira merge to `main`. If you work from that branch, a config selecting `jira` is rejected as an
unknown source. A rebase onto current `main` is pending and needs the human's go-ahead, since
refreshing the pushed PR requires a force-push.
