import { test, expect, describe } from "bun:test";
import { aggregate, inWindow } from "../src/aggregate.ts";
import type { ChatMessage, Window } from "../src/domain.ts";
import { calendarEventRecord, chatMessageRecord, emailRecord } from "../src/sources/normalize.ts";
import type { Source, Sources } from "../src/sources/source.ts";
import type { DebugEvent } from "../src/debug.ts";

const window: Window = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };

/** A Slack message record at `at`; `ts` keeps each fixture's fingerprint distinct. */
function item(at: string, ts = at): ChatMessage {
  return chatMessageRecord({
    channelId: "C1",
    ts,
    at,
    conversation: { kind: "channel", isExternal: false, name: "general" },
    author: { name: "Ada", handle: "U2", isMe: false },
    mentionsMe: true,
    text: "hi",
  });
}

/** Every source now has a required, total `status()`; fakes default to ready. */
async function ready() {
  return { state: "ready" as const };
}

/** Every source logs in; the aggregator never calls it. */
async function login() {
  return "me@example.test";
}

/** Build an in-memory source lookup from fake sources, keyed by each source's `key`. */
function sourcesOf(...list: Source[]): Sources {
  return Object.fromEntries(list.map((s) => [s.key, s]));
}

describe("inWindow", () => {
  const event = (isAllDay: boolean, start: string, end: string) =>
    calendarEventRecord({
      id: start,
      continuesFromBefore: false,
      isAllDay,
      start,
      end,
      title: "e",
      organizer: { isMe: false },
      isOrganizer: false,
      attendees: [],
      rooms: [],
      myResponse: "none",
      showAs: "busy",
      isCancelled: false,
      isOnlineMeeting: false,
      recurring: false,
    });

  test("a message counts by its own time, from inclusive and to exclusive", () => {
    expect(inWindow(item("2026-07-05T23:59:59Z"), window)).toBe(false);
    expect(inWindow(item("2026-07-06T00:00:00Z"), window)).toBe(true);
    expect(inWindow(item("2026-07-12T23:59:59Z"), window)).toBe(true);
    expect(inWindow(item("2026-07-13T00:00:00Z"), window)).toBe(false);
  });

  test("a timed event counts when it overlaps the window", () => {
    expect(inWindow(event(false, "2026-07-05T23:00:00Z", "2026-07-06T01:00:00Z"), window)).toBe(true);
    expect(inWindow(event(false, "2026-07-05T22:00:00Z", "2026-07-05T23:00:00Z"), window)).toBe(false);
    expect(inWindow(event(false, "2026-07-13T00:00:00Z", "2026-07-13T01:00:00Z"), window)).toBe(false);
  });

  test("an all-day event is kept as the source returned it", () => {
    expect(inWindow(event(true, "2026-07-05", "2026-07-06"), window)).toBe(true);
  });

  test("throws on an unparseable instant", () => {
    // A record that bypassed the builder's instant check is a bug, not data.
    const bad = { ...item("2026-07-07T00:00:00Z"), at: "not-a-date" };
    expect(() => inWindow(bad, window)).toThrow(/unparseable/);
  });
});

