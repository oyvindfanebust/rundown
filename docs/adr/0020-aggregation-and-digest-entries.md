# ADR 0020 — Aggregation and digest entries

**Status:** Accepted

Supersedes [ADR-0003](0003-aggregation-model.md). Decided on the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117) (the digest unit on
[#120](https://github.com/oyvindfanebust/rundown/issues/120), refined on
[#122](https://github.com/oyvindfanebust/rundown/issues/122)), specified in
[#141](https://github.com/oyvindfanebust/rundown/issues/141) and built in
[#150](https://github.com/oyvindfanebust/rundown/issues/150). Builds on typed records
([ADR-0019](0019-typed-records.md)); the digest that carries the entries is
[ADR-0021](0021-the-digest.md) and the trust rules are [ADR-0022](0022-trust-boundary.md).

## Context

ADR-0003 made the Aggregator pull the selected sources, merge their items into one flat list,
derive a `standing`/`recent`/`upcoming` bucket per item and sort it, so the Planner could render a
plan-my-week prompt grouped by bucket. The digest has no plan and no buckets. It lists every
meeting, mail thread and Slack conversation in the window as one entry, and an entry is a group of
records: the messages of a thread, the occurrences of a series, a channel's messages over the
window.

Two questions follow: what the Aggregator still does, and where records become entries. The mail
thread merge compares senders and subjects, which are untrusted, so the answer to the second
question is fixed by the trust rule.

## Decision

### 1. The Aggregator merges, sorts and filters, and reads no content

`aggregate(window, selection) → Bundle` keeps ADR-0003's shape. One absolute window is shared by
every selected source, sources are pulled concurrently, and selection is config's decision
(ADR-0003 §1, §2). The Aggregator merges the sources' records, keeps only the records in the
window, and sorts them by each record's own instant, tie-broken by source and then by insertion
order. A message is in the window by its own time and a timed event when it overlaps the window.
An all-day event is kept as the source returned it, since its dates are local days and the
Aggregator knows no timezone. It reads trusted fields only: instants, the source key and the
record type.

Buckets go, with `bucketOf`, `AnnotatedItem` and the `now` the Aggregator compared against.
Whether part of the window is past is now the consumer's reading of `generatedAt` (ADR-0021).

Kept from ADR-0003:

- No partial results. The pre-flight `status()` check runs before any read; an unauthenticated
  source or a read error aborts the run. Zero records from a source is success (ADR-0003 §6).
- No dedup and no cross-source correlation (ADR-0003 §7).
- The Bundle is untrusted, stays in process and never crosses to the agent (ADR-0003 §8). The
  per-source counts are the only aggregation output that may be surfaced.

### 2. The Bundle is records plus the manifest

The Bundle is the window, the window's typed records (`SourceRecord[]`, ADR-0019) in the order
above, and the per-source manifest of record counts. It is not grouped: grouping reads untrusted
content and belongs to the Digester (§4).

### 3. Digest entries

An entry is one group of the window's records:

- **Mail:** one thread per `conversationId`. Threads whose earliest message has the same sender
  address and the same subject, with leading "Re:" and "Fw:" prefixes and their Norwegian forms
  "SV:" and "VS:" ignored, merge into one entry. The entry's `threads` counts the merged threads,
  and the entry takes the earliest thread's id. A notice sent eleven times in a week is one entry
  with `threads: 11`. A thread whose earliest message is by the user, or whose subject is empty
  or missing, never merges: two mails the user sent with one subject, possibly to different
  people, are separate mails, and so are two subject-less mails from one sender. The check is
  per thread, so a thread the user sent from a shared address is its own entry while that address's
  other threads still merge.
- **Chat:** one conversation per Slack channel id over the window: a DM, a group DM or a channel.
- **Meetings:** one entry per recurring series (`seriesMasterId`), listing its occurrences in the
  window, or one entry per one-off event.

An entry holds only records inside the window. No earlier context is fetched, so a thread that
began before the window shows only its in-window messages and carries `continuesFromBefore`. The
unit does not change with window length.

### 4. Grouping happens in the Digester

The Digester (`src/digester.ts`, ADR-0021) groups records into entries, not the Aggregator. Thread,
channel and series grouping need only `entryKey`, a trusted digest, but the mail merge reads the
sender address and the subject, which are `Untrusted<T>`. The Digester's unwrap is one of the two
extraction sites ADR-0022 allows, so grouping sits beside it and the Aggregator stays free of
untrusted reads.

### 5. Entry ids are stable digests

An entry's `id` is the `entryKey` of its group (ADR-0019 §3): 16 hex chars of a SHA-256 digest of
the source group id, domain-separated per type (`email-thread`, `chat-conversation`,
`event-series`). A merged mail entry takes the earliest thread's `entryKey`. The same records give
the same ids on every run, so a consumer can recognise a thread or a series across two digests.
The ids the model sees are different, opaque and per run (ADR-0021).

This is what survives of [ADR-0016](0016-evidence-fingerprint.md): a one-way digest of a backend
id, carrying no backend bytes, keyed on identity and not version. The evidence it was attached to
is gone. It is also what survives of [ADR-0018](0018-graph-immutable-ids.md) §3: `conversationId`
remains the mail thread's group identity, now as the `entryKey` under `email-thread`.

## Consequences

- The Aggregator gets smaller: pull, merge, filter, sort. It still never reads content.
- Every meeting, thread and conversation in the window appears in the digest. Nothing is curated
  out, and the cost is size, bounded by the Digester's input budget (ADR-0021).
- A merged mail entry's id depends on which thread is earliest in the window. Two windows that
  start at different times can give the same notice different ids. Accepted: the merge is for
  reading, and threads and series, the common case, keep one id.
- The mail merge compares untrusted values. A sender who spoofs another sender's address and
  subject joins that entry, whose counts and summary then cover both threads. The sender and
  subject still leave only as labels, and no field gains a new channel.
- Two windows that share a thread give it the same id but different messages, counts and
  summaries, since each entry covers only its own window.
