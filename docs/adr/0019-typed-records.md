# ADR 0019 — Typed records

**Status:** Accepted

Supersedes [ADR-0002](0002-source-abstraction.md). Decided on the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117) and specified in
[#141](https://github.com/oyvindfanebust/rundown/issues/141). Graph mail
([#147](https://github.com/oyvindfanebust/rundown/issues/147)) and Graph calendar
([#148](https://github.com/oyvindfanebust/rundown/issues/148)) and Slack
([#149](https://github.com/oyvindfanebust/rundown/issues/149)) are records.

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

While sources moved one at a time, the Aggregator carried a temporary `NormalizedItem |
SourceRecord` union. With Slack on records
([#149](https://github.com/oyvindfanebust/rundown/issues/149)) every source emits records, so the
union and `NormalizedItem` are gone: the Aggregator orders records by each one's own instant, and
the Planner mapped a record onto the fields it rendered before, so the Brief kept its shape. The
mapping went with the Planner when the Digester replaced it
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
scheme, domain-separated by type: a `fingerprint` under its record type (`email`,
`calendar-event`, `chat-message`) and an `entryKey` under its group type (`email-thread`,
`event-series`, `chat-conversation`), so a group key never equals a record key and no backend
bytes survive into either. A record whose group
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
- `fingerprint` digests the record type `calendar-event`. It digested `event`, the old
  NormalizedItem kind, until [#150](https://github.com/oyvindfanebust/rundown/issues/150): its
  stability mattered only for Brief evidence, which is gone.

### 5. Slack

```ts
interface ChatMessage extends RecordBase {
  type: "chat-message"; source: "slack";
  at: Instant;
  conversation: {
    kind: "dm" | "group_dm" | "channel";
    isExternal: boolean;      // Slack Connect: `is_ext_shared`
    name?: Untrusted<string>; // channels only
    members?: Person[];       // DM counterpart or group-DM members, from the conversation name
  };
  author: Person;
  byMe: boolean;              // author.isMe
  mentionsMe: boolean;
  text: Untrusted<string>;
}
```

- One record per `search.messages` match in the window, over the `from:<@me>`, `<@me>` and
  `is:dm` queries, deduplicated by channel id and `ts`. Every page is read: the first call passes
  `cursor=*` and the source follows `messages.paging.next_cursor` until it is empty
  ([#132](https://github.com/oyvindfanebust/rundown/issues/132)).
- `isMe` and `byMe` compare the author's user id with the signed-in user id cached at login (the
  OAuth exchange's `authed_user.id`, the id `auth.test` reports).
  `mentionsMe` is set when the `<@me>` query found the message or its text carries a mention
  token for that id.
- `members`: a DM's counterpart is the IM's `channel.name` when it is shaped like a user id. A
  group DM's members, the user among them, come from its `mpdm-<handle>--<handle>--…-<n>` name,
  mapped to user ids and names through `users.list`, fetched once per read and only when a group
  DM is read. A name that does not parse, or a handle `users.list` does not know, falls back to
  the authors seen in that conversation in the window, without the user for a DM. There is no marker for the fallback; the
  digest schema documents it. No `conversations.*` call is made and no scope is added
  ([ADR-0014](0014-slack-source.md) amendment for #149).
- `text` is the message text with Slack's reference tokens made readable, as before. File-only,
  blocks-only and bot messages are kept; a bot has an empty `handle` and its `username` as name.
- Thread membership is not read: search matches carry no `thread_ts`. The spec's `inThread` flag is
  therefore not on the record, and `continuesFromBefore` is always false, since earlier messages
  are not fetched.
- `entryKey` digests the channel id under the type `chat-conversation`. `fingerprint` digests
  channel id and `ts` under the record type `chat-message`. It digested `message`, the old
  NormalizedItem kind, until [#150](https://github.com/oyvindfanebust/rundown/issues/150), for the
  same reason as calendar. The permalink is not kept.

### 6. Kept from ADR-0002

- Sources are read-only adapters, one per backend and auth boundary, registered in the one binary.
- `read` takes one absolute window; sources do no timezone handling.
- `status()` and `login()` are required, as ADR-0002 amended them.
- The normalizer (`sources/normalize.ts`) stays the only `trust.ts` importer among sources: it
  brands, truncates and validates records. Its free-text cap
  (`TEXT_MAX`) rises from 200 to 255, so a subject of Outlook's full length survives to the label
  clamp. A mail body and a chat message's text keep up to 2,000 chars (`BODY_MAX`), the most the
  Digester renders per message ([ADR-0021](0021-the-digest.md)).

## Consequences

- Code can read facts about a record without a model and without unwrapping: who wrote it, whether
  it is the user's, which group it belongs to.
- Graph mail fingerprints change once: they now digest the record type `email` instead of the
  `message` kind. Releases are held from this change until the live hostile-input evals land
  ([#141](https://github.com/oyvindfanebust/rundown/issues/141)), so no released Brief carries both.
- Until the Digester landed, the Planner kept a mapping from each record type to the old item
  fields, so the Brief and its evidence kept their shape. The mapping went with the Planner in
  [#150](https://github.com/oyvindfanebust/rundown/issues/150).
- The Brief prompt changes slightly for calendar: the `url` and `categories` lines go, a `rooms`
  line joins, and the `location` line keeps only what the location says beyond the room names.
  `showAs` and `myResponse` render their parsed values.
- The Brief prompt changes slightly for mail: the `url` line goes, since records carry no URL, and
  previews keep up to 255 chars instead of 200. The prompt's structure is unchanged.
- The Brief prompt changes slightly for Slack: the `url` line and the query-family `relationship`
  extra go, the `channel` extra carries the conversation's `entryKey` digest in place of the
  channel id and `channel` in place of `public` or `private`, and an `external` line marks a
  Slack Connect conversation.
- With `dms` on by default and every search page read, a week's Slack bundle grows from at most
  100 matches per query to every match.
