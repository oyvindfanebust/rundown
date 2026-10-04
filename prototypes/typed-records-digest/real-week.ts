// PROTOTYPE (map #117, ticket #122). Throwaway. Pulls one real week from Graph, maps it
// to the prototype digest (code-filled parts only: no model summaries, no plan items),
// and writes an HTML page comparing each digest entry with the raw Graph objects it was
// built from. Output contains real mail and calendar data: it goes to OUT_DIR, outside
// the repo. Never commit or publish it.
//
//   OUT_DIR=/some/dir bun prototypes/typed-records-digest/real-week.ts [from] [to]

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getToken } from "../../src/sources/graph/auth.ts";
import type { CalendarEntry, MailEntry, Occurrence } from "./output.ts";

const TZ = "Europe/Oslo";
const FROM = process.argv[2] ?? "2026-09-27T22:00:00Z"; // Mon 28 Sep 00:00 Oslo
const TO = process.argv[3] ?? "2026-10-04T22:00:00Z"; // Mon 5 Oct 00:00 Oslo
const OUT_DIR = process.env.OUT_DIR ?? "./real-week-out";
const BASE = "https://graph.microsoft.com/v1.0";
const LABEL_MAX = 120;
const WHO_MAX = 8;

// ── Graph ──

const token = await getToken();

async function get(url: string): Promise<any> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' },
  });
  if (!r.ok) throw new Error(`Graph ${r.status} on ${new URL(url).pathname}`);
  return r.json();
}

async function all(path: string, params: Record<string, string>): Promise<any[]> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const out: any[] = [];
  let data = await get(url.toString());
  out.push(...(data.value ?? []));
  while (data["@odata.nextLink"]) {
    data = await get(data["@odata.nextLink"]);
    out.push(...(data.value ?? []));
  }
  return out;
}

const me = await get(`${BASE}/me?$select=id,mail,userPrincipalName,proxyAddresses`);
const events = await all("/me/calendarView", {
  startDateTime: FROM,
  endDateTime: TO,
  $select:
    "id,type,subject,start,end,originalStart,isAllDay,showAs,isCancelled,seriesMasterId,organizer,isOrganizer,attendees,location,locations,responseStatus,isOnlineMeeting",
  $orderby: "start/dateTime",
  $top: "50",
});
const mailSelect = (timeField: string) =>
  `id,conversationId,conversationIndex,subject,from,sender,toRecipients,ccRecipients,${timeField},bodyPreview,importance,isRead,flag,hasAttachments`;
const inbox = await all("/me/mailFolders/Inbox/messages", {
  $filter: `receivedDateTime ge ${FROM} and receivedDateTime lt ${TO}`,
  $select: mailSelect("receivedDateTime"),
  $top: "50",
});
const sent = await all("/me/mailFolders/SentItems/messages", {
  $filter: `sentDateTime ge ${FROM} and sentDateTime lt ${TO}`,
  $select: mailSelect("sentDateTime"),
  $top: "50",
});

// ── Helpers ──

const myAddresses = new Set<string>(
  [me.mail, me.userPrincipalName, ...((me.proxyAddresses ?? []) as string[])
    .filter((p) => p.toLowerCase().startsWith("smtp:"))
    .map((p) => p.slice(5))]
    .filter(Boolean)
    .map((a: string) => a.toLowerCase()),
);
const isMe = (addr?: string) => !!addr && myAddresses.has(addr.toLowerCase());

