// The Digester (ADR-0021): turns the Bundle into the digest. It groups records into
// entries, copies trusted values and labels into each entry by code, renders the mail and
// chat entries (and the meetings, as context) for one Summarizer call per window, and joins
// the model's summaries back onto the entries by opaque per-run id.
//
// This file is one of the two places untrusted bytes are read (ADR-0022): `unwrap()` here
// feeds Summarizer input and grouping (the mail merge, people dedup). The other is
// `label()`, through which every label that leaves in the digest passes. Nothing unwrapped
// here is copied into the digest directly.

import {
  eventBoundInstant,
  type Bundle,
  type CalendarEvent,
  type ChatMessage,
  type Email,
  type EventResponse,
  type Person,
  type SourceRecord,
  type Window,
} from "./domain.ts";
import {
  DigestSchema,
  ENTRY_SUMMARY_MAX,
  NAMES_MAX,
  OVERVIEW_MAX,
  SUMMARIZER_OUTPUT_SCHEMA,
  SummarizerOutputSchema,
  type ChatConversation,
  type Digest,
  type MailThread,
  type Meeting,
  type Occurrence,
  type SummarizerOutput,
  type YourResponse,
} from "./digest-contract.ts";
import { label, NAME_MAX, TITLE_MAX } from "./label.ts";
import { clamp, defang, oneLine, stripInvisible } from "./sanitize.ts";
import { summarize } from "./summarize.ts";
import { zonedIso, zonedWeekday } from "./temporal.ts";
import { unwrap } from "./trust.ts";

/** Most chars of rendered data one Summarizer call takes, after the entry caps. */
export const INPUT_BUDGET = 400_000;
/** About this many chars of messages render per entry, newest first. */
export const ENTRY_TEXT_MAX = 8_000;
/** Longest single rendered message. */
export const MESSAGE_TEXT_MAX = 2_000;

const TRUNCATION_MARKER = "…[truncated]";

export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

/** The run's trusted inputs: config-derived and clock-derived scalars, never source content. */
export interface DigestContext {
  window: Window;
  /** Validated IANA timezone; every rendered time is shown in it. */
  timezone: string;
  /** The run's single clock, read once in the composition root. */
  generatedAt: string;
}

/** Injectable dependencies: the Summarizer, faked in tests, and an optional progress sink. */
export interface DigesterDeps {
  summarize?: typeof summarize;
  /** Trusted progress lines (counts only). */
  onProgress?: (message: string) => void;
}

// ── Instruction region (trusted) ──

/** The opaque per-run id prefix for each entry kind, and how the prompt names the kind. */
const RUN_ID: Record<Kind, { prefix: string; noun: string }> = {
  mail: { prefix: "e", noun: "a mail thread" },
  chat: { prefix: "c", noun: "a chat conversation" },
  meeting: { prefix: "m", noun: "a meeting" },
};

function instructionsFor(ctx: DigestContext): string {
  const tz = ctx.timezone;
  const at = (instant: string) => renderInstant(instant, tz);
  const kinds = (Object.values(RUN_ID) as Array<{ prefix: string; noun: string }>)
    .map(({ prefix, noun }) => `[${prefix}…] ${noun}`)
    .join(", ");
  // The caps come from the contract, so the prompt and the parse cannot drift (ADR-0011).
  return `You are summarizing one window of the user's mail, chat and calendar.
The data holds one block per entry under an opaque id in brackets: ${kinds}.
Messages inside a block are listed oldest first.

Window: ${at(ctx.window.from)} to ${at(ctx.window.to)}
Timezone: ${tz}. Every time in the data is shown in it.
Generated at: ${at(ctx.generatedAt)}. Anything before this instant has happened; anything
after it is scheduled.

Return:
- "summary": an overview of the window in at most ${OVERVIEW_MAX} characters. Describe what happened
  before the generated-at time and what is scheduled after it. Report; do not judge what is
  still open, and do not tell the user what to do.
- "entries": one {"id", "summary"} for every mail thread and chat conversation, with the
  bracketed id copied exactly (without the brackets). Each summary is at most
  ${ENTRY_SUMMARY_MAX} characters and says what the thread or conversation is about and where it stands. Do not
  return entries for meetings; they are context for the overview only.
Write plain text: no links, no URLs, no markdown.`;
}

