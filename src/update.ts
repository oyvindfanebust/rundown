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

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stripJsonc } from "./config.ts";

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

// ── the gate (ADR-0001 §5) ──────────────────────────────────────────────────

/**
 * Marks the internal worker mode. An env var rather than an argv command, so the
 * five-command agent-facing surface stays exactly five (ADR-0008 §6): there is
 * nothing here for an agent to discover or invoke. Named to read as internal
 * plumbing, not as a user knob.
 */
export const WORKER_ENV = "RUNDOWN_INTERNAL_UPDATE_WORKER";

/**
 * How stale a recorded check must be before another one runs. Twenty hours rather
 * than a flat twenty-four so a daily habit at a slightly earlier hour still
 * checks, instead of drifting a day later on every run.
 */
export const THROTTLE_MS = 20 * 60 * 60 * 1000;

/** Why the gate declined. Every value is a short structural string, safe to record and print. */
export type GateRefusal =
  | "dev-build"
  | "worker"
  | "disabled-env"
  | "ci"
  | "disabled-config"
  | "throttled"
  | "not-writable";

/** Everything the decision depends on, passed in so the predicate stays pure. */
export interface GateInputs {
  /** The running version; the dev marker means a source run. */
  version: string;
  env: NodeJS.ProcessEnv;
  /** The config field as the lenient reader saw it; `undefined` when absent or unreadable. */
  autoUpdateConfig: boolean | undefined;
  state: UpdateState | undefined;
  now: Date;
  installDirWritable: boolean;
}

export type GateDecision = { spawn: true } | { spawn: false; reason: GateRefusal };

/**
 * Whether this invocation should fork an update worker, and when not, why.
 *
 * The order is load-bearing and matches ADR-0001 §5: the cheap structural
 * refusals come first, and writability — the only one worth recording as a
 * user-visible refusal — comes last, so a throttled run does not re-record it
 * every day. `CI` is checked by presence, with no override: an opt-out switch
 * does not protect a vendored binary in a pipeline that never sets it.
 */
export function updateGateDecision({
  version,
  env,
  autoUpdateConfig,
  state,
  now,
  installDirWritable,
}: GateInputs): GateDecision {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { spawn: false, reason: "dev-build" };
  if (env[WORKER_ENV] !== undefined) return { spawn: false, reason: "worker" };
  if (autoUpdateDisabled(env)) return { spawn: false, reason: "disabled-env" };
  if (env.CI !== undefined) return { spawn: false, reason: "ci" };
  if (autoUpdateConfig === false) return { spawn: false, reason: "disabled-config" };
  if (state) {
    const checkedAt = Date.parse(state.checkedAt);
    // An unparseable stamp fails toward checking again rather than toward never
    // checking: a damaged state file must not wedge the throttle shut.
    if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < THROTTLE_MS) {
      return { spawn: false, reason: "throttled" };
    }
  }
  if (!installDirWritable) return { spawn: false, reason: "not-writable" };
  return { spawn: true };
}

/**
 * The gate's own read of the config file — deliberately a second reader, not
 * `config.ts`'s strict fail-hard path (ADR-0001 §5).
 *
 * The gate runs before any command, including on invocations where no config
 * exists yet, so it cannot fail hard. Every error is swallowed and read as
 * not-disabled. The consequence is explicit and intended: a config file with a
 * syntax error keeps auto-updating even if it contains the off-switch. That bias
 * is correct — a broken file should not strand someone on an old binary — and the
 * strict reader still rejects the same file the moment a real command runs.
 */
