// The Graph reference Source (ADR-0002, ADR-0019): Microsoft 365 calendar + mail.
// Inbox and sent mail are typed `Email` records and calendar events are typed
// `CalendarEvent` records. All backend content is branded Untrusted at this boundary.
//
// Testability seam: every request flows through one injected
// `fetchJson(token, url)` — exactly the shape the real bearer-fetch has — and all
// auth rides a single `deps.auth` bundle defaulting to the real auth.ts functions.
// Pagination (nextLink is a full URL, so the seam speaks URLs), `toInstant` UTC
// normalization, and the calendar/mail mapping all stay inside the module, tested
// through `read()`; the fake is a URL → canned-Graph-JSON map emulating Microsoft's
// published HTTP surface, not this module's private routing.

import type { CalendarEvent, Email, EventResponse, SourceRecord, Window } from "../../domain.ts";
import { calendarEventRecord, emailRecord, type PersonSpec } from "../normalize.ts";
import { statusOnlyError } from "../errors.ts";
import { noDebug, type DebugSink } from "../../debug.ts";
import type { OptionSchema, Source, SourceStatus } from "../source.ts";
import { azureConfig, getToken, login as graphLogin, signedInAccount } from "./auth.ts";

/** Graph's declared option schema — exposed on the static descriptor (registry.ts). */
export const GRAPH_OPTIONS: OptionSchema = {
  kinds: {
    type: "string[]",
    enum: ["event", "message"],
    description: 'Which kinds to pull. Options: "event", "message". Omit for both.',
  },
};

const BASE = "https://graph.microsoft.com/v1.0";

/** The single HTTP pipe every Graph request flows through — the injectable seam. */
export type FetchJson = (token: string, url: string) => Promise<any>;

/** The auth surface GraphSource depends on — one bundle, one seam. */
export interface GraphAuth {
  azureConfig: typeof azureConfig;
  signedInAccount: typeof signedInAccount;
  getToken: typeof getToken;
  login: typeof graphLogin;
}

/** Injectable dependencies — the seam that makes the read + status paths unit-testable. */
export interface GraphDeps {
  /** The bearer-fetch pipe (default: the real `fetch` + `Prefer: UTC` request). */
  fetchJson?: FetchJson;
  /** The auth bundle (default: the real auth.ts functions). */
  auth?: GraphAuth;
  /** Structural diagnostics sink (ADR-0015); defaults to the no-op. */
  debug?: DebugSink;
  /** The wait between retried requests (default: a real timer); injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The statuses Graph answers when the request is fine but the service will not
 * serve it now: throttling (429) and an unavailable or timed-out backend (503,
 * 504). Outlook allows four concurrent requests per mailbox, and one run makes up
 * to three, so two runs at once are throttled.
 */
const RETRYABLE = new Set([429, 503, 504]);

/** Retries after the first attempt, per request. */
const MAX_RETRIES = 3;

/** The longest single wait, whatever `Retry-After` asks for. */
const MAX_WAIT_MS = 60_000;

/**
 * How long to wait before retry number `attempt + 1`: the `Retry-After` header as
 * delta-seconds or an HTTP-date, else 1s, 2s, 4s; never more than {@link MAX_WAIT_MS}.
 * The header is a trusted scalar parsed to a number and never echoed anywhere.
 */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const fallback = 1000 * 2 ** attempt;
  let ms = fallback;
  const value = retryAfter?.trim() ?? "";
  if (/^\d+$/.test(value)) ms = Number(value) * 1000;
  else if (/[a-z]/i.test(value) && Number.isFinite(Date.parse(value))) ms = Math.max(0, Date.parse(value) - Date.now());
  return Math.min(ms, MAX_WAIT_MS);
}

/**
 * The default `fetchJson`: a real bearer GET that throws on a non-2xx Graph
 * response. A 429, 503 or 504 is retried up to three times after the wait
 * {@link retryDelayMs} picks; one that outlasts the retries throws its status like
 * any other failure. A factory rather than a bare function so it can close over the
 * debug sink and the sleep, and emit one `http` event per attempt (ADR-0015 §6).
 * The event carries the host and path shape only, never the populated URL, which
 * carries `$filter`/`$select` query content.
 */
