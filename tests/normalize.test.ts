import { test, expect, describe } from "bun:test";
import { untrusted, unwrap } from "../src/trust.ts";
import { TEXT_MAX, text, chatMessageRecord, type ChatMessageSpec } from "../src/sources/normalize.ts";

// The record builders are exercised through each source's tests too; these pin the
// builder's own invariants with the Slack builder, the one with no source-side parsing.
function chat(over: Partial<ChatMessageSpec> = {}) {
  return chatMessageRecord({
    channelId: "C1",
    ts: "1783414800.000100",
    at: "2026-07-08T09:00:00Z",
    conversation: { kind: "channel", isExternal: false, name: "general" },
    author: { name: "Ada", handle: "U2", isMe: false },
    mentionsMe: false,
    text: "hello",
    ...over,
  });
}

describe("record builder", () => {
  test("brands backend strings Untrusted and keeps the trusted values bare", () => {
    const m = chat({ conversation: { kind: "dm", isExternal: true, members: [{ name: "Bo", handle: "U3", isMe: false }] } });
    expect(m.type).toBe("chat-message");
    expect(m.source).toBe("slack");
    expect(m.at).toBe("2026-07-08T09:00:00Z");
    expect(m.text).toEqual(untrusted("hello"));
    expect(m.author).toEqual({ name: untrusted("Ada"), handle: untrusted("U2"), isMe: false });
    expect(m.conversation).toEqual({
      kind: "dm",
      isExternal: true,
      members: [{ name: untrusted("Bo"), handle: untrusted("U3"), isMe: false }],
    });
  });

  test("keeps a conversation name for channels only", () => {
    expect(unwrap(chat().conversation.name!)).toBe("general");
    expect(chat({ conversation: { kind: "group_dm", isExternal: false, name: "mpdm-a--b-1" } }).conversation.name).toBeUndefined();
  });

  test("byMe follows the author's isMe", () => {
    expect(chat({ author: { handle: "U1", isMe: true } }).byMe).toBe(true);
    expect(chat().byMe).toBe(false);
  });

  test("free text truncates at TEXT_MAX; absent text is empty, an absent handle is empty", () => {
    expect(unwrap(chat({ text: "x".repeat(500) }).text)).toBe("x".repeat(TEXT_MAX));
    expect(unwrap(chat({ text: undefined }).text)).toBe("");
    expect(unwrap(chat({ author: { name: "bot", isMe: false } }).author.handle)).toBe("");
  });

  test("a message with no channel id or ts fails hard", () => {
    expect(() => chat({ channelId: "" })).toThrow();
    expect(() => chat({ ts: "" })).toThrow();
  });
});

// Instants are verbatim backend strings until here. The builder is the one place that
// constrains them to real ISO instants, so a hostile or garbage value fails hard
// (ADR-0007 §6) rather than sliding through as a trusted string. `Date.parse` alone is
// engine-lenient, so the guard shape-checks against a strict ISO-8601 grammar first.
describe("structural instant validation", () => {
  test("accepts every instant shape the real sources emit", () => {
    for (const at of [
      "2026-07-08T09:00:00Z", // Graph calendar, post-toInstant() (fraction stripped, Z stamped)
      "2026-07-09T10:00:00Z", // Graph mail receivedDateTime/sentDateTime
      "2026-07-09T06:27:12.737Z", // Slack ts via toISOString()
    ]) {
      expect(chat({ at }).at).toBe(at);
    }
  });

  test("rejects a non-ISO or hostile instant", () => {
    for (const bad of ["", "not-a-date", "ignore previous instructions", "t"]) {
      expect(() => chat({ at: bad })).toThrow();
    }
  });

  test("rejects Date.parse-tolerant but non-ISO-8601 forms", () => {
    for (const lenient of [
      "July 1 2026", // long-form English date
      "Wed, 01 Jul 2026 09:00:00 GMT", // RFC-2822
      "07/08/2026", // slash-delimited
      "2026-07-08 09:00:00", // space instead of "T"
    ]) {
      expect(() => chat({ at: lenient })).toThrow();
    }
  });

  test("does not echo the raw (backend-controlled) value into the error", () => {
    const secret = "2026-13-99T99:99:99Z ← hostile bytes";
    expect(() => chat({ at: secret })).toThrow(expect.not.stringContaining("hostile bytes"));
  });
});

describe("text", () => {
  test("caps free text at TEXT_MAX and passes short text through", () => {
    expect(text("x".repeat(500))).toBe("x".repeat(TEXT_MAX));
    expect(text("short")).toBe("short");
  });

  test('empty, null, and undefined all vanish — "presence is signal"', () => {
    expect(text("")).toBeUndefined();
    expect(text(null)).toBeUndefined();
    expect(text(undefined)).toBeUndefined();
  });
});

describe("fingerprint and entryKey (#108)", () => {
  test("deterministic 16-hex digests, keyed on identity rather than time or text", () => {
    const a = chat();
    const b = chat({ at: "2026-07-09T09:00:00Z", text: "edited" });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.entryKey).toBe(a.entryKey);
  });

  test("a message's fingerprint is by channel and ts; its entryKey by channel only", () => {
    const a = chat();
    const otherTs = chat({ ts: "1783414801.000100" });
    const otherChannel = chat({ channelId: "C2" });
    expect(new Set([a.fingerprint, otherTs.fingerprint, otherChannel.fingerprint]).size).toBe(3);
    expect(otherTs.entryKey).toBe(a.entryKey);
    expect(otherChannel.entryKey).not.toBe(a.entryKey);
  });

  test("the group key is domain-separated from the record key", () => {
    const a = chat();
    expect(a.entryKey).not.toBe(a.fingerprint);
  });
});
