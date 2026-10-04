// The normalizer: the record builders every Source hands its parsed fields to
// (ADR-0019 §6). It owns branding (every free-text field and id boxed Untrusted),
// marked truncation of free text, the digests (`fingerprint`, `entryKey`), and
// validating the structural instants, the one check that can throw: a non-ISO instant
// is backend garbage and fails hard here (ADR-0007 §6) rather than sliding through as a
// trusted string. No I/O. It is the sole trust.ts importer among sources and the only
// way a Source constructs a record. Domain judgment (parsing enums and flags, group
// membership) stays at call sites. Never unwrapped here (the read sites are the
// Digester and label(); ADR-0022).

import { createHash } from "node:crypto";
import type { Attendee, CalendarEvent, ChatMessage, Conversation, Email, Person } from "../domain.ts";
import { clamp, ELLIPSIS, TRUNCATION_MARKER } from "../sanitize.ts";
import { untrusted, untrustedOpt } from "../trust.ts";

// The normalizer marks its own cuts. Its caps equal the downstream ones (TEXT_MAX is
// label.ts's TITLE_MAX, BODY_MAX is the Digester's MESSAGE_TEXT_MAX), so a downstream cap
// never sees text over its limit and cannot add a mark itself. A margin would not fix that:
// the Digester and label() collapse whitespace first, which can pull a cut text back under
// the cap. So a cut here ends in "…" (free text) or "…[truncated]" (bodies), the cut text
// including the mark stays within the cap, and the mark survives both downstream steps
// (it has no whitespace, and a downstream re-cut adds its own). The constants may then
// coincide or differ freely; any cut, here or downstream, stays visible (#141).

/**
 * Max length for a free-text field (title / subject / name / …). 255 so a subject of
 * Outlook's full length survives to the label clamp (#141).
 */
export const TEXT_MAX = 255;

/**
 * Max length for a message body or chat text. The Digester renders each message up to
 * 2,000 chars for the Summarizer (ADR-0021), so a body keeps that much.
 */
export const BODY_MAX = 2_000;

/**
 * The free-text marker (grilled design): truncate to `max` (default {@link TEXT_MAX}),
 * ending in `mark` when cut, and let absence collapse — `""`/`null`/`undefined` →
 * `undefined`, so compaction can treat presence as signal. Pass `mark = ""` for an
 * identifier that must not change shape.
 */
export function text(v: string | null | undefined, max = TEXT_MAX, mark = ELLIPSIS): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  return clamp(v, max, mark);
}

/**
 * Strict ISO-8601 instant shape: `YYYY-MM-DDTHH:mm` with optional
 * `:ss` (optional `.fraction`, any digit count) and an optional `Z` or numeric
 * `±HH:mm`/`±HHmm` offset. Chosen by inspecting what the real sources
 * hand the normalizer: Graph calendar's `dateTime` is pre-normalized to
 * `Z` (fraction stripped, offset-less values stamped `Z`) before it ever
 * reaches here; Graph mail's `receivedDateTime`/`sentDateTime` are
 * `Z`-suffixed, with 0 or 3-digit fractions. None of today's shapes carry a bare numeric offset or omit the
 * trailing `Z`/offset, but the grammar still accepts one, since that is still
 * strictly ISO-8601 and a plain engine-parseable string like `"July 1 2026"`
 * or an RFC-2822 date is not.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The structural-instant guard. `timestamp`/`end`
 * reach the normalizer as *verbatim backend strings* (Graph
 * `receivedDateTime`, a Slack `ts`-derived instant, …), yet they
 * are typed **trusted** and so bypass the `Untrusted<T>` unwrap tripwire. Left
 * unchecked they could carry NaN, which would misorder or misfilter records
 * downstream (ADR-0020), or arbitrary backend bytes with no type-level warning. A
 * shape check against {@link ISO_INSTANT} plus a `Date.parse` round-trip (for
 * semantic validity, e.g. rejecting month 13) constrains them to real
 * ISO-8601 instants here, the one place every source funnels through, making
 * ADR-0002 §5's "produced/constrained by rundown's own source module" true —
 * and true to the letter: `Date.parse` alone is engine-lenient (accepts
 * `"July 1 2026"`, RFC-2822, …), which the shape check now closes. Garbage
 * fails hard (ADR-0007 §6). The raw value is **never** echoed into the error:
 * it is backend-controlled, so it stays out of the error channel (CLAUDE.md).
 */
function instant(v: string, field: string, source: string): string {
  if (!ISO_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(
      `Source "${source}" emitted a structural ${field} that is not a strict ISO-8601 instant.`,
    );
  }
  return v;
}

