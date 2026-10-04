# PROTOTYPE: typed records and a sample digest

Throwaway, for [Sketch the typed records and a sample digest for one week](https://github.com/oyvindfanebust/rundown/issues/122) on the map [Typed records and a full digest in place of generic summaries](https://github.com/oyvindfanebust/rundown/issues/117). Nothing in `src/` imports it. Delete it once the spec is written.

- `records.ts`: `Person`, `Email`, `ChatMessage`, `CalendarEvent`, the `SourceRecord` union.
- `output.ts`: the output, and `FIELD_TRUST`, the trust class of every field.
- `sample-week.ts`: one synthetic week, typed against `output.ts`. `bun prototypes/typed-records-digest/emit.ts` writes `sample-week.json`.
- `real-week.ts` + `real-week.html`: pulls one real week from Graph, maps it to the output (no model parts) and writes an HTML page comparing each entry with its raw Graph objects. `OUT_DIR=<dir outside the repo> bun prototypes/typed-records-digest/real-week.ts [from] [to]`. The output holds real mail: never commit or publish it.
- Typecheck: `bunx tsc --noEmit -p prototypes/typed-records-digest`.

## Output, second take

Decided in review on the ticket:

1. **Flat entries, written to be read.** One object per meeting, mail thread or chat conversation. No `meta`/`labels` split.
2. **Trust lives in the schema.** `FIELD_TRUST` classes every field as `trusted`, `label` or `model`; it is typed `Record<keyof Entry, Trust>`, so a field without a class fails to compile. The real contract carries the class in each Zod field's description (ADR-0011).
3. **No cross-references.** What needs your attention is `attention` (kind, summary, when) on the entry it is about. The separate plan list and its `entries: [fingerprint]` pointers are gone; the skill builds the plan view by filtering.
4. **Rooms are not attendees.** `rooms` comes from Graph `resource` attendees plus attendees whose address is one of the event's `locations[]`. `location` stays only when it says more than the room names.
5. **Subjects and titles cap at 255, everything else at 120.** `subject` and `title` clamp to `TITLE_MAX` (255, about Outlook's own subject limit), so honest subjects are not cut: 6 of 145 real subjects in a week ran over 120, none over 142. Names, channels, rooms and locations keep `LABEL_MAX` (120). A cut ends in "…". The normalizer's `TEXT_MAX` (200) cut has to rise to match. Refines the single 120 limit from [Decide which digest fields leave the binary verbatim and which only through the model](https://github.com/oyvindfanebust/rundown/issues/121).

Follows from those:

6. **Presence is signal.** False, zero, default and empty fields are left out: no `cancelled: false`, `importance: "normal"`, `showAs: "busy"`, `fromYou: 0`.
7. **"You" fields.** `youOrganize`, `yourResponse`, `fromYou`, `lastFromYou`, `mentionsYou`. Your own name never appears; `lastFrom` is absent when `lastFromYou`.
8. **Clamped lists say how much is left.** `attendees`/`people` hold at most 8 names; `moreAttendees`/`morePeople` count the rest.
9. **One-offs are flat, series list occurrences.** A one-off has `start`/`end`; a series has `recurring: true` and `occurrences`. A series carries its most common `yourResponse`; an occurrence repeats it only when it differs, and a moved one carries `movedFrom`.
10. **Top level is flat too.** `window`, `timezone`, `counts`, `summary`, then `meetings`, `mail`, `chat`. The envelope wrapper is gone.

Still open:

- **Multi-entry attention.** An attention item sits on one entry. The sample's architecture review mentions the DM and the channel in its summary instead of pointing at them. Fine for the plan view; it means the Summarizer picks the primary entry.
- **Meeting summaries** stay optional ([Decide how the Summarizer produces a summary per digest entry](https://github.com/oyvindfanebust/rundown/issues/123)).

**Size.** The real week (23 meetings, 108 mail threads, no summaries) is 43 KB, against 218 KB of raw Graph.

## Records

- **`byMe` on every message record**: `Email.byMe = from.isMe || sentBy?.isMe`; `ChatMessage.byMe = author.isMe`.
- **`Email.sentBy`** only when Graph's `sender` differs from `from` (delegate, send-as a shared mailbox).
- **`Person.handle`** (address or Slack user id) replaces `NormalizedItem.sender`. Boxed, never out.
- **`relationship` goes**: `byMe`, `mentionsMe` and the conversation kind say the same thing.
- **`CalendarEvent.rooms`** split from `attendees`; **`originalStart`** kept on moved exceptions. Needs `type,originalStart,locations,isOrganizer,isOnlineMeeting` in `$select`.
