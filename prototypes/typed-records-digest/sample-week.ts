// PROTOTYPE (map #117, ticket #122). A synthetic week, typed against output.ts so the
// sample cannot drift from the types. `bun prototypes/typed-records-digest/emit.ts`
// writes it to sample-week.json. People and content are invented.
//
// A real week has about 105 mail, 35 chat and 20–35 calendar entries (#119, #120);
// this is a slice of four per type, chosen to show the awkward cases.

import type { Output } from "./output.ts";

export const sampleWeek = {
  envelope: {
    window: { from: "2026-09-28T00:00:00+02:00", to: "2026-10-05T00:00:00+02:00" },
    timezone: "Europe/Oslo",
    counts: [
      { source: "graph", type: "calendar", records: 8, entries: 4 },
      { source: "graph", type: "mail", records: 7, entries: 4 },
      { source: "slack", type: "chat", records: 33, entries: 4 },
    ],
  },
  summary:
    "A meeting-heavy week. You run the architecture review on Thursday and owe Acme an answer on the contract renewal. The Q4 budget thread is waiting on Grace. Friday's standup moved to 10:00.",
  plan: [
    {
      kind: "commitment",
      summary: "Run the architecture review; Ada asked for the event-store proposal to go first.",
      when: "Thu 13:00",
      entries: ["7c1e04b9a2d35f81", "b40e9d2c7a61f358"],
    },
    {
      kind: "task",
      summary: "Answer Acme on the renewal terms; Katherine wants a yes or no on the three-year option.",
      when: "by Fri",
      entries: ["e2a9c4417b0d6f35", "5d8f31c0e94a7b26"],
    },
    {
      kind: "waiting",
      summary: "Grace owes the revised Q4 budget figures after your Wednesday reply.",
      entries: ["3f6b2a90d1c4e758"],
    },
    {
      kind: "fyi",
      summary: "Friday standup moved from 09:00 to 10:00; Thursday's was cancelled.",
      entries: ["9a04c7e2f15b3d68"],
    },
  ],
  digest: {
    calendar: [
      {
        type: "calendar",
        fingerprint: "9a04c7e2f15b3d68",
        meta: {
          recurring: true,
          isAllDay: false,
          isOrganizer: false,
          isOnlineMeeting: true,
          continuesFromBefore: false,
          others: 5,
          occurrences: [
            { start: "2026-09-28T09:00:00+02:00", end: "2026-09-28T09:15:00+02:00", myResponse: "accepted", showAs: "busy", cancelled: false, moved: false },
            { start: "2026-09-29T09:00:00+02:00", end: "2026-09-29T09:15:00+02:00", myResponse: "accepted", showAs: "busy", cancelled: false, moved: false },
            { start: "2026-09-30T09:00:00+02:00", end: "2026-09-30T09:15:00+02:00", myResponse: "accepted", showAs: "busy", cancelled: false, moved: false },
            { start: "2026-10-01T09:00:00+02:00", end: "2026-10-01T09:15:00+02:00", myResponse: "accepted", showAs: "free", cancelled: true, moved: false },
            { start: "2026-10-02T10:00:00+02:00", end: "2026-10-02T10:15:00+02:00", myResponse: "notResponded", showAs: "busy", cancelled: false, moved: true },
          ],
        },
        labels: {
          title: "Platform standup",
          organizer: "Grace Hopper",
          people: ["Grace Hopper", "Ada Lovelace", "Alan Turing", "Barbara Liskov", "Edsger Dijkstra"],
        },
      },
      {
        type: "calendar",
        fingerprint: "c85d1e3a7f20b946",
        meta: {
          recurring: true,
          isAllDay: false,
          isOrganizer: false,
          isOnlineMeeting: false,
          continuesFromBefore: false,
          others: 3,
          occurrences: [
            { start: "2026-09-29T14:00:00+02:00", end: "2026-09-29T15:00:00+02:00", myResponse: "tentativelyAccepted", showAs: "tentative", cancelled: false, moved: false },
          ],
        },
        labels: {
          title: "Team lead sync",
          location: "Room Hopper, 4th floor",
          organizer: "Margaret Hamilton",
          people: ["Margaret Hamilton", "Grace Hopper", "Linus Torvalds"],
        },
      },
      {
        type: "calendar",
        fingerprint: "7c1e04b9a2d35f81",
        meta: {
          recurring: false,
          isAllDay: false,
          isOrganizer: true,
          isOnlineMeeting: true,
          continuesFromBefore: false,
          others: 11,
          occurrences: [
            { start: "2026-10-01T13:00:00+02:00", end: "2026-10-01T14:30:00+02:00", myResponse: "organizer", showAs: "busy", cancelled: false, moved: false },
          ],
        },
        labels: {
          title: "Architecture review: event store",
          location: "Room Kepler",
          people: ["Ada Lovelace", "Grace Hopper", "Barbara Liskov", "Edsger Dijkstra", "Alan Turing", "Margaret Hamilton", "Linus Torvalds", "Katherine Johnson"],
        },
      },
      {
        type: "calendar",
        fingerprint: "2b7f90e4c1a8d563",
        meta: {
          recurring: false,
          isAllDay: true,
          isOrganizer: false,
          isOnlineMeeting: false,
          continuesFromBefore: false,
          others: 1,
          occurrences: [
            { start: "2026-10-02", end: "2026-10-03", myResponse: "none", showAs: "free", cancelled: false, moved: false },
          ],
        },
        labels: {
          title: "Ada out of office",
          organizer: "Ada Lovelace",
          people: ["Ada Lovelace"],
        },
      },
    ],
    mail: [
      {
        type: "mail-thread",
        fingerprint: "e2a9c4417b0d6f35",
        meta: {
          messages: 1,
          fromMe: 0,
          firstAt: "2026-10-02T16:42:00+02:00",
          lastAt: "2026-10-02T16:42:00+02:00",
          lastFromMe: false,
          continuesFromBefore: false,
          others: 2,
          unread: 1,
          importance: "high",
          flagged: false,
          hasAttachments: true,
        },
        labels: {
          subject: "Acme renewal: terms for 2027–2029",
          lastFrom: "Katherine Johnson",
          people: ["Katherine Johnson", "Alan Turing"],
        },
        summary:
          "Katherine (Acme) sends revised renewal terms with a three-year option at a lower rate and asks for a decision by Friday. Draft contract attached.",
      },
      {
        type: "mail-thread",
        fingerprint: "d0c37a5e2b91f846",
        meta: {
          messages: 2,
          fromMe: 0,
          firstAt: "2026-09-30T08:05:00+02:00",
          lastAt: "2026-10-01T11:20:00+02:00",
          lastFromMe: false,
          continuesFromBefore: true,
          others: 1,
          unread: 2,
          importance: "normal",
          flagged: false,
          hasAttachments: false,
        },
        labels: {
          subject: "Re: invoice 4471 overdue, pay here: hxxps://billing-portal.example/4471",
          lastFrom: "Billing Team",
          people: ["Billing Team"],
        },
        summary:
          "Two reminders about an overdue invoice 4471 from an unfamiliar billing address, each urging payment through a link. No earlier invoice from this sender in the window.",
      },
      {
        type: "mail-thread",
        fingerprint: "3f6b2a90d1c4e758",
        meta: {
          messages: 3,
          fromMe: 1,
          firstAt: "2026-09-29T10:12:00+02:00",
          lastAt: "2026-09-30T15:48:00+02:00",
          lastFromMe: true,
          continuesFromBefore: true,
          others: 2,
          unread: 0,
          importance: "normal",
          flagged: true,
          hasAttachments: true,
        },
        labels: {
          subject: "Re: Q4 budget draft",
          people: ["Grace Hopper", "Margaret Hamilton"],
        },
        summary:
          "Grace shared the Q4 draft; Margaret questioned the cloud line. You replied on Wednesday asking Grace to split cloud cost by team before you sign off.",
      },
      {
        type: "mail-thread",
        fingerprint: "61e8b5d03c7a29f4",
        meta: {
          messages: 1,
          fromMe: 0,
          firstAt: "2026-09-28T07:00:00+02:00",
          lastAt: "2026-09-28T07:00:00+02:00",
          lastFromMe: false,
          continuesFromBefore: false,
          others: 1,
          unread: 0,
          importance: "normal",
          flagged: false,
          hasAttachments: false,
        },
        labels: {
          subject: "Your weekly digest from GitHub",
          lastFrom: "GitHub",
          people: ["GitHub"],
        },
        summary: "Automated weekly activity digest for the platform repositories.",
      },
    ],
    chat: [
      {
        type: "chat-conversation",
        fingerprint: "5d8f31c0e94a7b26",
        meta: {
          kind: "channel",
          isExternal: true,
          messages: 5,
          fromMe: 1,
          mentionsMe: 1,
          firstAt: "2026-10-01T09:30:00+02:00",
          lastAt: "2026-10-02T17:05:00+02:00",
          lastFromMe: false,
          continuesFromBefore: false,
          others: 2,
        },
        labels: {
          channel: "#acme-integration",
          lastFrom: "Katherine Johnson",
          people: ["Katherine Johnson", "Alan Turing"],
        },
        summary:
          "Katherine pinged you to confirm you had seen the renewal email; Alan noted the API rate limits in the new terms differ from today's.",
      },
      {
        type: "chat-conversation",
        fingerprint: "a7d2f6083be15c49",
        meta: {
          kind: "dm",
          isExternal: false,
          messages: 12,
          fromMe: 6,
          mentionsMe: 0,
          firstAt: "2026-09-28T13:14:00+02:00",
          lastAt: "2026-10-01T18:02:00+02:00",
          lastFromMe: true,
          continuesFromBefore: false,
          others: 1,
        },
        labels: {
          people: ["Ada Lovelace"],
        },
        summary:
          "You and Ada worked through the event-store proposal; she wants it first on Thursday's agenda. Your last message confirmed it.",
      },
      {
        type: "chat-conversation",
        fingerprint: "b40e9d2c7a61f358",
        meta: {
          kind: "channel",
          isExternal: false,
          messages: 9,
          fromMe: 2,
          mentionsMe: 2,
          firstAt: "2026-09-29T08:41:00+02:00",
          lastAt: "2026-09-30T16:10:00+02:00",
          lastFromMe: false,
          continuesFromBefore: true,
          others: 4,
        },
        labels: {
          channel: "#platform-team",
          lastFrom: "Edsger Dijkstra",
          people: ["Edsger Dijkstra", "Barbara Liskov", "Grace Hopper", "Alan Turing"],
        },
        summary:
          "A thread from last week on retry semantics continued; you were asked twice whether the review covers idempotency keys. Edsger posted a draft answer.",
      },
      {
        type: "chat-conversation",
        fingerprint: "f19c62a8e0d74b35",
        meta: {
          kind: "group_dm",
          isExternal: false,
          messages: 7,
          fromMe: 2,
          mentionsMe: 0,
          firstAt: "2026-09-30T12:02:00+02:00",
          lastAt: "2026-09-30T12:40:00+02:00",
          lastFromMe: false,
          continuesFromBefore: false,
          others: 3,
        },
        labels: {
          lastFrom: "Barbara Liskov",
          people: ["Ada Lovelace", "Grace Hopper", "Barbara Liskov"],
        },
        summary: "Lunch plans and a short exchange about the offsite date; settled on 14 October.",
      },
    ],
  },
} satisfies Output;
