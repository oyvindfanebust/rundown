import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRundown, type LoginEvent } from "../src/root.ts";
import { ConfigError } from "../src/config.ts";
import { parseWindowSelector } from "../src/temporal.ts";
import type { SourceRecord, Window } from "../src/domain.ts";
import { chatMessageRecord } from "../src/sources/normalize.ts";
import type { Descriptors, Source, SourceStatus } from "../src/sources/source.ts";
import type { summarize as realSummarize } from "../src/summarize.ts";

// The composition root (ADR-0008 §2) takes its descriptors and Summarizer as
// arguments, so every test here composes it from fakes: no module mocks, no
// network. Config still goes through resolveConfig's real load path, pointed at a
// temp file with RUNDOWN_CONFIG.

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

/** A fake source with a settable status; `login()` makes it ready and returns its identity. */
interface FakeSource extends Source {
  state: SourceStatus;
  records: SourceRecord[];
  lastReadWindow?: Window;
  logins: number;
  builtWith?: Record<string, unknown>;
}

function fakeSource(key: string, state: SourceStatus, identity = `${key}@example.test`): FakeSource {
  const source: FakeSource = {
    key,
    label: `Fake ${key}`,
    state,
    records: [],
    logins: 0,
    async status() {
      return source.state;
    },
    async login() {
      source.logins++;
      source.state = { state: "ready", identity };
      return identity;
    },
    async read(window) {
      source.lastReadWindow = window;
      return source.records;
    },
  };
  return source;
}

function descriptorsFor(...sources: FakeSource[]): Descriptors {
  const out: Descriptors = {};
  for (const source of sources) {
    out[source.key] = {
      key: source.key,
      label: source.label,
      options: {},
      build: (options) => {
        source.builtWith = options;
        return source;
      },
    };
  }
  return out;
}

/** A fake Summarizer that records its input and summarizes the one chat entry. */
function fakeSummarize() {
  const calls: { instructions: string; data: string }[] = [];
  const fn = (async ({ instructions, data }: { instructions: string; data: string }) => {
    calls.push({ instructions, data });
    return { summary: "an overview", entries: [{ id: "c1", summary: "the board meeting" }] };
  }) as unknown as typeof realSummarize;
  return { fn, calls };
}

const originalConfig = process.env.RUNDOWN_CONFIG;
let dir: string | undefined;

// A fixed config behind RUNDOWN_CONFIG (the temp-dir trick shared with config.test.ts).
function writeConfig(json: string): void {
  dir = mkdtempSync(join(tmpdir(), "rundown-root-"));
  writeFileSync(join(dir, "config.json"), json);
  process.env.RUNDOWN_CONFIG = join(dir, "config.json");
}

/** Point RUNDOWN_CONFIG at a path with no file. */
function noConfig(): void {
  dir = mkdtempSync(join(tmpdir(), "rundown-root-"));
  process.env.RUNDOWN_CONFIG = join(dir, "config.json");
}

