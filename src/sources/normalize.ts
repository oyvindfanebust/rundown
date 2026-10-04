// The normalizer (ADR-0002 §4): the shared NormalizedItem constructor —
// the branding + compaction ritual every Source repeated, spelled once. A source
// module makes ONE normalizer (`normalizer(source, {untitled})`) and hands each
// item's extracted fields to it; the normalizer owns the whole invariant: total
// branding via untrusted()/untrustedOpt(), String() id-coercion, title fallback +
// truncation, union compaction, and validating the structural
// instants (timestamp/end), the one operation that can throw: a non-ISO instant
// is backend garbage and fails hard here (ADR-0007 §6) rather than sliding through
// as a "trusted" string. Otherwise total, no I/O — and the sole trust.ts importer
// among sources: the only way a Source constructs
// a NormalizedItem. What stays at call sites is domain judgment only (e.g. graph's
// "normal" importance elision). ADR-0002 names the NormalizedItem
// *shape*; this deepens under it. Never unwrapped here (sole unwrap site is
// plan.ts; CLAUDE.md).
//
// Attribution (#54) is branded and compacted here too, so no source imports trust.ts
// and the "who and where" invariant is spelled once rather than five times.

import { createHash } from "node:crypto";
import type { Attendee, Attribution, CalendarEvent, Email, NormalizedItem, Person } from "../domain.ts";
import { untrusted, untrustedOpt } from "../trust.ts";

/**
 * Max length for a free-text field (title / subject / preview / …). 255 so a subject of
 * Outlook's full length survives to the label clamp (#141).
 */
export const TEXT_MAX = 255;

/**
 * The free-text marker (grilled design): truncate to {@link TEXT_MAX},
 * and let absence collapse — `""`/`null`/`undefined` → `undefined`, so compaction
 * can treat presence as signal.
 */
