// The external surface (ADR-0008 §4): parse args, dispatch the five commands,
// and own emission (digest JSON → stdout, errors → stderr, exit codes). No domain
// logic lives here.

import { parseArgs, type ParseArgsConfig } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { composeRundown } from "./root.ts";
import { configPath } from "./config.ts";
import { parseWindowSelector, WindowError, WINDOW_SPANS, type WindowSelector } from "./temporal.ts";
import { descriptors, registeredKeys } from "./sources/registry.ts";
import { narrateStatus, optionTemplateDefault } from "./sources/source.ts";
import { summarize } from "./summarize.ts";
import { debugEnabled, makeDebugSink, type DebugSink } from "./debug.ts";
import { runUpdateWorkerIfRequested, startUpdateGate, updateWarning, versionLine } from "./update.ts";

// Build-time semver (ADR-0001 §7): the release workflow injects RUNDOWN_VERSION via
// `bun build --define` from the git tag; running from source falls back to the dev marker.
declare const RUNDOWN_VERSION: string;
const VERSION = typeof RUNDOWN_VERSION === "string" ? RUNDOWN_VERSION : "0.0.0-dev";

/**
 * Build this invocation's debug sink (ADR-0015 §2, §4) and emit the one event
 * every command shares. Debug goes to stderr unconditionally — unlike the
 * TTY-gated progress sink — because its whole purpose is capturing signal from a
 * piped or CI run. stdout stays reserved for the digest (ADR-0006).
 *
 * The config-path event is emitted here rather than per command: which file was
 * read, and whether `RUNDOWN_CONFIG` chose it, is the first question every
 * config-touching command raises — including `init`, whose "already exists" can
 * otherwise be baffling when an override is set in a forgotten shell profile.
 */