function graphGet(debug: DebugSink = noDebug, sleep = realSleep): FetchJson {
  return async (token: string, url: string): Promise<any> => {
    const u = new URL(url);
    for (let attempt = 0; ; attempt++) {
      // IdType="ImmutableId" (ADR-0018): backend ids survive folder moves, so a mail
      // item's fingerprint is durable across inbox → archive.
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"',
        },
      });
      debug({ kind: "http", source: "graph", method: "GET", host: u.host, pathShape: u.pathname, status: r.status });
      if (RETRYABLE.has(r.status) && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(r.headers.get("retry-after"), attempt));
        continue;
      }
      // Scrub the backend response body: only the HTTP status crosses into the thrown
      // message (ADR-0004 §5). The shared statusOnlyError owns that rule (sources/errors.ts).
      if (!r.ok) throw statusOnlyError("Graph", r);
      return r.json();
    }
  };
}

// ── Graph row shapes (the external HTTP contract, mirrored for mapping + fixtures) ──

interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}
interface GraphEmailAddress {
  name?: string;
  address?: string;
}
interface GraphAttendee {
  type?: unknown;
  status?: { response?: unknown };
  emailAddress?: GraphEmailAddress;
}
interface GraphEvent {
  id?: string;
  type?: unknown;
  subject?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  originalStart?: unknown;
  isAllDay?: unknown;
  showAs?: unknown;
  isCancelled?: unknown;
  isOrganizer?: unknown;
  isOnlineMeeting?: unknown;
  seriesMasterId?: string;
  organizer?: { emailAddress?: GraphEmailAddress };
  attendees?: GraphAttendee[];
  location?: { displayName?: unknown };
  locations?: { locationEmailAddress?: unknown }[];
  responseStatus?: { response?: unknown };
}
interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}
interface GraphMessage {
  id?: string;
  conversationId?: string;
  conversationIndex?: string;
  subject?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bodyPreview?: string;
  importance?: unknown;
  isRead?: unknown;
  hasAttachments?: unknown;
  flag?: { flagStatus?: unknown };
  inferenceClassification?: unknown;
  // The time field is chosen per folder (receivedDateTime | sentDateTime) and read via m[timeField].
  receivedDateTime?: string;
  sentDateTime?: string;
}
interface GraphMe {
  mail?: string | null;
  userPrincipalName?: string | null;
  proxyAddresses?: string[] | null;
}

async function paginate(
  fetchJson: FetchJson,
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<any[]> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const results: any[] = [];
  let data = await fetchJson(token, url.toString());
  results.push(...(data.value ?? []));
  while (data["@odata.nextLink"]) {
    data = await fetchJson(token, data["@odata.nextLink"]);
    results.push(...(data.value ?? []));
  }
  return results;
}

/** Graph returns local wall-time + a timezone; with Prefer UTC the dateTime is UTC. */
function toInstant(dt: GraphDateTime | undefined): string {
  // dateTime like "2026-07-11T09:00:00.0000000" (no offset under Prefer UTC) → mark as Z.
  // An absent one becomes "", which the record builder rejects.
  const base = String(dt?.dateTime ?? "").replace(/\.\d+(Z?)$/, "$1");
  return base === "" || base.endsWith("Z") ? base : `${base}Z`;
}

/** An all-day bound's calendar date: the date part of its midnight `dateTime`. */
function toDate(dt: GraphDateTime | undefined): string {
  return String(dt?.dateTime ?? "").slice(0, 10);
}

/** A closed-enum value Graph sent, or `fallback` when it sent anything else. */
function oneOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  return values.find((x) => x === v) ?? fallback;
}

/**
 * The calendar date of an instant that is some zone's local midnight: the window's
 * start, or an all-day exception's `originalStart`. Sources do no timezone handling, so
 * the date is read by shifting 13 hours east, which names the right day for any zone
 * from UTC−10 to UTC+13.
 */