export async function readAutoUpdateSetting(io: UpdateStateIO, path: string): Promise<boolean | undefined> {
  try {
    const raw = JSON.parse(stripJsonc(await io.readFile(path)));
    if (typeof raw !== "object" || raw === null) return undefined;
    const v = (raw as Record<string, unknown>).autoUpdate;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── the hook and the worker (ADR-0001 §5) ───────────────────────────────────

/** Everything the hook touches, injected so the whole path is testable offline. */
export interface UpdateGateDeps {
  version: string;
  env: NodeJS.ProcessEnv;
  /** The resolved config directory, where the state document lives. */
  dir: string;
  /** The config file itself, for the lenient off-switch read. */
  configFile: string;
  io: UpdateStateIO;
  now: () => Date;
  /** The running executable, symlinks already resolved. */
  execPath: string;
  /** Whether the directory holding the executable can be written. */
  dirWritable: (dir: string) => Promise<boolean>;
  /** Fork the detached worker. Never awaited by the caller. */
  spawnWorker: (execPath: string) => void;
  debug: (reason: string, spawned: boolean) => void;
}

/**
 * Decide whether to check for a new version, and if so fork the worker and return
 * immediately. Runs from one hook at the top of CLI dispatch, above the version
 * branch, so all five commands and the usage fallback arm it — which also means
 * the installer's own post-install version probe counts as the day's check, and a
 * fresh install does not check again the same hour.
 *
 * Never throws: a diagnostic side errand must not fail the command the user asked
 * for. The throttle stamp is written before the worker is spawned, so a worker
 * that crashes on startup cannot re-spawn on every invocation.
 */
export async function armUpdateCheck(deps: UpdateGateDeps): Promise<GateDecision> {
  try {
    const state = await readUpdateState(deps.io, deps.dir);
    const decision = updateGateDecision({
      version: deps.version,
      env: deps.env,
      autoUpdateConfig: await readAutoUpdateSetting(deps.io, deps.configFile),
      state,
      now: deps.now(),
      installDirWritable: await deps.dirWritable(dirname(deps.execPath)),
    });
    deps.debug(decision.spawn ? "spawn" : decision.reason, decision.spawn);

    if (!decision.spawn) {
      // An unwritable install directory is the one refusal worth surfacing: it is
      // silent otherwise, and the user can fix it. The rest are either expected
      // (CI, a source run) or already visible (the off-switch, the throttle).
      if (decision.reason === "not-writable") {
        await writeUpdateState(
          deps.io,
          deps.dir,
          { outcome: "refused", reason: "install directory not writable", consecutiveFailures: state?.consecutiveFailures ?? 0 },
          deps.now,
        );
      }
      return decision;
    }

    // Stamp first, spawn second. The stamp carries the previous outcome forward
    // rather than claiming a fresh result: all this write asserts is when the
    // check started. The worker replaces it with the real outcome.
    await writeUpdateState(
      deps.io,
      deps.dir,
      {
        outcome: state?.outcome ?? "current",
        ...(state?.latest ? { latest: state.latest } : {}),
        ...(state?.reason ? { reason: state.reason } : {}),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
      },
      deps.now,
    );
    deps.spawnWorker(deps.execPath);
    return decision;
  } catch {
    // Any failure here means no update check this run, which is the safe outcome.
    return { spawn: false, reason: "not-writable" };
  }
}

// ── discovery: the redirect probe (ADR-0001 §5) ──────────────────────────────

/** The stable "latest" pointer. A redirect, not the JSON API — see {@link discoverLatestVersion}. */
export const RELEASES_LATEST_URL = "https://github.com/oyvindfanebust/rundown/releases/latest";

/** How long a network read may take before it is abandoned. */
export const NETWORK_TIMEOUT_MS = 10_000;

/** What discovery learned, or why it learned nothing. Both are recordable as-is. */
export type Discovery =
  | { ok: true; latest: string }
  | { ok: false; reason: "unreachable" | "unexpected-response" | "unparseable-tag" };

/**
 * Ask GitHub for the latest release version by reading the redirect, with
 * redirects handled manually so the `Location` header is ours to parse.
 *
 * This is deliberately not the JSON API. The redirect needs no token, has no rate
 * limit, costs a few hundred bytes, and honours the same `latest` pointer that
 * already excludes drafts and pre-releases. The API's unauthenticated
 * 60-per-hour-per-IP limit is reachable behind a shared corporate egress address,
 * and its failure mode is a silent refusal that would stop updates for an unknown
 * set of users. Nothing in the response is needed beyond the tag, because asset
 * names are deterministic from the platform (ADR-0001 §2–§3).
 *
 * Anything unexpected returns a reason rather than a guess: a tag that is not an
 * exact three-part semver aborts instead of being interpreted, so an unexpected
 * response can never turn into an arbitrary download. The read carries an abort
 * timeout, so a hung worker cannot linger as an orphaned process.
 */
export async function discoverLatestVersion(deps: {
  fetch: typeof fetch;
  url?: string;
  timeoutMs?: number;
}): Promise<Discovery> {
  let response: Response;
  try {
    response = await deps.fetch(deps.url ?? RELEASES_LATEST_URL, {
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? NETWORK_TIMEOUT_MS),
    });
  } catch {
    // A network failure, a DNS failure, and a timeout are one outcome here: no
    // answer. The distinction would not change what the updater does next.
    return { ok: false, reason: "unreachable" };
  }
  if (response.status < 300 || response.status > 399) return { ok: false, reason: "unexpected-response" };
  const location = response.headers.get("location");
  if (!location) return { ok: false, reason: "unexpected-response" };

  // The live shape is `.../releases/tag/v0.6.0`; the leading `v` is the tag
  // convention, not part of the version.
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1];
  if (!tag) return { ok: false, reason: "unparseable-tag" };
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: "unparseable-tag" };
  return { ok: true, latest: version };
}

