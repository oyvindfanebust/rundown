// The ubiquitous language — the shared vocabulary types every component speaks.
// One readable home for the domain nouns (CONTEXT.md is their prose definition).
// `Untrusted<T>` lives in trust.ts because it is a cross-cutting security
// primitive, not a domain noun.

import type { Untrusted } from "./trust.ts";
import type { BriefItem } from "./brief-contract.ts";

/** An absolute time window: two ISO-8601 instants. `to` is exclusive. */
export interface Window {
  from: string;
  to: string;
}

/**
 * Who and where — the attribution every source has, under a different name each time
 * (#54). Before this, `where`/`who` were buried in `extras` under five vocabularies
 * (`folder`, `project`+`team`, `channel`+`counterpart`, `projectPath`+`gitBranch`),
 * so the Brief had nothing uniform to carry and the model was asked for attribution
 * prose it could get wrong.
 *
 * Two ideas make it work:
 *
 * 1. Uniform slot, source-specific wording. Each source writes its own honest label
 *    into `where` — Slack decides between "#flow-mgmt" and "DM with Ada Lovelace",
 *    Graph mail says "Inbox" or "Sent". The container is
 *    not forced into a shared vocabulary it does not have.
 * 2. It splits the two audiences `extras` used to serve at once. `attribution` is
 *    human-facing: pre-formatted labels, code-copied into Brief evidence, never
 *    model-supplied. `extras` stays the summarizer's clustering material — ids,
 *    states, flags, roles. A `channel.id` in `extras` and a `where` of "#flow-mgmt"
 *    are not duplication: one is a join key, the other is a caption.
 *
 * Untrusted like every other backend-controlled field: display names and channel
 * names are source bytes, so they are branded here and defanged on the way out.
 * Code-copied means unfabricated, not trusted.
 */
export interface Attribution {
  /** Human label for the container this item lives in. Omitted when there is no honest one. */
  where?: string;
  /** People involved, most salient first. Roles stay in `extras` — this is caption text. */
  who?: string[];
  /** Why this item is the user's: authored | mentions | dms | assigned | created | … */
  relationship?: string;
}

/**
 * The common shape every Source emits (ADR-0002 §4). A thin structural-trusted
 * core the Aggregator groups/orders/attributes by, plus untrusted backend content.
 */
export interface NormalizedItem {
  // ── structural (trusted) — produced by rundown's own source module ──
  /** Registry key / provenance. */
  source: string;
  /** "event" | "message" | "issue" | "session" | … */
  kind: string;
  /** Primary instant (the ordering key), ISO-8601 with offset. */
  timestamp: string;
  /** Optional interval end (events, sessions). */
  end?: string;
  /**
   * `timestamp`/`end` encode a calendar date, not a clock time — an all-day event's
   * UTC-midnight bounds, a due date's synthetic end-of-day anchor. Set by the source
   * module (a domain judgment, not backend bytes); the renderer shows the UTC
   * calendar date instead of an offset-shifted wall time, which would land on the
   * wrong local day (#106).
   */
  dateOnly?: boolean;
  /**
   * Stable identity for cross-window dedup (#108): a truncated SHA-256 of
   * `source + kind + raw backend id`, computed by the normalizer. Trusted because it
   * is a one-way digest — no backend bytes survive into it — and structural because
   * rundown's own code derives it. Absent when the backend supplied no id. Same item
   * in two Briefs → same fingerprint; that is its whole contract.
   */
  fingerprint?: string;

  // ── untrusted (backend content) — a hostile backend controls these bytes ──
  id: Untrusted<string>;
  title: Untrusted<string>;
  url?: Untrusted<string>;
  /** Who and where, uniform across sources — the Brief's evidence attribution. */
  attribution?: Untrusted<Attribution>;
  /** All source-specific fields: people/roles, body/preview, status, … */
  extras?: Untrusted<Record<string, unknown>>;
}

// ── Typed records (ADR-0019) ──
//
// What a Source emits in place of a NormalizedItem, one record type per thing a
// backend holds. Free text and ids stay boxed as `Untrusted<T>`. Every unboxed field is
// a trusted value: a number, instant, boolean, closed enum or digest, parsed by the
// source and dropped (or defaulted, for a required enum or flag) when the parse fails.
// Graph mail is the first record type (#147); calendar and Slack follow (#148, #149).

