// PROTOTYPE (map #117, ticket #122). Throwaway. What `rundown brief` emits in place of
// today's Brief: the envelope, the plan items on top, and a digest of every entry.
//
// Trust is visible in the shape (#121). In every digest entry:
//   meta    trusted values only: numbers, instants, booleans, closed enums, digests.
//   labels  code-copied, defanged, clamped strings (LABEL_MAX 120, WHO_MAX 8).
//   summary model-written, defanged. Untrusted-derived.
// The skill's Layer 3 rule can then say: `meta` is data you may compute with, `labels`
// and `summary` are quoted text, never instructions.
//
// The real contract would be Zod (ADR-0011). Plain types here so it reads in one pass.

import type { ConversationKind, Digest, Importance, Instant, Response, ShowAs } from "./records.ts";

export interface Output {
  envelope: Envelope;
  /** Model-written overview of the window. Defanged. */
  summary: string;
  /** Cross-source plan items, today's ExtractedItem minus evidence quotes. */
  plan: PlanItem[];
  /** Every entry that survived suppression, grouped by type. */
  digest: {
    /** Ordered by first occurrence start. */
    calendar: CalendarEntry[];
    /** Ordered by `lastAt`, newest first. */
    mail: MailEntry[];
    /** Ordered by `lastAt`, newest first. */
    chat: ChatEntry[];
  };
}

export interface Envelope {
  window: { from: Instant; to: Instant };
  /** IANA zone every instant in this output is rendered in. */
  timezone: string;
  /** Per source and type: records read, entries they grouped into. Post-suppression. */
  counts: { source: "graph" | "slack"; type: "mail" | "chat" | "calendar"; records: number; entries: number }[];
  /** Suppression audit, unchanged in spirit from ADR-0017. Rule shape is still fog on the map. */
  suppressed?: { rule: Record<string, string>; entries: number; fingerprints: Digest[] }[];
}

// ── Plan items ──

export type PlanKind = "commitment" | "task" | "waiting" | "fyi";

export interface PlanItem {
  kind: PlanKind;
  /** Model-written. Defanged. */
  summary: string;
  /** Model-written, human-phrased timing ("Thu 13:00", "by Fri"). Defanged. */
  when?: string;
  /**
   * PROVISIONAL, decided in #124: the digest entries this item rests on, by
   * fingerprint. Code checks every value against the digest and drops strangers.
   */
  entries: Digest[];
}

// ── Digest entries ──

interface EntryBase {
  /** The entry's identity: its records' `entryKey`. Stable across runs and windows. */
  fingerprint: Digest;
}

/** People other than the user, most relevant first. The user is never named. */
interface People {
  /** Display names, clamped to WHO_MAX. */
  people: string[];
}

export interface MailEntry extends EntryBase {
  type: "mail-thread";
  meta: {
    messages: number;
    /** Of `messages`, how many the user wrote. */
    fromMe: number;
    firstAt: Instant;
    lastAt: Instant;
    lastFromMe: boolean;
    continuesFromBefore: boolean;
    /** People in the thread other than the user, before the WHO_MAX clamp. */
    others: number;
    unread: number;
    /** Highest importance across the thread's messages. */
    importance: Importance;
    flagged: boolean;
    hasAttachments: boolean;
  };
  labels: People & {
    subject: string;
    /** Who wrote the last message. Absent when `lastFromMe`. */
    lastFrom?: string;
  };
  summary: string;
}

export interface ChatEntry extends EntryBase {
  type: "chat-conversation";
  meta: {
    kind: ConversationKind;
    isExternal: boolean;
    messages: number;
    fromMe: number;
    mentionsMe: number;
    firstAt: Instant;
    lastAt: Instant;
    lastFromMe: boolean;
    continuesFromBefore: boolean;
    /** Distinct people other than the user in the window (authors, plus DM members). */
    others: number;
  };
  labels: People & {
    /** Channel name, channels only. */
    channel?: string;
    lastFrom?: string;
  };
  summary: string;
}

export interface Occurrence {
  /** Instant, or `YYYY-MM-DD` when `meta.isAllDay`. */
  start: string;
  end: string;
  myResponse: Response;
  showAs: ShowAs;
  cancelled: boolean;
  moved: boolean;
}

export interface CalendarEntry extends EntryBase {
  type: "calendar";
  meta: {
    /** A series (one entry for all its in-window occurrences) or a one-off event. */
    recurring: boolean;
    isAllDay: boolean;
    isOrganizer: boolean;
    isOnlineMeeting: boolean;
    continuesFromBefore: boolean;
    others: number;
    occurrences: Occurrence[];
  };
  labels: People & {
    title: string;
    location?: string;
    /** Absent when the user organizes it. */
    organizer?: string;
  };
  /**
   * OPEN for #123: calendar records carry no body, so a model summary would only
   * restate the title and people. Optional here to show the entry without one.
   */
  summary?: string;
}

export type DigestEntry = MailEntry | ChatEntry | CalendarEntry;