/**
 * Stable identity: a truncated SHA-256 of `source + type + raw backend id`. A one-way
 * digest of the untrusted id, computed here before branding, so the value is a trusted
 * scalar carrying no backend bytes. 16 hex chars (64 bits) is collision-safe at this
 * scale. Keyed on identity only, never time: a rescheduled item keeps its digest. The
 * group digests (`entryKey`) become the digest's entry ids (ADR-0020).
 */
function fingerprintOf(source: string, kind: string, rawId: string): string {
  return createHash("sha256").update(`${source}\n${kind}\n${rawId}`).digest("hex").slice(0, 16);
}

// ── Typed records (ADR-0019) ──
//
// The record builders. A source parses its trusted values (enums, flags,
// group membership) itself, since those are domain judgments about its backend, and
// hands the builder bare strings for everything that stays boxed.

/** One person as the source read them: bare name and handle, and the source's `isMe` answer. */
export interface PersonSpec {
  name?: string | null;
  /** Mail address or Slack user id. */
  handle?: string | null;
  isMe: boolean;
}

/**
 * Brand one person. Name and handle are free text, truncated like every other; an absent
 * handle boxes as "" so every Person has one.
 */
export function person(spec: PersonSpec): Person {
  return {
    name: untrustedOpt(text(spec.name)),
    // A handle is a dedup key, never shown: cut without a mark.
    handle: untrusted(text(spec.handle, TEXT_MAX, "") ?? ""),
    isMe: spec.isMe,
  };
}

/** The fields one mail message hands the builder: parsed trusted values plus bare text. */
export interface EmailSpec {
  /** Backend message id; digested into `fingerprint`, never kept. */
  id: string | null | undefined;
  /** Backend thread id (`conversationId`); digested into `entryKey`. Absent → the message is its own group. */
  groupId?: string | null;
  continuesFromBefore: boolean;
  at: string;
  folder: Email["folder"];
  subject: string | null | undefined;
  from: PersonSpec;
  sentBy?: PersonSpec;
  to: PersonSpec[];
  cc: PersonSpec[];
  body: string | null | undefined;
  importance: Email["importance"];
  isRead: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  inferenceClassification: Email["inferenceClassification"];
}

/**
 * Build one {@link Email}. `at` must be a strict ISO-8601 instant and `id` must be
 * present; either failing is backend garbage and fails hard (ADR-0007 §6), without
 * echoing the value. `byMe` is derived here so it always agrees with `from` and `sentBy`.
 */
export function emailRecord(spec: EmailSpec): Email {
  const source = "graph";
  const rawId = String(spec.id ?? "");
  if (rawId === "") throw new Error(`Source "${source}" emitted an email with no id.`);
  const from = person(spec.from);
  const sentBy = spec.sentBy === undefined ? undefined : person(spec.sentBy);
  const record: Email = {
    type: "email",
    source,
    fingerprint: fingerprintOf(source, "email", rawId),
    // Domain-separated from the record digest, so a thread key never equals a message key.
    entryKey: fingerprintOf(source, "email-thread", spec.groupId || rawId),
    continuesFromBefore: spec.continuesFromBefore,
    at: instant(spec.at, "email time", source),
    folder: spec.folder,
    subject: untrusted(text(spec.subject) ?? "(no subject)"),
    from,
    to: spec.to.map(person),
    cc: spec.cc.map(person),
    byMe: from.isMe || sentBy?.isMe === true,
    body: untrusted(text(spec.body, BODY_MAX, TRUNCATION_MARKER) ?? ""),
    importance: spec.importance,
    isRead: spec.isRead,
    flagged: spec.flagged,
    hasAttachments: spec.hasAttachments,
    inferenceClassification: spec.inferenceClassification,
  };
  if (sentBy !== undefined) record.sentBy = sentBy;
  return record;
}

/** The fields one Slack message hands the builder: parsed trusted values plus bare text. */
export interface ChatMessageSpec {
  /** Backend channel id; digested into `entryKey`, and with `ts` into `fingerprint`. Never kept. */
  channelId: string;
  /** Slack's message `ts`, the message id within its channel. Never kept. */
  ts: string;
  at: string;
  conversation: {
    kind: Conversation["kind"];
    isExternal: boolean;
    name?: string | null;
    members?: PersonSpec[];
  };
  author: PersonSpec;
  mentionsMe: boolean;
  text: string | null | undefined;
}

/**
 * Build one {@link ChatMessage}. `at` must be a strict ISO-8601 instant and the channel
 * id and `ts` must be present; anything else is backend garbage and fails hard (ADR-0007
 * §6), without echoing the value. `byMe` is derived here so it always agrees with
 * `author`. The conversation name is kept for channels only.
 */
