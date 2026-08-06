import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  readUpdateState,
  writeUpdateState,
  updateStatePath,
  isNewerVersion,
  autoUpdateDisabled,
  renderVersionLine,
  updateGateDecision,
  readAutoUpdateSetting,
  armUpdateCheck,
  runUpdateWorker,
  discoverLatestVersion,
  persistentFailureWarning,
  WORKER_ENV,
  type UpdateGateDeps,
  type GateInputs,
  type UpdateState,
  type UpdateStateIO,
  type SwapRefusal,
} from "../src/update.ts";

// The update module takes its effects by parameter (ADR-0001 §5), so reading and
// writing the state document is testable without touching a real filesystem: this
// fake is the whole seam.
function fakeIO(files: Record<string, string> = {}): UpdateStateIO & {
  files: Record<string, string>;
  dirs: string[];
  fail?: Error;
} {
  const io = {
    files,
    dirs: [] as string[],
    fail: undefined as Error | undefined,
    async readFile(path: string) {
      if (io.fail) throw io.fail;
      const text = files[path];
      if (text === undefined) {
        const e: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
        e.code = "ENOENT";
        throw e;
      }
      return text;
    },
    async writeFile(path: string, text: string) {
      files[path] = text;
    },
    async mkdir(path: string) {
      io.dirs.push(path);
    },
  };
  return io;
}

const DIR = "/tmp/rundown-fake-config";
const PATH = join(DIR, "update-state.json");

describe("update state document", () => {
  test("lives in the resolved config directory, beside config.json", () => {
    expect(updateStatePath(DIR)).toBe(PATH);
    expect(updateStatePath("/elsewhere")).toBe("/elsewhere/update-state.json");
  });

  test("writeUpdateState stamps checkedAt from the injected clock and round-trips", async () => {
    const io = fakeIO();
    const now = new Date("2026-08-05T09:00:00.000Z");
    const written = await writeUpdateState(io, DIR, { outcome: "current", latest: "0.4.0", consecutiveFailures: 0 }, () => now);
    expect(written.checkedAt).toBe("2026-08-05T09:00:00.000Z");
    expect(io.dirs).toContain(DIR);
    expect(JSON.parse(io.files[PATH]!)).toEqual({
      checkedAt: "2026-08-05T09:00:00.000Z",
      latest: "0.4.0",
      outcome: "current",
      consecutiveFailures: 0,
    });
    expect(await readUpdateState(io, DIR)).toEqual(written);
  });

  test("an absent reason is absent from the document rather than null", async () => {
    const io = fakeIO();
    await writeUpdateState(io, DIR, { outcome: "current", consecutiveFailures: 0 }, () => new Date(0));
    expect(io.files[PATH]).not.toContain("reason");
    expect(io.files[PATH]).not.toContain("latest");
  });

  test("a recorded refusal keeps its reason and failure count", async () => {
    const io = fakeIO();
    await writeUpdateState(
      io,
      DIR,
      { outcome: "refused", latest: "1.2.3", reason: "install directory not writable", consecutiveFailures: 3 },
      () => new Date("2026-08-05T09:00:00.000Z"),
    );
    const state = await readUpdateState(io, DIR);
    expect(state).toEqual({
      checkedAt: "2026-08-05T09:00:00.000Z",
      latest: "1.2.3",
      outcome: "refused",
      reason: "install directory not writable",
      consecutiveFailures: 3,
    });
  });

  test("a missing document reads as no state", async () => {
    expect(await readUpdateState(fakeIO(), DIR)).toBeUndefined();
  });

  test("an empty document reads as no state", async () => {
    expect(await readUpdateState(fakeIO({ [PATH]: "" }), DIR)).toBeUndefined();
  });

  test("an unparseable document reads as no state", async () => {
    expect(await readUpdateState(fakeIO({ [PATH]: "{not json" }), DIR)).toBeUndefined();
  });

  test("a document that is not an object reads as no state", async () => {
    expect(await readUpdateState(fakeIO({ [PATH]: `["nope"]` }), DIR)).toBeUndefined();
    expect(await readUpdateState(fakeIO({ [PATH]: `null` }), DIR)).toBeUndefined();
  });

  test("a document with an unknown outcome reads as no state", async () => {
    expect(await readUpdateState(fakeIO({ [PATH]: `{"checkedAt":"x","outcome":"weird"}` }), DIR)).toBeUndefined();
  });

  test("absent optional fields default rather than fail", async () => {
    const state = await readUpdateState(fakeIO({ [PATH]: `{"checkedAt":"2026-08-05T09:00:00.000Z","outcome":"current"}` }), DIR);
    expect(state).toEqual({ checkedAt: "2026-08-05T09:00:00.000Z", outcome: "current", consecutiveFailures: 0 });
  });

  test("fields of the wrong type are dropped rather than trusted", async () => {
    const state = await readUpdateState(
      fakeIO({ [PATH]: `{"checkedAt":"2026-08-05T09:00:00.000Z","outcome":"failed","latest":42,"reason":{},"consecutiveFailures":"lots"}` }),
      DIR,
    );
    expect(state).toEqual({ checkedAt: "2026-08-05T09:00:00.000Z", outcome: "failed", consecutiveFailures: 0 });
  });

  test("an unreadable document reads as no state rather than throwing", async () => {
    const io = fakeIO();
    io.fail = new Error("EACCES");
    expect(await readUpdateState(io, DIR)).toBeUndefined();
  });
});

