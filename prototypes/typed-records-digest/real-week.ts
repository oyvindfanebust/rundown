// PROTOTYPE (map #117, tickets #122 and #130). Throwaway. Pulls one real week from Graph and Slack, maps it
// to the prototype digest (code-filled parts only: no model summaries, no plan items),
// and writes an HTML page comparing each digest entry with the raw Graph objects it was
// built from. Output contains real mail and calendar data: it goes to OUT_DIR, outside
// the repo. Never commit or publish it.
//
//   OUT_DIR=/some/dir bun prototypes/typed-records-digest/real-week.ts [from] [to]

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getToken } from "../../src/sources/graph/auth.ts";
import type { Meeting, MailThread, Occurrence, Output, YourResponse, ShowAs } from "./output.ts";
import { LABEL_MAX, TITLE_MAX, TZ, WHO_MAX, clampPeople, digest, label, zoned, type Pair, type Raw } from "./shape.ts";
import { slackWeek } from "./slack-week.ts";

const FROM = process.argv[2] ?? "2026-09-27T22:00:00Z"; // Mon 28 Sep 00:00 Oslo
const TO = process.argv[3] ?? "2026-10-04T22:00:00Z"; // Mon 5 Oct 00:00 Oslo
const OUT_DIR = process.env.OUT_DIR ?? "./real-week-out";
const BASE = "https://graph.microsoft.com/v1.0";

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

// ── Mail → threads ──

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
  // Mail to yourself lands in both folders: dedup by id within a thread.
  const list = threads.get(key) ?? [];
  if (!list.some((x) => x.raw.id === r.raw.id)) list.push(r);
  threads.set(key, list);
}

// Merge threads that a sender started under the same subject (the user's call on #122):
// repeated notices arrive as separate conversations, one entry each otherwise. A thread's
// sender and subject are its earliest message's; "Re:"/"Fw:" prefixes are stripped. The
// merged entry keeps the earliest thread's id.
const baseSubject = (s?: string) =>
  (s ?? "").replace(/^((re|fw|fwd|sv|vs|vb|aw|wg)\s*:\s*)+/i, "").trim().toLowerCase();
interface Group { convId: string; recs: MailRec[]; threads: number }
const groups = new Map<string, Group>();
for (const [convId, recs] of [...threads.entries()]
  .map(([k, rs]) => [k, [...rs].sort((a, b) => a.at.localeCompare(b.at))] as const)
  .sort((a, b) => a[1][0]!.at.localeCompare(b[1][0]!.at))) {
  const first = recs[0]!;
  const sender = first.raw.from?.emailAddress?.address?.toLowerCase() ?? "";
  const key = sender ? `${sender}\n${baseSubject(first.raw.subject)}` : `thread\n${convId}`;
  const g = groups.get(key);
  if (g) {
    g.recs.push(...recs);
    g.threads++;
  } else groups.set(key, { convId, recs: [...recs], threads: 1 });
}

/** Collects people other than the user, deduped by address, in insertion order. */
function peopleList() {
  const seen = new Set<string>();
  const names: string[] = [];
  return {
    names,
    add(ea?: { name?: string; address?: string }, skip?: Set<string>) {
      const addr = ea?.address?.toLowerCase();
      if (!addr || isMe(addr) || seen.has(addr) || skip?.has(addr)) return;
      seen.add(addr);
      names.push(ea?.name || addr.split("@")[0]!);
    },
  };
}

