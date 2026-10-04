# ADR 0019 — Typed records

**Status:** Accepted

Supersedes [ADR-0002](0002-source-abstraction.md). Decided on the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117) and specified in
[#141](https://github.com/oyvindfanebust/rundown/issues/141). Graph mail is the first record type
([#147](https://github.com/oyvindfanebust/rundown/issues/147)); Graph calendar
([#148](https://github.com/oyvindfanebust/rundown/issues/148)) and Slack
([#149](https://github.com/oyvindfanebust/rundown/issues/149)) follow, and this ADR grows with them.

## Context

Every source flattens what it reads into one `NormalizedItem`: a thin trusted core (`source`,
`kind`, `timestamp`, `end`) and untrusted `title`, `url`, `attribution` and an `extras` bag. The
shape served a Planner that handed everything to the model. It does not serve code that has to
know facts about an item: whether the user wrote a message, who the other people in a thread are,
which mail thread or calendar series an item belongs to, or whether a field can be trusted. Those
facts sit in free-form `extras` keys and caption strings, and the trust boundary rests on a fixed
list of trusted fields rather than a rule.

The digest ([#141](https://github.com/oyvindfanebust/rundown/issues/141)) groups items into entries
and copies facts into them by code, so it needs those facts typed.

## Decision

### 1. A Source returns typed records

The Source contract becomes `read(window) → Record[]` over a discriminated union, one record type
per thing a backend holds: `Email` (Graph mail), `CalendarEvent` (Graph calendar) and `ChatMessage`
(Slack). `NormalizedItem`, `attribution`, `extras`, `title`, `url`, `relationship` and the string
`kind` go once every source emits records. In code the union is `SourceRecord`, since `Record` is a
TypeScript built-in.

Until then the Aggregator carries `NormalizedItem | SourceRecord` (`BundleItem` in
`src/domain.ts`), orders it by each item's own instant, and the Planner maps a record onto the
fields it rendered before, so the Brief keeps its shape. The union goes when Slack moves to records
([#149](https://github.com/oyvindfanebust/rundown/issues/149)) and the Planner with the Digester
([#150](https://github.com/oyvindfanebust/rundown/issues/150)).

### 2. Trust follows type

- Free text and ids stay boxed as `Untrusted<T>`: subjects, bodies, display names, addresses and
  Slack user ids.
- Every unboxed field is a trusted value: a number, instant, boolean, closed enum or digest. The
  source parses it from the backend's bytes and drops it when the parse fails. A required enum or
  flag falls back to its no-signal value instead: `normal` importance, read, not flagged, no
  attachments, `focused`. An instant that does not parse fails the read, as the normalizer's
  instant check always has.

A trusted value is trusted because of its type, whoever set it. A sender-set importance counts; a
string never does, even one from the user's own account.

### 3. The shared shapes

```ts
interface Person {
  name?: Untrusted<string>;   // display name; leaves only as a label
  handle: Untrusted<string>;  // address or Slack user id; never leaves
  isMe: boolean;              // set by the source, never by the model
}

interface RecordBase {
  source: "graph" | "slack";
  fingerprint: Digest;        // this record: digest of source + type + backend id
  entryKey: Digest;           // its group: conversationId, channel id, seriesMasterId, or own id
  continuesFromBefore: boolean; // set only where free
}

interface Email extends RecordBase {
  type: "email"; source: "graph";
  at: Instant; folder: "inbox" | "sent";
  subject: Untrusted<string>;
  from: Person;
  sentBy?: Person;            // Graph `sender`, only when it differs from `from`
  to: Person[]; cc: Person[];
  byMe: boolean;              // from.isMe || sentBy?.isMe
  body: Untrusted<string>;    // Summarizer input only
  importance: "low" | "normal" | "high";
  isRead: boolean; flagged: boolean; hasAttachments: boolean;
  inferenceClassification: "focused" | "other";
}
```

`Person` is per source. Ada on mail and Ada on Slack are two Persons; there is no cross-source
merge. `fingerprint` and `entryKey` are 16-hex-char truncated SHA-256 digests in the ADR-0016
scheme, domain-separated by record type (`email`, `email-thread`), so a thread key never equals a
message key and no backend bytes survive into either. A record whose group id is missing is its own
group.

### 4. Graph

Mail:

- One `/me` call per run that reads mail, with `$select=id,mail,userPrincipalName,proxyAddresses`,
  under the existing `User.Read`. The "me" set is `mail`, the UPN and every `smtp:` or `SMTP:` proxy
  address with the prefix stripped, compared case-insensitively. Other prefixes (`X500:`, `SIP:`, …)
  are skipped. A calendar-only read makes no `/me` call.
- `isMe` is set on every `Person` by matching `handle` against that set.
- `sentBy` is kept only when Graph's `sender` differs from `from`, compared case-insensitively. A
  delegate sending for the user has `from` as the user; the user sending on behalf of a shared
  mailbox has `sentBy` as the user. Both make `byMe` true.
- `importance`, `isRead`, `hasAttachments`, `flag.flagStatus` and `inferenceClassification` come
  from the message list (standard properties under `Mail.Read`) and are parsed per §2.
- `entryKey` digests `conversationId`. `continuesFromBefore` is set when the message's
  `conversationIndex` is longer than its 22-byte header, which means the thread started before
  this message.
- `body` is `bodyPreview`.

The calendar half of this section lands with
[#148](https://github.com/oyvindfanebust/rundown/issues/148).

### 5. Kept from ADR-0002

- Sources are read-only adapters, one per backend and auth boundary, registered in the one binary.
- `read` takes one absolute window; sources do no timezone handling.
- `status()` and `login()` are required, as ADR-0002 amended them.
- The normalizer (`sources/normalize.ts`) stays the only `trust.ts` importer among sources: it
  brands, truncates and validates records as it does NormalizedItems. Its free-text cap
  (`TEXT_MAX`) rises from 200 to 255, so a subject of Outlook's full length survives to the label
  clamp.

## Consequences

- Code can read facts about a record without a model and without unwrapping: who wrote it, whether
  it is the user's, which group it belongs to.
- Graph mail fingerprints change once: they now digest the record type `email` instead of the
  `message` kind. Releases are held from this change until the live hostile-input evals land
  ([#141](https://github.com/oyvindfanebust/rundown/issues/141)), so no released Brief carries both.
- Until the Digester lands, the Planner keeps a mapping from `Email` to the old item fields. The
  Brief's mail evidence keeps `source: "graph/message"`, `where`, `who` and `fingerprint`.
- The Brief prompt changes slightly for mail: the `url` line goes, since records carry no URL, and
  previews keep up to 255 chars instead of 200. The prompt's structure is unchanged.
