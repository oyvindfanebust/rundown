import { test, expect, describe, afterEach, afterAll, mock } from "bun:test";
// Capture the REAL summarize.ts exports before the mock.module below overrides the
// module registry, so we can restore them once this file's tests finish (afterAll).
// bun 1.3.13 does NOT reset module mocks between test files and mock.restore() does
// not undo mock.module — an un-restored mock leaks into any test file that loads
// AFTER this one (e.g. injection-corpus.test.ts, which exercises the REAL
// summarizer). Restoring here keeps that leak from depending on load order.
import * as realSummarizeModule from "../src/summarize.ts";
const REAL_SUMMARIZE_EXPORTS = { ...realSummarizeModule };
import * as realRegistryModule from "../src/sources/registry.ts";
const REAL_REGISTRY_EXPORTS = { ...realRegistryModule };
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWindowSelector } from "../src/temporal.ts";
import type { SourceRecord, Window } from "../src/domain.ts";
import { chatMessageRecord } from "../src/sources/normalize.ts";
import type { Source, SourceDescriptor } from "../src/sources/source.ts";

// buildDigest is the composition root (ADR-0008 §2): resolve config → build the
// selected sources → aggregate → digest, threading ONE shared `now`. It wires in
// the module-global registry (ADR-0008 §5: the real one in production), so we
// mock that module to inject a fake descriptor + buildRegistry, and mock the
// Summarizer so the items>0 path needs no network. Both mocks are restored in
// afterAll, for the reason given at the top of this file.

// A single fake source driven by module-level state, so each test sets what it
// returns and can read back what `read()` was handed — the shared clock reaches
// the source only via the resolved `window`, so capturing it proves the threading.
let currentItems: SourceRecord[] = [];
let lastReadWindow: Window | undefined;
const fake: Source = {
  key: "fake",
  label: "Fake",
  async status() {
    return { state: "ready" };
  },
  async login() {
    return "me@example.test";
  },
  async read(window) {
    lastReadWindow = window;
    return currentItems;
  },
};

const fakeDescriptor: SourceDescriptor = {
  key: "fake",
  label: "Fake",
  options: {},
  build: () => fake,
};

mock.module("../src/sources/registry.ts", () => ({
  descriptors: { fake: fakeDescriptor },
  buildRegistry: () => ({ fake }),
  registeredKeys: () => ["fake"],
}));

// Record what the Digester hands the Summarizer; summarize the one chat entry.
let summarizeCalls = 0;
let lastInstructions = "";
let lastData = "";
mock.module("../src/summarize.ts", () => ({
  summarize: async ({ instructions, data }: { instructions: string; data: string }) => {
    summarizeCalls++;
    lastInstructions = instructions;
    lastData = data;
    return { summary: "an overview", entries: [{ id: "c1", summary: "the board meeting" }] };
  },
  SummarizerError: class extends Error {},
  SummarizerRefusal: class extends Error {},
}));

// Restore the real modules so the mocks do not leak into later-loading files.
afterAll(() => {
  mock.module("../src/summarize.ts", () => REAL_SUMMARIZE_EXPORTS);
  mock.module("../src/sources/registry.ts", () => REAL_REGISTRY_EXPORTS);
});

const { buildDigest } = await import("../src/digest.ts");

const NOW = new Date("2026-07-08T12:00:00.000Z"); // a Wednesday, mid-day UTC

function item(at: string, text: string): SourceRecord {
  return chatMessageRecord({
    channelId: "C1",
    ts: at,
    at,
    conversation: { kind: "channel", isExternal: false, name: "general" },
    author: { name: "Ada", handle: "U2", isMe: false },
    mentionsMe: true,
    text,
  });
}

describe("buildDigest", () => {
  const originalConfig = process.env.RUNDOWN_CONFIG;
  let dir: string | undefined;

  // A fixed config behind RUNDOWN_CONFIG (the temp-dir trick shared with
  // config.test.ts), so the run goes through resolveConfig's real load path.
  function writeConfig(json: string): void {
    dir = mkdtempSync(join(tmpdir(), "rundown-digest-"));
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

  test("empty window: short-circuits the Summarizer and says so in progress", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    currentItems = [];
    const progress: string[] = [];

    const result = await buildDigest({ now: NOW, onProgress: (m) => progress.push(m) });

    expect(result.summary).toBe("");
    expect([...result.meetings, ...result.mail, ...result.chat]).toEqual([]);
    expect(summarizeCalls).toBe(0);
    expect(progress).toEqual([
      "Pulling 1 source(s) (fake) for this-week…",
      "No records in the window; emitting an empty digest.",
    ]);
  });

  test("one clock: the same `now` resolves the window the source reads and becomes generatedAt", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    currentItems = [];

    const result = await buildDigest({ now: NOW });

    // this-week around Wed 2026-07-08 in UTC: Monday 2026-07-06 to the next Monday.
    const expected = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };
    expect(lastReadWindow).toEqual(expected);
    expect(result.window).toEqual(expected);
    expect(result.generatedAt).toBe("2026-07-08T12:00:00.000Z");
    expect(result.timezone).toBe("UTC");
  });

  test("records in the window: wires aggregate → digest → summaries, with entry progress", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    currentItems = [item("2026-07-07T09:00:00Z", "Board meeting")];
    const progress: string[] = [];

    const result = await buildDigest({ now: NOW, onProgress: (m) => progress.push(m) });

    expect(summarizeCalls).toBe(1);
    expect(progress).toEqual([
      "Pulling 1 source(s) (fake) for this-week…",
      "Read 1 record(s); grouping them into digest entries…",
      "Summarizing 1 entries with Claude (this can take a bit)…",
    ]);
    expect(result.summary).toBe("an overview");
    expect(result.counts.chat).toEqual({ records: 1, entries: 1 });
    expect(result.chat[0]).toMatchObject({ kind: "channel", channel: "general", summary: "the board meeting" });
    // The unwrapped body reaches the Summarizer; generatedAt reaches its instructions.
    expect(lastData).toContain("Board meeting");
    expect(lastInstructions).toContain("Generated at: Wed 2026-07-08T12:00:00Z");
  });

  test("--window override threads through to the window and leaves generatedAt on the clock", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"fake":{}}}`);
    currentItems = [item("2026-06-10T09:00:00Z", "June retro")];

    const result = await buildDigest({ now: NOW, windowOverride: parseWindowSelector("2026-06-01..2026-06-30") });

    expect(lastReadWindow).toEqual({ from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" });
    expect(result.generatedAt).toBe("2026-07-08T12:00:00.000Z");
    // One overview prompt for every window: no look-back or planning variant.
    expect(lastInstructions).not.toMatch(/look-back|retrospective|plan my week/i);
  });
});