const mailEntries: Pair<MailThread>[] = [...groups.values()].map(({ convId, recs, threads: threadCount }) => {
  recs.sort((a, b) => a.at.localeCompare(b.at));
  const last = recs[recs.length - 1]!;
  const people = peopleList();
  for (const r of [...recs].reverse()) people.add(r.raw.from?.emailAddress);
  for (const r of [...recs].reverse())
    for (const p of [...(r.raw.toRecipients ?? []), ...(r.raw.ccRecipients ?? [])]) people.add(p.emailAddress);
  const fromYou = recs.filter((r) => r.byMe).length;
  const unread = recs.filter((r) => r.folder === "inbox" && r.raw.isRead === false).length;
  const imp = new Set(recs.map((r) => r.raw.importance));
  const importance = imp.has("high") ? "high" : imp.size === 1 && imp.has("low") ? "low" : undefined;
  const continues = recs.some((r) => {
    const idx = r.raw.conversationIndex as string | undefined;
    return !!idx && Buffer.from(idx, "base64").length > 22;
  });
  const entry = {
    id: digest(`graph\nmessage-series\n${convId}`),
    type: "mail",
    subject: label(last.raw.subject, TITLE_MAX) ?? "(no subject)",
    messages: recs.length,
    ...(threadCount > 1 ? { threads: threadCount } : {}),
    ...(fromYou ? { fromYou } : {}),
    firstAt: zoned(recs[0]!.at),
    lastAt: zoned(last.at),
    ...(last.byMe
      ? { lastFromYou: true }
      : { lastFrom: label(last.raw.from?.emailAddress?.name ?? last.raw.from?.emailAddress?.address) ?? "(unknown)" }),
    ...clampPeople(people.names, "people", "morePeople"),
    ...(unread ? { unread } : {}),
    ...(importance ? { importance } : {}),
    ...(recs.some((r) => r.raw.flag?.flagStatus === "flagged") ? { flagged: true } : {}),
    ...(recs.some((r) => r.raw.hasAttachments === true) ? { attachments: true } : {}),
    ...(continues ? { continuesFromBefore: true } : {}),
    summary: "(not generated: summaries are #123)",
  } as MailThread;
  return { entry, raw: recs.map((r) => ({ _folder: r.folder, ...r.raw })) };
});
mailEntries.sort((a, b) => b.entry.lastAt.localeCompare(a.entry.lastAt));

// ── Calendar → meetings ──
//
// Rooms are split from people (the user's call on #122): an attendee is a room when Graph
// types it `resource`, or when its address is one of the event's `locations[]`.

const series = new Map<string, Raw[]>();
for (const e of events) {
  const key = e.seriesMasterId ?? e.id;
  series.set(key, [...(series.get(key) ?? []), e]);
}

const day = (dt?: { dateTime?: string }) => (dt?.dateTime ?? "").slice(0, 10);
const utc = (dt?: { dateTime?: string }) => `${(dt?.dateTime ?? "").replace(/\.\d+$/, "")}Z`;
const response = (r?: string): YourResponse | undefined =>
  r === "accepted" ? "accepted" : r === "tentativelyAccepted" ? "tentative" : r === "declined" ? "declined"
    : r === "notResponded" ? "notResponded" : undefined; // "organizer" and "none" say nothing
const showAs = (s?: string): ShowAs | undefined =>
  s === "free" || s === "tentative" || s === "oof" || s === "workingElsewhere" ? s : undefined;