function startDebug(flag: boolean | undefined): DebugSink {
  const debug = makeDebugSink(debugEnabled(flag), (s) => process.stderr.write(s));
  debug({
    kind: "config-path",
    path: configPath(),
    provenance: process.env.RUNDOWN_CONFIG ? "env" : "default",
  });
  return debug;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ── init: write the annotated JSONC config template ──────────────────────────

function renderSourceEntry(key: string): string {
  const descriptor = descriptors[key]!;
  const optionLines: string[] = [];
  const names = Object.keys(descriptor.options);
  names.forEach((name, i) => {
    const spec = descriptor.options[name]!;
    const def = optionTemplateDefault(spec);
    const comma = i < names.length - 1 ? "," : "";
    optionLines.push(`      // ${spec.description}`);
    optionLines.push(`      ${JSON.stringify(name)}: ${def}${comma}`);
  });
  // Every source logs in interactively.
  return [`    // ${descriptor.label}. Auth: rundown login`, `    ${JSON.stringify(key)}: {`, ...optionLines, `    }`].join("\n");
}

function initTemplate(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sources = registeredKeys()
    .map(renderSourceEntry)
    .join(",\n");
  return `{
  // rundown config — personalization only, zero secrets.
  // Secrets (ANTHROPIC_API_KEY, AZURE_TENANT_ID, AZURE_CLIENT_ID, SLACK_CLIENT_ID,
  // SLACK_CLIENT_SECRET, source tokens)
  // live in your environment, never here. Safe to copy or commit this file.

  // IANA timezone. Window spans + all-day items resolve against it. Omit to use the system tz.
  "timezone": ${JSON.stringify(tz)},

  // Default window. Override per run: rundown digest --window today
  // Spans: ${WINDOW_SPANS.join(" | ")}
  "window": "this-week",

  // Whether rundown may replace its own binary with a newer release in the background.
  // Default true. Set it to false to stay on the version you installed; that is what makes
  // an install-time version pin (RUNDOWN_VERSION in install.sh) durable.
  // "autoUpdate": true,

  // Which sources run — selection = presence in this map. At least one required.
  // Only registered sources may appear; an unknown key is a hard error.
  "sources": {
${sources}
  },
}
`;
}

async function cmdInit(): Promise<void> {
  const path = configPath();
  if (existsSync(path)) {
    process.stdout.write(`Config already exists at ${path} — leaving it untouched.\n`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, initTemplate());
  process.stdout.write(
    `Wrote ${path} (annotated template).\n\n` +
      `Next:\n` +
      `  1. edit the file — set your timezone and any source options\n` +
      `  2. rundown login    (authenticate every configured source)\n` +
      `  3. rundown status   (check what's still missing)\n`,
  );
}

// The composition root, built from the static source registry and the real Summarizer.
const rundown = composeRundown({ descriptors, summarize });

// ── status: converging per-source diagnostic ────────────────────────────────

async function cmdStatus(debug: DebugSink): Promise<void> {
  const path = configPath();
  const out = process.stdout;

  // The version line first, and before config is even read: it is the one line
  // that always renders (ADR-0001 §5). It makes no network call — the numbers come
  // from the state document the background updater writes — so `status` stays a
  // diagnostic that cannot hang, and a broken config still gets a version answer.
  out.write(`${await versionLine(VERSION)}\n`);

  const report = await rundown.status({ env: process.env, onDebug: debug });
  if (report.kind === "invalid-config") {
    out.write(`config    ${path}   ✗ invalid\n\n    ${report.message}\n\n`);
    out.write(`Config is checked before any source runs, so this surfaces first.\n`);
    out.write(`Next: fix the file, then re-run rundown status\n`);
    process.exit(1);
  }

  out.write(`config    ${path}   ✓ valid\n`);
  out.write(`timezone  ${report.timezone}\n`);
  out.write(`window    ${report.windowSpan}\n`);

  // Global summarizer credential (ADR-0009 §4).
  out.write(`summarizer  ${report.summarizerKey ? "✓ ANTHROPIC_API_KEY present" : "✗ ANTHROPIC_API_KEY missing — export it"}\n`);

  out.write(`\nsources\n`);
  for (const { key, status } of report.sources) {
    // The narration owns the glyph/phrase/identity wording; this line
    // just lays out the parts. Identity shows whenever a source reports one.
    const n = narrateStatus(status);
    out.write(`  ${key}    ${n.glyph} ${n.label}${n.note ? `   ${n.note}` : ""}\n`);
  }

  const total = report.sources.length;
  const ready = report.sources.filter((s) => s.status.state === "ready").length;
  out.write(`\n${ready} of ${total} source${total === 1 ? "" : "s"} ready.\n`);
  switch (report.next) {
    case "export-key":
      out.write(`Next: export ANTHROPIC_API_KEY\n`);
      break;
    case "login":
      out.write(`Next: rundown login   (authenticates ${report.unauthenticated.join(", ")})\n`);
      break;
    case "fix-config":
      out.write(`Next: fix source configuration above, then re-run rundown status\n`);
      break;
    case "digest":
      out.write(`Next: rundown digest\n`);
      break;
  }
}

// ── login: walk every configured-but-unauthenticated source, or ─────────────
// (with a positional) target one source by its registry key ─────────────────

async function cmdLogin(debug: DebugSink, sourceKey?: string): Promise<void> {
  const out = process.stdout;
  // Each line is written as its event arrives, so "authenticating…" shows before
  // the interactive login blocks.
  const result = await rundown.login({
    only: sourceKey,
    onDebug: debug,
    onEvent: (event) => {
      switch (event.phase) {
        case "already": {
          const n = narrateStatus({ state: "ready", identity: event.identity });
          out.write(`  ${event.key}   ${n.glyph} already authenticated${n.note ? `   ${n.note}` : ""}\n`);
          break;
        }
        case "authenticating":
          out.write(`  ${event.key}   authenticating…\n`);
          break;
        case "authenticated":
          out.write(`  ${event.key}   ✓ authenticated   ${event.identity}\n`);
          break;
      }
    },
  });

  if (result.targeted) {
    out.write(result.authenticated > 0 ? `\nDone. Next: rundown status\n` : `\nAlready authenticated. Next: rundown status\n`);
  } else {
    out.write(result.authenticated === 0 ? `\nAll configured sources already authenticated.\n` : `\nDone. Next: rundown status\n`);
  }
}

// ── digest: the composed pipeline; emit one digest as JSON on stdout ─────────

async function cmdDigest(debug: DebugSink, windowOverride?: WindowSelector, sourceFilter?: string[]): Promise<void> {
  // Progress goes to stderr, and only when it's a terminal — a piped/agent run
  // gets clean silent streams; stdout stays reserved for the digest JSON (ADR-0006).
  const onProgress = process.stderr.isTTY
    ? (message: string) => process.stderr.write(`${message}\n`)
    : undefined;

  // A permanently broken updater must not stay invisible to a human. Gated on the
  // same terminal check as progress output, so a piped or agent-driven run stays
  // byte-for-byte silent on both streams and no automated consumer is affected.
  // Nothing about this reaches the digest: ADR-0021 pins that contract with a schema
  // test, and it is the untrusted-derived artifact.
  if (process.stderr.isTTY) {
    const warning = await updateWarning();
    if (warning) process.stderr.write(`${warning}\n`);
  }
  const result = await rundown.digest({ windowOverride, sourceFilter, onProgress, onDebug: debug });
  // Bun.write awaits the flush, so the JSON is fully emitted before we exit.
  await Bun.write(Bun.stdout, JSON.stringify(result) + "\n");
}

// ── self-update: the internal worker mode, then the gate ─────────────────────
//
// Both run above every line that touches an argument (ADR-0001 §5, ADR-0008 §2).
// Self-update is a behavior, not a sixth command: the worker is an env-gated mode
// of this same binary, so the agent-facing surface stays exactly five commands and
// no output channel gains an imperative.
//
// The worker's early return is the structural guarantee that matters: because it
// returns before argument handling, config resolution, Sources, and the Summarizer
// are all unreachable from it. No untrusted byte is ever in scope while it runs,
// which is why self-update needs no separate trust argument — its axis (a
// first-party artifact over TLS) and the untrusted-content axis cannot both be
// live in one process.

if (await runUpdateWorkerIfRequested({ version: VERSION })) process.exit(0);

const [command, ...rest] = process.argv.slice(2);

// The flags each command accepts. parseCommandArgs parses a command's arguments
// against its entry; the update gate reads --debug against the same entry.
const COMMAND_OPTIONS = {
  // Repeatable --source (`--source graph --source slack`) narrows this run to a
  // subset of the configured sources; absent = the full selection.
  digest: {
    window: { type: "string" },
    source: { type: "string", multiple: true },
    debug: { type: "boolean" },
  },
  login: { debug: { type: "boolean" } },
  status: { debug: { type: "boolean" } },
  init: { debug: { type: "boolean" } },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

/**
 * Whether the command will parse `--debug` as set, read before dispatch so the
 * update gate can use it (issue #105). It runs the command's own parse, so it
 * agrees with parseCommandArgs on option values and `--`. A command that does
 * not declare the flag, or arguments the command will reject, read as off.
 */
function debugFlagOnArgv(name: string | undefined, args: string[]): boolean {
  if (name === undefined || !Object.hasOwn(COMMAND_OPTIONS, name)) return false;
  try {
    const options = COMMAND_OPTIONS[name as keyof typeof COMMAND_OPTIONS];
    return parseArgs({ args, options, allowPositionals: true }).values.debug === true;
  } catch {
    return false;
  }
}

// Fire before the command runs, not after: several paths below exit the process
// directly, and a trailing hook would be skipped on exactly the error paths where
// a stale version is most likely. The gate never throws and never waits on the
// worker, so an armed check costs the command nothing. `entry` is this script's
// path, which the worker needs when running from source.
await startUpdateGate({
  version: VERSION,
  entry: import.meta.path,
  debug: makeDebugSink(debugEnabled(debugFlagOnArgv(command, rest)), (s) => process.stderr.write(s)),
});

// ── dispatch ──────────────────────────────────────────────────────────────

if (command === "--version" || command === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// Options are parsed per command, not once globally: each command declares only
// the flags it accepts, so a flag a command doesn't own is a hard error rather
// than silently ignored (issue #30). parseArgs is strict, so it throws on any
// undeclared flag; parseCommandArgs translates that into a clean fail() naming
// the command. Only `digest` accepts flags today (--window, --source); the rest
// accept none (login still takes its optional <source> positional).
function parseCommandArgs<const T extends ParseArgsConfig["options"]>(name: string, options: T) {
  try {
    return parseArgs({ args: rest, options, allowPositionals: true });
  } catch (e) {
    if (e instanceof Error && "code" in e && typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS")) {
      // parseArgs names no offending token structurally, so lift it from the
      // message; if that wording ever changes we fall back to the raw message
      // rather than crash. The pinned test string catches a wording drift in CI.
      const m = /'(--?[^']+)'/.exec(e.message);
      fail(m ? `rundown ${name}: option ${m[1]} is not valid here` : `rundown ${name}: ${e.message}`);
    }
    throw e;
  }
}

function parseWindow(w: string | undefined): WindowSelector | undefined {
  if (w === undefined) return undefined;
  try {
    return parseWindowSelector(w);
  } catch (e) {
    if (e instanceof WindowError) fail(e.message);
    throw e;
  }
}

const USAGE = `rundown — a readout of your mail, chat and calendar

Usage:
  rundown digest [--window <span|date|range>] [--source <name>]…  emit the window's digest as JSON on stdout
  rundown login [<source>]                     authenticate every configured source, or just <source>
  rundown status                               per-source configured/authed diagnostic
  rundown init                                 write the annotated config template
  rundown --version                            print the version

Window:
  spans:  ${WINDOW_SPANS.join(" | ")}
  date:   YYYY-MM-DD                 (a single calendar day)
  range:  YYYY-MM-DD..YYYY-MM-DD     (explicit, end-inclusive)

Debug:
  --debug on any command (or RUNDOWN_DEBUG=1) writes structural diagnostics to
  stderr: config path, HTTP method/host/path/status, auth outcomes, per-source
  timings and counts. Never source content. stdout stays the digest.

Source:
  --source narrows this run to a subset of the configured sources; repeat it to
  keep several (--source graph --source slack). Omit it to run them all.`;

try {
  switch (command) {
    case "digest": {
      const { values } = parseCommandArgs("digest", COMMAND_OPTIONS.digest);
      await cmdDigest(startDebug(values.debug), parseWindow(values.window), values.source);
      break;
    }
    case "login": {
      const { values, positionals } = parseCommandArgs("login", COMMAND_OPTIONS.login);
      await cmdLogin(startDebug(values.debug), positionals[0]);
      break;
    }
    case "status": {
      const { values } = parseCommandArgs("status", COMMAND_OPTIONS.status);
      await cmdStatus(startDebug(values.debug));
      break;
    }
    case "init": {
      const { values } = parseCommandArgs("init", COMMAND_OPTIONS.init);
      // init writes a template and does no I/O worth tracing; the shared
      // config-path event startDebug emits is its entire debug surface.
      startDebug(values.debug);
      await cmdInit();
      break;
    }
    default:
      process.stderr.write(USAGE + "\n");
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

// Exit explicitly once the command has completed and its output has flushed —
// lingering handles (MSAL keep-alive sockets, the Anthropic client) must not
// keep the process alive after the work is done.
process.exit(0);
