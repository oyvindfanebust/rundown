import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  readUpdateState,
  writeUpdateState,
  updateStatePath,
  isNewerVersion,
  autoUpdateDisabled,
  renderVersionLine,
  type UpdateState,
  type UpdateStateIO,
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

  test("an updated outcome reads as up to date on the version now running", () => {
    expect(renderVersionLine({ running: "0.4.0", state: state({ outcome: "updated", latest: "0.4.0" }), autoUpdateDisabled: false })).toBe(
      "version   0.4.0   up to date (checked 2026-08-05T09:00:00.000Z)",
    );
  });
});