describe("aggregate", () => {
  test("merges, filters to the window, and sorts chronologically", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      login,
      status: ready,
      async read() {
        return [
          item("2026-07-10T00:00:00Z"),
          item("2026-07-01T00:00:00Z"),
          item("2026-07-07T00:00:00Z"),
        ];
      },
    };
    const bundle = await aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake));
    // The record before the window is dropped; the manifest counts what the source read.
    expect(bundle.records.map((r) => (r.type === "chat-message" ? r.at : ""))).toEqual([
      "2026-07-07T00:00:00Z",
      "2026-07-10T00:00:00Z",
    ]);
    expect(bundle.sources).toEqual([{ source: "fake", itemCount: 3 }]);
  });

  test("carries every record type, ordered by its own time", async () => {
    const mail = (id: string, at: string) =>
      emailRecord({
        id,
        continuesFromBefore: false,
        at,
        folder: "inbox",
        subject: id,
        from: { name: "Ada", handle: "ada@x.test", isMe: false },
        to: [],
        cc: [],
        body: "",
        importance: "normal",
        isRead: true,
        flagged: false,
        hasAttachments: false,
        inferenceClassification: "focused",
      });
    const fake: Source = {
      key: "graph",
      label: "Graph",
      login,
      status: ready,
      async read() {
        return [
          mail("later", "2026-07-10T00:00:00Z"),
          item("2026-07-07T00:00:00Z"),
          mail("earlier", "2026-07-06T09:00:00Z"),
        ];
      },
    };
    const bundle = await aggregate(window, [{ sourceKey: "graph", options: {} }], sourcesOf(fake));
    expect(bundle.records.map((r) => r.type)).toEqual(["email", "chat-message", "email"]);
    expect(bundle.sources).toEqual([{ source: "graph", itemCount: 3 }]);
  });

  test("tie-breaks equal timestamps by source", async () => {
    const ts = "2026-07-07T00:00:00Z";
    const mail = emailRecord({
      id: "m",
      continuesFromBefore: false,
      at: ts,
      folder: "inbox",
      subject: "m",
      from: { name: "Ada", handle: "ada@x.test", isMe: false },
      to: [],
      cc: [],
      body: "",
      importance: "normal",
      isRead: true,
      flagged: false,
      hasAttachments: false,
      inferenceClassification: "focused",
    });
    const slack: Source = { key: "slack", label: "", login, status: ready, async read() { return [item(ts)]; } };
    const graph: Source = { key: "graph", label: "", login, status: ready, async read() { return [mail]; } };
    const bundle = await aggregate(
      window,
      [{ sourceKey: "slack", options: {} }, { sourceKey: "graph", options: {} }],
      sourcesOf(slack, graph),
    );
    expect(bundle.records.map((i) => i.source)).toEqual(["graph", "slack"]);
  });

  test("pre-flight throws on not-authenticated", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      login,
      async read() { return []; },
      async status() { return { state: "not-authenticated" }; },
    };
    expect(aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake))).rejects.toThrow(
      /not authenticated.*rundown login/,
    );
  });

  test("pre-flight throws on not-configured, surfacing the detail", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      login,
      async read() { return []; },
      async status() { return { state: "not-configured", detail: "set FOO" }; },
    };
    expect(aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake))).rejects.toThrow(
      /not configured — set FOO.*rundown status/,
    );
  });

  test("pre-flight passes on ready and reads", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      login,
      status: ready,
      async read() { return [item("2026-07-07T00:00:00Z")]; },
    };
    const bundle = await aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake));
    expect(bundle.records).toHaveLength(1);
  });

  test("fails hard when a read errors — no partial bundle", async () => {
    const good: Source = { key: "good", label: "", login, status: ready, async read() { return [item("2026-07-07T00:00:00Z")]; } };
    const bad: Source = { key: "bad", label: "", login, status: ready, async read() { throw new Error("boom"); } };
    expect(
      aggregate(
        window,
        [{ sourceKey: "good", options: {} }, { sourceKey: "bad", options: {} }],
        sourcesOf(good, bad),
      ),
    ).rejects.toThrow("boom");
  });
});

describe("aggregate debug events (ADR-0015)", () => {
  test("emits one source-run per source with its item count", async () => {
    const events: DebugEvent[] = [];
    const a: Source = {
      key: "a",
      label: "A",
      login,
      status: ready,
      read: async () => [item("2026-07-07T00:00:00Z")],
    };
    const b: Source = { key: "b", label: "B", login, status: ready, read: async () => [] };
    await aggregate(
      window,
      [
        { sourceKey: "a", options: {} },
        { sourceKey: "b", options: {} },
      ],
      sourcesOf(a, b),
      (e) => events.push(e),
    );
    const runs = events.filter((e) => e.kind === "source-run");
    expect(runs.map((r) => (r as any).source).sort()).toEqual(["a", "b"]);
    // The zero-count source is the diagnostic payoff: "why is nothing here?"
    expect(runs.find((r) => (r as any).source === "b")).toMatchObject({ itemCount: 0 });
    expect(runs.find((r) => (r as any).source === "a")).toMatchObject({ itemCount: 1 });
  });

  test("defaults to the no-op sink when none is passed", async () => {
    const a: Source = { key: "a", label: "A", login, status: ready, read: async () => [] };
    await expect(aggregate(window, [{ sourceKey: "a", options: {} }], sourcesOf(a))).resolves.toBeDefined();
  });
});