/**
 * The internal worker mode: the same binary, re-executed with {@link WORKER_ENV}/**
 * The internal worker mode: the same binary, re-executed with {@link WORKER_ENV}
 * set. It returns before any argument handling, which is what guarantees it cannot
 * reach config resolution, Sources, or the Summarizer — no untrusted byte is ever
 * in scope while it runs, so self-update needs no separate trust argument.
 *
 * Today it only records that a check happened. Release discovery and the
 * download/verify/swap arrive in #64 and #65 and report into the same document.
 */
export async function runUpdateWorker(deps: {
  io: UpdateStateIO;
  dir: string;
  now: () => Date;
  /** The running version, passed in rather than read from the build-time constant, so every comparison branch is testable. */
  version: string;
  fetch: typeof fetch;
  url?: string;
  timeoutMs?: number;
  /** Replace the binary with the given version. Absent means discovery only (the read path). */
  swap?: (latest: string) => Promise<SwapResult>;
}): Promise<void> {
  try {
    const state = await readUpdateState(deps.io, deps.dir);
    const found = await discoverLatestVersion(deps);

    if (!found.ok) {
      // A failed check is recorded, not swallowed: the count is what lets a
      // permanently broken updater become visible instead of silently never
      // working. It stays silent on the invoking run — this process is detached.
      await writeUpdateState(
        deps.io,
        deps.dir,
        { outcome: "failed", reason: found.reason, consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1 },
        deps.now,
      );
      return;
    }

    // A successful check resets the count. `latest` is recorded whether or not it
    // is newer, because that is what the status line reports from; the
    // strictly-greater comparison is what decides whether anything happens — never
    // on equal, never downward.
    if (!isNewerVersion(found.latest, deps.version) || !deps.swap) {
      await writeUpdateState(
        deps.io,
        deps.dir,
        { latest: found.latest, outcome: "current", consecutiveFailures: 0 },
        deps.now,
      );
      return;
    }

    const swapped = await deps.swap(found.latest);
    if (swapped.ok) {
      // The new version takes effect on the next invocation; this process is not
      // mutated, so a Brief in flight stays deterministic.
      await writeUpdateState(
        deps.io,
        deps.dir,
        { latest: found.latest, outcome: "updated", consecutiveFailures: 0 },
        deps.now,
      );
      return;
    }
    // A refusal is recorded with its reason, which `status` then surfaces, and the
    // working binary is untouched. This counts as a failure: something is wrong
    // with the release or the install, and a run of them should become visible.
    await writeUpdateState(
      deps.io,
      deps.dir,
      {
        latest: found.latest,
        outcome: "refused",
        reason: swapped.reason,
        consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
      },
      deps.now,
    );
  } catch {
    // A worker that cannot record its own outcome exits quietly; the next run's
    // stale stamp will simply try again.
  }
}

// ── the swap: download, verify, smoke-test, rename (ADR-0001 §5) ─────────────

/**
 * This platform's release asset name, or `undefined` on a platform the release
 * matrix does not build. The mapping exists in three places — `install.sh`'s case
 * statement, the release workflow's build matrix, and here — so a test pins the
 * expected names and a platform added to one and forgotten in another fails loudly.
 */
export function assetName(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "darwin") {
    if (arch === "arm64") return "rundown-darwin-arm64";
    if (arch === "x64") return "rundown-darwin-x64";
    return undefined;
  }
  if (platform === "linux") {
    if (arch === "x64") return "rundown-linux-x64";
    if (arch === "arm64") return "rundown-linux-arm64";
    return undefined;
  }
  // Windows needs a different self-replace strategy entirely: there is no atomic
  // rename over a running executable (ADR-0001 §3).
  return undefined;
}

/** The download URL for one asset on one release tag. */
export function assetUrl(version: string, asset: string, base = "https://github.com/oyvindfanebust/rundown/releases/download"): string {
  return `${base}/v${version}/${asset}`;
}

/** Why the swap declined. Recorded verbatim to the state document, which `status` surfaces. */
export type SwapRefusal =
  | "unsupported-platform"
  | "asset-missing"
  | "checksum-missing"
  | "checksum-mismatch"
  | "smoke-test-failed"
  | "version-mismatch"
  | "write-failed";

export type SwapResult = { ok: true } | { ok: false; reason: SwapRefusal };

