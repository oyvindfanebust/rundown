# ADR 0019 — Typed records

**Status:** Accepted

Supersedes [ADR-0002](0002-source-abstraction.md). Decided on the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117) and specified in
[#141](https://github.com/oyvindfanebust/rundown/issues/141). Graph mail
([#147](https://github.com/oyvindfanebust/rundown/issues/147)) and Graph calendar
([#148](https://github.com/oyvindfanebust/rundown/issues/148)) are records; Slack
([#149](https://github.com/oyvindfanebust/rundown/issues/149)) follows, and this ADR grows with it.

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

type EventResponse =
  "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded";

interface Attendee extends Person {
  response: EventResponse;
  optional: boolean;          // Graph attendee type `optional`
}

interface CalendarEvent extends RecordBase {
  type: "calendar-event"; source: "graph";
  isAllDay: boolean;
  start: Instant | CalendarDate; // YYYY-MM-DD when isAllDay
  end: Instant | CalendarDate;   // exclusive
  originalStart?: Instant;    // only on a moved exception
  title: Untrusted<string>;
  location?: Untrusted<string>; // what it says beyond the room names
  organizer: Person;
  isOrganizer: boolean;
  attendees: Attendee[];      // people only
  rooms: Untrusted<string>[]; // display names only
  myResponse: EventResponse;
  showAs: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  isCancelled: boolean;
  isOnlineMeeting: boolean;   // the flag; the join URL is never read
  recurring: boolean;         // an occurrence or exception of a series
}
```

`Person` is per source. Ada on mail and Ada on Slack are two Persons; there is no cross-source
merge. `fingerprint` and `entryKey` are 16-hex-char truncated SHA-256 digests in the ADR-0016
scheme, domain-separated by record type (`email`, `email-thread`, `event`, `event-series`), so a
group key never equals a record key and no backend bytes survive into either. A record whose group
id is missing is its own group.

### 4. Graph

Identity:

- One `/me` call per run, shared by calendar and mail, with
  `$select=id,mail,userPrincipalName,proxyAddresses`, under the existing `User.Read`. The "me" set
  is `mail`, the UPN and every `smtp:` or `SMTP:` proxy address with the prefix stripped, compared
  case-insensitively. Other prefixes (`X500:`, `SIP:`, …) are skipped.
- `isMe` is set on every `Person` by matching `handle` against that set.

Mail:

- `sentBy` is kept only when Graph's `sender` differs from `from`, compared case-insensitively. A
  delegate sending for the user has `from` as the user; the user sending on behalf of a shared
  mailbox has `sentBy` as the user. Both make `byMe` true.
- `importance`, `isRead`, `hasAttachments`, `flag.flagStatus` and `inferenceClassification` come
  from the message list (standard properties under `Mail.Read`) and are parsed per §2.
- `entryKey` digests `conversationId`. `continuesFromBefore` is set when the message's
  `conversationIndex` is longer than its 22-byte header, which means the thread started before
  this message.
- `body` is `bodyPreview`.

Calendar:

- `calendarView` over the window, with standard properties under `Calendars.Read`.
- `attendees` are people only. `rooms` holds attendees of Graph type `resource` plus attendees
  whose address matches one of the event's `locations[].locationEmailAddress`, compared
  case-insensitively, since a room booked from the room finder is often listed as a required
  attendee. A room is listed once by its display name and never appears among `attendees`; a room
  without a display name is not listed.
- `location` is what Graph's `location.displayName` says beyond the room names. Outlook writes a
  multi-room location as the names joined by `; `, so the source splits it on `;`, drops blank
  parts and parts that name a room (ignoring case and surrounding space), and joins the rest with
  `; `. When nothing is left, `location` is absent.
- An absent organizer is a `Person` with no name and an empty handle, as an absent mail `from` is.
- `myResponse` and each attendee's `response` parse Graph's response enum and fall back to
  `none`; `showAs` falls back to `unknown`; `isOrganizer`, `isCancelled` and `isOnlineMeeting`
  are true only when Graph says `true`. `onlineMeeting`, its join URL and `webLink` are not
  selected.
- `recurring` is set for an `occurrence` or `exception`. `originalStart` is kept only on an
  `exception` whose `originalStart` differs from its start, which is a moved one. An all-day
  exception's `originalStart` is the series' local midnight, so it is compared by date.
- An all-day event's `start` and `end` are the `YYYY-MM-DD` dates of its midnight bounds; a timed
  one's are UTC instants. A bound that does not parse fails the read.
- `entryKey` digests `seriesMasterId`, or the event's own id for a one-off. `continuesFromBefore`
  is set when the event starts before the window; an all-day event's start date is compared with
  the window's first day.
- Sources do no timezone handling, so the date of a local midnight (the window's start, an
  all-day `originalStart`) is read by shifting the instant 13 hours east. That names the right
  day for every zone from UTC−10 to UTC+13.
- `fingerprint` digests `event`, the old NormalizedItem kind, not the record type
  `calendar-event`, so calendar fingerprints do not change.

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
- Until the Digester lands, the Planner keeps a mapping from `Email` and `CalendarEvent` to the old
  item fields. The Brief's mail evidence keeps `source: "graph/message"`, `where`, `who` and
  `fingerprint`; calendar evidence keeps `source: "graph/event"`, `who` and `fingerprint`.
- The Brief prompt changes slightly for calendar: the `url` and `categories` lines go, a `rooms`
  line joins, and the `location` line keeps only what the location says beyond the room names.
  `showAs` and `myResponse` render their parsed values.
- The Brief prompt changes slightly for mail: the `url` line goes, since records carry no URL, and
  previews keep up to 255 chars instead of 200. The prompt's structure is unchanged.
