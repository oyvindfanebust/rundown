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
  summary: string;                                     // model, ≤ 800
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
  messages: number; threads?: number; fromYou?: number; unread?: number; truncated?: number;
  firstAt: Instant; lastAt: Instant;
  lastFromYou?: true; lastFrom?: string;               // lastFrom: label, absent when lastFromYou
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
  messages: number; fromYou?: number; mentionsYou?: number; truncated?: number;
  firstAt: Instant; lastAt: Instant;
  lastFromYou?: true; lastFrom?: string;
  people?: string[]; morePeople?: number;              // label ≤ 8; a DM's counterpart
  continuesFromBefore?: true;
  summary?: string;                                    // model ≤ 300
}
```

- Presence is signal. False, zero, default and empty fields are left out, so `flagged` appears only
  when a thread is flagged and `showAs` only when it is not `busy`.
- "You" fields (`youOrganize`, `fromYou`, `lastFromYou`, `mentionsYou`) replace the user's own name,
  which never appears.
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
  (counts, times, `lastFromYou`, `continuesFromBefore`) and its newest messages up to about 8,000
  chars, each message capped at 2,000. Older messages become one line, "N earlier messages in the
  window not shown", and the entry carries a trusted `truncated` count. Meetings render as context
  for the overview only. Timezone and weekday rendering and date-only handling move here from the
  Planner.
- **Input budget.** The rendered data, after the entry caps, may be at most 400,000 chars. Over it,
  the run fails before any Summarizer call with "The window has N entries (M chars); the limit is
  400,000. Use a shorter window." A real week measures about 150 entries and 240,000 chars.
- **One Summarizer call per window.** The trusted instruction region carries `generatedAt`, the
  timezone and one overview prompt for every window: describe what happened before `generatedAt`
  and what is scheduled after it, and do not judge what is still open. `REVIEW_TASK` and
  `PLAN_TASK` go. The model returns `{ summary, entries: [{ id, summary }] }`, with the overview at
  most 800 chars and each entry summary at most 300; a longer one fails the parse.
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
