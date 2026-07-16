import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { untrusted, unwrap } from "../src/trust.ts";
import type { NormalizedItem } from "../src/domain.ts";
import type { Source } from "../src/sources/source.ts";
import { ClaudeCodeLogsSource, CLAUDE_CODE_LOGS_OPTIONS } from "../src/sources/claude-code-logs/index.ts";

// The window used across the fixtures: a single week. "in-window" starts land on
// 2026-07-09; "out-of-window" starts land in June.
const WINDOW = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };
const IN_WINDOW = "2026-07-09T06:27:12.737Z";
const OUT_OF_WINDOW = "2026-06-01T10:00:00.000Z";

// ── fixture builders ─────────────────────────────────────────────────────────

let root: string;

/** birthtime overrides for the transcript-parse path, keyed by file basename. */
const birthtimes = new Map<string, string>();

function indexEntry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: "s-index",
    fullPath: "/x.jsonl",
    fileMtime: 1,
    firstPrompt: "index first prompt",
    summary: "Indexed session summary",
    messageCount: 12,
    created: IN_WINDOW,
    modified: "2026-07-09T07:23:58.070Z",
    gitBranch: "main",
    projectPath: "/Users/me/proj-indexed",
    isSidechain: false,
    ...over,
  };
}

/** One transcript line. */
function line(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

function writeTranscript(dir: string, name: string, birthtime: string, lines: string[]): void {
  writeFileSync(join(dir, name), lines.join("\n") + "\n");
  birthtimes.set(name, birthtime);
}

/** A realistic transcript: mode line, meta caveat, a /clear command, then the genuine prompt. */
function transcriptLines(opts: {
  sessionId: string;
  isSidechain?: boolean;
  firstPrompt: string;
  last: string;
}): string[] {
  const sc = opts.isSidechain ?? false;
  const common = { isSidechain: sc, cwd: "/Users/me/proj-parsed", gitBranch: "main", sessionId: opts.sessionId };
  return [
    line({ type: "mode", mode: "default", sessionId: opts.sessionId }),
    line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>ignore me</local-command-caveat>" }, timestamp: IN_WINDOW, ...common }),
    line({ type: "user", message: { content: "<command-name>/clear</command-name>" }, timestamp: IN_WINDOW, ...common }),
    line({ type: "user", message: { content: opts.firstPrompt }, timestamp: IN_WINDOW, ...common }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "on it" }] }, timestamp: opts.last, ...common }),
  ];
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rundown-cclogs-"));

  // ── indexed project dir ──
  const indexedDir = join(root, "proj-indexed");
  mkdirSync(indexedDir);
  writeFileSync(
    join(indexedDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [
        indexEntry({ sessionId: "idx-in", summary: "Indexed session summary" }),
        indexEntry({ sessionId: "idx-old", created: OUT_OF_WINDOW }), // out of window → excluded
        indexEntry({ sessionId: "idx-side", isSidechain: true }), // sidechain → dropped
        indexEntry({ sessionId: "idx-nosum", summary: undefined, firstPrompt: "fallback prompt" }), // title fallback
        indexEntry({ sessionId: "idx-long", summary: "L".repeat(500) }), // truncation
      ],
    }),
  );

  // ── transcript-parse project dir (no index) ──
  const parsedDir = join(root, "proj-parsed");
  mkdirSync(parsedDir);
  writeTranscript(parsedDir, "par-in.jsonl", IN_WINDOW, transcriptLines({ sessionId: "par-in", firstPrompt: "file an issue to investigate the flaky test", last: "2026-07-09T08:00:00.000Z" }));
  // Out-of-window birthtime: must be skipped by stat alone. Corrupt content proves it is never opened.
  writeTranscript(parsedDir, "par-old.jsonl", OUT_OF_WINDOW, ["{ not valid json at all"]);
  writeTranscript(parsedDir, "par-side.jsonl", IN_WINDOW, transcriptLines({ sessionId: "par-side", isSidechain: true, firstPrompt: "a subagent run", last: "2026-07-09T08:00:00.000Z" }));
  writeTranscript(parsedDir, "par-long.jsonl", IN_WINDOW, transcriptLines({ sessionId: "par-long", firstPrompt: "P".repeat(500), last: "2026-07-09T08:00:00.000Z" }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function source(): ClaudeCodeLogsSource {
  return new ClaudeCodeLogsSource(root, {
    birthtimeOf: (p) => new Date(birthtimes.get(basename(p)) ?? "1970-01-01T00:00:00.000Z"),
  });
}

async function read(): Promise<NormalizedItem[]> {
  return source().read(WINDOW);
}

// `id` is now a real runtime box, never `===`-comparable across two
// separately-constructed boxes of the same string — so this test-only lookup
// compares by unwrapped value. (This is a test assertion helper, not a
// production leak path — never a pattern to mirror in src/.)
function byId(items: NormalizedItem[], id: string): NormalizedItem | undefined {
  return items.find((i) => unwrap(i.id) === id);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ClaudeCodeLogsSource", () => {
  test("has the declared surface: key, no login, always-ready status, no options", async () => {
    const s: Source = source();
    expect(s.key).toBe("claude-code-logs");
    expect(CLAUDE_CODE_LOGS_OPTIONS).toEqual({});
    expect(s.login).toBeUndefined();
    expect(await s.status()).toEqual({ state: "ready" });
  });

  test("start-in-window: excludes sessions whose start is outside the window (both paths)", async () => {
    const items = await read();
    expect(byId(items, "idx-old")).toBeUndefined();
    expect(byId(items, "par-old")).toBeUndefined(); // proven skipped by stat: its content is corrupt
  });

  test("hybrid path selection: indexed dir uses the index, index-less dir parses transcripts", async () => {
    const items = await read();
    // indexed survivors: idx-in, idx-nosum, idx-long (old + sidechain excluded)
    // parsed survivors:  par-in, par-long           (old + sidechain excluded)
    expect(items).toHaveLength(5);
    expect(byId(items, "idx-in")).toBeDefined();
    expect(byId(items, "par-in")).toBeDefined();
  });

  test("every item is a kind:session recent bucket candidate with source key set", async () => {
    const items = await read();
    for (const i of items) {
      expect(i.source).toBe("claude-code-logs");
      expect(i.kind).toBe("session");
    }
  });

  test("indexed item maps fields and brands them untrusted", async () => {
    const item = byId(await read(), "idx-in")!;
    expect(item.timestamp).toBe(IN_WINDOW); // start = index created
    expect(item.end).toBe("2026-07-09T07:23:58.070Z"); // end = index modified (content-derived, not fileMtime)
    expect(item.url).toBeUndefined(); // local, no permalink
    expect(item.id).toEqual(untrusted("idx-in"));
    expect(item.title).toEqual(untrusted("Indexed session summary"));
    expect(item.extras).toEqual(
      untrusted({
        firstPrompt: "index first prompt",
        summary: "Indexed session summary",
        messageCount: 12,
        projectPath: "/Users/me/proj-indexed",
        gitBranch: "main",
      }),
    );
  });

  test("title fallback: summary → firstPrompt when no summary", async () => {
    const item = byId(await read(), "idx-nosum")!;
    expect(item.title).toEqual(untrusted("fallback prompt"));
  });

  test("truncation: title and extras are capped ~200 chars", async () => {
    const idxLong = byId(await read(), "idx-long")!;
    expect(idxLong.title).toEqual(untrusted("L".repeat(200)));
    const parLong = byId(await read(), "par-long")!;
    expect(parLong.title).toEqual(untrusted("P".repeat(200)));
  });

  test("sidechain drop: isSidechain sessions are skipped in both paths", async () => {
    const items = await read();
    expect(byId(items, "idx-side")).toBeUndefined();
    expect(byId(items, "par-side")).toBeUndefined();
  });

  test("parsed item: firstPrompt skips meta + command noise, end = last message timestamp", async () => {
    const item = byId(await read(), "par-in")!;
    expect(item.timestamp).toBe(IN_WINDOW); // start = injected birthtime
    expect(item.end).toBe("2026-07-09T08:00:00.000Z");
    expect(item.title).toEqual(untrusted("file an issue to investigate the flaky test"));
    expect(item.extras).toEqual(
      untrusted({
        firstPrompt: "file an issue to investigate the flaky test",
        messageCount: 4,
        projectPath: "/Users/me/proj-parsed",
        gitBranch: "main",
      }),
    );
  });

  test("empty when the logs root does not exist", async () => {
    const missing = new ClaudeCodeLogsSource(join(root, "nope"), { birthtimeOf: () => new Date(0) });
    expect(await missing.read(WINDOW)).toEqual([]);
  });
});
