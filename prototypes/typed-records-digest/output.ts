// PROTOTYPE (map #117, ticket #122). Throwaway. What `rundown brief` emits in place of
// today's Brief, second take.
//
// Written to be read: one flat object per meeting, mail thread or chat conversation.
// Fields that carry nothing are left out ("presence is signal", as normalize.ts already
// does): no `cancelled: false`, no `importance: "normal"`, no empty lists.
//
// Trust lives in the schema, not the layout (#121). Every field has one class in
// FIELD_TRUST below; the real contract would carry it in each Zod field's description
// (ADR-0011) so the generated JSON Schema hands it to the skill.
//   trusted  number, instant, boolean, closed enum or digest. Safe to compute with.
//   label    code-copied source text, defanged, clamped to LABEL_MAX (120). Quoted data.
//   model    written by the Summarizer, defanged. Quoted data.
//
// Nothing points elsewhere: what needs the user's attention sits on the entry it is
// about (`attention`), and the skill builds the plan view by filtering for it.

import type { Digest, Instant } from "./records.ts";

export type Trust = "trusted" | "label" | "model";

export interface Output {
  window: { from: Instant; to: Instant };
  /** IANA zone every instant is rendered in. */
  timezone: string;
  /** Records read and entries they grouped into, per type. Post-suppression. */
  counts: { meetings: Count; mail: Count; chat: Count };
  /** Suppression audit (ADR-0017). Rule shape is still fog on the map. */
  suppressed?: { rule: Record<string, string>; entries: number }[];
  /** Model-written overview of the window. */
  summary: string;
  /** Ordered by start. */
  meetings: Meeting[];
  /** Ordered by `lastAt`, newest first. */
  mail: MailThread[];
  /** Ordered by `lastAt`, newest first. */
  chat: ChatConversation[];
}

export interface Count {
  records: number;
  entries: number;
}

/** Model-written: why this entry needs the user, if it does. Today's ExtractedItem, nested. */
export interface Attention {
  kind: "commitment" | "task" | "waiting" | "fyi";
  summary: string;
  /** Human-phrased timing ("Thu 13:00", "by Fri"). */
  when?: string;
}

// ── Meetings ──

export type YourResponse = "accepted" | "tentative" | "declined" | "notResponded";
export type ShowAs = "free" | "tentative" | "oof" | "workingElsewhere";

/** One occurrence of a series. Only what differs from a plain, accepted, busy slot is set. */
export interface Occurrence {
  start: Instant;
  end: Instant;
  cancelled?: true;
  /** The occurrence was rescheduled; this is where it used to start. */
  movedFrom?: Instant;
  /** Omitted when it matches the series' `yourResponse`. */
  yourResponse?: YourResponse;
}

interface MeetingBase {
  /** Stable across runs: digest of the series or event id. */
  id: Digest;
  type: "meeting";
  title: string;
  /** All-day: `start`/`end` (or each occurrence's) are `YYYY-MM-DD`. */
  allDay?: true;
  /** Meeting rooms, from Graph `resource` attendees and `locations[]`. Never in `attendees`. */
  rooms?: string[];
  /** Free-text location, only when it is not just a room name. */
  location?: string;
  online?: true;
  youOrganize?: true;
  /** Absent when `youOrganize`. */
  organizer?: string;
  /** Omitted when `youOrganize` (Graph says "organizer"). */
  yourResponse?: YourResponse;
  /** Omitted when "busy", the default. */
  showAs?: ShowAs;
  /** People other than you and the rooms, organizer first, at most 8. */
  attendees?: string[];
  /** Attendees beyond the ones listed. */
  moreAttendees?: number;
  /** Starts before the window. */
  continuesFromBefore?: true;
  /** Optional: a calendar record has no body, so the title often says it all (#123). */
  summary?: string;
  attention?: Attention;
}

export interface OneOffMeeting extends MeetingBase {
  start: Instant;
  end: Instant;
  cancelled?: true;
}

