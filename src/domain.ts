// The ubiquitous language — the shared vocabulary types every component speaks.
// One readable home for the domain nouns (CONTEXT.md is their prose definition).
// `Untrusted<T>` lives in trust.ts because it is a cross-cutting security
// primitive, not a domain noun.

import type { Untrusted } from "./trust.ts";

/** An absolute time window: two ISO-8601 instants. `to` is exclusive. */
export interface Window {
  from: string;
  to: string;
}

// ── Typed records (ADR-0019) ──
//
// What a Source emits, one record type per thing a backend holds. Free text and ids stay
// boxed as `Untrusted<T>`. Every unboxed field is a trusted value: a number, instant,
// boolean, closed enum or digest, parsed by the source and dropped (or defaulted, for a
// required enum or flag) when the parse fails.

/** An ISO-8601 instant, validated by the source as the normalizer's `instant()` does. */
export type Instant = string;

/** A 16-hex-char truncated SHA-256 of rundown-chosen inputs. Carries no backend bytes. */
export type Hash = string;

/**
 * One person as one source sees them. Per source: Ada on mail and Ada on Slack are two
 * Persons, never merged.
 */
export interface Person {
  /** Display name. The only part that may leave the binary, and only as a label. */
  name?: Untrusted<string>;
  /** Mail address or Slack user id. Never leaves the binary. */
  handle: Untrusted<string>;
  /**
   * Set by the source from the account it knows, never by the model. Graph matches
   * `handle` against the `/me` address set; Slack compares with its `auth.test` user id.
   */
  isMe: boolean;
}

/** The fields every typed record shares. */
export interface RecordBase {
  source: "graph" | "slack";
  /** Identity of this record: a digest of source, record type and backend id. */
  fingerprint: Hash;
  /**
   * Identity of the group this record belongs to: a digest of the mail `conversationId`,
   * the Slack channel id or the calendar `seriesMasterId`, domain-separated per type. A
   * record with no group id is its own group.
   */
  entryKey: Hash;
  /** The record's group started before the window. Set only where it is free to know. */
  continuesFromBefore: boolean;
}

/** One mail message from the inbox or the sent folder (Graph). */
export interface Email extends RecordBase {
  type: "email";
  source: "graph";
  /** `receivedDateTime` in the inbox, `sentDateTime` in sent. */
  at: Instant;
  folder: "inbox" | "sent";
  subject: Untrusted<string>;
  from: Person;
  /**
   * Graph's `sender`, kept only when it differs from `from`: a delegate sending for the
   * user, or the user sending on behalf of a shared mailbox.
   */
  sentBy?: Person;
  to: Person[];
  cc: Person[];
  /** The user wrote it: `from.isMe || sentBy?.isMe`. */
  byMe: boolean;
  /** `uniqueBody` as text, or `bodyPreview` without one. Summarizer input only. */
  body: Untrusted<string>;
  importance: "low" | "normal" | "high";
  isRead: boolean;
  /** `flag.flagStatus` is `flagged`. */
  flagged: boolean;
  hasAttachments: boolean;
  /** Outlook's Focused/Other sort. Unknown values read as `focused`. */
  inferenceClassification: "focused" | "other";
}

/** The Slack conversation a {@link ChatMessage} was posted in. */
export interface Conversation {
  kind: "dm" | "group_dm" | "channel";
  /** Slack Connect: the conversation is shared with another workspace. */
  isExternal: boolean;
  /** The channel name. Channels only: a DM or group DM has no honest name. */
  name?: Untrusted<string>;
  /**
   * A DM's counterpart, or a group DM's members with the user among them, read from the
   * conversation name. When the name cannot be read, the authors seen in the window
   * instead, so silent members are missing. Absent for channels.
   */
  members?: Person[];
}

/** One Slack message the user wrote, was mentioned in, or received in a DM (`search.messages`). */
export interface ChatMessage extends RecordBase {
  type: "chat-message";
  source: "slack";
  at: Instant;
  conversation: Conversation;
  /** A bot or file-only message may have no user id; its handle is then empty. */
  author: Person;
  /** The user wrote it: `author.isMe`. */
  byMe: boolean;
  /** The `mentions` query found it, or its text mentions the user's id. */
  mentionsMe: boolean;
  /** The message text with Slack's reference tokens made readable. */
  text: Untrusted<string>;
}

/** An attendee's answer to an invitation, as Graph's `responseStatus.response` spells it. */
export type EventResponse =
  | "none"
  | "organizer"
  | "tentativelyAccepted"
  | "accepted"
  | "declined"
  | "notResponded";

/** One person invited to an event, with their answer. Rooms and other resources are never attendees. */
export interface Attendee extends Person {
  response: EventResponse;
  /** Graph attendee type `optional`; `required` reads as false. */
  optional: boolean;
}

/** A calendar date, `YYYY-MM-DD`, validated by the source. */
export type CalendarDate = string;

/** One calendar event or one occurrence of a series in the window (Graph `calendarView`). */
export interface CalendarEvent extends RecordBase {
  type: "calendar-event";
  source: "graph";
  /** An all-day event's `start`/`end` are calendar dates; `end` is exclusive. */
  isAllDay: boolean;
  start: Instant | CalendarDate;
  end: Instant | CalendarDate;
  /** The series slot a moved exception was moved from. Absent on everything else. */
  originalStart?: Instant;
  title: Untrusted<string>;
  /** Free-text place: what Graph's location says beyond the room names. Absent when nothing is left. */
  location?: Untrusted<string>;
  /** Graph's organizer. An absent one is a Person with no name and an empty handle. */
  organizer: Person;
  /** The user organizes this event: Graph's `isOrganizer`. */
  isOrganizer: boolean;
  /** People only: resource attendees and attendees that are one of the event's locations go to `rooms`. */
  attendees: Attendee[];
  /** Display names of the rooms booked for the event. A room without one is not listed. */
  rooms: Untrusted<string>[];
  myResponse: EventResponse;
  showAs: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  isCancelled: boolean;
  /** The event has an online meeting. The join URL is never read. */
  isOnlineMeeting: boolean;
  /** An occurrence or exception of a series. */
  recurring: boolean;
}

/** What a Source emits, discriminated on `type`. */
export type SourceRecord = Email | CalendarEvent | ChatMessage;

/** An event bound as an instant: itself, or UTC midnight of an all-day event's date. */
export function eventBoundInstant(e: CalendarEvent, bound: Instant | CalendarDate): Instant {
  return e.isAllDay ? `${bound}T00:00:00Z` : bound;
}

/** A record's ordering instant: its own time, an event's start. */
export function instantOf(item: SourceRecord): string {
  switch (item.type) {
    case "chat-message":
    case "email":
      return item.at;
    case "calendar-event":
      return eventBoundInstant(item, item.start);
  }
}

/** One entry in the Bundle's provenance manifest — trusted scalars only. */
export interface SourceManifestEntry {
  source: string;
  itemCount: number;
}

/**
 * What the Aggregator hands the Digester (ADR-0020): the window's typed records, merged,
 * filtered to the window and ordered by each record's own instant, plus the per-source
 * manifest. Wholly untrusted (it carries record text); it flows only Aggregator → Digester
 * as a sealed in-process value, never to the agent.
 */
export interface Bundle {
  window: Window;
  sources: SourceManifestEntry[];
  records: SourceRecord[];
}
