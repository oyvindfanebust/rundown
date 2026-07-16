import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stripJsonc, parseConfig, resolveConfig, configPath, configDir, ConfigError } from "../src/config.ts";
import { resolveSelector, parseWindowSelector } from "../src/temporal.ts";
import type { Source, SourceDescriptor, Descriptors } from "../src/sources/source.ts";

// A fake descriptor map injected into parseConfig/resolveConfig — validation runs
// against the static schemas here, not the real registry, so the seam (not the
// shipped sources) is under test. `build` returns a trivial always-ready source;
// config validation never calls it, but it completes the SourceDescriptor shape.
const readySource = (key: string, label: string): Source => ({
  key,
  label,
  async read() {
    return [];
  },
  async status() {
    return { state: "ready" };
  },
});
const fakeGraph: SourceDescriptor = {
  key: "graph",
  label: "Fake Graph",
  interactive: true,
  options: {
    kinds: {
      type: "string[]",
      enum: ["event", "message"],
      description: "Which kinds to pull.",
    },
  },
  build: () => readySource("graph", "Fake Graph"),
};
const fakeLinear: SourceDescriptor = {
  key: "linear",
  label: "Fake Linear",
  interactive: false,
  options: {},
  build: () => readySource("linear", "Fake Linear"),
};
const descriptors: Descriptors = { graph: fakeGraph, linear: fakeLinear };

