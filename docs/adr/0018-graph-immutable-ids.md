# ADR 0018 — Graph immutable ids and mail thread identity

**Status:** Accepted

**Amendment (digest, [#117](https://github.com/oyvindfanebust/rundown/issues/117)).** Graph mail
is now typed `Email` records ([#147](https://github.com/oyvindfanebust/rundown/issues/147),
[ADR-0019](0019-typed-records.md)).

- §1 stands: immutable ids keep a record's `fingerprint` stable across folder moves.
- §3's thread identity now feeds the mail entry: `conversationId` is digested into the record's
  `entryKey` under the `email-thread` namespace, which the Digester groups by
  ([#150](https://github.com/oyvindfanebust/rundown/issues/150)). It no longer rides the normalizer's
  `seriesId` slot.
- Suppression was removed in [#145](https://github.com/oyvindfanebust/rundown/issues/145)
  ([ADR-0017](0017-suppression-rules.md) retired), so every consequence below that concerns
  `series` rules, `seriesFingerprint` or the `suppress` debug event is void, and so is §3's
  `message-series` namespace.
- §2's fingerprint consequences are void. Evidence fingerprints go with the Brief, and the digest
  identifies an entry by a digest of its group id instead. Meanwhile a mail record's `fingerprint`
  digests the record type `email` rather than the `message` kind, so Brief mail fingerprints change
  from this change; releases are held until the digest ships, so no consumer sees it.
- `graphGet`, the request function §1 adds the header to, now retries a 429, 503 or 504 up to
  three times ([#141](https://github.com/oyvindfanebust/rundown/issues/141)). One run makes up to
  three concurrent requests to the mailbox (`/me`, Inbox, SentItems) and Outlook allows four, so
  two runs at once were throttled and failed. The wait is the `Retry-After` header, as whole
  seconds or an HTTP-date, else 1, 2 and 4 seconds, and never more than 60 seconds. Each attempt
  emits its own `http` debug event, as Slack's `slackApi` does, and no new event kind is added
  ([ADR-0015](0015-debug-logging.md)). A response that outlasts the retries fails as any other
  non-2xx does, with only its status (`Graph request failed: 429`, ADR-0004 §5). Slack keeps its
  own 429-only policy (ADR-0014); the two transports share the status-only error, not the retry.

This ADR switches the Graph source to immutable backend ids and gives mail items thread
identity (#111), the follow-up [ADR-0016](0016-evidence-fingerprint.md) recorded. It changes
what the normalizer digests, not how: the fingerprint scheme, the trust boundary
([ADR-0004](0004-trust-boundary-enforcement.md)), and the suppression mechanics
([ADR-0017](0017-suppression-rules.md)) are all unchanged.

## Context

Evidence fingerprints inherit the stability of the backend id (ADR-0016 §2). Graph's default
ids are store-relative: moving a message between folders (inbox → archive) issues a new id, so
the moved message re-fingerprints and defeats cross-window dedup — the accepted gap ADR-0016
tracked here.

Separately, id-level fingerprints cannot group a mail thread: a weekend thread is several
messages, each with its own id and fingerprint, and nothing in the Brief says they belong
together. Graph exposes `conversationId` for exactly that, but the source does not select it.

## Decision

### 1. Request immutable ids on every Graph call

The single bearer-fetch pipe (`graphGet`) adds `IdType="ImmutableId"` to its existing `Prefer`
header. Graph then returns ids that survive folder moves for every Outlook resource, so a mail
item keeps one fingerprint for its lifetime. Event ids ride along and become immutable too;
they were already stable, so nothing is lost.

### 2. One deliberate id rotation, shipped as a breaking change

Immutable ids are a different encoding of the same objects, so every existing Graph
`fingerprint` and `seriesFingerprint` changes once when this lands. The release is a
`feat!` with a `BREAKING CHANGE` note naming both halves of the blast radius:

- Consumer dedup state self-heals: an old fingerprint simply never matches again, so at worst
  an already-seen item surfaces once more in the next Brief.
- Config `series` rules do not self-heal — the obligation ADR-0017 recorded on this issue. A
  stale rule matches nothing and silently un-suppresses its series. The fix is one-time and
  manual: re-copy the `seriesFingerprint` from a fresh Brief's evidence. The zero-count
  `suppress` debug events (ADR-0015) are the detection signal.

Bridging old ids in code was rejected: `translateExchangeIds` would add a POST to the sealed
pipeline and carry both id encodings forever, permanent complexity for a one-time event.

### 3. Mail threads reuse the group-identity slot

Mail's `$select` gains `conversationId`, and the source hands it to the normalizer as the
item's `seriesId` — the same slot calendar occurrences use for `seriesMasterId`. A thread is
the same shape as a recurring series: several items, one group, and per-item fingerprints that
cannot name it. Reusing `seriesFingerprint` means no new contract field, no new
`resolveEvidence` copy, and `series` suppression rules mute a noisy mail thread with no new
rule vocabulary.

The normalizer's group-digest namespace becomes kind-derived: `SHA-256(source + "\n" + kind +
"-series" + "\n" + raw group id)`. Events keep the byte-identical `event-series` component, so
this refactor alone rotates nothing; messages digest under `message-series`, so a thread digest
can never collide with a calendar-series digest of the same raw id.

`conversationId` is stable across folder moves and unaffected by the `IdType` preference, so
thread identity is durable from the first release that carries it.

### 4. Invisible to the model

Ids, `conversationId`, and every digest stay out of the rendered bundle; the prompt is
byte-identical to before. This change does not trigger the ADR-0012 eval gate.

## Consequences

- A mail item cited in two Briefs matches by fingerprint even if the user archived it in
  between — the ADR-0016 stability table loses its one exception.
- Consumers can group a thread's evidence entries by `seriesFingerprint` and suppress a thread
  by copying it into a `series` rule; README and the contract docs say so.
- Anyone holding pre-rotation Graph fingerprints reconciles once, per §2. Sources other than
  Graph are untouched.
- `seriesFingerprint` now means "recurring group", not only "calendar series"; the field name
  is kept because renaming it would be a second, gratuitous contract break.
