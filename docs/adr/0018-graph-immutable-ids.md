# ADR 0018 — Graph immutable ids and mail thread identity

**Status:** Accepted

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