afterEach(() => {
  if (originalConfig === undefined) delete process.env.RUNDOWN_CONFIG;
  else process.env.RUNDOWN_CONFIG = originalConfig;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("digest", () => {
  test("empty window: short-circuits the Summarizer and says so in progress", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    const fake = fakeSource("fake", { state: "ready" });
    const summarizer = fakeSummarize();
    const progress: string[] = [];

    const result = await composeRundown({ descriptors: descriptorsFor(fake), summarize: summarizer.fn }).digest({
      now: NOW,
      onProgress: (m) => progress.push(m),
    });

    expect(result.summary).toBe("");
    expect([...result.meetings, ...result.mail, ...result.chat]).toEqual([]);
    expect(summarizer.calls).toHaveLength(0);
    expect(progress).toEqual([
      "Pulling 1 source(s) (fake) for this-week…",
      "No records in the window; emitting an empty digest.",
    ]);
  });

  test("one clock: the same `now` resolves the window the source reads and becomes generatedAt", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    const fake = fakeSource("fake", { state: "ready" });

    const result = await composeRundown({ descriptors: descriptorsFor(fake), summarize: fakeSummarize().fn }).digest({
      now: NOW,
    });

    // this-week around Wed 2026-07-08 in UTC: Monday 2026-07-06 to the next Monday.
    const expected = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };
    expect(fake.lastReadWindow).toEqual(expected);
    expect(result.window).toEqual(expected);
    expect(result.generatedAt).toBe("2026-07-08T12:00:00.000Z");
    expect(result.timezone).toBe("UTC");
  });

  test("records in the window: wires aggregate → digest → the injected Summarizer, with entry progress", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"fake":{}}}`);
    const fake = fakeSource("fake", { state: "ready" });
    fake.records = [item("2026-07-07T09:00:00Z", "Board meeting")];
    const summarizer = fakeSummarize();
    const progress: string[] = [];

    const result = await composeRundown({ descriptors: descriptorsFor(fake), summarize: summarizer.fn }).digest({
      now: NOW,
      onProgress: (m) => progress.push(m),
    });

    expect(summarizer.calls).toHaveLength(1);
    expect(progress).toEqual([
      "Pulling 1 source(s) (fake) for this-week…",
      "Read 1 record(s); grouping them into digest entries…",
      "Summarizing 1 entries with Claude (this can take a bit)…",
    ]);
    expect(result.summary).toBe("an overview");
    expect(result.counts.chat).toEqual({ records: 1, entries: 1 });
    expect(result.chat[0]).toMatchObject({ kind: "channel", channel: "general", summary: "the board meeting" });
    // The unwrapped body reaches the Summarizer; generatedAt reaches its instructions.
    expect(summarizer.calls[0]!.data).toContain("Board meeting");
    expect(summarizer.calls[0]!.instructions).toContain("Generated at: Wed 2026-07-08T12:00:00Z");
  });

  test("--window override threads through to the window and leaves generatedAt on the clock", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"fake":{}}}`);
    const fake = fakeSource("fake", { state: "ready" });
    fake.records = [item("2026-06-10T09:00:00Z", "June retro")];
    const summarizer = fakeSummarize();

    const result = await composeRundown({ descriptors: descriptorsFor(fake), summarize: summarizer.fn }).digest({
      now: NOW,
      windowOverride: parseWindowSelector("2026-06-01..2026-06-30"),
    });

    expect(fake.lastReadWindow).toEqual({ from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" });
    expect(result.generatedAt).toBe("2026-07-08T12:00:00.000Z");
    // One overview prompt for every window: no look-back or planning variant.
    expect(summarizer.calls[0]!.instructions).not.toMatch(/look-back|retrospective|plan my week/i);
  });

  test("--source narrows the run to the named configured sources", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{},"b":{}}}`);
    const a = fakeSource("a", { state: "ready" });
    const b = fakeSource("b", { state: "ready" });

    await composeRundown({ descriptors: descriptorsFor(a, b), summarize: fakeSummarize().fn }).digest({
      now: NOW,
      sourceFilter: ["b"],
    });

    expect(a.lastReadWindow).toBeUndefined();
    expect(b.lastReadWindow).toBeDefined();
  });
});

describe("status", () => {
  const KEY = { ANTHROPIC_API_KEY: "x" };

  test("a missing config is reported as invalid-config, not thrown", async () => {
    noConfig();
    const report = await composeRundown({ descriptors: descriptorsFor(), summarize: fakeSummarize().fn }).status({ env: KEY });
    expect(report.kind).toBe("invalid-config");
    if (report.kind === "invalid-config") expect(report.message).toContain("No config");
  });

  test("an unknown source in the config is reported as invalid-config", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"bogus":{}}}`);
    const report = await composeRundown({
      descriptors: descriptorsFor(fakeSource("a", { state: "ready" })),
      summarize: fakeSummarize().fn,
    }).status({ env: KEY });
    expect(report.kind).toBe("invalid-config");
    if (report.kind === "invalid-config") expect(report.message).toContain(`Unknown source "bogus"`);
  });

  test("reports timezone, window and each selected source's status in config order", async () => {
    writeConfig(`{"timezone":"Europe/Oslo","window":"today","sources":{"b":{},"a":{}}}`);
    const a = fakeSource("a", { state: "ready", identity: "a@example.test" });
    const b = fakeSource("b", { state: "not-configured", detail: "missing option" });
    const c = fakeSource("c", { state: "ready" });

    const report = await composeRundown({ descriptors: descriptorsFor(a, b, c), summarize: fakeSummarize().fn }).status({
      env: KEY,
    });

    expect(report).toEqual({
      kind: "ok",
      timezone: "Europe/Oslo",
      windowSpan: "today",
      summarizerKey: true,
      sources: [
        { key: "b", status: { state: "not-configured", detail: "missing option" } },
        { key: "a", status: { state: "ready", identity: "a@example.test" } },
      ],
      unauthenticated: [],
      next: "fix-config",
    });
  });

  test("next is digest when the key is set and every source is ready", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{}}}`);
    const report = await composeRundown({
      descriptors: descriptorsFor(fakeSource("a", { state: "ready" })),
      summarize: fakeSummarize().fn,
    }).status({ env: KEY });
    expect(report.kind === "ok" && report.next).toBe("digest");
  });

  test("next is login, naming the unauthenticated sources", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{},"b":{},"c":{}}}`);
    const report = await composeRundown({
      descriptors: descriptorsFor(
        fakeSource("a", { state: "not-authenticated" }),
        fakeSource("b", { state: "not-configured" }),
        fakeSource("c", { state: "not-authenticated" }),
      ),
      summarize: fakeSummarize().fn,
    }).status({ env: KEY });
    expect(report.kind === "ok" && report.next).toBe("login");
    expect(report.kind === "ok" && report.unauthenticated).toEqual(["a", "c"]);
  });

  test("next is export-key when the summarizer key is missing, ahead of any source problem", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{}}}`);
    const report = await composeRundown({
      descriptors: descriptorsFor(fakeSource("a", { state: "not-authenticated" })),
      summarize: fakeSummarize().fn,
    }).status({ env: { ANTHROPIC_API_KEY: "" } });
    expect(report.kind === "ok" && report.summarizerKey).toBe(false);
    expect(report.kind === "ok" && report.next).toBe("export-key");
  });

  test("the key is read from the env it is given, not the process", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{}}}`);
    const report = await composeRundown({
      descriptors: descriptorsFor(fakeSource("a", { state: "ready" })),
      summarize: fakeSummarize().fn,
    }).status({ env: {} });
    expect(report.kind === "ok" && report.summarizerKey).toBe(false);
  });
});