/** The effects the swap needs, injected so the whole path is testable. */
export interface SwapIO {
  /** Write the candidate bytes, then make it executable. */
  writeCandidate(path: string, bytes: Uint8Array): Promise<void>;
  makeExecutable(path: string): Promise<void>;
  /** Run the candidate once with the version flag. */
  probe(path: string): Promise<{ exitCode: number; stdout: string }>;
  /** Same-filesystem atomic replace. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  sha256(bytes: Uint8Array): string;
}

/**
 * The real implementation: a real filesystem and a real subprocess. Only the
 * network is faked in tests, because renaming, permission bits, and actually
 * executing the candidate are the behavior under test rather than incidental.
 */
export const fsSwapIO: SwapIO = {
  writeCandidate: async (path, bytes) => {
    await writeFile(path, bytes);
  },
  makeExecutable: async (path) => {
    await chmod(path, 0o755);
  },
  probe: async (path) => {
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: (await proc.exited) ?? 1, stdout };
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
  sha256: (bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
};

/** The candidate's fixed name, in the target's own directory so the rename is atomic. */
export const CANDIDATE_SUFFIX = ".update-candidate";

/**
 * Download the newer release, verify it, prove it runs, and only then replace the
 * binary on disk. Returns a refusal rather than throwing, so the worker can record
 * why nothing was installed.
 *
 * The order is the safety argument. The checksum is verified before the file is
 * made executable, so a corrupt download is never even runnable. The candidate is
 * then executed once and must exit zero AND report the expected version — a
 * liveness check, not a correctness check, and the reason this can ship enabled by
 * default: a binary that does not start would otherwise reach every install within
 * a day and leave users on a `rundown` that cannot update out of the problem. Only
 * then is it renamed over the target.
 *
 * The candidate is a fixed-name file in the target's own directory, so the rename
 * is a same-filesystem atomic swap and a killed worker leaves at most one stale
 * file that the next run overwrites rather than accumulating debris. The temporary
 * file is removed on every exit path.
 *
 * No lock is taken. Two workers can both download, both verify, and both rename;
 * rename is atomic and the bytes are identical either way, so the outcome is the
 * same and the cost is one wasted download. The cost of a lock would be stale-lock
 * detection in the code path that must never wedge.
 */
export async function downloadAndSwap(deps: {
  fetch: typeof fetch;
  io: SwapIO;
  /** The resolved target path, symlinks already followed. */
  target: string;
  version: string;
  asset?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<SwapResult> {
  const asset = deps.asset ?? assetName();
  if (!asset) return { ok: false, reason: "unsupported-platform" };
  const candidate = deps.target + CANDIDATE_SUFFIX;
  const signal = () => AbortSignal.timeout(deps.timeoutMs ?? NETWORK_TIMEOUT_MS);
  const url = assetUrl(deps.version, asset, deps.baseUrl);

  try {
    const binary = await deps.fetch(url, { signal: signal() });
    if (!binary.ok) return { ok: false, reason: "asset-missing" };
    const bytes = new Uint8Array(await binary.arrayBuffer());

    const sums = await deps.fetch(`${url}.sha256`, { signal: signal() });
    if (!sums.ok) return { ok: false, reason: "checksum-missing" };
    // The checksum asset is `<hash>  <name>`, the shasum/sha256sum format.
    const expected = (await sums.text()).trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || expected !== deps.io.sha256(bytes)) return { ok: false, reason: "checksum-mismatch" };

    await deps.io.writeCandidate(candidate, bytes);
    await deps.io.makeExecutable(candidate);

    const probe = await deps.io.probe(candidate);
    if (probe.exitCode !== 0) return { ok: false, reason: "smoke-test-failed" };
    if (probe.stdout.trim() !== deps.version) return { ok: false, reason: "version-mismatch" };

    await deps.io.rename(candidate, deps.target);
    return { ok: true };
  } catch {
    return { ok: false, reason: "write-failed" };
  } finally {
    // Every exit path, including the successful one where the rename already moved
    // it: removing a file that is gone is not an error worth propagating.
    await deps.io.remove(candidate).catch(() => {});
  }
}

// ── the persistent-failure warning (ADR-0001 §5) ─────────────────────────────

/**
 * How many consecutive failed checks before a human is told. Seven days is long
 * enough that transient network failures never trigger it, and short enough to
 * catch a real breakage within the week.
 */
export const FAILURE_WARN_THRESHOLD = 7;

/**
 * The one line a human sees when updates have been failing for about a week, or
 * `undefined` when there is nothing to say.
 *
 * Everything else about update failure is deliberately silent, and the visible
 * signal lives in `status`. But the primary consumer is an agent, and an agent runs
 * `brief`; it has no reason to call `status` again after onboarding. An install
 * where every check has failed for months looks identical to a healthy one from the
 * only command anyone actually runs.
 *
 * Accepted limitation: a fully headless install never has a terminal, so it stays
 * silent regardless. The rejected alternative was surfacing this in the Brief,
 * which would pollute a contract ADR-0011 pins with a schema test and which is the
 * untrusted-derived artifact.
 */
export function persistentFailureWarning(state: UpdateState | undefined): string | undefined {
  if (!state || state.outcome !== "failed" && state.outcome !== "refused") return undefined;
  if (state.consecutiveFailures < FAILURE_WARN_THRESHOLD) return undefined;
  const why = state.reason ? ` (${state.reason})` : "";
  return `rundown: self-update has failed ${state.consecutiveFailures} times in a row${why}. Run \`rundown status\` for details.`;
}