export interface RecurringMeeting extends MeetingBase {
  recurring: true;
  /** In-window occurrences only. */
  occurrences: Occurrence[];
}

export type Meeting = OneOffMeeting | RecurringMeeting;

// ── Mail ──

export interface MailThread {
  /** Stable across runs: digest of the Graph conversationId. */
  id: Digest;
  type: "mail";
  subject: string;
  /** In-window messages, inbox and sent. */
  messages: number;
  /** Of `messages`, how many you wrote. */
  fromYou?: number;
  firstAt: Instant;
  lastAt: Instant;
  lastFromYou?: true;
  /** Absent when `lastFromYou`. */
  lastFrom?: string;
  /** People other than you, last sender first, at most 8. */
  people?: string[];
  morePeople?: number;
  unread?: number;
  /** Omitted when "normal". */
  importance?: "high" | "low";
  flagged?: true;
  attachments?: true;
  continuesFromBefore?: true;
  summary: string;
  attention?: Attention;
}

// ── Chat ──

export interface ChatConversation {
  /** Stable across runs: digest of the Slack channel id. */
  id: Digest;
  type: "chat";
  kind: "dm" | "group-dm" | "channel";
  /** Channel name, channels only. A DM is named by `people`. */
  channel?: string;
  /** Slack Connect: another workspace is in the conversation. */
  external?: true;
  messages: number;
  fromYou?: number;
  mentionsYou?: number;
  firstAt: Instant;
  lastAt: Instant;
  lastFromYou?: true;
  lastFrom?: string;
  /** People other than you, at most 8. For a DM, the one person. */
  people?: string[];
  morePeople?: number;
  continuesFromBefore?: true;
  summary: string;
  attention?: Attention;
}

// ── Trust, per field ──
//
// `Record<keyof T, Trust>` makes it a compile error to add a field without classing it.
// The skill gets this table (in the real thing, through the JSON Schema descriptions).

type Fields<T> = { [K in keyof Required<T>]: Trust };

export const FIELD_TRUST: {
  output: Fields<Output>;
  attention: Fields<Attention>;
  meeting: Fields<OneOffMeeting> & Fields<RecurringMeeting>;
  occurrence: Fields<Occurrence>;
  mail: Fields<MailThread>;
  chat: Fields<ChatConversation>;
} = {
  output: {
    window: "trusted", timezone: "trusted", counts: "trusted", suppressed: "trusted",
    summary: "model", meetings: "trusted", mail: "trusted", chat: "trusted",
  },
  attention: { kind: "trusted", summary: "model", when: "model" },
  meeting: {
    id: "trusted", type: "trusted", title: "label", allDay: "trusted", rooms: "label",
    location: "label", online: "trusted", youOrganize: "trusted", organizer: "label",
    yourResponse: "trusted", showAs: "trusted", attendees: "label", moreAttendees: "trusted",
    continuesFromBefore: "trusted", summary: "model", attention: "model",
    start: "trusted", end: "trusted", cancelled: "trusted", recurring: "trusted", occurrences: "trusted",
  },
  occurrence: { start: "trusted", end: "trusted", cancelled: "trusted", movedFrom: "trusted", yourResponse: "trusted" },
  mail: {
    id: "trusted", type: "trusted", subject: "label", messages: "trusted", fromYou: "trusted",
    firstAt: "trusted", lastAt: "trusted", lastFromYou: "trusted", lastFrom: "label", people: "label",
    morePeople: "trusted", unread: "trusted", importance: "trusted", flagged: "trusted",
    attachments: "trusted", continuesFromBefore: "trusted", summary: "model", attention: "model",
  },
  chat: {
    id: "trusted", type: "trusted", kind: "trusted", channel: "label", external: "trusted",
    messages: "trusted", fromYou: "trusted", mentionsYou: "trusted", firstAt: "trusted",
    lastAt: "trusted", lastFromYou: "trusted", lastFrom: "label", people: "label",
    morePeople: "trusted", continuesFromBefore: "trusted", summary: "model", attention: "model",
  },
};