function dateOfLocalMidnight(instant: string): string {
  return new Date(Date.parse(instant) + 13 * 3_600_000).toISOString().slice(0, 10);
}

const RESPONSES: readonly EventResponse[] = [
  "none",
  "organizer",
  "tentativelyAccepted",
  "accepted",
  "declined",
  "notResponded",
];

function responseOf(v: unknown): EventResponse {
  return oneOf(RESPONSES, v, "none");
}

const SHOW_AS: readonly CalendarEvent["showAs"][] = ["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"];

function showAsOf(v: unknown): CalendarEvent["showAs"] {
  return oneOf(SHOW_AS, v, "unknown");
}

/** An address lowercased for comparison as Exchange compares them. "" when absent. */
function addressKeyOf(address: unknown): string {
  return typeof address === "string" ? address.toLowerCase() : "";
}

/**
 * The series slot a moved exception came from. Only an `exception` whose
 * `originalStart` differs from its start was moved; an exception edited in place
 * keeps its slot and carries none. An all-day exception's `originalStart` is the
 * series' local midnight, so it is compared by date.
 */
function movedFrom(e: GraphEvent, isAllDay: boolean, start: string): string | undefined {
  if (e.type !== "exception" || typeof e.originalStart !== "string") return undefined;
  const original = toInstant({ dateTime: e.originalStart });
  const moved = isAllDay ? dateOfLocalMidnight(original) !== start : Date.parse(original) !== Date.parse(start);
  return moved ? original : undefined;
}

/**
 * The parts of a location that are not room names, or undefined when nothing is left.
 * Outlook writes a multi-room location as the names joined by `; `, so the location is
 * split on `;` and each part compared with the room names, ignoring case and
 * surrounding space.
 */
function placeBeyondRooms(location: unknown, rooms: string[]): string | undefined {
  if (typeof location !== "string") return undefined;
  const names = new Set(rooms.map((r) => r.trim().toLowerCase()));
  const places = location
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !names.has(part.toLowerCase()));
  return places.length > 0 ? places.join("; ") : undefined;
}

/**
 * One Graph event as a {@link CalendarEvent}. Rooms come from two places: attendees of
 * type `resource`, and attendees whose address is one of the event's `locations[]`
 * (a room booked as a location is often listed as a required attendee). Neither ever
 * appears among `attendees`, and a room without a display name is not listed. The
 * location keeps only what it says beyond the room names. Trusted fields fall back to
 * their no-signal value.
 */
function toCalendarEvent(e: GraphEvent, window: Window, me: Set<string>): CalendarEvent {
  const isAllDay = e.isAllDay === true;
  const start = isAllDay ? toDate(e.start) : toInstant(e.start);
  const locationAddresses = new Set(
    (e.locations ?? []).map((l) => addressKeyOf(l?.locationEmailAddress)).filter((a) => a !== ""),
  );
  const isRoom = (a: GraphAttendee) =>
    a.type === "resource" || locationAddresses.has(addressKeyOf(a.emailAddress?.address));
  const attendees = e.attendees ?? [];
  const rooms = attendees
    .filter(isRoom)
    .map((a) => a.emailAddress?.name)
    .filter((name): name is string => typeof name === "string" && name !== "");
  return calendarEventRecord({
    id: e.id,
    groupId: e.seriesMasterId,
    // An all-day event starts on a date, so it is compared with the window's first day.
    continuesFromBefore: isAllDay
      ? start < dateOfLocalMidnight(window.from)
      : Date.parse(start) < Date.parse(window.from),
    isAllDay,
    start,
    end: isAllDay ? toDate(e.end) : toInstant(e.end),
    originalStart: movedFrom(e, isAllDay, start),
    title: e.subject,
    location: placeBeyondRooms(e.location?.displayName, rooms),
    organizer: personOf(e.organizer, me),
    isOrganizer: e.isOrganizer === true,
    attendees: attendees
      .filter((a) => !isRoom(a))
      .map((a) => ({ ...personOf(a, me), response: responseOf(a.status?.response), optional: a.type === "optional" })),
    rooms,
    myResponse: responseOf(e.responseStatus?.response),
    showAs: showAsOf(e.showAs),
    isCancelled: e.isCancelled === true,
    isOnlineMeeting: e.isOnlineMeeting === true,
    recurring: e.type === "occurrence" || e.type === "exception",
  });
}