export function chatMessageRecord(spec: ChatMessageSpec): ChatMessage {
  const source = "slack";
  if (spec.channelId === "" || spec.ts === "") throw new Error(`Source "${source}" emitted a message with no id.`);
  const author = person(spec.author);
  const { kind, isExternal, name, members } = spec.conversation;
  const conversation: Conversation = { kind, isExternal };
  const label = kind === "channel" ? text(name) : undefined;
  if (label !== undefined) conversation.name = untrusted(label);
  if (members !== undefined) conversation.members = members.map(person);
  return {
    type: "chat-message",
    source,
    fingerprint: fingerprintOf(source, "chat-message", `${spec.channelId}:${spec.ts}`),
    // Domain-separated from the record digest, so a conversation key never equals a message key.
    entryKey: fingerprintOf(source, "chat-conversation", spec.channelId),
    // Earlier messages in a conversation are not fetched, so it is never known to be free.
    continuesFromBefore: false,
    at: instant(spec.at, "message time", source),
    conversation,
    author,
    byMe: author.isMe,
    mentionsMe: spec.mentionsMe,
    text: untrusted(text(spec.text, BODY_MAX, TRUNCATION_MARKER) ?? ""),
  };
}

/** One attendee as the source read them: a person spec plus the parsed answer and role. */
export interface AttendeeSpec extends PersonSpec {
  response: Attendee["response"];
  optional: boolean;
}

/** The fields one calendar event hands the builder: parsed trusted values plus bare text. */
export interface CalendarEventSpec {
  /** Backend event id; digested into `fingerprint`, never kept. */
  id: string | null | undefined;
  /** Backend series id (`seriesMasterId`); digested into `entryKey`. Absent → the event is its own group. */
  groupId?: string | null;
  continuesFromBefore: boolean;
  isAllDay: boolean;
  /** An ISO instant, or a `YYYY-MM-DD` date when `isAllDay`. */
  start: string;
  end: string;
  originalStart?: string;
  title: string | null | undefined;
  /** Free-text place, with the room names already taken out by the source. */
  location?: string | null;
  organizer: PersonSpec;
  isOrganizer: boolean;
  attendees: AttendeeSpec[];
  /** Room display names. */
  rooms: Array<string | null | undefined>;
  myResponse: CalendarEvent["myResponse"];
  showAs: CalendarEvent["showAs"];
  isCancelled: boolean;
  isOnlineMeeting: boolean;
  recurring: boolean;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar-date guard: `YYYY-MM-DD` that names a real day. Garbage fails hard, unechoed. */
function calendarDate(v: string, field: string, source: string): string {
  if (!CALENDAR_DATE.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) {
    throw new Error(`Source "${source}" emitted a structural ${field} that is not a YYYY-MM-DD date.`);
  }
  return v;
}

/**
 * Build one {@link CalendarEvent}. `start`/`end` must be strict ISO-8601 instants, or
 * `YYYY-MM-DD` dates for an all-day event, and `id` must be present; anything else is
 * backend garbage and fails hard (ADR-0007 §6), without echoing the value. Rooms with
 * no label are dropped.
 */
export function calendarEventRecord(spec: CalendarEventSpec): CalendarEvent {
  const source = "graph";
  const rawId = String(spec.id ?? "");
  if (rawId === "") throw new Error(`Source "${source}" emitted an event with no id.`);
  const parseBound = (v: string, field: string) =>
    spec.isAllDay ? calendarDate(v, field, source) : instant(v, field, source);
  const rooms: string[] = [];
  for (const raw of spec.rooms) {
    const label = text(raw);
    if (label !== undefined && !rooms.includes(label)) rooms.push(label);
  }
  const record: CalendarEvent = {
    type: "calendar-event",
    source,
    fingerprint: fingerprintOf(source, "calendar-event", rawId),
    // Domain-separated from the record digest, so a series key never equals an event key.
    entryKey: fingerprintOf(source, "event-series", spec.groupId || rawId),
    continuesFromBefore: spec.continuesFromBefore,
    isAllDay: spec.isAllDay,
    start: parseBound(spec.start, "event start"),
    end: parseBound(spec.end, "event end"),
    title: untrusted(text(spec.title) ?? "(no subject)"),
    organizer: person(spec.organizer),
    isOrganizer: spec.isOrganizer,
    attendees: spec.attendees.map((a) => ({ ...person(a), response: a.response, optional: a.optional })),
    rooms: rooms.map((r) => untrusted(r)),
    myResponse: spec.myResponse,
    showAs: spec.showAs,
    isCancelled: spec.isCancelled,
    isOnlineMeeting: spec.isOnlineMeeting,
    recurring: spec.recurring,
  };
  const location = text(spec.location);
  if (location !== undefined) record.location = untrusted(location);
  if (spec.originalStart !== undefined) record.originalStart = instant(spec.originalStart, "event original start", source);
  return record;
}
