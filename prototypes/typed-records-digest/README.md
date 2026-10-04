# PROTOTYPE: typed records and a sample digest

Throwaway, for [Sketch the typed records and a sample digest for one week](https://github.com/oyvindfanebust/rundown/issues/122) on the map [Typed records and a full digest in place of generic summaries](https://github.com/oyvindfanebust/rundown/issues/117). Nothing in `src/` imports it. Delete it once the spec is written.

- `records.ts`: `Person`, `Email`, `ChatMessage`, `CalendarEvent`, the `SourceRecord` union.
- `output.ts`: the output: envelope, plan items, digest entries.
- `sample-week.ts`: one synthetic week, typed against `output.ts`. `bun prototypes/typed-records-digest/emit.ts` writes `sample-week.json`.
- Typecheck: `bunx tsc --noEmit -p prototypes/typed-records-digest`.

## Choices to react to

**Records**

1. **`byMe` on every message record.** `Email.byMe = from.isMe || sentBy?.isMe`; `ChatMessage.byMe = author.isMe`. Entry `lastFromMe` and `fromMe` read it the same way for both.
2. **`Email.sentBy` stays, only when Graph's `sender` differs from `from`.** It is what makes mail sent as a shared mailbox count as yours. It never leaves the binary.
3. **`Person.handle`** (address or Slack user id) replaces `NormalizedItem.sender`. Boxed, never out; used for `isMe`, dedup within an entry, and suppression.
4. **`relationship` goes.** `byMe`, `mentionsMe` and the conversation kind say the same thing as `authored` / `mentions` / `dms`, as trusted values instead of a string.
5. **Slack private vs public is dropped.** Kind is `dm | group_dm | channel` plus `isExternal`, as ticket #121 listed.
6. **`moved`** is derived by the source from Graph's `originalStart`. That needs `type,originalStart` added to `$select`.

**Output**

7. **The user is never named.** `labels.people` lists everyone but the user; `meta.others` is the count before the `WHO_MAX` clamp; `lastFrom` is absent when `lastFromMe`. No label ever has to carry the user's own name.
8. **Digest grouped by type** (`calendar`, `mail`, `chat`), not one mixed list. Each type has its own `meta`, and the skill renders them as separate sections anyway.
9. **Calendar entries have no summary** (optional). Without a body the model can only restate the title. Goes to [Decide how the Summarizer produces a summary per digest entry](https://github.com/oyvindfanebust/rundown/issues/123).
10. **`bucket` (standing/recent/upcoming) goes.** Every entry has instants; the consumer compares them to the window. A calendar occurrence after "now" is upcoming by its `start`.
11. **All-day occurrences use `YYYY-MM-DD`** instead of UTC midnight plus `dateOnly`.
12. **Plan items cite `entries: [fingerprint]`**, with no evidence quotes. Placeholder for [Decide how plan items cite digest entries](https://github.com/oyvindfanebust/rundown/issues/124).
13. **Envelope `counts`** per source and type (records, entries) replace `sources[].itemCount`.

**Size.** The 12-entry sample is about 8 KB of JSON. A real week is about 165 entries, so roughly 100 KB, around 25K tokens for the skill to read. That bears on the skill's rendering guidance, which is still fog on the map.

**The hostile mail** (`d0c37a5e2b91f846`) shows a subject label after defanging: the URL scheme is `hxxps://`, and the summary describes the thread without relaying the link.
