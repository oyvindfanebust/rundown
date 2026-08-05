// Self-update (ADR-0001 §5). This ticket builds the two halves that everything
// else reports into: the update state document, and the `status` version line read
// from it. The gate, the detached worker, release discovery, and the download/swap
// land later in this same module.
//
// The module runs beside the read → aggregate → summarize → emit pipeline, not in
// it (ADR-0008 §2): it is not a component, shares no state with one, and reads no
// source content. Every value here is a trusted structural scalar — a version
// string, an outcome enum, a short reason — so nothing untrusted is ever in scope
// and no `Untrusted<T>` is imported.
//
// Effects arrive by parameter, following the Graph and Slack sources and the debug
// sink: the caller supplies the filesystem operations, the directory, and the
// clock, which is what makes every branch below testable without a real
// filesystem.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the last update check did. */
export type UpdateOutcome = "updated" | "current" | "refused" | "failed";

const OUTCOMES: readonly string[] = ["updated", "current", "refused", "failed"];

/**
 * The update state document (ADR-0001 §5): the throttle stamp and the diagnostic
 * channel in one. `reason` is absent when nothing declined or failed.
 */
export interface UpdateState {
  /** When the check ran, as an ISO instant. */
  checkedAt: string;
  /** The latest version the check saw, when it got that far. */
  latest?: string;
  outcome: UpdateOutcome;
  /** Short structural reason a refusal or failure happened. */
  reason?: string;
  consecutiveFailures: number;
}

/** What a writer records; `checkedAt` comes from the injected clock. */
export type UpdateRecord = Omit<UpdateState, "checkedAt">;

/** The filesystem effects the state document needs, injected by parameter. */
export interface UpdateStateIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** The real filesystem implementation, used by the CLI. */
export const fsUpdateStateIO: UpdateStateIO = {
  readFile: (path) => readFile(path, "utf-8"),
  writeFile: (path, text) => writeFile(path, text),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

export const UPDATE_STATE_FILENAME = "update-state.json";

/**
 * The state document's path inside a resolved config directory. It lives beside
 * config.json rather than in the home directory, so `RUNDOWN_CONFIG` moves config
 * and its companion state together the way the Graph token cache already does.
 */
export function updateStatePath(dir: string): string {
  return join(dir, UPDATE_STATE_FILENAME);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Read the state document, or `undefined` when there is nothing usable there.
 * Missing, empty, unparseable, wrong-shaped, and unreadable all read the same
 * way: no state. This is a diagnostic file written by a background process, so a
 * damaged one must never fail the command that reads it. Fields of the wrong type
 * are dropped rather than trusted.
 */
export async function readUpdateState(io: UpdateStateIO, dir: string): Promise<UpdateState | undefined> {
  let text: string;
  try {
    text = await io.readFile(updateStatePath(dir));
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const checkedAt = asString(obj.checkedAt);
  const outcome = asString(obj.outcome);
  // checkedAt and outcome are the two fields the line and the throttle both need;
  // without either the document says nothing, so it reads as no state at all.
  if (!checkedAt || !outcome || !OUTCOMES.includes(outcome)) return undefined;
  const state: UpdateState = {
    checkedAt,
    outcome: outcome as UpdateOutcome,
    consecutiveFailures: typeof obj.consecutiveFailures === "number" && Number.isFinite(obj.consecutiveFailures) ? obj.consecutiveFailures : 0,
  };
  const latest = asString(obj.latest);
  if (latest) state.latest = latest;
  const reason = asString(obj.reason);
  if (reason) state.reason = reason;
  return state;
}

/**
 * Write the state document, stamping `checkedAt` from the injected clock, and
 * return what was written. The config directory is created when absent, so the
 * first check on a machine with no config still records its outcome.
 */
export async function writeUpdateState(
  io: UpdateStateIO,
  dir: string,
  record: UpdateRecord,
  now: () => Date,
): Promise<UpdateState> {
  const state: UpdateState = { checkedAt: now().toISOString(), ...record };
  // Absent fields stay absent rather than becoming null.
  const document: Record<string, unknown> = {
    checkedAt: state.checkedAt,
    ...(state.latest ? { latest: state.latest } : {}),
    outcome: state.outcome,
    ...(state.reason ? { reason: state.reason } : {}),
    consecutiveFailures: state.consecutiveFailures,
  };
  await io.mkdir(dir);
  await io.writeFile(updateStatePath(dir), JSON.stringify(document, null, 2) + "\n");
  return state;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether `latest` is strictly greater than `running`. Both are parsed against an
 * exact three-part pattern; anything else — a `v` prefix, a pre-release suffix,
 * the `0.0.0-dev` source marker — reads as "not newer" rather than being
 * interpreted (ADR-0001 §5). Comparison is in-repo with no dependency, because
 * this is the one path where a supply-chain edge would be self-defeating.
 */
export function isNewerVersion(latest: string, running: string): boolean {
  const a = SEMVER.exec(latest);
  const b = SEMVER.exec(running);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Whether auto-update is switched off for this invocation via
 * `RUNDOWN_DISABLE_AUTOUPDATE` (ADR-0001 §5). `0`, `false`, and empty read as off,
 * the same convention `RUNDOWN_DEBUG` uses. The durable config field is a separate
 * reader that arrives with the gate; when it is set, the gate records the refusal
 * in the state document and the version line names it from there.
 */
export function autoUpdateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.RUNDOWN_DISABLE_AUTOUPDATE;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export interface VersionLineInput {
  /** The version this process is running (`0.0.0-dev` when run from source). */
  running: string;
  state?: UpdateState;
  autoUpdateDisabled: boolean;
}

/**
 * The `status` version line, rendered from the state document with no network
 * call: the running version, a newer known version when the state records one,
 * and the recorded reason when an update is being refused. A daily-stale number is
 * the right trade for a diagnostic command that must never hang, and every input
 * is optional, so the line renders on a fresh install with no state and on a
 * source run with no version stamp.
 */
export function renderVersionLine({ running, state, autoUpdateDisabled: disabled }: VersionLineInput): string {
  const parts: string[] = [];
  const newer = state?.latest && isNewerVersion(state.latest, running) ? state.latest : undefined;

  if (!state && !disabled) return `version   ${running}   no update check recorded yet`;

  if (newer) parts.push(`${newer} available`);
  // A running version that is not an exact three-part semver is the source-run dev
  // marker, which no comparison can order: name the recorded release rather than
  // claim to be up to date with it.
  else if (state?.latest && state.latest !== running && !SEMVER.test(running)) parts.push(`latest release ${state.latest}`);

  const failed = !disabled && state?.outcome === "failed";
  if (disabled) parts.push(`auto-update disabled`);
  else if (state?.outcome === "refused") parts.push(`update refused: ${state.reason ?? "no reason recorded"}`);
  else if (failed) parts.push(`last update check failed${state.reason ? `: ${state.reason}` : ""}`);
  else if (parts.length === 0) parts.push(`up to date`);

  const notes: string[] = [];
  if (failed && state.consecutiveFailures > 1) notes.push(`${state.consecutiveFailures} in a row`);
  if (state) notes.push(`checked ${state.checkedAt}`);
  const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return `version   ${running}   ${parts.join(" — ")}${suffix}`;
}