async function readCalendar(
  fetchJson: FetchJson,
  token: string,
  window: Window,
  meRequest: Promise<Set<string>>,
): Promise<CalendarEvent[]> {
  const [me, events] = await Promise.all([
    meRequest,
    paginate(fetchJson, token, "/me/calendarView", {
      startDateTime: window.from,
      endDateTime: window.to,
      $select:
        "id,type,subject,start,end,originalStart,isAllDay,showAs,isCancelled,isOrganizer,isOnlineMeeting,seriesMasterId,organizer,attendees,location,locations,responseStatus",
      $orderby: "start/dateTime",
      $top: "50",
    }) as Promise<GraphEvent[]>,
  ]);
  return events.map((e) => toCalendarEvent(e, window, me));
}

/** The proxy-address prefix of an SMTP address; `SMTP:` marks the primary, `smtp:` an alias. */
const SMTP_PREFIX = "smtp:";

/** The fixed header length of a mail `conversationIndex`, in bytes. */
const CONVERSATION_INDEX_HEADER_BYTES = 22;

/**
 * The addresses that are the signed-in user, lowercased: `mail`, the UPN and every
 * `smtp:` proxy address (the primary `SMTP:` and its aliases) with the prefix stripped.
 * Other proxy prefixes (X500, SIP, …) are not mail addresses and are skipped. One `/me`
 * call per run, under the existing `User.Read`.
 */
async function readMe(fetchJson: FetchJson, token: string): Promise<Set<string>> {
  const url = new URL(`${BASE}/me`);
  url.searchParams.set("$select", "id,mail,userPrincipalName,proxyAddresses");
  const me = (await fetchJson(token, url.toString())) as GraphMe;
  const addresses = [me.mail, me.userPrincipalName];
  for (const proxy of me.proxyAddresses ?? []) {
    if (typeof proxy === "string" && proxy.toLowerCase().startsWith(SMTP_PREFIX)) {
      addresses.push(proxy.slice(SMTP_PREFIX.length));
    }
  }
  return new Set(
    addresses.filter((a): a is string => typeof a === "string" && a !== "").map((a) => a.toLowerCase()),
  );
}

/** A recipient's address, lowercased for comparison as Exchange compares them. "" when absent. */
function addressKey(r: GraphRecipient | undefined): string {
  return addressKeyOf(r?.emailAddress?.address);
}

/** One recipient, organizer or attendee as a person spec, `isMe` from the `/me` set. */
function personOf(r: GraphRecipient | undefined, me: Set<string>): PersonSpec {
  return { name: r?.emailAddress?.name, handle: r?.emailAddress?.address, isMe: me.has(addressKey(r)) };
}

/**
 * A `conversationIndex` is a 22-byte header plus one 5-byte block per reply, so a
 * longer one means the thread started before this message. Unreadable → false.
 */
function threadStartedBefore(conversationIndex: string | undefined): boolean {
  if (typeof conversationIndex !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(conversationIndex)) return false;
  return Buffer.from(conversationIndex, "base64").length > CONVERSATION_INDEX_HEADER_BYTES;
}

function importanceOf(v: unknown): Email["importance"] {
  return oneOf(["low", "normal", "high"], v, "normal");
}

async function readMailFolder(
  fetchJson: FetchJson,
  token: string,
  folder: "Inbox" | "SentItems",
  timeField: "receivedDateTime" | "sentDateTime",
  window: Window,
): Promise<GraphMessage[]> {
  return (await paginate(fetchJson, token, `/me/mailFolders/${folder}/messages`, {
    $filter: `${timeField} ge ${window.from} and ${timeField} lt ${window.to}`,
    $select: `id,conversationId,conversationIndex,subject,from,sender,toRecipients,ccRecipients,${timeField},bodyPreview,importance,isRead,hasAttachments,flag,inferenceClassification`,
    $orderby: timeField,
    $top: "50",
  })) as GraphMessage[];
}