describe("isNewerVersion", () => {
  test("is strictly greater, three-part semver only", () => {
    expect(isNewerVersion("0.4.0", "0.3.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.3.10", "0.3.9")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "0.3.0")).toBe(false);
  });

  test("refuses anything that is not an exact three-part version", () => {
    expect(isNewerVersion("v0.4.0", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.4", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.4.0-rc.1", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.4.0", "0.0.0-dev")).toBe(false);
    expect(isNewerVersion("", "0.3.0")).toBe(false);
  });
});

describe("autoUpdateDisabled", () => {
  test("reads RUNDOWN_DISABLE_AUTOUPDATE, off by default", () => {
    expect(autoUpdateDisabled({})).toBe(false);
    expect(autoUpdateDisabled({ RUNDOWN_DISABLE_AUTOUPDATE: "1" })).toBe(true);
    expect(autoUpdateDisabled({ RUNDOWN_DISABLE_AUTOUPDATE: "true" })).toBe(true);
    expect(autoUpdateDisabled({ RUNDOWN_DISABLE_AUTOUPDATE: "0" })).toBe(false);
    expect(autoUpdateDisabled({ RUNDOWN_DISABLE_AUTOUPDATE: "false" })).toBe(false);
    expect(autoUpdateDisabled({ RUNDOWN_DISABLE_AUTOUPDATE: "" })).toBe(false);
  });
});

describe("renderVersionLine", () => {
  const state = (over: Partial<UpdateState> = {}): UpdateState => ({
    checkedAt: "2026-08-05T09:00:00.000Z",
    outcome: "current",
    consecutiveFailures: 0,
    ...over,
  });

  test("reports the running version with no state recorded", () => {
    expect(renderVersionLine({ running: "0.0.0-dev", autoUpdateDisabled: false })).toBe(
      "version   0.0.0-dev   no update check recorded yet",
    );
  });

  test("reports up to date when the recorded latest is not newer", () => {
    expect(renderVersionLine({ running: "0.4.0", state: state({ latest: "0.4.0" }), autoUpdateDisabled: false })).toBe(
      "version   0.4.0   up to date (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("names the newer version the state records", () => {
    expect(renderVersionLine({ running: "0.3.0", state: state({ latest: "0.4.0" }), autoUpdateDisabled: false })).toBe(
      "version   0.3.0   0.4.0 available (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("names the recorded reason when an update is refused", () => {
    const line = renderVersionLine({
      running: "0.3.0",
      state: state({ outcome: "refused", latest: "0.4.0", reason: "install directory not writable" }),
      autoUpdateDisabled: false,
    });
    expect(line).toBe(
      "version   0.3.0   0.4.0 available — update refused: install directory not writable (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("a refusal with no recorded reason still reads sensibly", () => {
    expect(renderVersionLine({ running: "0.3.0", state: state({ outcome: "refused" }), autoUpdateDisabled: false })).toBe(
      "version   0.3.0   update refused: no reason recorded (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("reports a failed check and its consecutive count", () => {
    expect(
      renderVersionLine({
        running: "0.3.0",
        state: state({ outcome: "failed", reason: "checksum mismatch", consecutiveFailures: 4 }),
        autoUpdateDisabled: false,
      }),
    ).toBe("version   0.3.0   last update check failed: checksum mismatch (4 in a row, checked 2026-08-05T09:00:00.000Z)");
  });

  test("reports that auto-update is disabled, and still names a known newer version", () => {
    expect(renderVersionLine({ running: "0.3.0", autoUpdateDisabled: true })).toBe("version   0.3.0   auto-update disabled");
    expect(renderVersionLine({ running: "0.3.0", state: state({ latest: "0.4.0" }), autoUpdateDisabled: true })).toBe(
      "version   0.3.0   0.4.0 available — auto-update disabled (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("a source run names the recorded release rather than claiming to match it", () => {
    // 0.0.0-dev cannot be ordered against a release, so "up to date" would be a
    // false claim while the state records 9.9.9.
    expect(renderVersionLine({ running: "0.0.0-dev", state: state({ latest: "9.9.9" }), autoUpdateDisabled: false })).toBe(
      "version   0.0.0-dev   latest release 9.9.9 (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("disabled suppresses the failure count, which belongs to the failure phrase", () => {
    expect(
      renderVersionLine({
        running: "0.3.0",
        state: state({ outcome: "failed", reason: "checksum mismatch", consecutiveFailures: 4 }),
        autoUpdateDisabled: true,
      }),
    ).toBe("version   0.3.0   auto-update disabled (checked 2026-08-05T09:00:00.000Z)");
  });

  test("every swap refusal reason renders in the line", () => {
    // The vocabulary is closed and structural, and the line is where a user reads
    // it, so each value is pinned here rather than only at the swap.
    const reasons: SwapRefusal[] = [
      "unsupported-platform",
      "asset-missing",
      "checksum-missing",
      "checksum-mismatch",
      "smoke-test-failed",
      "version-mismatch",
      "download-failed",
      "write-failed",
      "rename-failed",
      "unexpected-error",
    ];
    for (const reason of reasons) {
      expect(renderVersionLine({ running: "0.3.0", state: state({ outcome: "refused", latest: "0.4.0", reason }), autoUpdateDisabled: false })).toBe(
        `version   0.3.0   0.4.0 available — update refused: ${reason} (checked 2026-08-05T09:00:00.000Z)`,
      );
    }
  });

  test("names a network failure and a filesystem failure differently", () => {
    // The defect this replaced: both of these read as `write-failed`, so the line
    // could not say which fix applied.
    expect(renderVersionLine({ running: "0.3.0", state: state({ outcome: "refused", reason: "download-failed" }), autoUpdateDisabled: false })).toBe(
      "version   0.3.0   update refused: download-failed (checked 2026-08-05T09:00:00.000Z)",
    );
    expect(renderVersionLine({ running: "0.3.0", state: state({ outcome: "refused", reason: "write-failed" }), autoUpdateDisabled: false })).toBe(
      "version   0.3.0   update refused: write-failed (checked 2026-08-05T09:00:00.000Z)",
    );
  });

  test("an updated outcome reads as up to date on the version now running", () => {
    expect(renderVersionLine({ running: "0.4.0", state: state({ outcome: "updated", latest: "0.4.0" }), autoUpdateDisabled: false })).toBe(
      "version   0.4.0   up to date (checked 2026-08-05T09:00:00.000Z)",
    );
  });
});

// ── the gate predicate (ADR-0001 §5) ────────────────────────────────────────
//
// The gate is a pure function of (version, environment, config value, state age,
// writability), so every refusal reason is enumerable without a filesystem, a
// clock, or a process. The order matters and is asserted: a dev build refuses
// before anything else looks at the environment.

const NOW = new Date("2026-08-05T12:00:00.000Z");

function gateInputs(over: Partial<GateInputs> = {}): GateInputs {
  return {
    version: "0.6.0",
    env: {},
    autoUpdateConfig: undefined,
    state: undefined,
    now: NOW,
    installDirWritable: true,
    ...over,
  };
}

function stateAgedHours(h: number): UpdateState {
  return {
    checkedAt: new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString(),
    outcome: "current",
    consecutiveFailures: 0,
  };
}

describe("updateGateDecision", () => {
  test("spawns when nothing refuses", () => {
    expect(updateGateDecision(gateInputs())).toEqual({ spawn: true });
  });

  test("refuses a run from source, so a working tree is never overwritten", () => {
    expect(updateGateDecision(gateInputs({ version: "0.0.0-dev" }))).toEqual({ spawn: false, reason: "dev-build" });
  });

  test("a dev build refuses before the environment is consulted", () => {
    // Order is load-bearing: the dev marker wins even when everything else would spawn.
    const d = updateGateDecision(gateInputs({ version: "0.0.0-dev", env: { CI: "1" } }));
    expect(d).toEqual({ spawn: false, reason: "dev-build" });
  });

  test("refuses inside the worker, so a worker cannot spawn a worker", () => {
    expect(updateGateDecision(gateInputs({ env: { [WORKER_ENV]: "1" } }))).toEqual({ spawn: false, reason: "worker" });
  });

  test("refuses when the disable env var is truthy", () => {
    expect(updateGateDecision(gateInputs({ env: { RUNDOWN_DISABLE_AUTOUPDATE: "1" } }))).toEqual({
      spawn: false,
      reason: "disabled-env",
    });
  });

  test("the disable env var follows the project truthiness rules, so 0 leaves updates on", () => {
    for (const v of ["0", "false", "FALSE", ""]) {
      expect(updateGateDecision(gateInputs({ env: { RUNDOWN_DISABLE_AUTOUPDATE: v } }))).toEqual({ spawn: true });
    }
  });

  test("refuses when CI is present, with no override", () => {
    expect(updateGateDecision(gateInputs({ env: { CI: "true" } }))).toEqual({ spawn: false, reason: "ci" });
    // Even an explicitly falsey-looking CI value refuses: presence is the signal,
    // and a vendored binary in a pipeline must not mutate itself.
    expect(updateGateDecision(gateInputs({ env: { CI: "" } }))).toEqual({ spawn: false, reason: "ci" });
  });

  test("refuses when the config field is false", () => {
    expect(updateGateDecision(gateInputs({ autoUpdateConfig: false }))).toEqual({
      spawn: false,
      reason: "disabled-config",
    });
  });

  test("an absent or true config field does not refuse", () => {
    expect(updateGateDecision(gateInputs({ autoUpdateConfig: undefined }))).toEqual({ spawn: true });
    expect(updateGateDecision(gateInputs({ autoUpdateConfig: true }))).toEqual({ spawn: true });
  });

  test("refuses while the recorded check is less than roughly a day old", () => {
    expect(updateGateDecision(gateInputs({ state: stateAgedHours(1) }))).toEqual({ spawn: false, reason: "throttled" });
    expect(updateGateDecision(gateInputs({ state: stateAgedHours(19) }))).toEqual({ spawn: false, reason: "throttled" });
  });

  test("spawns once the recorded check is old enough", () => {
    expect(updateGateDecision(gateInputs({ state: stateAgedHours(21) }))).toEqual({ spawn: true });
  });

  test("an unparseable checkedAt does not wedge the throttle shut", () => {
    // A damaged stamp must fail toward checking again, not toward never checking.
    const state: UpdateState = { checkedAt: "not a date", outcome: "current", consecutiveFailures: 0 };
    expect(updateGateDecision(gateInputs({ state }))).toEqual({ spawn: true });
  });

  test("refuses when the install directory is not writable", () => {
    expect(updateGateDecision(gateInputs({ installDirWritable: false }))).toEqual({
      spawn: false,
      reason: "not-writable",
    });
  });

  test("throttling wins over unwritability, so a stale-stamp refusal is not re-recorded daily", () => {
    const d = updateGateDecision(gateInputs({ state: stateAgedHours(1), installDirWritable: false }));
    expect(d).toEqual({ spawn: false, reason: "throttled" });
  });
});

// ── the lenient config read (ADR-0001 §5) ───────────────────────────────────
//
// Deliberately not config.ts's strict path: the gate runs before any command,
// including where no config exists. Every failure reads as not-disabled, because
// a broken file must not strand someone on an old binary.

describe("readAutoUpdateSetting", () => {
  test("reads the field when the file is well formed", async () => {
    const io = fakeIO({ [join("/cfg", "config.json")]: `{"autoUpdate": false, "sources": {"graph": {}}}` });
    expect(await readAutoUpdateSetting(io, join("/cfg", "config.json"))).toBe(false);
  });

  test("reads the field through JSONC comments and trailing commas", async () => {
    const text = `{\n  // the off-switch\n  "autoUpdate": false,\n  "sources": {"graph": {}},\n}`;
    const io = fakeIO({ [join("/cfg", "config.json")]: text });
    expect(await readAutoUpdateSetting(io, join("/cfg", "config.json"))).toBe(false);
  });

  test("a missing file reads as not-disabled", async () => {
    expect(await readAutoUpdateSetting(fakeIO(), join("/cfg", "config.json"))).toBeUndefined();
  });

  test("a malformed file reads as not-disabled, so a syntax error keeps updates on", async () => {
    const io = fakeIO({ [join("/cfg", "config.json")]: `{"autoUpdate": false` });
    expect(await readAutoUpdateSetting(io, join("/cfg", "config.json"))).toBeUndefined();
  });

  test("a non-boolean field reads as not-disabled rather than being coerced", async () => {
    const io = fakeIO({ [join("/cfg", "config.json")]: `{"autoUpdate": "no"}` });
    expect(await readAutoUpdateSetting(io, join("/cfg", "config.json"))).toBeUndefined();
  });
});

// ── armUpdateCheck: the hook's observable effects ───────────────────────────
//
// Every effect is injected, so the spawn path runs with no process created and no
// real filesystem. What is asserted is what the next run and `status` can see:
// what was written, and whether a worker was asked for.

function gateDeps(over: Partial<UpdateGateDeps> = {}): UpdateGateDeps & {
  io: ReturnType<typeof fakeIO>;
  spawns: string[];
  events: string[];
} {
  const spawns: string[] = [];
  const events: string[] = [];
  const io = (over.io as ReturnType<typeof fakeIO>) ?? fakeIO();
  return {
    version: "0.6.0",
    env: {},
    dir: "/cfg",
    configFile: join("/cfg", "config.json"),
    now: () => NOW,
    execPath: join("/opt", "rundown", "rundown"),
    dirWritable: async () => true,
    spawnWorker: (p) => spawns.push(p),
    debug: (reason, spawned) => events.push(`${spawned ? "spawn" : "skip"}:${reason}`),
    ...over,
    // Narrowed after the spread: callers need the fake's inspection fields, not
    // the bare interface Partial<UpdateGateDeps> widens `io` back to.
    io,
    spawns,
    events,
  };
}

describe("armUpdateCheck", () => {
  test("stamps the state before spawning, so a worker crash cannot re-spawn every run", async () => {
    const deps = gateDeps();
    const d = await armUpdateCheck(deps);
    expect(d).toEqual({ spawn: true });
    expect(deps.spawns).toEqual([join("/opt", "rundown", "rundown")]);
    const written = JSON.parse(deps.io.files[updateStatePath("/cfg")]!);
    expect(written.checkedAt).toBe(NOW.toISOString());
  });

  test("spawns with the resolved executable path, never argv[0]", async () => {
    const deps = gateDeps({ execPath: join("/real", "rundown") });
    await armUpdateCheck(deps);
    expect(deps.spawns).toEqual([join("/real", "rundown")]);
  });

  test("an unwritable install directory refuses, records the reason, and spawns nothing", async () => {
    const deps = gateDeps({ dirWritable: async () => false });
    expect(await armUpdateCheck(deps)).toEqual({ spawn: false, reason: "not-writable" });
    expect(deps.spawns).toEqual([]);
    const written = JSON.parse(deps.io.files[updateStatePath("/cfg")]!);
    expect(written.outcome).toBe("refused");
    expect(written.reason).toBe("install directory not writable");
  });

  test("a refusal that is not the user's problem records nothing", async () => {
    // CI, a source run, the off-switch and the throttle are all either expected or
    // already visible; writing a state document for them would be noise.
    for (const over of [{ env: { CI: "1" } }, { version: "0.0.0-dev" }, { env: { RUNDOWN_DISABLE_AUTOUPDATE: "1" } }]) {
      const deps = gateDeps(over);
      await armUpdateCheck(deps);
      expect(deps.spawns).toEqual([]);
      expect(deps.io.files[updateStatePath("/cfg")]).toBeUndefined();
    }
  });

  test("the stamp carries the previous outcome forward rather than claiming a fresh result", async () => {
    const io = fakeIO({
      [updateStatePath("/cfg")]: JSON.stringify({
        checkedAt: "2026-08-01T00:00:00.000Z",
        latest: "0.7.0",
        outcome: "failed",
        reason: "checksum mismatch",
        consecutiveFailures: 2,
      }),
    });
    const deps = gateDeps({ io });
    await armUpdateCheck(deps);
    const written = JSON.parse(io.files[updateStatePath("/cfg")]!);
    expect(written.checkedAt).toBe(NOW.toISOString());
    expect(written.outcome).toBe("failed");
    expect(written.latest).toBe("0.7.0");
    expect(written.consecutiveFailures).toBe(2);
  });

  test("emits exactly one decision event, spawning or not", async () => {
    const spawned = gateDeps();
    await armUpdateCheck(spawned);
    expect(spawned.events).toEqual(["spawn:spawn"]);

    const skipped = gateDeps({ env: { CI: "1" } });
    await armUpdateCheck(skipped);
    expect(skipped.events).toEqual(["skip:ci"]);
  });

  test("never throws: a filesystem that fails everywhere still returns a decision", async () => {
    const io = fakeIO();
    io.fail = new Error("disk on fire");
    const deps = gateDeps({ io, dirWritable: async () => { throw new Error("nope"); } });
    expect((await armUpdateCheck(deps)).spawn).toBe(false);
    expect(deps.spawns).toEqual([]);
  });
});

describe("runUpdateWorker", () => {
  /** A fetch that resolves the redirect to a fixed tag, so the worker has an answer. */
  function tagged(tag: string): typeof fetch {
    return (async () =>
      new Response(null, { status: 302, headers: { location: `https://example.test/releases/tag/${tag}` } })) as unknown as typeof fetch;
  }

  test("records that a check happened", async () => {
    const io = fakeIO({
      [updateStatePath("/cfg")]: JSON.stringify({ checkedAt: "2026-08-01T00:00:00.000Z", outcome: "failed", consecutiveFailures: 3 }),
    });
    await runUpdateWorker({ io, dir: "/cfg", now: () => NOW, version: "0.6.0", fetch: tagged("v0.6.0"), url: "https://example.test/releases/latest" });
    const written = JSON.parse(io.files[updateStatePath("/cfg")]!);
    expect(written.checkedAt).toBe(NOW.toISOString());
    expect(written.outcome).toBe("current");
  });

  test("a failing filesystem exits quietly rather than throwing", async () => {
    const io = fakeIO();
    io.fail = new Error("nope");
    expect(
      await runUpdateWorker({ io, dir: "/cfg", now: () => NOW, version: "0.6.0", fetch: tagged("v0.6.0"), url: "https://example.test/releases/latest" }),
    ).toBeUndefined();
  });
});

// ── discovery: the redirect probe (ADR-0001 §5) ──────────────────────────────
//
// The redirect, not the JSON API: no token, no rate limit, a few hundred bytes,
// and the same `latest` pointer that already excludes drafts and pre-releases. The
// live header shape this parses is
//   HTTP/2 302
//   location: https://github.com/<owner>/rundown/releases/tag/v0.6.0
// so the fakes below mirror exactly that.

const LATEST_URL = "https://example.test/releases/latest";

function redirectTo(location: string | undefined, status = 302): typeof fetch {
  return (async () =>
    new Response(null, {
      status,
      headers: location ? { location } : {},
    })) as unknown as typeof fetch;
}

describe("discoverLatestVersion", () => {
  test("reads the tag out of the Location header", async () => {
    const f = redirectTo("https://example.test/releases/tag/v0.7.0");
    expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({ ok: true, latest: "0.7.0" });
  });

  test("accepts a tag with no leading v", async () => {
    const f = redirectTo("https://example.test/releases/tag/0.7.0");
    expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({ ok: true, latest: "0.7.0" });
  });

  test("refuses a tag that is not an exact three-part semver, rather than interpreting it", async () => {
    for (const tag of ["v0.7", "v0.7.0-rc.1", "latest", "v1.2.3.4", "nightly-2026-08-05", ""]) {
      const f = redirectTo(`https://example.test/releases/tag/${tag}`);
      expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({ ok: false, reason: "unparseable-tag" });
    }
  });

  test("refuses a Location that is not a release-tag URL", async () => {
    const f = redirectTo("https://example.test/login?return_to=%2Freleases");
    expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({ ok: false, reason: "unparseable-tag" });
  });

  test("a missing Location header is an unexpected response", async () => {
    expect(await discoverLatestVersion({ fetch: redirectTo(undefined), url: LATEST_URL })).toEqual({
      ok: false,
      reason: "unexpected-response",
    });
  });

  test("a non-redirect status is an unexpected response", async () => {
    for (const status of [200, 404, 500]) {
      const f = redirectTo("https://example.test/releases/tag/v0.7.0", status);
      expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({
        ok: false,
        reason: "unexpected-response",
      });
    }
  });

  test("a network failure is unreachable, not a crash", async () => {
    const f = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({ ok: false, reason: "unreachable" });
  });

  test("an aborted read is unreachable, so a hung worker cannot linger", async () => {
    const f = (async () => {
      const e = new Error("The operation timed out.");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    expect(await discoverLatestVersion({ fetch: f, url: LATEST_URL })).toEqual({ ok: false, reason: "unreachable" });
  });

  test("passes an abort signal and asks for manual redirects", async () => {
    // The two request options the whole design rests on: without manual redirects
    // there is no Location to read, and without a signal a hung read never returns.
    let seen: RequestInit | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 302, headers: { location: "https://example.test/releases/tag/v0.7.0" } });
    }) as unknown as typeof fetch;
    await discoverLatestVersion({ fetch: f, url: LATEST_URL });
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBeDefined();
  });
});

// ── the worker's read path (ADR-0001 §5) ────────────────────────────────────

describe("runUpdateWorker with discovery", () => {
  function workerDeps(over: Partial<Parameters<typeof runUpdateWorker>[0]> = {}) {
    // Narrowed before the spread, so a caller-supplied fake is the one read back.
    const io = (over.io as ReturnType<typeof fakeIO>) ?? fakeIO();
    return {
      dir: "/cfg",
      now: () => NOW,
      version: "0.6.0",
      url: LATEST_URL,
      fetch: redirectTo("https://example.test/releases/tag/v0.7.0"),
      ...over,
      io,
    };
  }

  async function stateAfter(over: Partial<Parameters<typeof runUpdateWorker>[0]> = {}) {
    const deps = workerDeps(over);
    await runUpdateWorker(deps);
    const text = deps.io.files[updateStatePath("/cfg")];
    return text ? JSON.parse(text) : undefined;
  }

  test("records the newer version it found", async () => {
    const s = await stateAfter();
    expect(s.latest).toBe("0.7.0");
    expect(s.checkedAt).toBe(NOW.toISOString());
    expect(s.consecutiveFailures).toBe(0);
  });

  test("an equal version records the check without claiming an update", async () => {
    const s = await stateAfter({ fetch: redirectTo("https://example.test/releases/tag/v0.6.0") });
    expect(s.latest).toBe("0.6.0");
    expect(s.outcome).toBe("current");
  });

  test("never moves downward: an older latest is recorded, not acted on", async () => {
    const s = await stateAfter({ fetch: redirectTo("https://example.test/releases/tag/v0.5.0") });
    expect(s.latest).toBe("0.5.0");
    expect(s.outcome).toBe("current");
  });

  test("the running version is a parameter, so every comparison branch is reachable", async () => {
    const older = await stateAfter({ version: "0.1.0" });
    expect(older.latest).toBe("0.7.0");
    const newer = await stateAfter({ version: "9.9.9" });
    expect(newer.latest).toBe("0.7.0");
    expect(newer.outcome).toBe("current");
  });

  test("a failed check records the failure and increments the count", async () => {
    const io = fakeIO({
      [updateStatePath("/cfg")]: JSON.stringify({
        checkedAt: "2026-08-01T00:00:00.000Z",
        outcome: "failed",
        reason: "unreachable",
        consecutiveFailures: 2,
      }),
    });
    const s = await stateAfter({ io, fetch: redirectTo("https://example.test/releases/tag/v0.7", 302) });
    expect(s.outcome).toBe("failed");
    expect(s.reason).toBe("unparseable-tag");
    expect(s.consecutiveFailures).toBe(3);
  });

  test("a successful check resets the failure count", async () => {
    const io = fakeIO({
      [updateStatePath("/cfg")]: JSON.stringify({
        checkedAt: "2026-08-01T00:00:00.000Z",
        outcome: "failed",
        reason: "unreachable",
        consecutiveFailures: 6,
      }),
    });
    const s = await stateAfter({ io });
    expect(s.outcome).toBe("current");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.reason).toBeUndefined();
  });

  test("an unreachable network records a failure and never throws", async () => {
    const f = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const s = await stateAfter({ fetch: f });
    expect(s.outcome).toBe("failed");
    expect(s.reason).toBe("unreachable");
    expect(s.consecutiveFailures).toBe(1);
  });
});

// ── the persistent-failure warning (ADR-0001 §5) ─────────────────────────────

describe("persistentFailureWarning", () => {
  function failing(n: number, over: Partial<UpdateState> = {}): UpdateState {
    return { checkedAt: NOW.toISOString(), outcome: "failed", reason: "unreachable", consecutiveFailures: n, ...over };
  }

  test("says nothing below the threshold", () => {
    for (const n of [0, 1, 3, 6]) expect(persistentFailureWarning(failing(n))).toBeUndefined();
  });

  test("warns once the threshold is reached, naming the count and the reason", () => {
    const w = persistentFailureWarning(failing(7));
    expect(w).toContain("7 times in a row");
    expect(w).toContain("unreachable");
    // It points at the diagnostic command rather than telling anyone to run an
    // upgrade: no output channel gains an imperative an agent could act on.
    expect(w).toContain("rundown status");
  });

  test("keeps warning past the threshold", () => {
    expect(persistentFailureWarning(failing(30))).toContain("30 times in a row");
  });

  test("a recorded refusal counts too, since a refused install never updates either", () => {
    const w = persistentFailureWarning(failing(7, { outcome: "refused", reason: "install directory not writable" }));
    expect(w).toContain("install directory not writable");
  });

  test("says nothing when the last check succeeded, whatever the stale count", () => {
    expect(persistentFailureWarning(failing(9, { outcome: "current", reason: undefined }))).toBeUndefined();
    expect(persistentFailureWarning(failing(9, { outcome: "updated", reason: undefined }))).toBeUndefined();
  });

  test("says nothing with no state at all", () => {
    expect(persistentFailureWarning(undefined)).toBeUndefined();
  });

  test("tolerates a missing reason", () => {
    expect(persistentFailureWarning(failing(7, { reason: undefined }))).toContain("7 times in a row");
  });
});