export function text(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  return v.slice(0, TEXT_MAX);
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
 * unchecked they could carry NaN — silently mislabelling a bucket downstream
 * (ADR-0003 §4) — or arbitrary backend bytes with no type-level warning. A
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

/** The fields one item hands its normalizer: structural verbatim + bare backend content. */
export interface ItemSpec {
  kind: string;
  timestamp: string;
  end?: string;
  /** The instants encode a calendar date, not a clock time (all-day event, due-date anchor). */
  dateOnly?: boolean;
  id: string | number | null | undefined;
  title: string | null | undefined;
  url?: string;
  /**
   * Who and where, as bare values — the normalizer brands and compacts it (#54). A
   * source writes its own honest label; see {@link Attribution}. Absent `where`, an
   * empty/all-absent `who`, and an absent `relationship` all vanish under the same
   * "presence is signal" policy as `extras`, so a source can pass what it has without
   * guarding each field.
   */
  attribution?: {
    where?: string | null;
    who?: Array<string | null | undefined>;
    relationship?: string | null;
  };
  extras?: Record<string, unknown>;
}

/**
 * The union compaction policy — "presence is signal": a value earns its
 * key by carrying information. `undefined`, `null`, `""`, `false`, and empty
 * arrays are absence and vanish; `0` and `true` are signal and stay. Declaration
 * order is preserved for deterministic rendering.
 */
function isSignal(v: unknown): boolean {
  if (v === undefined || v === null || v === "" || v === false) return false;
  return !(Array.isArray(v) && v.length === 0);
}

/**
 * Stable identity for cross-window dedup (#108): a truncated SHA-256 of
 * `source + kind + raw backend id`. A one-way digest of the untrusted id, computed
 * here before branding, so the value that reaches the Brief is a trusted structural
 * scalar carrying no backend bytes — the raw id itself never leaves the sealed
 * pipeline, and evidence resolution copies the fingerprint without a new unwrap
 * site. 16 hex chars (64 bits) is collision-safe at this scale. Deliberately keyed
 * on identity only, never `timestamp`: a rescheduled or updated item must still
 * dedup against its earlier appearance.
 */
function fingerprintOf(source: string, kind: string, rawId: string): string {
  return createHash("sha256").update(`${source}\n${kind}\n${rawId}`).digest("hex").slice(0, 16);
}

function compactExtras(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (isSignal(v)) out[k] = v;
  return out;
}

/**
 * Compact one attribution under the same "presence is signal" policy: drop absent
 * `where`/`relationship`, drop absent entries from `who`, truncate every label to
 * {@link TEXT_MAX} (these are hostile free text like titles are), and collapse the
 * whole thing to `undefined` when nothing survives — so an all-absent attribution
 * costs no key on the item and no line in the rendered bundle.
 *
 * `who` is deduplicated, order-preserving: Slack's `author` and `counterpart` are the
 * same person on an incoming DM, and a caption listing them twice reads as a bug.
 */
function compactAttribution(spec: NonNullable<ItemSpec["attribution"]>): Attribution | undefined {
  const out: Attribution = {};
  const where = text(spec.where ?? undefined);
  if (where !== undefined) out.where = where;
  const relationship = text(spec.relationship ?? undefined);
  if (relationship !== undefined) out.relationship = relationship;
  if (spec.who !== undefined) {
    const seen = new Set<string>();
    const who: string[] = [];
    for (const raw of spec.who) {
      const label = text(raw ?? undefined);
      if (label === undefined || seen.has(label)) continue;
      seen.add(label);
      who.push(label);
    }
    if (who.length > 0) out.who = who;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Make a Source's normalizer: brand the backend content Untrusted
 * (`id`/`title`/`url`/`extras`), keep the structural core (`source`/`kind`/
 * `timestamp`/`end`) trusted — validating each instant via {@link instant} so a
 * non-ISO `timestamp`/`end` fails hard here — truncate every title (titles are hostile free text
 * by definition; no policy knob), fall back to `untitled` when the title is
 * absent, and compact `extras` — omitting it entirely when compaction empties it.
 */
export function normalizer(
  source: string,
  opts: { untitled?: string } = {},
): (spec: ItemSpec) => NormalizedItem {
  const untitled = opts.untitled ?? "(untitled)";
  return (spec) => {
    const extras = spec.extras === undefined ? undefined : compactExtras(spec.extras);
    const attribution =
      spec.attribution === undefined ? undefined : compactAttribution(spec.attribution);
    const rawId = String(spec.id ?? "");
    const item: NormalizedItem = {
      source,
      kind: spec.kind,
      timestamp: instant(spec.timestamp, "timestamp", source),
      id: untrusted(rawId),
      title: untrusted(text(spec.title) ?? untitled),
      url: untrustedOpt(spec.url),
      attribution: attribution === undefined ? undefined : untrusted(attribution),
      extras: extras && Object.keys(extras).length > 0 ? untrusted(extras) : undefined,
    };
    if (spec.end !== undefined) item.end = instant(spec.end, "end", source);
    if (spec.dateOnly === true) item.dateOnly = true;
    // No fingerprint for an absent id: a shared digest of "" would alias unrelated items.
    if (rawId !== "") item.fingerprint = fingerprintOf(source, spec.kind, rawId);
    return item;
  };
}

// ── Typed records (ADR-0019) ──
//
// The record builders: the same branding, truncation and instant validation as the
// normalizer, for typed records. A source parses its trusted values (enums, flags,
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
    handle: untrusted(text(spec.handle) ?? ""),
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
    body: untrusted(text(spec.body) ?? ""),
    importance: spec.importance,
    isRead: spec.isRead,
    flagged: spec.flagged,
    hasAttachments: spec.hasAttachments,
    inferenceClassification: spec.inferenceClassification,
  };
  if (sentBy !== undefined) record.sentBy = sentBy;
  return record;
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
    // Digests the old NormalizedItem kind `event`, not the record type, so an event keeps
    // the fingerprint it had before records.
    fingerprint: fingerprintOf(source, "event", rawId),
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