/**
 * One Graph message as an {@link Email}. Trusted fields are parsed here and fall back
 * to their no-signal value when Graph sends something else: `normal` importance, read,
 * not flagged, no attachments, `focused`.
 */
function toEmail(
  m: GraphMessage,
  folder: Email["folder"],
  timeField: "receivedDateTime" | "sentDateTime",
  me: Set<string>,
): Email {
  return emailRecord({
    id: m.id,
    groupId: m.conversationId,
    continuesFromBefore: threadStartedBefore(m.conversationIndex),
    at: String(m[timeField]),
    folder,
    subject: m.subject,
    from: personOf(m.from, me),
    // Graph's `sender` differs from `from` only for a delegate or a send-on-behalf.
    sentBy: m.sender !== undefined && addressKey(m.sender) !== addressKey(m.from) ? personOf(m.sender, me) : undefined,
    to: (m.toRecipients ?? []).map((r) => personOf(r, me)),
    cc: (m.ccRecipients ?? []).map((r) => personOf(r, me)),
    body: m.bodyPreview,
    importance: importanceOf(m.importance),
    isRead: m.isRead !== false,
    flagged: m.flag?.flagStatus === "flagged",
    hasAttachments: m.hasAttachments === true,
    inferenceClassification: m.inferenceClassification === "other" ? "other" : "focused",
  });
}

async function readMail(
  fetchJson: FetchJson,
  token: string,
  window: Window,
  meRequest: Promise<Set<string>>,
): Promise<Email[]> {
  const [me, inbox, sent] = await Promise.all([
    meRequest,
    readMailFolder(fetchJson, token, "Inbox", "receivedDateTime", window),
    readMailFolder(fetchJson, token, "SentItems", "sentDateTime", window),
  ]);
  return [
    ...inbox.map((m) => toEmail(m, "inbox", "receivedDateTime", me)),
    ...sent.map((m) => toEmail(m, "sent", "sentDateTime", me)),
  ];
}

export class GraphSource implements Source {
  readonly key = "graph";
  readonly label = "Microsoft Graph (calendar + mail)";

  private readonly config: Record<string, unknown>;
  private readonly fetchJson: FetchJson;
  private readonly auth: GraphAuth;
  private readonly debug: DebugSink;

  constructor(options: Record<string, unknown> = {}, deps: GraphDeps = {}) {
    this.config = options;
    this.debug = deps.debug ?? noDebug;
    this.fetchJson = deps.fetchJson ?? graphGet(this.debug, deps.sleep);
    this.auth = deps.auth ?? { azureConfig, signedInAccount, getToken, login: graphLogin };
  }

  async read(window: Window): Promise<SourceRecord[]> {
    const kinds = (this.config.kinds as string[] | undefined) ?? ["event", "message"];
    const token = await this.auth.getToken();
    if (!kinds.includes("event") && !kinds.includes("message")) return [];
    // One `/me` call per run, shared by calendar and mail (ADR-0019 §4).
    const meRequest = readMe(this.fetchJson, token);
    const items: SourceRecord[] = [];
    if (kinds.includes("event")) items.push(...(await readCalendar(this.fetchJson, token, window, meRequest)));
    if (kinds.includes("message")) items.push(...(await readMail(this.fetchJson, token, window, meRequest)));
    return items;
  }

  login(): Promise<string> {
    return this.auth.login();
  }

  async status(): Promise<SourceStatus> {
    if (this.auth.azureConfig() === null) {
      return { state: "not-configured", detail: "set AZURE_TENANT_ID and AZURE_CLIENT_ID" };
    }
    const account = await this.auth.signedInAccount();
    return account ? { state: "ready", identity: account } : { state: "not-authenticated" };
  }
}
