import { test, expect, describe } from "bun:test";
import { untrusted } from "../src/trust.ts";
import type { AnnotatedItem, Bundle } from "../src/domain.ts";
import { ruleMatches, suppress } from "../src/suppress.ts";

const window = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };

function item(overrides: Partial<AnnotatedItem> = {}): AnnotatedItem {
  return {
    source: "graph",
    kind: "message",
    timestamp: "2026-07-07T09:00:00Z",
    bucket: "recent",
    id: untrusted("m1"),
    title: untrusted("Release Pipeline approval needed"),
    ...overrides,
  };
}

function bundleOf(items: AnnotatedItem[]): Bundle {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.source, (counts.get(i.source) ?? 0) + 1);
  return {
    window,
    sources: [...counts].map(([source, itemCount]) => ({ source, itemCount })),
    items,
  };
}

describe("ruleMatches", () => {
  test("title is a case-insensitive substring match on the untrusted title", () => {
    expect(ruleMatches({ title: "release pipeline" }, item())).toBe(true);
    expect(ruleMatches({ title: "standup" }, item())).toBe(false);
  });

  test("sender matches the structural sender address, case-insensitively", () => {
    const mail = item({ sender: untrusted("Notifications@GitHub.com") });
    expect(ruleMatches({ sender: "notifications@github.com" }, mail)).toBe(true);
    expect(ruleMatches({ sender: "noreply@linear.app" }, mail)).toBe(false);
  });

  test("sender also matches the display name in extras.from", () => {
    const mail = item({ extras: untrusted({ from: "GitHub" }) });
    expect(ruleMatches({ sender: "github" }, mail)).toBe(true);
  });

  test("a sender rule never matches an item with no sender and no extras.from", () => {
    expect(ruleMatches({ sender: "github" }, item())).toBe(false);
    // A non-string extras.from is absence, not a match target.
    expect(ruleMatches({ sender: "42" }, item({ extras: untrusted({ from: 42 }) }))).toBe(false);
  });

  test("series is an exact match on the trusted seriesFingerprint", () => {
    const occurrence = item({ kind: "event", seriesFingerprint: "0123456789abcdef" });
    expect(ruleMatches({ series: "0123456789abcdef" }, occurrence)).toBe(true);
    expect(ruleMatches({ series: "fedcba9876543210" }, occurrence)).toBe(false);
    expect(ruleMatches({ series: "0123456789abcdef" }, item())).toBe(false);
  });

  test("criteria within a rule AND together", () => {
    const mail = item({ sender: untrusted("notifications@github.com") });
    expect(ruleMatches({ sender: "github.com", title: "Release Pipeline" }, mail)).toBe(true);
    expect(ruleMatches({ sender: "github.com", title: "standup" }, mail)).toBe(false);
  });

  test("source scopes a rule to one registry key", () => {
    expect(ruleMatches({ source: "graph", title: "release" }, item())).toBe(true);
    expect(ruleMatches({ source: "linear", title: "release" }, item())).toBe(false);
  });
});

describe("suppress", () => {
  test("no rules → the bundle passes through untouched, no audit entries", () => {
    const bundle = bundleOf([item()]);
    const result = suppress(bundle, []);
    expect(result.bundle).toBe(bundle);
    expect(result.suppressed).toEqual([]);
  });

  test("rules OR: an item matched by any rule is removed", () => {
    const noise = item({ fingerprint: "aaaaaaaaaaaaaaaa" });
    const signal = item({ id: untrusted("m2"), title: untrusted("Q3 budget question") });
    const result = suppress(bundleOf([noise, signal]), [
      { title: "release pipeline" },
      { title: "does-not-match-anything" },
    ]);
    expect(result.bundle.items).toHaveLength(1);
    expect(result.bundle.items[0]!.title).toEqual(untrusted("Q3 budget question"));
  });

  test("the audit lists only rules that matched, with count and fingerprints", () => {
    const a = item({ fingerprint: "aaaaaaaaaaaaaaaa" });
    const b = item({ id: untrusted("m2"), fingerprint: "bbbbbbbbbbbbbbbb" });
    const unfingerprinted = item({ id: untrusted(""), fingerprint: undefined });
    const rules = [{ title: "release pipeline" }, { title: "never-matches" }];
    const result = suppress(bundleOf([a, b, unfingerprinted]), rules);
    expect(result.suppressed).toEqual([
      {
        rule: rules[0]!,
        count: 3,
        // Only items that carry a fingerprint contribute one.
        fingerprints: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
      },
    ]);
  });

  test("an item matched by several rules is counted by each but removed once", () => {
    const noise = item({ sender: untrusted("notifications@github.com") });
    const result = suppress(bundleOf([noise]), [
      { title: "release pipeline" },
      { sender: "github.com" },
    ]);
    expect(result.bundle.items).toHaveLength(0);
    expect(result.suppressed.map((e) => e.count)).toEqual([1, 1]);
  });

  test("manifest counts are recomputed so itemCount means items the Summarizer saw", () => {
    const graphNoise = item();
    const linearSignal = item({ source: "linear", kind: "issue", title: untrusted("Fix login") });
    const result = suppress(bundleOf([graphNoise, linearSignal]), [{ title: "release pipeline" }]);
    expect(result.bundle.sources).toEqual([
      { source: "graph", itemCount: 0 },
      { source: "linear", itemCount: 1 },
    ]);
  });
});