const meetingEntries: Pair<Meeting>[] = [...series.entries()].map(([key, occ]) => {
  occ.sort((a, b) => utc(a.start).localeCompare(utc(b.start)));
  const first = occ[0]!;
  const recurring = !!first.seriesMasterId;
  const allDay = first.isAllDay === true;
  const at = (dt: any) => (allDay ? day(dt) : zoned(utc(dt)));

  const roomAddrs = new Set<string>();
  for (const e of occ) {
    for (const l of e.locations ?? []) {
      const a = (l.locationEmailAddress ?? l.locationUri)?.toLowerCase();
      if (a?.includes("@")) roomAddrs.add(a);
    }
    for (const a of e.attendees ?? [])
      if (a.type === "resource" && a.emailAddress?.address) roomAddrs.add(a.emailAddress.address.toLowerCase());
  }
  const rooms: string[] = [];
  const roomSeen = new Set<string>();
  const people = peopleList();
  const youOrganize = first.isOrganizer === true || isMe(first.organizer?.emailAddress?.address);
  for (const e of occ) {
    for (const a of [{ emailAddress: e.organizer?.emailAddress }, ...(e.attendees ?? [])]) {
      const addr = a.emailAddress?.address?.toLowerCase();
      if (addr && roomAddrs.has(addr)) {
        if (!roomSeen.has(addr)) { roomSeen.add(addr); rooms.push(a.emailAddress?.name || addr.split("@")[0]!); }
        continue;
      }
      people.add(a.emailAddress, roomAddrs);
    }
  }
  // Location text that only names the rooms adds nothing.
  const loc = first.location?.displayName as string | undefined;
  const locParts = (loc ?? "").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const location = locParts.length && !locParts.every((p) => rooms.some((r) => r.toLowerCase() === p)) ? label(loc) : undefined;

  // The series' response is the most common one; an occurrence repeats it only when it differs.
  const responses = occ.map((e) => response(e.responseStatus?.response));
  const tally = new Map<string, number>();
  for (const r of responses) if (r) tally.set(r, (tally.get(r) ?? 0) + 1);
  const yourResponse = youOrganize ? undefined : ([...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as YourResponse | undefined);

  const base = {
    id: digest(`graph\n${recurring ? "event-series" : "event"}\n${key}`),
    type: "meeting",
    title: label(first.subject, TITLE_MAX) ?? "(no subject)",
    ...(allDay ? { allDay: true } : {}),
    ...(rooms.length ? { rooms: rooms.map((r) => label(r)!) } : {}),
    ...(location ? { location } : {}),
    ...(first.isOnlineMeeting ? { online: true } : {}),
    ...(youOrganize ? { youOrganize: true } : first.organizer?.emailAddress?.name ? { organizer: label(first.organizer.emailAddress.name)! } : {}),
    ...(yourResponse ? { yourResponse } : {}),
    ...(showAs(first.showAs) ? { showAs: showAs(first.showAs) } : {}),
    ...clampPeople(people.names, "attendees", "moreAttendees"),
    ...(Date.parse(utc(first.start)) < Date.parse(FROM) ? { continuesFromBefore: true } : {}),
  };
  const entry = recurring
    ? ({
        ...base,
        recurring: true,
        occurrences: occ.map((e, i): Occurrence => {
          const moved = e.type === "exception" && e.originalStart && Date.parse(e.originalStart) !== Date.parse(utc(e.start));
          return {
            start: at(e.start),
            end: at(e.end),
            ...(e.isCancelled ? { cancelled: true } : {}),
            ...(moved ? { movedFrom: zoned(e.originalStart) } : {}),
            ...(!youOrganize && responses[i] && responses[i] !== yourResponse ? { yourResponse: responses[i] } : {}),
          };
        }),
      } as Meeting)
    : ({
        ...base,
        start: at(first.start),
        end: at(first.end),
        ...(first.isCancelled ? { cancelled: true } : {}),
      } as Meeting);
  return { entry, raw: occ };
});
const startOf = (m: Meeting) => ("occurrences" in m ? m.occurrences[0]!.start : m.start);
meetingEntries.sort((a, b) => startOf(a.entry).localeCompare(startOf(b.entry)));

// ── Slack → chat (#130) ──

const slack = await slackWeek(FROM, TO);
const chatEntries = slack?.pairs ?? [];

// ── Output ──

const output: Output = {
  window: { from: zoned(FROM), to: zoned(TO) },
  timezone: TZ,
  counts: {
    meetings: { records: events.length, entries: meetingEntries.length },
    mail: { records: mailRecs.length, entries: mailEntries.length },
    chat: { records: slack?.raw.matches.length ?? 0, entries: chatEntries.length },
  },
  summary: "(not generated: needs the Summarizer)",
  meetings: meetingEntries.map((p) => p.entry),
  mail: mailEntries.map((p) => p.entry),
  chat: chatEntries.map((p) => p.entry),
};

const raw = { me, calendarView: events, inbox, sent, slack: slack?.raw };
const pairs = { meetings: meetingEntries, mail: mailEntries, chat: chatEntries };

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "output.json"), JSON.stringify(output, null, 2));
await writeFile(join(OUT_DIR, "graph-raw.json"), JSON.stringify(raw, null, 2));

const page = (await Bun.file(new URL("./real-week.html", import.meta.url)).text()).replace(
  "/*DATA*/null",
  JSON.stringify({ output, raw, pairs, slackStats: slack?.stats ?? null, proxyAddressesReturned: Array.isArray(me.proxyAddresses) && me.proxyAddresses.length > 0 })
    .replace(/</g, "\\u003c"),
);
await writeFile(join(OUT_DIR, "real-week.html"), page);

const bytes = (v: unknown) => JSON.stringify(v).length;
console.log(JSON.stringify({
  events: events.length, inbox: inbox.length, sent: sent.length,
  meetings: meetingEntries.length, mailThreads: mailEntries.length, chat: chatEntries.length,
  meetingsWithRooms: meetingEntries.filter((p) => p.entry.rooms).length,
  outputBytes: bytes(output), rawBytes: bytes(raw),
}));
