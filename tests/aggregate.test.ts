import { test, expect, describe } from "bun:test";
import { aggregate, bucketOf, AggregateError } from "../src/aggregate.ts";
import { untrusted } from "../src/trust.ts";
import type { NormalizedItem, Window } from "../src/domain.ts";
import type { Source, Sources } from "../src/sources/source.ts";

const window: Window = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };
const now = new Date("2026-07-08T12:00:00Z");

function item(source: string, kind: string, timestamp: string, title: string): NormalizedItem {
  return { source, kind, timestamp, id: untrusted(`${source}-${title}`), title: untrusted(title) };
}

/** Every source now has a required, total `status()`; fakes default to ready. */
async function ready() {
  return { state: "ready" as const };
}

/** Build an in-memory source lookup from fake sources, keyed by each source's `key`. */
function sourcesOf(...list: Source[]): Sources {
  return Object.fromEntries(list.map((s) => [s.key, s]));
}

describe("bucketOf", () => {
  test("classifies before-window / in-window / after-now", () => {
    expect(bucketOf(item("s", "e", "2026-07-01T00:00:00Z", "a"), window, now)).toBe("standing");
    expect(bucketOf(item("s", "e", "2026-07-07T00:00:00Z", "b"), window, now)).toBe("recent");
    expect(bucketOf(item("s", "e", "2026-07-10T00:00:00Z", "c"), window, now)).toBe("upcoming");
  });

  // Once the normalizer rejects garbage, an unparseable timestamp reaching
  // bucketOf is a bug. Fail hard (ADR-0007 §6) instead of the old silent `recent`
  // fallback, which mislabelled rather than surfaced the error.
  test("throws on a NaN timestamp instead of silently returning recent", () => {
    const bad = item("s", "e", "not-a-date", "x");
    expect(() => bucketOf(bad, window, now)).toThrow();
  });
});

describe("aggregate", () => {
  test("merges, buckets, and sorts chronologically", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      status: ready,
      async read() {
        return [
          item("fake", "event", "2026-07-10T00:00:00Z", "upcoming"),
          item("fake", "event", "2026-07-01T00:00:00Z", "standing"),
          item("fake", "event", "2026-07-07T00:00:00Z", "recent"),
        ];
      },
    };
    const bundle = await aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake), now);
    expect(bundle.items.map((i) => i.bucket)).toEqual(["standing", "recent", "upcoming"]);
    expect(bundle.sources).toEqual([{ source: "fake", itemCount: 3 }]);
  });

  test("tie-breaks equal timestamps by source", async () => {
    const ts = "2026-07-07T00:00:00Z";
    const a: Source = { key: "aaa", label: "", status: ready, async read() { return [item("aaa", "e", ts, "x")]; } };
    const b: Source = { key: "zzz", label: "", status: ready, async read() { return [item("zzz", "e", ts, "y")]; } };
    const bundle = await aggregate(
      window,
      [{ sourceKey: "zzz", options: {} }, { sourceKey: "aaa", options: {} }],
      sourcesOf(a, b),
      now,
    );
    expect(bundle.items.map((i) => i.source)).toEqual(["aaa", "zzz"]);
  });

  test("pre-flight throws on not-authenticated", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      async read() { return []; },
      async status() { return { state: "not-authenticated" }; },
    };
    expect(aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake), now)).rejects.toThrow(
      /not authenticated.*rundown login/,
    );
  });

  test("pre-flight throws on not-configured, surfacing the detail", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      async read() { return []; },
      async status() { return { state: "not-configured", detail: "set FOO" }; },
    };
    expect(aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake), now)).rejects.toThrow(
      /not configured — set FOO.*rundown status/,
    );
  });

  test("pre-flight passes on ready and reads", async () => {
    const fake: Source = {
      key: "fake",
      label: "Fake",
      status: ready,
      async read() { return [item("fake", "e", "2026-07-07T00:00:00Z", "ok")]; },
    };
    const bundle = await aggregate(window, [{ sourceKey: "fake", options: {} }], sourcesOf(fake), now);
    expect(bundle.items).toHaveLength(1);
  });

  test("fails hard when a read errors — no partial bundle", async () => {
    const good: Source = { key: "good", label: "", status: ready, async read() { return [item("good", "e", "2026-07-07T00:00:00Z", "ok")]; } };
    const bad: Source = { key: "bad", label: "", status: ready, async read() { throw new Error("boom"); } };
    expect(
      aggregate(
        window,
        [{ sourceKey: "good", options: {} }, { sourceKey: "bad", options: {} }],
        sourcesOf(good, bad),
        now,
      ),
    ).rejects.toThrow("boom");
  });
});
