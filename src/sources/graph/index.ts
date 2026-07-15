// The Graph reference Source (ADR-0002): Microsoft 365 calendar + mail, emitting
// kind-tagged NormalizedItems. Calendar events are `event`s; inbox + sent mail
// are `message`s. All backend content is branded Untrusted at this boundary.
//
// Testability seam: every request flows through one injected
// `fetchJson(token, url)` — exactly the shape the real bearer-fetch has — and all
// auth rides a single `deps.auth` bundle defaulting to the real auth.ts functions.
// Pagination (nextLink is a full URL, so the seam speaks URLs), `toInstant` UTC
// normalization, and the calendar/mail mapping all stay inside the module, tested
// through `read()`; the fake is a URL → canned-Graph-JSON map emulating Microsoft's
// published HTTP surface, not this module's private routing.

import type { NormalizedItem, Window } from "../../domain.ts";
import { normalizer, text } from "../normalize.ts";
import { statusOnlyError } from "../errors.ts";
import type { Source, SourceStatus } from "../source.ts";
import { azureConfig, getToken, login as graphLogin, signedInAccount } from "./auth.ts";

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
}

/** The default `fetchJson`: a real bearer GET that throws on a non-2xx Graph response. */
async function graphGet(token: string, url: string): Promise<any> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
  });
  // Scrub the backend response body: only the HTTP status crosses into the thrown
  // message (ADR-0004 §5). The shared statusOnlyError owns that rule (sources/errors.ts).
  if (!r.ok) throw statusOnlyError("Graph", r);
  return r.json();
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
  organizer?: { emailAddress?: GraphEmailAddress };
  attendees?: { type?: string; emailAddress?: GraphEmailAddress }[];
  location?: { displayName?: string };
  categories?: string[];
  responseStatus?: { response?: string };
  webLink?: string;
}
interface GraphMessage {
  id?: string;
  subject?: string;
  from?: { emailAddress?: GraphEmailAddress };
  toRecipients?: { emailAddress?: GraphEmailAddress }[];
  bodyPreview?: string;
  importance?: string;
  isRead?: boolean;
  webLink?: string;
  // The time field is chosen per folder (receivedDateTime | sentDateTime) and read via m[timeField].
  receivedDateTime?: string;
  sentDateTime?: string;
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
      "id,subject,start,end,isAllDay,showAs,isCancelled,organizer,attendees,location,categories,responseStatus,webLink",
    $orderby: "start/dateTime",
    $top: "50",
  })) as GraphEvent[];
  return events.map((e): NormalizedItem => {
    const start = toInstant(e.start) ?? window.from;
    return normalize({
      kind: "event",
      timestamp: start,
      end: toInstant(e.end),
      id: e.id,
      title: e.subject,
      url: e.webLink,
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

async function readMailFolder(
  fetchJson: FetchJson,
  token: string,
  folder: "Inbox" | "SentItems",
  timeField: "receivedDateTime" | "sentDateTime",
  window: Window,
): Promise<NormalizedItem[]> {
  const messages = (await paginate(fetchJson, token, `/me/mailFolders/${folder}/messages`, {
    $filter: `${timeField} ge ${window.from} and ${timeField} lt ${window.to}`,
    $select: `id,subject,from,toRecipients,${timeField},bodyPreview,importance,isRead,webLink`,
    $orderby: timeField,
    $top: "50",
  })) as GraphMessage[];
  const direction = folder === "Inbox" ? "inbox" : "sent";
  return messages.map((m): NormalizedItem =>
    normalize({
      kind: "message",
      timestamp: String(m[timeField]),
      id: m.id,
      title: m.subject,
      url: m.webLink,
      extras: {
        folder: direction,
        from: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address,
        to: (m.toRecipients ?? []).map((r) => r.emailAddress?.name ?? r.emailAddress?.address),
        preview: text(m.bodyPreview),
        // Domain judgment stays caller-side: "normal" importance is the default, not signal.
        importance: m.importance !== "normal" ? m.importance : undefined,
        unread: m.isRead === false,
      },
    }),
  );
}

export class GraphSource implements Source {
  readonly key = "graph";
  readonly label = "Microsoft Graph (calendar + mail)";
  readonly options = {
    kinds: {
      type: "string[]" as const,
      enum: ["event", "message"] as const,
      description: 'Which kinds to pull. Options: "event", "message". Omit for both.',
    },
  };

  private readonly fetchJson: FetchJson;
  private readonly auth: GraphAuth;

  constructor(deps: GraphDeps = {}) {
    this.fetchJson = deps.fetchJson ?? graphGet;
    this.auth = deps.auth ?? { azureConfig, signedInAccount, getToken, login: graphLogin };
  }

  async read(window: Window, options: Record<string, unknown>): Promise<NormalizedItem[]> {
    const kinds = (options.kinds as string[] | undefined) ?? ["event", "message"];
    const token = await this.auth.getToken();
    const items: NormalizedItem[] = [];
    if (kinds.includes("event")) items.push(...(await readCalendar(this.fetchJson, token, window)));
    if (kinds.includes("message")) {
      const [inbox, sent] = await Promise.all([
        readMailFolder(this.fetchJson, token, "Inbox", "receivedDateTime", window),
        readMailFolder(this.fetchJson, token, "SentItems", "sentDateTime", window),
      ]);
      items.push(...inbox, ...sent);
    }
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