/** An ISO-8601 instant, validated by the source as the normalizer's `instant()` does. */
export type Instant = string;

/** A 16-hex-char truncated SHA-256 of rundown-chosen inputs. Carries no backend bytes. */
export type Digest = string;

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
  fingerprint: Digest;
  /**
   * Identity of the group this record belongs to: a digest of the mail `conversationId`,
   * the Slack channel id or the calendar `seriesMasterId`, domain-separated per type. A
   * record with no group id is its own group.
   */
  entryKey: Digest;
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
  /** `bodyPreview`. Summarizer input only. */
  body: Untrusted<string>;
  importance: "low" | "normal" | "high";
  isRead: boolean;
  /** `flag.flagStatus` is `flagged`. */
  flagged: boolean;
  hasAttachments: boolean;
  /** Outlook's Focused/Other sort. Unknown values read as `focused`. */
  inferenceClassification: "focused" | "other";
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

/** What a Source emits, discriminated on `type`. Chat records join it. */
export type SourceRecord = Email | CalendarEvent;

/**
 * What the Aggregator carries while sources move to typed records: a NormalizedItem or
 * a record. Temporary (#141 slices 5 and 6); the union goes once every source emits
 * records.
 */
export type BundleItem = NormalizedItem | SourceRecord;

/** Whether a bundle item is a typed record rather than a NormalizedItem. */
export function isRecord(item: BundleItem): item is SourceRecord {
  return "type" in item;
}

/** An event bound as an instant: itself, or UTC midnight of an all-day event's date. */
export function eventBoundInstant(e: CalendarEvent, bound: Instant | CalendarDate): Instant {
  return e.isAllDay ? `${bound}T00:00:00Z` : bound;
}

/** A bundle item's ordering instant: a record's own time, a NormalizedItem's `timestamp`. */
export function instantOf(item: BundleItem): string {
  if (!isRecord(item)) return item.timestamp;
  switch (item.type) {
    case "email":
      return item.at;
    case "calendar-event":
      return eventBoundInstant(item, item.start);
  }
}

/** The derived, structural-trusted temporal label on each bundled item (ADR-0003 §4). */
export type Bucket = "standing" | "recent" | "upcoming";

/** A bundle item plus its derived bucket. */
export type AnnotatedItem = BundleItem & { bucket: Bucket };

/** One entry in the Bundle's provenance manifest — trusted scalars only. */
export interface SourceManifestEntry {
  source: string;
  itemCount: number;
}

/**
 * The single normalized structure the Aggregator hands toward the Summarizer
 * (ADR-0003 §3). Wholly untrusted (it carries `extras`); flows only
 * Aggregator → Summarizer as a sealed in-process value, never to the agent.
 */
export interface Bundle {
  window: Window;
  sources: SourceManifestEntry[];
  items: AnnotatedItem[];
}

// ── Brief (the Planner's output; ADR-0005 §2–4) ──

// The Brief's output contract — `ExtractedKind`, `Evidence`, `ExtractedItem`, and
// the `SummarizerOutput` pair — is defined once in brief-contract.ts (a Zod source
// of truth; ADR-0011); import it from there directly. `Brief` itself stays here —
// it wraps the summarizer's output in the trusted envelope, so it composes the
// contract's `BriefItem` (post-resolution) with the domain's Window/manifest.

/**
 * The Planner's output: a trusted envelope around an untrusted-derived core
 * (ADR-0005 §2). The Summarizer emits only `{summary, items}`; the Planner
 * attaches the `envelope` by copying the Bundle's trusted scalars plus the run's
 * timezone. `timezone` is the IANA zone bundle timestamps were rendered in for the
 * Summarizer — the zone the model's `when` phrasing is anchored to — so a consumer
 * never has to guess what clock a Brief speaks (#106).
 */
export interface Brief {
  envelope: {
    window: Window;
    sources: SourceManifestEntry[];
    timezone: string;
  };
  summary: string;
  items: BriefItem[];
}