const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function defang(t: string): string {
  return t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https:\/\//gi, "hxxps://")
    .replace(/http:\/\//gi, "hxxp://");
}
const label = (t?: string) => (t ? defang(t).slice(0, LABEL_MAX) : undefined);

/** An instant rendered in TZ with its offset, e.g. 2026-10-01T13:00:00+02:00. */
function zoned(iso: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const off = Math.round((local - d.getTime()) / 60000);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

const rank = { low: 0, normal: 1, high: 2 } as const;

// ── Mail → entries ──

type Raw = Record<string, any>;
interface MailRec { raw: Raw; folder: "inbox" | "sent"; at: string; byMe: boolean }

const mailRecs: MailRec[] = [
  ...inbox.map((raw): MailRec => ({ raw, folder: "inbox", at: raw.receivedDateTime, byMe: false })),
  ...sent.map((raw): MailRec => ({ raw, folder: "sent", at: raw.sentDateTime, byMe: false })),
];
for (const r of mailRecs) {
  r.byMe = isMe(r.raw.from?.emailAddress?.address) || isMe(r.raw.sender?.emailAddress?.address);
}

const threads = new Map<string, MailRec[]>();
for (const r of mailRecs) {
  const key = r.raw.conversationId ?? r.raw.id;
  // Sent mail also lands in Inbox when you mail yourself: dedup by id within a thread.
  const list = threads.get(key) ?? [];
  if (!list.some((x) => x.raw.id === r.raw.id)) list.push(r);
  threads.set(key, list);
}

interface Pair<E> { entry: E; raw: Raw[] }

const mailEntries: Pair<MailEntry>[] = [...threads.entries()].map(([convId, recs]) => {
  recs.sort((a, b) => a.at.localeCompare(b.at));
  const last = recs[recs.length - 1]!;
  // People other than the user: last sender first, then other senders newest first, then recipients.
  const seen = new Set<string>();
  const people: string[] = [];
  const add = (ea?: { name?: string; address?: string }) => {
    const addr = ea?.address?.toLowerCase();
    if (!addr || isMe(addr) || seen.has(addr)) return;
    seen.add(addr);
    people.push(ea?.name || addr.split("@")[0]!);
  };
  for (const r of [...recs].reverse()) add(r.raw.from?.emailAddress);
  for (const r of [...recs].reverse())
    for (const p of [...(r.raw.toRecipients ?? []), ...(r.raw.ccRecipients ?? [])]) add(p.emailAddress);
  const continues = recs.some((r) => {
    const idx = r.raw.conversationIndex as string | undefined;
    return !!idx && Buffer.from(idx, "base64").length > 22;
  });
  const importance = recs.reduce<"low" | "normal" | "high">(
    (m, r) => (rank[r.raw.importance as keyof typeof rank] > rank[m] ? r.raw.importance : m),
    "low",
  );
  const lastFrom = last.byMe ? undefined : label(last.raw.from?.emailAddress?.name ?? last.raw.from?.emailAddress?.address);
  const entry: MailEntry = {
    type: "mail-thread",
    fingerprint: digest(`graph\nmessage-series\n${convId}`),
    meta: {
      messages: recs.length,
      fromMe: recs.filter((r) => r.byMe).length,
      firstAt: zoned(recs[0]!.at),
      lastAt: zoned(last.at),
      lastFromMe: last.byMe,
      continuesFromBefore: continues,
      others: people.length,
      unread: recs.filter((r) => r.folder === "inbox" && r.raw.isRead === false).length,
      importance,
      flagged: recs.some((r) => r.raw.flag?.flagStatus === "flagged"),
      hasAttachments: recs.some((r) => r.raw.hasAttachments === true),
    },
    labels: {
      subject: label(last.raw.subject) ?? "(no subject)",
      ...(lastFrom ? { lastFrom } : {}),
      people: people.slice(0, WHO_MAX).map((p) => label(p)!),
    },
    summary: "(not generated: summaries are #123)",
  };
  return { entry, raw: recs.map((r) => ({ _folder: r.folder, ...r.raw })) };
});
mailEntries.sort((a, b) => b.entry.meta.lastAt.localeCompare(a.entry.meta.lastAt));

// ── Calendar → entries ──
//
// Rooms are split from people (the user's call on #122): an attendee is a room when Graph
// types it `resource`, or when its address is one of the event's `locations[]`. Rooms go
// to `labels.rooms`, never to `people` or `others`.

const series = new Map<string, Raw[]>();
for (const e of events) {
  const key = e.seriesMasterId ?? e.id;
  series.set(key, [...(series.get(key) ?? []), e]);
}

const day = (dt?: { dateTime?: string }) => (dt?.dateTime ?? "").slice(0, 10);
const inst = (dt?: { dateTime?: string }) => zoned((dt?.dateTime ?? "").replace(/\.\d+$/, ""));

// Extended entry type: the prototype's CalendarEntry plus the room split proposed here.
type CalendarEntryWithRooms = CalendarEntry & { labels: CalendarEntry["labels"] & { rooms?: string[] } };

const calendarEntries: Pair<CalendarEntryWithRooms>[] = [...series.entries()].map(([key, occ]) => {
  const first = occ[0]!;
  const recurring = !!first.seriesMasterId;
  const roomAddrs = new Set<string>();
  const rooms: string[] = [];
  for (const e of occ) {
    for (const l of e.locations ?? []) {
      const a = (l.locationEmailAddress ?? l.locationUri)?.toLowerCase();
      if (a && a.includes("@")) roomAddrs.add(a);
    }
    for (const a of e.attendees ?? []) {
      if (a.type === "resource" && a.emailAddress?.address) roomAddrs.add(a.emailAddress.address.toLowerCase());
    }
  }
  const seen = new Set<string>();
  const people: string[] = [];
  const organizerAddr = first.organizer?.emailAddress?.address?.toLowerCase();
  const orgIsMe = first.isOrganizer === true || isMe(organizerAddr);
  for (const e of occ) {
    for (const a of [{ emailAddress: e.organizer?.emailAddress }, ...(e.attendees ?? [])]) {
      const addr = a.emailAddress?.address?.toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      if (roomAddrs.has(addr)) {
        rooms.push(a.emailAddress?.name || addr.split("@")[0]!);
        continue;
      }
      if (isMe(addr)) continue;
      people.push(a.emailAddress?.name || addr.split("@")[0]!);
    }
  }
  const occurrences: Occurrence[] = occ.map((e) => ({
    start: e.isAllDay ? day(e.start) : inst(e.start),
    end: e.isAllDay ? day(e.end) : inst(e.end),
    myResponse: e.responseStatus?.response ?? "none",
    showAs: e.showAs ?? "unknown",
    cancelled: e.isCancelled === true,
    moved: e.type === "exception" && !!e.originalStart &&
      Date.parse(e.originalStart) !== Date.parse(`${(e.start?.dateTime ?? "").replace(/\.\d+$/, "")}Z`),
  }));
  const location = label(first.location?.displayName);
  const entry: CalendarEntryWithRooms = {
    type: "calendar",
    fingerprint: digest(`graph\n${recurring ? "event-series" : "event"}\n${key}`),
    meta: {
      recurring,
      isAllDay: first.isAllDay === true,
      isOrganizer: orgIsMe,
      isOnlineMeeting: first.isOnlineMeeting === true,
      continuesFromBefore: occ.some((e) => Date.parse(`${(e.start?.dateTime ?? "").replace(/\.\d+$/, "")}Z`) < Date.parse(FROM)),
      others: people.length,
      occurrences,
    },
    labels: {
      title: label(first.subject) ?? "(no subject)",
      ...(location ? { location } : {}),
      ...(rooms.length ? { rooms: rooms.map((r) => label(r)!) } : {}),
      ...(!orgIsMe && first.organizer?.emailAddress?.name ? { organizer: label(first.organizer.emailAddress.name)! } : {}),
      people: people.slice(0, WHO_MAX).map((p) => label(p)!),
    },
  };
  return { entry, raw: occ };
});
calendarEntries.sort((a, b) => a.entry.meta.occurrences[0]!.start.localeCompare(b.entry.meta.occurrences[0]!.start));

// ── Output ──

const output = {
  envelope: {
    window: { from: zoned(FROM), to: zoned(TO) },
    timezone: TZ,
    counts: [
      { source: "graph", type: "calendar", records: events.length, entries: calendarEntries.length },
      { source: "graph", type: "mail", records: mailRecs.length, entries: mailEntries.length },
    ],
  },
  summary: "(not generated: needs the Summarizer)",
  plan: [],
  digest: {
    calendar: calendarEntries.map((p) => p.entry),
    mail: mailEntries.map((p) => p.entry),
    chat: [],
  },
};

const raw = { me, calendarView: events, inbox, sent };
const pairs = {
  calendar: calendarEntries,
  mail: mailEntries,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "output.json"), JSON.stringify(output, null, 2));
await writeFile(join(OUT_DIR, "graph-raw.json"), JSON.stringify(raw, null, 2));

const page = (await Bun.file(new URL("./real-week.html", import.meta.url)).text()).replace(
  "/*DATA*/null",
  JSON.stringify({ output, raw, pairs, meSummary: {
    proxyAddressesReturned: Array.isArray(me.proxyAddresses) && me.proxyAddresses.length > 0,
  } }).replace(/</g, "\\u003c"),
);
await writeFile(join(OUT_DIR, "real-week.html"), page);

const bytes = (v: unknown) => JSON.stringify(v).length;
console.log(JSON.stringify({
  events: events.length, inbox: inbox.length, sent: sent.length,
  calendarEntries: calendarEntries.length, mailEntries: mailEntries.length,
  roomsFound: calendarEntries.filter((p) => p.entry.labels.rooms).length,
  outputBytes: bytes(output), rawBytes: bytes(raw),
  proxyAddressesReturned: Array.isArray(me.proxyAddresses) && me.proxyAddresses.length > 0,
}));