describe("stripJsonc", () => {
  test("removes line and block comments", () => {
    const src = `{
      // a line comment
      "a": 1, /* inline */ "b": 2
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ a: 1, b: 2 });
  });

  test("removes trailing commas", () => {
    expect(JSON.parse(stripJsonc(`{"a": [1, 2,], "b": 3,}`))).toEqual({ a: [1, 2], b: 3 });
  });

  test("does not touch // inside string values", () => {
    expect(JSON.parse(stripJsonc(`{"url": "https://example.com"}`))).toEqual({
      url: "https://example.com",
    });
  });

  test("preserves a comma-before-brace inside a string value", () => {
    // The trailing-comma stripper must respect string literals: `,}` here is
    // string content, not a trailing comma before a closing brace.
    expect(JSON.parse(stripJsonc(`{"a": "x ,}"}`))).toEqual({ a: "x ,}" });
  });

  test("preserves a comma-before-bracket inside a string value", () => {
    expect(JSON.parse(stripJsonc(`{"a": ["y ,]"]}`))).toEqual({ a: ["y ,]"] });
  });

  test("strips a trailing comma even when a string with `,}` precedes it", () => {
    // Confirms real trailing commas are still removed alongside string content.
    expect(JSON.parse(stripJsonc(`{"a": "x ,}", "b": 2,}`))).toEqual({ a: "x ,}", b: 2 });
  });
});

describe("configDir", () => {
  const original = process.env.RUNDOWN_CONFIG;
  afterEach(() => {
    if (original === undefined) delete process.env.RUNDOWN_CONFIG;
    else process.env.RUNDOWN_CONFIG = original;
  });

  test("is the directory of the resolved config path", () => {
    expect(configDir()).toBe(dirname(configPath()));
  });

  test("tracks RUNDOWN_CONFIG so state stays co-located with the config file", () => {
    const sandbox = join("/tmp", "rundown-sandbox-xyz");
    process.env.RUNDOWN_CONFIG = join(sandbox, "config.json");
    expect(configDir()).toBe(sandbox);
  });
});

describe("parseConfig", () => {
  test("accepts a minimal valid config", () => {
    const parsed = parseConfig(`{"sources": {"graph": {}}}`, descriptors);
    expect(parsed.selection).toEqual([{ sourceKey: "graph", options: {} }]);
  });

  test("accepts graph kinds option", () => {
    const parsed = parseConfig(`{"sources": {"graph": {"kinds": ["event"]}}}`, descriptors);
    expect(parsed.selection[0]!.options).toEqual({ kinds: ["event"] });
  });

  test("rejects a missing sources field", () => {
    expect(() => parseConfig(`{}`, descriptors)).toThrow(ConfigError);
  });

  test("rejects an empty sources map", () => {
    expect(() => parseConfig(`{"sources": {}}`, descriptors)).toThrow(/at least one source/);
  });

  test("rejects an unknown source key", () => {
    expect(() => parseConfig(`{"sources": {"slack": {}}}`, descriptors)).toThrow(/Unknown source/);
  });

  test("rejects an unknown option with a did-you-mean", () => {
    expect(() => parseConfig(`{"sources": {"graph": {"kind": ["event"]}}}`, descriptors)).toThrow(/did you mean "kinds"/);
  });

  test("rejects an out-of-enum kind", () => {
    expect(() => parseConfig(`{"sources": {"graph": {"kinds": ["chat"]}}}`, descriptors)).toThrow(/not one of/);
  });

  test("rejects an invalid timezone", () => {
    expect(() => parseConfig(`{"timezone": "Mars/Olympus", "sources": {"graph": {}}}`, descriptors)).toThrow(/timezone/);
  });

  test("accepts a last-week window span", () => {
    const parsed = parseConfig(`{"window": "last-week", "sources": {"graph": {}}}`, descriptors);
    expect(parsed.window).toBe("last-week");
  });

  test("rejects an invalid window span", () => {
    expect(() => parseConfig(`{"window": "yesterday", "sources": {"graph": {}}}`, descriptors)).toThrow(/window/);
  });
});

// resolveConfig is the untested wiring around temporal.ts's tested fortress: it
// picks the selector (--window override vs config default vs this-week fallback),
// derives the windowSpan display label, and reconciles `now` into windowIsPast.
describe("resolveConfig", () => {
  const originalConfig = process.env.RUNDOWN_CONFIG;
  let dir: string | undefined;

  // A fixed config file behind RUNDOWN_CONFIG (the temp-dir trick), so resolution
  // is exercised through resolveConfig's real load → resolve path with an injected `now`.
  function writeConfig(json: string): void {
    dir = mkdtempSync(join(tmpdir(), "rundown-resolvecfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, json);
    process.env.RUNDOWN_CONFIG = path;
  }

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.RUNDOWN_CONFIG;
    else process.env.RUNDOWN_CONFIG = originalConfig;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const NOW = new Date("2026-07-08T12:00:00.000Z"); // a Wednesday, mid-day UTC

  test("absent window falls back to this-week", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"graph":{}}}`);
    const cfg = await resolveConfig(descriptors, { now: NOW });
    expect(cfg.windowSpan).toBe("this-week");
    expect(cfg.window).toEqual(resolveSelector({ kind: "span", span: "this-week" }, "UTC", NOW));
  });

  test("--window override takes precedence over the config default", async () => {
    writeConfig(`{"timezone":"UTC","window":"this-week","sources":{"graph":{}}}`);
    const cfg = await resolveConfig(descriptors, { now: NOW, windowOverride: { kind: "span", span: "today" } });
    expect(cfg.windowSpan).toBe("today");
    expect(cfg.window).toEqual(resolveSelector({ kind: "span", span: "today" }, "UTC", NOW));
  });

  test("windowSpan label is the explicit range literal for a range override", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"graph":{}}}`);
    const cfg = await resolveConfig(descriptors, {
      now: NOW,
      windowOverride: parseWindowSelector("2026-07-06..2026-07-12"),
    });
    expect(cfg.windowSpan).toBe("2026-07-06..2026-07-12");
  });

  test("windowIsPast flips exactly at the boundary instant (to <= now)", async () => {
    writeConfig(`{"timezone":"UTC","sources":{"graph":{}}}`);
    // A single-day window: inclusive 2026-07-10 → exclusive `to` at 2026-07-11T00:00Z.
    const windowOverride = parseWindowSelector("2026-07-10");

    const atBoundary = await resolveConfig(descriptors, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      windowOverride,
    });
    expect(atBoundary.window.to).toBe("2026-07-11T00:00:00.000Z");
    expect(atBoundary.windowIsPast).toBe(true); // to <= now → the window has closed

    const justBefore = await resolveConfig(descriptors, {
      now: new Date("2026-07-10T23:59:59.999Z"),
      windowOverride,
    });
    expect(justBefore.windowIsPast).toBe(false); // to > now → still open by 1ms
  });

  // --source narrows the configured selection for one run; it can only subset what
  // config selects, never reach past config to the registry.
  describe("--source narrowing", () => {
    const BOTH = `{"timezone":"UTC","sources":{"graph":{},"linear":{}}}`;

    test("absent filter runs the full configured selection", async () => {
      writeConfig(BOTH);
      const cfg = await resolveConfig(descriptors, { now: NOW });
      expect(cfg.selection.map((s) => s.sourceKey)).toEqual(["graph", "linear"]);
    });

    test("empty filter is treated as no narrowing", async () => {
      writeConfig(BOTH);
      const cfg = await resolveConfig(descriptors, { now: NOW, sourceFilter: [] });
      expect(cfg.selection.map((s) => s.sourceKey)).toEqual(["graph", "linear"]);
    });

    test("narrows to the named subset", async () => {
      writeConfig(BOTH);
      const cfg = await resolveConfig(descriptors, { now: NOW, sourceFilter: ["linear"] });
      expect(cfg.selection.map((s) => s.sourceKey)).toEqual(["linear"]);
    });

    test("a name not in the configured selection is a hard error", async () => {
      writeConfig(`{"timezone":"UTC","sources":{"graph":{}}}`);
      await expect(resolveConfig(descriptors, { now: NOW, sourceFilter: ["linear"] })).rejects.toThrow(
        /not a configured source/,
      );
    });

    test("a filter mixing a configured and an unconfigured name is rejected", async () => {
      // linear is registry-known but not in this config's selection → still an error:
      // the flag narrows the configured selection, it never reaches past config.
      writeConfig(`{"timezone":"UTC","sources":{"graph":{}}}`);
      await expect(resolveConfig(descriptors, { now: NOW, sourceFilter: ["graph", "linear"] })).rejects.toThrow(
        /"linear" is not a configured source/,
      );
    });
  });
});