describe("login", () => {
  function collect() {
    const events: LoginEvent[] = [];
    return { events, onEvent: (e: LoginEvent) => events.push(e) };
  }

  test("a walk logs in every configured source that is not ready, in config order", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{},"b":{}}}`);
    const a = fakeSource("a", { state: "ready", identity: "a@example.test" });
    const b = fakeSource("b", { state: "not-authenticated" });
    const unselected = fakeSource("c", { state: "not-authenticated" });
    const { events, onEvent } = collect();

    const result = await composeRundown({
      descriptors: descriptorsFor(a, b, unselected),
      summarize: fakeSummarize().fn,
    }).login({ onEvent });

    expect(events).toEqual([
      { key: "a", phase: "already", identity: "a@example.test" },
      { key: "b", phase: "authenticating" },
      { key: "b", phase: "authenticated", identity: "b@example.test" },
    ]);
    expect(result).toEqual({ targeted: false, authenticated: 1 });
    expect(a.logins).toBe(0);
    expect(unselected.logins).toBe(0);
  });

  test("a walk over already-authenticated sources authenticates none", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{}}}`);
    const { events, onEvent } = collect();
    const result = await composeRundown({
      descriptors: descriptorsFor(fakeSource("a", { state: "ready" })),
      summarize: fakeSummarize().fn,
    }).login({ onEvent });
    expect(events).toEqual([{ key: "a", phase: "already", identity: undefined }]);
    expect(result).toEqual({ targeted: false, authenticated: 0 });
  });

  test("a walk needs a valid config", async () => {
    noConfig();
    const login = composeRundown({ descriptors: descriptorsFor(), summarize: fakeSummarize().fn }).login({
      onEvent: () => {},
    });
    await expect(login).rejects.toBeInstanceOf(ConfigError);
  });

  test("the authenticating event arrives before the interactive login runs", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"a":{}}}`);
    const a = fakeSource("a", { state: "not-authenticated" });
    const seenAtLogin: number[] = [];
    const { events, onEvent } = collect();
    const realLogin = a.login.bind(a);
    a.login = async () => {
      seenAtLogin.push(events.length);
      return realLogin();
    };
    await composeRundown({ descriptors: descriptorsFor(a), summarize: fakeSummarize().fn }).login({ onEvent });
    expect(seenAtLogin).toEqual([1]);
    expect(events[0]).toEqual({ key: "a", phase: "authenticating" });
  });

  test("a targeted login resolves against all descriptors, ignores config and builds with empty options", async () => {
    // No config file at all: the targeted path never reads it.
    noConfig();
    const a = fakeSource("a", { state: "ready" });
    const b = fakeSource("b", { state: "not-authenticated" });
    const { events, onEvent } = collect();

    const result = await composeRundown({ descriptors: descriptorsFor(a, b), summarize: fakeSummarize().fn }).login({
      only: "b",
      onEvent,
    });

    expect(events).toEqual([
      { key: "b", phase: "authenticating" },
      { key: "b", phase: "authenticated", identity: "b@example.test" },
    ]);
    expect(result).toEqual({ targeted: true, authenticated: 1 });
    expect(b.builtWith).toEqual({});
    expect(a.builtWith).toBeUndefined();
  });

  test("a targeted login of an already-authenticated source reports it and authenticates none", async () => {
    noConfig();
    const a = fakeSource("a", { state: "ready", identity: "a@example.test" });
    const { events, onEvent } = collect();
    const result = await composeRundown({ descriptors: descriptorsFor(a), summarize: fakeSummarize().fn }).login({
      only: "a",
      onEvent,
    });
    expect(events).toEqual([{ key: "a", phase: "already", identity: "a@example.test" }]);
    expect(result).toEqual({ targeted: true, authenticated: 0 });
    expect(a.logins).toBe(0);
  });

  test("an unknown key is an error listing the registered keys", async () => {
    noConfig();
    const { events, onEvent } = collect();
    const login = composeRundown({
      descriptors: descriptorsFor(fakeSource("a", { state: "ready" }), fakeSource("b", { state: "ready" })),
      summarize: fakeSummarize().fn,
    }).login({ only: "bogus", onEvent });
    await expect(login).rejects.toThrow(`Unknown source "bogus". Registered sources: a, b`);
    expect(events).toEqual([]);
  });
});
