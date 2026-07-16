import { test, expect, describe, afterEach, afterAll, mock } from "bun:test";
// Capture the REAL summarize.ts exports before the mock.module below overrides the
// module registry, so we can restore them once this file's tests finish (afterAll).
// bun 1.3.13 does NOT reset module mocks between test files and mock.restore() does
// not undo mock.module — an un-restored mock leaks into any test file that loads
// AFTER this one (e.g. injection-corpus.test.ts, which exercises the REAL
// summarizer). Restoring here keeps that leak from depending on load order.
import * as realSummarizeModule from "../src/summarize.ts";
const REAL_SUMMARIZE_EXPORTS = { ...realSummarizeModule };
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untrusted } from "../src/trust.ts";
import { resolveSelector, parseWindowSelector } from "../src/temporal.ts";
import type { NormalizedItem, Window } from "../src/domain.ts";
import type { Source, SourceDescriptor } from "../src/sources/source.ts";

// buildBrief is the composition root (ADR-0008 §2): resolve config → build the
// selected sources → aggregate → plan, threading ONE shared `now`. It wires in
// the module-global registry (ADR-0008 §5: the real one in production), so we
// mock that module to inject a fake descriptor + buildRegistry, and mock the
// Summarizer so the items>0 path needs no network. Both mocks are safe to install
// here: no other test file imports registry.ts, and bun resets module mocks
// between test files (plan.test.ts + summarize.test.ts already rely on that).

// A single fake source driven by module-level state, so each test sets what it
// returns and can read back what `read()` was handed — the shared clock reaches
// the source only via the resolved `window`, so capturing it proves the threading.
let currentItems: NormalizedItem[] = [];
let lastReadWindow: Window | undefined;
const fake: Source = {
  key: "fake",
  label: "Fake",
  async status() {
    return { state: "ready" };
  },
  async read(window) {
    lastReadWindow = window;
    return currentItems;
  },
};

const fakeDescriptor: SourceDescriptor = {
  key: "fake",
  label: "Fake",
  interactive: false,
  options: {},
  build: () => fake,
};

mock.module("../src/sources/registry.ts", () => ({
  descriptors: { fake: fakeDescriptor },
  buildRegistry: () => ({ fake }),
  registeredKeys: () => ["fake"],
}));

// Record what the Planner hands the Summarizer; return a fixed, schema-shaped Brief.
let summarizeCalls = 0;
let lastInstructions = "";
let lastData = "";
mock.module("../src/summarize.ts", () => ({
  summarize: async ({ instructions, data }: { instructions: string; data: string }) => {
    summarizeCalls++;
    lastInstructions = instructions;
    lastData = data;
    return { summary: "cross-source synthesis", items: [{ kind: "commitment", summary: "do X", evidence: [] }] };
  },
  SummarizerError: class extends Error {},
  SummarizerRefusal: class extends Error {},
}));

// Restore the real summarize.ts so the mock does not leak into later-loading files.
afterAll(() => {
  mock.module("../src/summarize.ts", () => REAL_SUMMARIZE_EXPORTS);
});

const { buildBrief } = await import("../src/brief.ts");

const NOW = new Date("2026-07-08T12:00:00.000Z"); // a Wednesday, mid-day UTC

function item(timestamp: string, title: string): NormalizedItem {
  return { source: "fake", kind: "event", timestamp, id: untrusted(`fake-${title}`), title: untrusted(title) };
}

describe("buildBrief", () => {
  const originalConfig = process.env.RUNDOWN_CONFIG;
  let dir: string | undefined;

  // A fixed config behind RUNDOWN_CONFIG (the temp-dir trick shared with
  // config.test.ts), so the run goes through resolveConfig's real load path.
  function writeConfig(json: string): void {
    dir = mkdtempSync(join(tmpdir(), "rundown-brief-"));
    writeFileSync(join(dir, "config.json"), json);
    process.env.RUNDOWN_CONFIG = join(dir, "config.json");
  }

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.RUNDOWN_CONFIG;
    else process.env.RUNDOWN_CONFIG = originalConfig;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    currentItems = [];
    lastReadWindow = undefined;
    summarizeCalls = 0;
    lastInstructions = "";
    lastData = "";
  });

  test("empty window: short-circuits the Summarizer and takes the empty progress branch", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    currentItems = [];
    const progress: string[] = [];

    const brief = await buildBrief({ now: NOW, onProgress: (m) => progress.push(m) });

    expect(brief.summary).toBe("");
    expect(brief.items).toEqual([]);
    expect(summarizeCalls).toBe(0); // no model call on an empty bundle (ADR-0005 §8)
    expect(progress.some((p) => p.includes("Pulling 1 source(s) (fake) for this-week"))).toBe(true);
    expect(progress.some((p) => p.includes("No items in window"))).toBe(true);
    expect(progress.some((p) => p.includes("Aggregated"))).toBe(false);
  });

  test("threads one shared `now`: the resolved window reaches the source and the envelope", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    currentItems = [];

    const brief = await buildBrief({ now: NOW });

    const expected = resolveSelector({ kind: "span", span: "this-week" }, "UTC", NOW);
    expect(lastReadWindow).toEqual(expected);
    expect(brief.envelope.window).toEqual(expected);
  });

  test("items in window: takes the summarizing branch and wires plan → the Brief", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    currentItems = [item("2026-07-07T09:00:00Z", "Board meeting")];
    const progress: string[] = [];

    const brief = await buildBrief({ now: NOW, onProgress: (m) => progress.push(m) });

    expect(summarizeCalls).toBe(1);
    expect(progress.some((p) => p.includes("Aggregated 1 item(s)"))).toBe(true);
    expect(progress.some((p) => p.includes("No items"))).toBe(false);
    expect(brief.summary).toBe("cross-source synthesis");
    expect(brief.items[0]!.kind).toBe("commitment");
    expect(brief.envelope.sources).toEqual([{ source: "fake", itemCount: 1 }]);
    // The rendered (unwrapped) bundle is what reaches the Summarizer.
    expect(lastData).toContain("title: Board meeting");
  });

  test("--window override threads through: a past window selects the review task, guidance is appended", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"fake":{}},"guidance":"keep it terse"}`);
    currentItems = [item("2026-06-10T09:00:00Z", "June retro")];

    const brief = await buildBrief({
      now: NOW,
      windowOverride: parseWindowSelector("2026-06-01..2026-06-30"),
    });

    // A wholly-past override makes config.windowIsPast true → the retrospective task.
    expect(lastInstructions).toContain("look-back");
    expect(lastInstructions).toContain("retrospective");
    // Trusted guidance from config is threaded through plan into the instructions.
    expect(lastInstructions).toContain("keep it terse");
    expect(brief.envelope.sources).toEqual([{ source: "fake", itemCount: 1 }]);
  });
});
