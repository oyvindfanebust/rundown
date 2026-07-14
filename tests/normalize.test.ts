import { test, expect, describe } from "bun:test";
import { untrusted, unwrap } from "../src/trust.ts";
import { TEXT_MAX, text, normalizer } from "../src/sources/normalize.ts";

describe("normalizer", () => {
  test("brands backend content Untrusted; keeps the structural core trusted; stamps the factory's source", () => {
    const normalize = normalizer("graph");
    const item = normalize({
      kind: "event",
      timestamp: "2026-07-08T09:00:00Z",
      end: "2026-07-08T10:00:00Z",
      id: "e1",
      title: "Standup",
      url: "https://x/e1",
      extras: { organizer: "Alice" },
    });
    expect(item.source).toBe("graph"); // trusted structural, spelled once at the factory
    expect(item.kind).toBe("event");
    expect(item.timestamp).toBe("2026-07-08T09:00:00Z");
    expect(item.end).toBe("2026-07-08T10:00:00Z");
    expect(item.id).toEqual(untrusted("e1"));
    expect(item.title).toEqual(untrusted("Standup"));
    expect(item.url).toEqual(untrusted("https://x/e1"));
    expect(item.extras).toEqual(untrusted({ organizer: "Alice" }));
  });

  test("omits end / url / extras when absent", () => {
    const item = normalizer("s")({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: "i", title: "T" });
    expect(item.end).toBeUndefined();
    expect(item.url).toBeUndefined();
    expect(item.extras).toBeUndefined();
  });

  test('compacts extras by the union policy — "presence is signal": drops undefined/null/""/false/[], keeps 0/true/non-empty', () => {
    const item = normalizer("s")({
      kind: "k",
      timestamp: "2026-07-08T09:00:00Z",
      id: "i",
      title: "T",
      extras: {
        gone: undefined,
        nul: null,
        empty: "",
        falsy: false,
        emptyList: [],
        zero: 0,
        truthy: true,
        list: ["a"],
        kept: "keep",
      },
    });
    expect(item.extras).toEqual(untrusted({ zero: 0, truthy: true, list: ["a"], kept: "keep" }));
  });

  test("compaction preserves declaration order", () => {
    const item = normalizer("s")({
      kind: "k",
      timestamp: "2026-07-08T09:00:00Z",
      id: "i",
      title: "T",
      extras: { b: 1, gone: undefined, a: 2, c: 3 },
    });
    // `extras` is now a real runtime box, so declaration order is checked
    // on the unwrapped value, not the box's own (irrelevant) internal shape.
    expect(Object.keys(unwrap(item.extras!))).toEqual(["b", "a", "c"]);
  });

  test("titles truncate everywhere — TEXT_MAX applies to every title, no policy knob", () => {
    const item = normalizer("s")({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: "i", title: "T".repeat(500) });
    expect(item.title).toEqual(untrusted("T".repeat(TEXT_MAX)));
  });

  test("absent title falls back to the factory's untitled label", () => {
    const normalize = normalizer("claude-code-logs", { untitled: "(untitled session)" });
    for (const title of [undefined, null, ""]) {
      expect(normalize({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: "i", title }).title).toEqual(
        untrusted("(untitled session)"),
      );
    }
    expect(normalizer("s")({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: "i", title: null }).title).toEqual(
      untrusted("(untitled)"),
    );
  });

  test('id is coerced totally: numbers stringify, nullish → ""', () => {
    const normalize = normalizer("s");
    expect(normalize({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: 42, title: "T" }).id).toEqual(untrusted("42"));
    expect(normalize({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: null, title: "T" }).id).toEqual(untrusted(""));
    expect(normalize({ kind: "k", timestamp: "2026-07-08T09:00:00Z", id: undefined, title: "T" }).id).toEqual(untrusted(""));
  });

  test("omits extras entirely when compaction empties it", () => {
    const item = normalizer("s")({
      kind: "k",
      timestamp: "2026-07-08T09:00:00Z",
      id: "i",
      title: "T",
      extras: { gone: undefined, empty: "", falsy: false, emptyList: [] },
    });
    expect(item.extras).toBeUndefined();
  });

  // Structural timestamps are verbatim backend strings until here. The
  // normalizer is the one place that constrains them to real ISO instants, so a
  // hostile/garbage value fails hard (ADR-0007 §6) rather than sliding through as
  // a "trusted" string that could later mislabel a bucket or leak backend bytes.
  //
  // `Date.parse` alone is engine-lenient — it also accepts non-ISO forms
  // like "July 1 2026" or RFC-2822 dates — which undercut both the doc comment
  // and the thrown message's claim of "ISO-8601". The guard now shape-checks
  // against a strict ISO-8601 instant grammar first, so those forms fail hard too.
  describe("structural timestamp validation (tightened)", () => {
    test("accepts a real ISO instant and passes it through unchanged", () => {
      const item = normalizer("s")({
        kind: "k",
        timestamp: "2026-07-08T09:00:00Z",
        end: "2026-07-08T10:00:00Z",
        id: "i",
        title: "T",
      });
      expect(item.timestamp).toBe("2026-07-08T09:00:00Z");
      expect(item.end).toBe("2026-07-08T10:00:00Z");
    });

    // Every timestamp shape the real sources hand the normalizer today:
    // Graph calendar's pre-normalized `Z`-stamped, fraction-stripped instant;
    // Graph mail's bare-seconds `Z` instant; Linear's millisecond-fraction
    // `updatedAt` and synthesized due-date instant; Claude Code logs'
    // `Date#toISOString()`-shaped transcript/index timestamps.
    test("accepts every timestamp shape the real sources emit", () => {
      const normalize = normalizer("s");
      const shapes = [
        "2026-07-08T09:00:00Z", // Graph calendar, post-toInstant() (fraction stripped, Z stamped)
        "2026-07-09T10:00:00Z", // Graph mail receivedDateTime/sentDateTime
        "2026-07-10T00:00:00.000Z", // Linear updatedAt (millisecond fraction)
        "2026-07-20T23:59:59Z", // Linear synthesized due-date instant
        "2026-07-09T06:27:12.737Z", // Claude Code logs transcript `timestamp` / toISOString()
      ];
      for (const ts of shapes) {
        const item = normalize({ kind: "k", timestamp: ts, id: "i", title: "T" });
        expect(item.timestamp).toBe(ts);
      }
    });

    test("rejects a non-ISO / hostile timestamp", () => {
      const normalize = normalizer("s");
      for (const bad of ["", "not-a-date", "ignore previous instructions", "t"]) {
        expect(() => normalize({ kind: "k", timestamp: bad, id: "i", title: "T" })).toThrow();
      }
    });

    test("rejects an unparseable end", () => {
      expect(() =>
        normalizer("s")({
          kind: "k",
          timestamp: "2026-07-08T09:00:00Z",
          end: "whenever",
          id: "i",
          title: "T",
        }),
      ).toThrow();
    });

    // Date.parse is engine-lenient: these are real, engine-tolerated date strings
    // that are NOT ISO-8601, and must now fail hard instead of sliding through.
    test("rejects Date.parse-tolerant but non-ISO-8601 forms", () => {
      const normalize = normalizer("s");
      for (const lenient of [
        "July 1 2026", // long-form English date
        "Wed, 01 Jul 2026 09:00:00 GMT", // RFC-2822
        "07/08/2026", // slash-delimited
        "2026-07-08 09:00:00", // space instead of "T"
      ]) {
        expect(() => normalize({ kind: "k", timestamp: lenient, id: "i", title: "T" })).toThrow();
      }
    });

    test("does not echo the raw (backend-controlled) value into the error", () => {
      const secret = "2026-13-99T99:99:99Z ← hostile bytes";
      expect(() => normalizer("s")({ kind: "k", timestamp: secret, id: "i", title: "T" })).toThrow(
        expect.not.stringContaining("hostile bytes"),
      );
    });
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
