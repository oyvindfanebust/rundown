// PROTOTYPE (map #117, ticket #122). Throwaway: not imported by src/, delete once the
// spec is written. The typed records a Source emits in place of NormalizedItem.
//
// What stays inside the binary is boxed `Untrusted<T>` as today. Everything unboxed is
// a trusted value (#121): a number, date, boolean, closed enum or digest, parsed by the
// source and dropped when the parse fails. `attribution`, `extras`, `title`, `url` and
// `kind: string` are gone.

import type { Untrusted } from "../../src/trust.ts";

/** ISO-8601 instant with offset. Validated by the source, as `instant()` does today. */
export type Instant = string;

/** A 16-hex-char truncated SHA-256 (ADR-0016 scheme). Carries no backend bytes. */
export type Digest = string;

/**
 * One person as one source sees them. Per source: Ada on mail and Ada on Slack are two
 * Persons (merging them is out of scope on the map).
 */
export interface Person {
  /** Display name. The only part that can leave the binary, and only as a label. */
  name?: Untrusted<string>;
  /**
   * Mail address or Slack user id. Never leaves the binary. Used to set `isMe`, to
   * dedup people within an entry, and by suppression rules.
   */
  handle: Untrusted<string>;
  /**
   * Set by the source, never by the model (#118): Graph matches `handle` against
   * `/me` mail, UPN and `smtp:` proxyAddresses; Slack compares with the cached
   * `auth.test` user id.
   */
  isMe: boolean;
}

interface RecordBase {
  source: "graph" | "slack";
  /** Identity of this one record: digest of source + type + backend id. */
  fingerprint: Digest;
  /**
   * Identity of the digest entry this record groups into (#120): digest of the mail
   * `conversationId`, the Slack channel id, or the calendar `seriesMasterId`. A one-off
   * event uses its own id, so `entryKey` and `fingerprint` coincide only there.
   */
  entryKey: Digest;
  /**
   * The record belongs to something that started before the window (#120). Set only
   * where it is free: mail `conversationIndex` longer than its 22-byte header, a Slack
   * `thread_ts` before `window.from`, an event starting before `window.from`.
   */
  continuesFromBefore: boolean;
}

// ── Mail ──

export type Importance = "low" | "normal" | "high";

export interface Email extends RecordBase {
  type: "email";
  source: "graph";
  /** `receivedDateTime` for inbox, `sentDateTime` for sent. */
  at: Instant;
  folder: "inbox" | "sent";
  subject: Untrusted<string>;
  from: Person;
  /**
   * Graph's `sender`, kept only when it differs from `from`: a delegate sending on
   * someone's behalf, or the user sending as a shared mailbox. Without it, mail the
   * user sent as a shared mailbox would not count as the user's.
   */
  sentBy?: Person;
  to: Person[];
  cc: Person[];
  /**
   * The user wrote this: `from.isMe || sentBy?.isMe`. Same meaning as
   * `ChatMessage.byMe`, so an entry's `lastFromMe` is computed one way for both.
   */
  byMe: boolean;
  /** `bodyPreview` today. Summarizer input only. */
  body: Untrusted<string>;
  importance: Importance;
  isRead: boolean;
  /** `flag.flagStatus === "flagged"`. */
  flagged: boolean;
  hasAttachments: boolean;
}

// ── Slack ──

export type ConversationKind = "dm" | "group_dm" | "channel";

export interface Conversation {
  kind: ConversationKind;
  /** Slack Connect: the conversation includes another workspace. */
  isExternal: boolean;
  /** Channel name, channels only. DMs and group DMs have no honest name. */
  name?: Untrusted<string>;
  /**
   * DM counterpart (`conversations.info`) or group-DM members (`conversations.members`),
   * the user included (#118). Absent for channels: their membership is not the
   * conversation's participants.
   */
  members?: Person[];
}

export interface ChatMessage extends RecordBase {
  type: "chat-message";
  source: "slack";
  at: Instant;
  conversation: Conversation;
  author: Person;
  /** `author.isMe`, spelled out for symmetry with `Email.byMe`. */
  byMe: boolean;
  /** The message @-mentions the user (the `mentions` query found it, or the text has `<@me>`). */
  mentionsMe: boolean;
  /** A reply inside a thread. Threads are summary context, not entries (#120). */
  inThread: boolean;
  /** Text with user mentions resolved to names, as `readableText` does today. */
  text: Untrusted<string>;
}

// ── Calendar ──

/** Graph `responseStatus.response`. */
export type Response =
  | "none"
  | "organizer"
  | "tentativelyAccepted"
  | "accepted"
  | "declined"
  | "notResponded";

/** Graph `showAs`. */
export type ShowAs = "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";

export interface Attendee extends Person {
  /** Best effort per Graph docs: other attendees' status may lag. */
  response: Response;
  optional: boolean;
}

export interface CalendarEvent extends RecordBase {
  type: "calendar-event";
  source: "graph";
  /** An all-day event's `start`/`end` are dates (`YYYY-MM-DD`), not instants. */
  start: Instant | string;
  end: Instant | string;
  isAllDay: boolean;
  title: Untrusted<string>;
  location?: Untrusted<string>;
  organizer: Person;
  isOrganizer: boolean;
  /** Resources (rooms) filtered out, as today. */
  attendees: Attendee[];
  myResponse: Response;
  showAs: ShowAs;
  isCancelled: boolean;
  /** The boolean only. The join URL never leaves the binary (#121). */
  isOnlineMeeting: boolean;
  /** Part of a series: Graph `type` is `occurrence` or `exception`. */
  recurring: boolean;
  /** An exception whose `start` differs from Graph's `originalStart`. Derived by code. */
  moved: boolean;
}

/** What a Source emits and the Aggregator groups. Discriminated on `type`. */
export type SourceRecord = Email | ChatMessage | CalendarEvent;
