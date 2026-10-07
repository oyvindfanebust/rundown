# ADR 0021 — The digest and the Digester

**Status:** Accepted

Replaces the Planner and retires [ADR-0005](0005-planning-layer.md). The digest contract's Zod home
follows [ADR-0011](0011-brief-contract-source-of-truth.md). Decided on the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117), specified in
[#141](https://github.com/oyvindfanebust/rundown/issues/141) and built in
[#150](https://github.com/oyvindfanebust/rundown/issues/150), with the Summarizer transport from
[#146](https://github.com/oyvindfanebust/rundown/issues/146). Entries and their grouping are
[ADR-0020](0020-aggregation-and-digest-entries.md); the trust classes are
[ADR-0022](0022-trust-boundary.md).

**Amendment (where the user sits, [#164](https://github.com/oyvindfanebust/rundown/issues/164)).**
Mail and chat entries describe their latest message with a `lastMessage` object, and `lastFrom`,
`lastFromYou` and `fromYou` are removed (§2). A mail entry named who wrote the latest message but
not who it was addressed to, and the Summarizer saw each message's sender and one merged `people`
list. On 2026-10-06 a "Re: CV API" mail asked a colleague for files with the user on CC; the
Summarizer wrote that the request was made of the user, and the consuming agent put it on the
user's action list. A group DM had the same gap: the Summarizer saw `@Name` without knowing which
name was the user. `lastMessage.you` is one trusted value for the user's position, derived by code
from the source's `isMe`, `byMe` and `mentionsMe`, never by the model. For mail it is `from`
(`byMe`, which covers delegate and shared-mailbox sends), else `to` when a To recipient is the
user, else `cc`, else `indirect` (BCC or a list, which Graph does not tell apart for the
recipient). For chat it is `from`, else `mentioned` when the message mentions the user, else `to`
in a DM, else `indirect`. The user never appears in `from`, `to` or `cc`, which are labels through
`label()`, capped like `people`, with the rest counted in `moreTo` and `moreCc`. The count `fromYou`
became `messagesFromYou`, so it reads as a count beside `messages` and not as a flag beside
`you: "from"`. The Summarizer input carries the same facts (§4), and the instruction region tells
the model to say who a request is aimed at only when the data shows it, and never to describe a
request as made of the user when the user is on CC or indirect, or when a group conversation
message does not mention them. No new unwrap site: names reach the Summarizer through the
Digester's existing `unwrap()` and the digest through `label()`. The change breaks the contract
and ships as `feat!:`, without a deprecation period for the removed fields.

## Context

`rundown brief` emitted a curated plan: the Planner asked the model for commitments, tasks,
waiting items and FYIs with evidence quotes, and whatever it left out was gone, since the Bundle is
sealed. The consuming session planned a second time over that curated view, without the material to
answer "what did Ada say in that thread" or "which meetings did I decline".

The digest moves planning to the consumer. `rundown` reads, groups, summarizes and sanitizes; the
session that has the user's question plans. That needs an output that covers every entry, states
its facts as typed values, and keeps model-written text to short summaries.

## Decision

### 1. `rundown digest` replaces `rundown brief`

`rundown digest [--window <span>] [--source <name>]…` emits one digest JSON object on stdout per
run. `rundown brief` is removed, not aliased, and the Brief contract has no compatibility path.
Progress lines on a TTY speak of entries and the digest.

The composition root is `buildDigest` (`src/digest.ts`, replacing `src/brief.ts`): resolve config
→ Aggregator → Digester → digest. `generatedAt` is the run's one clock. The root reads it once and
threads it to window resolution and to the Digester, so the window and `generatedAt` cannot
disagree. `windowIsPast` is removed; a consumer compares `generatedAt` with the window.

### 2. The digest contract

```ts
interface Digest {
  window: { from: Instant; to: Instant };              // trusted
  timezone: string;                                    // trusted
  generatedAt: Instant;                                // trusted
  counts: Record<"meetings" | "mail" | "chat", { records: number; entries: number }>; // trusted
  unsummarized?: number;                               // trusted
  summary: string;                                     // model, ≤ 2000
  meetings: Meeting[];                                 // by start
  mail: MailThread[];                                  // by lastAt, newest first
  chat: ChatConversation[];                            // by lastAt, newest first
}

interface MeetingBase {
  id: Digest; type: "meeting";                         // trusted
  title: string;                                       // label ≤ 255
  allDay?: true; online?: true; youOrganize?: true;    // trusted
  rooms?: string[]; location?: string;                 // label ≤ 120
  organizer?: string;                                  // label; absent when youOrganize
  yourResponse?: "accepted" | "tentative" | "declined" | "notResponded"; // trusted
  showAs?: "free" | "tentative" | "oof" | "workingElsewhere";            // trusted; absent when busy
  attendees?: string[]; moreAttendees?: number;        // label ≤ 8 names, organizer first / trusted
  continuesFromBefore?: true;
}
type Meeting =
  | (MeetingBase & { start: Instant; end: Instant; cancelled?: true })
  | (MeetingBase & { recurring: true; occurrences: { start: Instant; end: Instant;
      cancelled?: true; movedFrom?: Instant; yourResponse?: YourResponse }[] });

interface MailThread {
  id: Digest; type: "mail";
  subject: string;                                     // label ≤ 255
  messages: number; threads?: number; messagesFromYou?: number; unread?: number; truncated?: number;
  firstAt: Instant; lastAt: Instant;
  lastMessage: {
    you: "from" | "to" | "cc" | "indirect";            // trusted, from isMe; To wins over CC
    from?: string;                                     // label; absent when you is "from"
    to?: string[]; moreTo?: number;                    // label ≤ 8, you excluded / trusted
    cc?: string[]; moreCc?: number;                    // label ≤ 8, you excluded / trusted
  };
  people?: string[]; morePeople?: number;              // label ≤ 8, last sender first
  importance?: "high" | "low"; flagged?: true; attachments?: true;
  bulk?: true;                                         // every message not by you is "other"
  continuesFromBefore?: true;
  summary?: string;                                    // model ≤ 300; absent only when unsummarized
}

interface ChatConversation {
  id: Digest; type: "chat";
  kind: "dm" | "group-dm" | "channel";
  channel?: string;                                    // label, channels only
  external?: true;
  messages: number; messagesFromYou?: number; mentionsYou?: number; truncated?: number;
  firstAt: Instant; lastAt: Instant;
  lastMessage: {
    you: "from" | "to" | "mentioned" | "indirect";     // trusted; mentioned wins over to
    from?: string;                                     // label; absent when you is "from"
  };
  people?: string[]; morePeople?: number;              // label ≤ 8; a DM's counterpart
  continuesFromBefore?: true;
  summary?: string;                                    // model ≤ 300
}
```

- Presence is signal. False, zero, default and empty fields are left out, so `flagged` appears only
  when a thread is flagged and `showAs` only when it is not `busy`.
- "You" fields (`youOrganize`, `messagesFromYou`, `mentionsYou`, `lastMessage.you`) replace the
  user's own name, which never appears.
- Meetings carry no summary: an event has no body, and a model summary would restate the title.
- The schema documents that a channel entry covers only the user's messages and mentions of the
  user, and that a group DM's `people` may be only the authors seen when its name cannot be read
  ([ADR-0019](0019-typed-records.md) §5).

### 3. Trust class is Zod metadata on every field

The contract lives in `src/digest-contract.ts` (replacing `src/brief-contract.ts`), the single Zod
source of truth per ADR-0011. Each field carries its trust class, `trusted`, `label` or `model`
(ADR-0022 §1), in a Zod registry. The JSON Schema descriptions are derived from it, and a leaf field
without a class fails at module load, so a field cannot be added without a class. The generic
schema generation and integer-bounds handling from ADR-0011 stay.

The module also exports a field list of path, trust class and description. The `rundown` skill's
field reference is checked against it in CI
([#151](https://github.com/oyvindfanebust/rundown/issues/151)), so the skill cannot drift from the
contract.

### 4. The Digester

`digest(bundle, { window, timezone, generatedAt }, { summarize }) → Digest`, in `src/digester.ts`
(replacing `src/plan.ts`). It groups records into entries (ADR-0020 §3–§4), builds the Summarizer
input, joins the model's output, and copies every trusted value and label into the entries by code.

- **Opaque ids.** Each entry gets a per-run id for the model: `m1…` for meetings, `e1…` for mail
  threads, `c1…` for chat conversations. Nothing stable or source-derived is in the prompt. The
  entry ids in the digest are the `entryKey` digests (ADR-0020 §5), which the model never sees.
- **Rendering.** Each mail and chat entry renders as a block under its opaque id: trusted metadata
  (counts, times, the user's position on the last message, `continuesFromBefore`) and its newest
  messages up to about 8,000 chars, each message capped at 2,000. A mail message line names its To
  and CC recipients, with "you" for the user written by code from `isMe`, capped at 400 chars apart
  from the body, and says when the user is on neither line; a chat message line is marked
  "(mentions you)" when it mentions the user. A cut message ends in "…[truncated]", whether the
  normalizer or the Digester cut it. Older messages become one line, "N earlier messages in the
  window not shown", and the entry carries a trusted `truncated` count. Meetings render as context
  for the overview only. Timezone and weekday rendering and date-only handling move here from the
  Planner.
- **Input budget.** The rendered data, after the entry caps, may be at most 800,000 chars, about
  444,000 tokens of Sonnet 5's 1M context. Over it, the run fails before any Summarizer
  call with "The window has N entries (M chars); the limit is 800,000. Use a shorter window." The
  budget is about twice a busy week. Measured on live data when mail bodies moved from Graph's
  `bodyPreview` to `uniqueBody` (#141): 53–60% of previews hit Graph's 255-char limit, so the
  Summarizer saw only the start of most mails; a week's rendered data was 176,000 chars on
  previews and 279,000–293,000 chars on `uniqueBody`, after the entry caps. The budget was 400,000
  before the switch.
- **One Summarizer call per window.** The trusted instruction region carries `generatedAt`, the
  timezone and one overview prompt for every window: describe what happened before `generatedAt`
  and what is scheduled after it, and do not judge what is still open. `REVIEW_TASK` and
  `PLAN_TASK` go. The model returns `{ summary, entries: [{ id, summary }] }`, with the overview at
  most 2,000 chars and each entry summary at most 1,000; a longer one fails the parse.
- **Overview target and cap.** The instructions ask for an overview of 3–5 sentences, about 800
  chars (`OVERVIEW_TARGET`), and never state the 2,000 cap (`OVERVIEW_MAX`); the cap reaches the
  model only as the output schema's `maxLength`. The cap was 800, the same length the prompt
  stated, and live runs on busy single days returned overviews of 891 and 972 chars, failed the
  parse three times and produced no digest. It was raised to 2,000 with the target kept at 800.
- **Entry summary target and cap.** The instructions ask for an entry summary of 1–2 sentences,
  about 180 chars (`ENTRY_SUMMARY_TARGET`), and never state the 300 cap (`ENTRY_SUMMARY_MAX`). The
  output parse accepts up to 1,000 chars (`ENTRY_SUMMARY_PARSE_MAX`), a sanity bound; the Digester
  clamps a longer summary to 300 with a trailing "…", so the digest keeps its 300 cap. The parse
  used to enforce 300, which the prompt also stated, so one summary over it failed all three
  attempts and the run. Live summaries measure a p99 of 221 chars and a maximum of 263.
- **The id join.** Code joins entry summaries on the opaque id. Unknown ids, ids of a meeting and
  duplicates (the first wins) are dropped. A mail or chat entry left without a summary is counted
  in `unsummarized` and keeps its code-filled fields. Neither case triggers a retry: a missing
  summary is a smaller harm than one attached to the wrong entry.
- **Extra keys are stripped.** The output schema strips keys it does not define instead of
  rejecting them, so the model can fill only `summary` fields and a volunteered trusted field costs
  no retry.
- Every label is clamped and every label and summary is defanged (ADR-0022).
- **Empty bundle.** A window with no records returns an empty digest without a model call.
- **Fail-hard** stays: a Summarizer error produces no digest and no partial output.

### 5. The Summarizer

The Summarizer keeps ADR-0005 §1's generic, tool-less contract, `summarize({ instructions, data,
schema }) → structured`. It prepends the Layer-1 hardening, wraps `data` in a nonce'd
`<untrusted-data>` delimiter, strips invisible Unicode from the data, makes the call with zero tools
and takes structured output from the response format, never from a tool. Its model parameters are
ADR-0005 §8's: `claude-sonnet-5`, effort `medium`, adaptive thinking, `RUNDOWN_MODEL` to override.

The transport changed in #146:

- The default transport streams and returns the final message, with `max_tokens` 64,000. The
  installed SDK refuses a non-streaming request above about 21,333 tokens. The `MessageTransport`
  seam keeps its request → `Message` shape, so tests are unchanged.
- A `max_tokens` stop is terminal, not retried, and tells the user to shorten the window. An
  identical call would stop identically.
- Schema-failure retries stay at 2. Refusals stay terminal. Transient API errors are retried by
  the transport.

### 6. What goes

The Planner, plan items, evidence and its verification, `ExtractedItem`, the plan output schemas,
the bucket-grouped prompt, `windowIsPast`, the review and plan prompts, and `guidance`. A config
that still sets `guidance` fails with the same kind of removed-key error as `suppress`: it names
the key and says in one line why it was removed
([#138](https://github.com/oyvindfanebust/rundown/issues/138)). No setting replaces it.

## Consequences

- The consumer gets every entry in the window with its facts as typed values, and plans with the
  user's question in front of it. `rundown` no longer plans.
- The model writes only summaries. Every count, time, flag and enum is set by code from records,
  and every name, subject and channel is a code-copied label.
- One call per window bounds cost and latency, and the budget refusal means a window that cannot
  fit costs nothing. A month window does not fit; chunking across calls is out of scope.
- Summaries are lossy: an entry over the 8,000-char render cap is summarized from its newest
  messages, and `truncated` says so.
- An entry the model skips is still listed, without a summary. `unsummarized` makes the gap
  visible.
- The digest is a breaking output change. Releases were held from the typed records until the
  live hostile-input evals land, so it ships as one version.
