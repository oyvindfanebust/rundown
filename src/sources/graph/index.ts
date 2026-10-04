// The Graph reference Source (ADR-0002, ADR-0019): Microsoft 365 calendar + mail.
// Inbox and sent mail are typed `Email` records; calendar events are still
// `event` NormalizedItems until they move to records (#148). All backend content is
// branded Untrusted at this boundary.
//
// Testability seam: every request flows through one injected
// `fetchJson(token, url)` — exactly the shape the real bearer-fetch has — and all
// auth rides a single `deps.auth` bundle defaulting to the real auth.ts functions.
// Pagination (nextLink is a full URL, so the seam speaks URLs), `toInstant` UTC
// normalization, and the calendar/mail mapping all stay inside the module, tested
// through `read()`; the fake is a URL → canned-Graph-JSON map emulating Microsoft's
// published HTTP surface, not this module's private routing.

import type { BundleItem, Email, NormalizedItem, Window } from "../../domain.ts";
import { emailRecord, normalizer, type PersonSpec } from "../normalize.ts";
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

// One normalizer for the whole source — calendar and mail mappers share it.
const normalize = normalizer("graph", { untitled: "(no subject)" });

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
}

/**
 * The default `fetchJson`: a real bearer GET that throws on a non-2xx Graph
 * response. A factory rather than a bare function so it can close over the debug
 * sink and emit one `http` event per request (ADR-0015 §6) — host and path shape
 * only, never the populated URL, which carries `$filter`/`$select` query content.
 */
function graphGet(debug: DebugSink = noDebug): FetchJson {
  return async (token: string, url: string): Promise<any> => {
    // IdType="ImmutableId" (ADR-0018): backend ids survive folder moves, so a mail
    // item's fingerprint is durable across inbox → archive.
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"',
      },
    });
    const u = new URL(url);
    debug({ kind: "http", source: "graph", method: "GET", host: u.host, pathShape: u.pathname, status: r.status });
    // Scrub the backend response body: only the HTTP status crosses into the thrown
    // message (ADR-0004 §5). The shared statusOnlyError owns that rule (sources/errors.ts).
    if (!r.ok) throw statusOnlyError("Graph", r);
    return r.json();
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
interface GraphEvent {
  id?: string;
  subject?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  showAs?: string;
  isCancelled?: boolean;
  seriesMasterId?: string;
  organizer?: { emailAddress?: GraphEmailAddress };
  attendees?: { type?: string; emailAddress?: GraphEmailAddress }[];
  location?: { displayName?: string };
  categories?: string[];
  responseStatus?: { response?: string };
  webLink?: string;
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
function toInstant(dt: GraphDateTime | undefined): string | undefined {
  if (!dt?.dateTime) return undefined;
  // dateTime like "2026-07-11T09:00:00.0000000" (no offset under Prefer UTC) → mark as Z.
  const base = dt.dateTime.replace(/\.\d+$/, "");
  return base.endsWith("Z") ? base : `${base}Z`;
}

async function readCalendar(fetchJson: FetchJson, token: string, window: Window): Promise<NormalizedItem[]> {
  const events = (await paginate(fetchJson, token, "/me/calendarView", {
    startDateTime: window.from,
    endDateTime: window.to,
    $select:
      "id,subject,start,end,isAllDay,showAs,isCancelled,seriesMasterId,organizer,attendees,location,categories,responseStatus,webLink",
    $orderby: "start/dateTime",
    $top: "50",
  })) as GraphEvent[];
  return events.map((e): NormalizedItem => {
    const start = toInstant(e.start) ?? window.from;
    return normalize({
      kind: "event",
      timestamp: start,
      end: toInstant(e.end),
      // All-day bounds are UTC midnights encoding calendar dates, not clock times.
      dateOnly: e.isAllDay === true,
      id: e.id,
      title: e.subject,
      url: e.webLink,
      // An event has no honest container, so it carries no `where` (#54). `location` is
      // a physical place, not the thing the item lives in, and a calendar title
      // describes itself — the asymmetry with a chat message that #54 opens with.
      // Filling the slot anyway would make the caption lie about what it means.
      // Organizer leads `who`: they own the meeting, attendees are context.
      // `who` is uncapped here by design (#86). The source reports the real roster;
      // the Brief's caption bounds are applied once, at the Brief boundary in plan.ts,
      // so every source gets the same treatment. Do not re-add a cap here.
      attribution: {
        who: [
          e.organizer?.emailAddress?.name,
          ...(e.attendees ?? [])
            .filter((a) => a.type !== "resource")
            .map((a) => a.emailAddress?.name),
        ],
      },
      extras: {
        organizer: e.organizer?.emailAddress?.name,
        attendees: (e.attendees ?? [])
          .filter((a) => a.type !== "resource")
          .map((a) => a.emailAddress?.name),
        location: e.location?.displayName,
        showAs: e.showAs,
        allDay: e.isAllDay,
        cancelled: e.isCancelled,
        myResponse: e.responseStatus?.response,
        categories: e.categories,
      },
    });
  });
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
  const address = r?.emailAddress?.address;
  return typeof address === "string" ? address.toLowerCase() : "";
}

/** One recipient as a person spec, `isMe` from the `/me` set. */
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
  return v === "low" || v === "high" ? v : "normal";
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

async function readMail(fetchJson: FetchJson, token: string, window: Window): Promise<Email[]> {
  const [me, inbox, sent] = await Promise.all([
    readMe(fetchJson, token),
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
    this.fetchJson = deps.fetchJson ?? graphGet(this.debug);
    this.auth = deps.auth ?? { azureConfig, signedInAccount, getToken, login: graphLogin };
  }

  async read(window: Window): Promise<BundleItem[]> {
    const kinds = (this.config.kinds as string[] | undefined) ?? ["event", "message"];
    const token = await this.auth.getToken();
    const items: BundleItem[] = [];
    if (kinds.includes("event")) items.push(...(await readCalendar(this.fetchJson, token, window)));
    if (kinds.includes("message")) items.push(...(await readMail(this.fetchJson, token, window)));
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