// ── Rendering helpers ──

function capField(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${TRUNCATION_MARKER}`;
}

function renderInstant(instant: string, tz: string): string {
  return `${zonedWeekday(instant, tz)} ${zonedIso(instant, tz)}`;
}

/** A meeting bound: a timed instant in the zone, or an all-day date with its weekday. */
function renderBound(e: CalendarEvent, bound: string, tz: string, exclusiveEnd = false): string {
  if (!e.isAllDay) return renderInstant(bound, tz);
  const date = exclusiveEnd ? new Date(Date.parse(`${bound}T00:00:00Z`) - 1).toISOString().slice(0, 10) : bound;
  return `${zonedWeekday(`${date}T00:00:00Z`, "UTC")} ${date}`;
}

/**
 * The newest messages that fit {@link ENTRY_TEXT_MAX}, oldest first, and how many older
 * ones were left out. The newest message always renders.
 */
function newestLines(lines: string[]): { shown: string[]; hidden: number } {
  const shown: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (shown.length > 0 && used + line.length > ENTRY_TEXT_MAX) break;
    shown.unshift(line);
    used += line.length + 1;
  }
  return { shown, hidden: lines.length - shown.length };
}

// ── People ──

/** A dedup key for a person: the handle, else the name, else none (skipped). */
function personKey(p: Person): string | undefined {
  const handle = unwrap(p.handle).toLowerCase();
  if (handle !== "") return `h:${handle}`;
  const name = p.name === undefined ? "" : unwrap(p.name);
  return name === "" ? undefined : `n:${name}`;
}

/**
 * Up to {@link NAMES_MAX} names of the people other than the user, in the order given, and
 * how many others there are beyond them (those without a display name included).
 */
function namesOf(people: Person[]): { names?: string[]; more?: number } {
  const seen = new Set<string>();
  const others: Person[] = [];
  for (const p of people) {
    if (p.isMe) continue;
    const key = personKey(p);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    others.push(p);
  }
  const names: string[] = [];
  for (const p of others) {
    if (names.length === NAMES_MAX) break;
    const n = label(p.name, NAME_MAX);
    if (n !== undefined && !names.includes(n)) names.push(n);
  }
  const more = others.length - names.length;
  return { ...(names.length > 0 ? { names } : {}), ...(more > 0 ? { more } : {}) };
}

/** The block line naming the people of an entry, or none when nobody is named. */
function peopleLine(heading: string, names?: string[], more?: number): string[] {
  return names ? [`${heading}: ${names.join(", ")}${more ? ` and ${more} more` : ""}`] : [];
}

function displayName(p: Person): string {
  if (p.isMe) return "you";
  return label(p.name, NAME_MAX) ?? "(unnamed)";
}

// ── Entries ──

type Kind = "meeting" | "mail" | "chat";

interface Built<T> {
  kind: Kind;
  entry: T;
  /** The rendered block, minus its `[id]` header, which is assigned after sorting. */
  render: (runId: string) => string;
  sortKey: number;
}

const SUBJECT_PREFIX = /^(\s*(re|fw|fwd)\s*:\s*)+/i;

/** A subject for the merge: "Re:"/"Fw:" prefixes stripped, whitespace collapsed, case folded. */
function mergeSubject(subject: string): string {
  return oneLine(subject.replace(SUBJECT_PREFIX, "")).toLowerCase();
}

/**
 * Mail entries: one per thread (`entryKey`), with threads whose earliest message has the same
 * sender address and the same subject (ignoring "Re:"/"Fw:") merged into the earliest thread.
 */
function groupMail(emails: Email[]): Email[][] {
  const threads = new Map<string, Email[]>();
  for (const m of emails) {
    const thread = threads.get(m.entryKey);
    if (thread) thread.push(m);
    else threads.set(m.entryKey, [m]);
  }
  const byTime = (a: Email, b: Email) => Date.parse(a.at) - Date.parse(b.at);
  const ordered = [...threads.values()].map((t) => t.sort(byTime)).sort((a, b) => byTime(a[0]!, b[0]!));
  const merged = new Map<string, Email[][]>();
  const groups: Email[][][] = [];
  for (const thread of ordered) {
    const first = thread[0]!;
    const sender = unwrap(first.from.handle).toLowerCase();
    const key = sender === "" ? undefined : `${sender}\n${mergeSubject(unwrap(first.subject))}`;
    const existing = key === undefined ? undefined : merged.get(key);
    if (existing) {
      existing.push(thread);
      continue;
    }
    const group = [thread];
    groups.push(group);
    if (key !== undefined) merged.set(key, group);
  }
  return groups.map((group) => group.flat().sort(byTime)).map((msgs, i) => {
    // The earliest thread leads, so its entryKey is the entry id.
    const lead = groups[i]![0]![0]!;
    return [lead, ...msgs.filter((m) => m !== lead)];
  });
}

function mailEntry(group: Email[], threadLeads: Email[], tz: string): Built<MailThread> {
  const threadCount = threadLeads.length;
  const lead = group[0]!;
  const msgs = [...group].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = msgs[msgs.length - 1]!;
  const fromYou = msgs.filter((m) => m.byMe).length;
  const unread = msgs.filter((m) => !m.isRead).length;
  const people = namesOf(
    [...msgs].reverse().flatMap((m) => [m.from, ...(m.sentBy ? [m.sentBy] : [])]).concat(
      [...msgs].reverse().flatMap((m) => [...m.to, ...m.cc]),
    ),
  );
  const notMine = msgs.filter((m) => !m.byMe);
  const importance = msgs.some((m) => m.importance === "high")
    ? "high"
    : msgs.every((m) => m.importance === "low")
      ? "low"
      : undefined;
  const lines = msgs.map((m) => {
    const body = capField(oneLine(unwrap(m.body)), MESSAGE_TEXT_MAX);
    return `- ${renderInstant(m.at, tz)} ${displayName(m.from)} (${m.folder}): ${body}`;
  });
  const { shown, hidden } = newestLines(lines);
  const lastFrom = last.byMe ? undefined : label(last.from.name, NAME_MAX);

  const entry: MailThread = {
    id: lead.entryKey,
    type: "mail",
    subject: label(lead.subject, TITLE_MAX) ?? "(no subject)",
    messages: msgs.length,
    ...(threadCount > 1 ? { threads: threadCount } : {}),
    ...(fromYou > 0 ? { fromYou } : {}),
    ...(unread > 0 ? { unread } : {}),
    ...(hidden > 0 ? { truncated: hidden } : {}),
    firstAt: msgs[0]!.at,
    lastAt: last.at,
    ...(last.byMe ? { lastFromYou: true as const } : {}),
    ...(lastFrom !== undefined ? { lastFrom } : {}),
    ...(people.names ? { people: people.names } : {}),
    ...(people.more ? { morePeople: people.more } : {}),
    ...(importance ? { importance } : {}),
    ...(msgs.some((m) => m.flagged) ? { flagged: true as const } : {}),
    ...(msgs.some((m) => m.hasAttachments) ? { attachments: true as const } : {}),
    ...(notMine.length > 0 && notMine.every((m) => m.inferenceClassification === "other") ? { bulk: true as const } : {}),
    ...(threadLeads.some((m) => m.continuesFromBefore) ? { continuesFromBefore: true as const } : {}),
  };

  const render = (runId: string) => {
    const head = [
      `[${runId}] mail thread`,
      `subject: ${capField(oneLine(unwrap(lead.subject)), MESSAGE_TEXT_MAX)}`,
      `messages in the window: ${msgs.length}${fromYou > 0 ? ` (${fromYou} from you)` : ""}${threadCount > 1 ? `, ${threadCount} threads merged` : ""}`,
      `last message: ${last.byMe ? "from you" : `from ${displayName(last.from)}`}`,
    ];
    head.push(...peopleLine("people", entry.people, entry.morePeople));
    if (entry.continuesFromBefore) head.push("the thread began before the window; earlier messages are not shown");
    if (hidden > 0) head.push(`${hidden} earlier messages in the window not shown`);
    return [...head, ...shown].join("\n");
  };
  return { kind: "mail", entry, render, sortKey: Date.parse(last.at) };
}

const CHAT_KIND = { dm: "dm", group_dm: "group-dm", channel: "channel" } as const;

function chatEntry(msgs: ChatMessage[], tz: string): Built<ChatConversation> {
  const sorted = [...msgs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const { conversation } = last;
  const kind = CHAT_KIND[conversation.kind];
  const authorsNewestFirst = [...sorted].reverse().map((m) => m.author);
  const people = namesOf([last.author, ...(conversation.members ?? []), ...authorsNewestFirst]);
  const fromYou = sorted.filter((m) => m.byMe).length;
  const mentionsYou = sorted.filter((m) => m.mentionsMe).length;
  const channel = kind === "channel" ? label(conversation.name, NAME_MAX) : undefined;
  const lastFrom = last.byMe ? undefined : label(last.author.name, NAME_MAX);
  const lines = sorted.map((m) => {
    const text = capField(oneLine(unwrap(m.text)), MESSAGE_TEXT_MAX);
    return `- ${renderInstant(m.at, tz)} ${displayName(m.author)}: ${text === "" ? "(no text)" : text}`;
  });
  const { shown, hidden } = newestLines(lines);

  const entry: ChatConversation = {
    id: last.entryKey,
    type: "chat",
    kind,
    ...(channel !== undefined ? { channel } : {}),
    ...(conversation.isExternal ? { external: true as const } : {}),
    messages: sorted.length,
    ...(fromYou > 0 ? { fromYou } : {}),
    ...(mentionsYou > 0 ? { mentionsYou } : {}),
    ...(hidden > 0 ? { truncated: hidden } : {}),
    firstAt: first.at,
    lastAt: last.at,
    ...(last.byMe ? { lastFromYou: true as const } : {}),
    ...(lastFrom !== undefined ? { lastFrom } : {}),
    ...(people.names ? { people: people.names } : {}),
    ...(people.more ? { morePeople: people.more } : {}),
    // No continuesFromBefore: earlier chat messages are not read, so it is never known.
  };

  const render = (runId: string) => {
    const where =
      kind === "channel"
        ? `channel ${channel ?? "(unnamed)"} (only your messages and mentions of you)`
        : kind === "dm"
          ? "direct message"
          : "group direct message";
    const head = [
      `[${runId}] chat conversation: ${where}${conversation.isExternal ? ", shared with another workspace" : ""}`,
      `messages in the window: ${sorted.length}${fromYou > 0 ? ` (${fromYou} from you)` : ""}`,
    ];
    head.push(...peopleLine("people", entry.people, entry.morePeople));
    if (hidden > 0) head.push(`${hidden} earlier messages in the window not shown`);
    return [...head, ...shown].join("\n");
  };
  return { kind: "chat", entry, render, sortKey: Date.parse(last.at) };
}

const RESPONSES: Partial<Record<EventResponse, YourResponse>> = {
  accepted: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
  notResponded: "notResponded",
};

/** The most common answer across the occurrences; ties go to the earliest. */
function seriesResponse(events: CalendarEvent[]): YourResponse | undefined {
  const counts = new Map<YourResponse, number>();
  let best: YourResponse | undefined;
  for (const e of events) {
    const r = RESPONSES[e.myResponse];
    if (r === undefined) continue;
    const n = (counts.get(r) ?? 0) + 1;
    counts.set(r, n);
    if (best === undefined || n > counts.get(best)!) best = r;
  }
  return best;
}

function meetingEntry(events: CalendarEvent[], tz: string): Built<Meeting> {
  const byStart = (a: CalendarEvent, b: CalendarEvent) =>
    Date.parse(eventBoundInstant(a, a.start)) - Date.parse(eventBoundInstant(b, b.start));
  const sorted = [...events].sort(byStart);
  const lead = sorted[0]!;
  const series = sorted.some((e) => e.recurring);
  const youOrganize = lead.isOrganizer;
  const response = youOrganize ? undefined : series ? seriesResponse(sorted) : RESPONSES[lead.myResponse];
  const showAs = lead.showAs === "busy" || lead.showAs === "unknown" ? undefined : lead.showAs;
  const rooms = lead.rooms.map((r) => label(r, NAME_MAX)).filter((r): r is string => r !== undefined);
  const location = label(lead.location, NAME_MAX);
  const organizer = youOrganize ? undefined : label(lead.organizer.name, NAME_MAX);
  const attendees = namesOf([lead.organizer, ...lead.attendees]);

  const base = {
    id: lead.entryKey,
    type: "meeting" as const,
    title: label(lead.title, TITLE_MAX) ?? "(no subject)",
    ...(lead.isAllDay ? { allDay: true as const } : {}),
    ...(lead.isOnlineMeeting ? { online: true as const } : {}),
    ...(youOrganize ? { youOrganize: true as const } : {}),
    ...(rooms.length > 0 ? { rooms } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(organizer !== undefined ? { organizer } : {}),
    ...(response !== undefined ? { yourResponse: response } : {}),
    ...(showAs !== undefined ? { showAs } : {}),
    ...(attendees.names ? { attendees: attendees.names } : {}),
    ...(attendees.more ? { moreAttendees: attendees.more } : {}),
    ...(lead.continuesFromBefore ? { continuesFromBefore: true as const } : {}),
  };

  const entry: Meeting = series
    ? {
        ...base,
        recurring: true,
        occurrences: sorted.map((e): Occurrence => {
          const own = RESPONSES[e.myResponse];
          return {
            start: e.start,
            end: e.end,
            ...(e.isCancelled ? { cancelled: true as const } : {}),
            ...(e.originalStart !== undefined ? { movedFrom: e.originalStart } : {}),
            ...(!youOrganize && own !== undefined && own !== response ? { yourResponse: own } : {}),
          };
        }),
      }
    : { ...base, start: lead.start, end: lead.end, ...(lead.isCancelled ? { cancelled: true as const } : {}) };

  const render = (runId: string) => {
    const span = (e: CalendarEvent) =>
      `${renderBound(e, e.start, tz)} – ${renderBound(e, e.end, tz, true)}${e.isCancelled ? " (cancelled)" : ""}`;
    const head = [
      `[${runId}] meeting${series ? `, recurring, ${sorted.length} occurrence(s) in the window` : ""}`,
      `title: ${capField(oneLine(unwrap(lead.title)), MESSAGE_TEXT_MAX)}`,
      `organizer: ${youOrganize ? "you" : (organizer ?? "(unnamed)")}`,
    ];
    if (response !== undefined) head.push(`your response: ${response}`);
    head.push(...peopleLine("attendees", base.attendees, base.moreAttendees));
    if (series) head.push(...sorted.map((e) => `- ${span(e)}`));
    else head.push(`when: ${span(lead)}`);
    return head.join("\n");
  };
  return { kind: "meeting", entry, render, sortKey: Date.parse(eventBoundInstant(lead, lead.start)) };
}

function groupBy<T extends SourceRecord>(records: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of records) {
    const g = groups.get(r.entryKey);
    if (g) g.push(r);
    else groups.set(r.entryKey, [r]);
  }
  return [...groups.values()];
}

function byKeyThenId<T extends { entry: { id: string }; sortKey: number }>(direction: 1 | -1) {
  return (a: T, b: T) =>
    a.sortKey !== b.sortKey ? direction * (a.sortKey - b.sortKey) : a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

// ── The Digester ──

/**
 * Turn a Bundle into the digest. An empty bundle short-circuits with no model call. A window
 * whose rendered data exceeds {@link INPUT_BUDGET} fails before any call. Otherwise one
 * Summarizer call writes the overview and the entry summaries, which are joined back by
 * opaque id: unknown ids, meeting ids and duplicates are dropped, and mail and chat entries
 * left without a summary are counted in `unsummarized`. Fail-hard on Summarizer failure.
 */
export async function digest(bundle: Bundle, ctx: DigestContext, deps: DigesterDeps = {}): Promise<Digest> {
  const summarizeFn = deps.summarize ?? summarize;
  const tz = ctx.timezone;
  const emails = bundle.records.filter((r): r is Email => r.type === "email");
  const events = bundle.records.filter((r): r is CalendarEvent => r.type === "calendar-event");
  const chats = bundle.records.filter((r): r is ChatMessage => r.type === "chat-message");

  const meetings = groupBy(events).map((g) => meetingEntry(g, tz)).sort(byKeyThenId(1));
  const mail = groupMail(emails)
    .map((group) => {
      const leads = groupBy(group).map((thread) => thread[0]!);
      return mailEntry(group, leads, tz);
    })
    .sort(byKeyThenId(-1));
  const chat = groupBy(chats).map((g) => chatEntry(g, tz)).sort(byKeyThenId(-1));

  const result: Digest = {
    window: { from: ctx.window.from, to: ctx.window.to },
    timezone: tz,
    generatedAt: ctx.generatedAt,
    counts: {
      meetings: { records: events.length, entries: meetings.length },
      mail: { records: emails.length, entries: mail.length },
      chat: { records: chats.length, entries: chat.length },
    },
    summary: "",
    meetings: meetings.map((m) => m.entry),
    mail: mail.map((m) => m.entry),
    chat: chat.map((c) => c.entry),
  };

  // Empty bundle → empty digest, no model call.
  if (bundle.records.length === 0) return DigestSchema.parse(result);

  // Opaque per-run ids: nothing stable or source-derived reaches the prompt.
  const byRunId = new Map<string, Built<{ id: string; summary?: string }>>();
  const blocks: string[] = [];
  const section = (title: string, built: Built<{ id: string }>[], prefix: string) => {
    if (built.length === 0) return;
    blocks.push(`## ${title}`);
    built.forEach((b, i) => {
      const runId = `${prefix}${i + 1}`;
      byRunId.set(runId, b as Built<{ id: string; summary?: string }>);
      blocks.push(b.render(runId), "");
    });
  };
  section("Meetings (context for the overview)", meetings, RUN_ID.meeting.prefix);
  section("Mail threads", mail, RUN_ID.mail.prefix);
  section("Chat conversations", chat, RUN_ID.chat.prefix);
  const data = blocks.join("\n").trimEnd();

  const entryCount = meetings.length + mail.length + chat.length;
  if (data.length > INPUT_BUDGET) {
    throw new DigestError(
      `The window has ${entryCount.toLocaleString("en-US")} entries (${data.length.toLocaleString("en-US")} chars); the limit is ${INPUT_BUDGET.toLocaleString("en-US")}. Use a shorter window.`,
    );
  }

  deps.onProgress?.(`Summarizing ${entryCount} entries with Claude (this can take a bit)…`);
  const output = await summarizeFn<SummarizerOutput>({
    instructions: instructionsFor(ctx),
    data,
    schema: SUMMARIZER_OUTPUT_SCHEMA,
    // The hard runtime check: caps enforced, extra keys stripped.
    parse: (value) => SummarizerOutputSchema.parse(value),
  });

  // Join on id. The model can only fill `summary`; every other field was set by code.
  const summarized = new Set<string>();
  for (const { id, summary } of output.entries) {
    const target = byRunId.get(id);
    if (target === undefined || target.kind === "meeting" || summarized.has(id)) continue;
    summarized.add(id);
    // Defang can lengthen text, so the cap is applied again after it.
    target.entry.summary = clamp(defang(stripInvisible(summary)), ENTRY_SUMMARY_MAX);
  }
  const unsummarized = mail.length + chat.length - summarized.size;

  return DigestSchema.parse({
    ...result,
    ...(unsummarized > 0 ? { unsummarized } : {}),
    summary: clamp(defang(stripInvisible(output.summary)), OVERVIEW_MAX),
    meetings: meetings.map((m) => m.entry),
    mail: mail.map((m) => m.entry),
    chat: chat.map((c) => c.entry),
  });
}
