// The external surface (ADR-0008 §4): parse args, dispatch the five commands,
// and own emission (Brief JSON → stdout, errors → stderr, exit codes). No domain
// logic lives here.

import { parseArgs, type ParseArgsConfig } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildBrief } from "./brief.ts";
import { configPath, resolveConfig, ConfigError } from "./config.ts";
import { parseWindowSelector, WindowError, WINDOW_SPANS, type WindowSelector } from "./temporal.ts";
import { descriptors, registeredKeys, buildRegistry } from "./sources/registry.ts";
import { narrateStatus, optionTemplateDefault, type Source } from "./sources/source.ts";

// Build-time semver (ADR-0001 §7): the release workflow injects RUNDOWN_VERSION via
// `bun build --define` from the git tag; running from source falls back to the dev marker.
declare const RUNDOWN_VERSION: string;
const VERSION = typeof RUNDOWN_VERSION === "string" ? RUNDOWN_VERSION : "0.0.0-dev";

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
  // Sources with interactive login need `rundown login`; no-auth sources (local
  // logs) don't — say so rather than print a misleading auth hint. `interactive`
  // is the static declaration (#27), read here where no instance exists yet.
  const auth = descriptor.interactive ? "Auth: rundown login" : "No auth required.";
  return [`    // ${descriptor.label}. ${auth}`, `    ${JSON.stringify(key)}: {`, ...optionLines, `    }`].join("\n");
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

  // Default planning window. Override per run: rundown brief --window today
  // Spans: ${WINDOW_SPANS.join(" | ")}
  "window": "this-week",

  // Which sources run — selection = presence in this map. At least one required.
  // Only registered sources may appear; an unknown key is a hard error.
  "sources": {
${sources}
  },

  // Freeform steering for the planner. Trusted — reaches the model as instructions.
  // Say what to surface first and the tone you want.
  "guidance": "Surface commitments I've made to others first, then anything time-sensitive or that people are waiting on me for. Keep it terse."
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
      `  1. edit the file — set your timezone, guidance, and any source options\n` +
      `  2. rundown login    (authenticate every configured source)\n` +
      `  3. rundown status   (check what's still missing)\n`,
  );
}

// ── status: converging per-source diagnostic ────────────────────────────────

async function cmdStatus(): Promise<void> {
  const path = configPath();
  const out = process.stdout;

  let config;
  try {
    config = await resolveConfig(descriptors);
  } catch (e) {
    if (e instanceof ConfigError) {
      out.write(`config    ${path}   ✗ invalid\n\n    ${e.message}\n\n`);
      out.write(`Config is checked before any source runs, so this surfaces first.\n`);
      out.write(`Next: fix the file, then re-run rundown status\n`);
      process.exit(1);
    }
    throw e;
  }

  out.write(`config    ${path}   ✓ valid\n`);
  out.write(`timezone  ${config.timezone}\n`);
  out.write(`window    ${config.windowSpan}\n`);

  // Global summarizer credential (ADR-0009 §4).
  const keyPresent = Boolean(process.env.ANTHROPIC_API_KEY);
  out.write(`summarizer  ${keyPresent ? "✓ ANTHROPIC_API_KEY present" : "✗ ANTHROPIC_API_KEY missing — export it"}\n`);

  out.write(`\nsources\n`);
  // Build the selected sources (config injected) to query their live status (#27).
  const sources = buildRegistry(config.selection);
  let ready = 0;
  const unauthed: string[] = [];
  for (const { sourceKey } of config.selection) {
    const source = sources[sourceKey]!;
    const st = await source.status();
    // The narration owns the glyph/phrase/identity wording; this line
    // just lays out the parts. Identity shows whenever a source reports one; a
    // no-auth local source reads "(no auth required)".
    const n = narrateStatus(st, { interactive: Boolean(source.login) });
    out.write(`  ${sourceKey}    ${n.glyph} ${n.label}${n.note ? `   ${n.note}` : ""}\n`);
    if (st.state === "ready") ready++;
    else if (st.state === "not-authenticated") unauthed.push(sourceKey);
  }

  const total = config.selection.length;
  out.write(`\n${ready} of ${total} source${total === 1 ? "" : "s"} ready.\n`);
  if (!keyPresent) out.write(`Next: export ANTHROPIC_API_KEY\n`);
  else if (unauthed.length > 0) out.write(`Next: rundown login   (authenticates ${unauthed.join(", ")})\n`);
  else if (ready < total) out.write(`Next: fix source configuration above, then re-run rundown status\n`);
  else out.write(`Next: rundown brief\n`);
}

// ── login: walk every configured-but-unauthenticated interactive source, or ──
// (with a positional) target one source by its registry key ─────────────────

/**
 * A `not-configured` detail conventionally reads "set VAR[, VAR2]" (Graph, Linear
 * both phrase it this way) — strip that prefix so the credential can be named on
 * its own (e.g. in "authenticates via LINEAR_API_KEY"). Details that don't follow
 * the convention pass through unchanged rather than being mangled.
 */
function credentialHint(detail: string): string {
  const m = /^set (.+)$/.exec(detail);
  return m ? m[1]! : detail;
}

/**
 * Log in one interactive source, printing the same per-source lines the bare walk
 * has always printed. Returns whether it newly authenticated (false when it was
 * already ready) — shared by the bare walk and the targeted `login <source>` path.
 */
async function loginOne(out: NodeJS.WritableStream, key: string, source: Source): Promise<boolean> {
  const st = await source.status();
  if (st.state === "ready") {
    const n = narrateStatus(st, { interactive: true });
    out.write(`  ${key}   ${n.glyph} already authenticated${n.note ? `   ${n.note}` : ""}\n`);
    return false;
  }
  out.write(`  ${key}   authenticating…\n`);
  const identity = await source.login!();
  out.write(`  ${key}   ✓ authenticated   ${identity}\n`);
  return true;
}

/**
 * The message for `login <source>` when the named source has no `login()` — auth
 * is structural (ADR-0002 §2): `login()` presence is the interactive declaration,
 * so its absence always means "nothing to log in" here, whether the source needs
 * a declared env-credential (its `status()` can report `not-configured`, with the
 * credential named in `detail`) or no auth at all.
 */
async function nonInteractiveLoginError(key: string, source: Source): Promise<string> {
  const st = await source.status();
  if (st.state === "not-configured" && st.detail) {
    return `${key} authenticates via ${credentialHint(st.detail)} — nothing to log in`;
  }
  return `${key} requires no authentication — nothing to log in`;
}

async function cmdLogin(sourceKey?: string): Promise<void> {
  const out = process.stdout;

  // Targeted mode: one registered source, independent of the user's config
  // selection — pre-authenticating a source before adding it to config.json is
  // legitimate, and the registry key is the only thing that needs resolving.
  if (sourceKey !== undefined) {
    const descriptor = descriptors[sourceKey];
    if (!descriptor) fail(`Unknown source "${sourceKey}". Registered sources: ${registeredKeys().join(", ")}`);
    // Config-independent: build with empty config (#27). A source that needs config
    // reports `not-configured` from status(), which the login paths already narrate.
    const source = descriptor.build({});
    if (!source.login) fail(await nonInteractiveLoginError(sourceKey, source));
    const authenticated = await loginOne(out, sourceKey, source);
    out.write(authenticated ? `\nDone. Next: rundown status\n` : `\nAlready authenticated. Next: rundown status\n`);
    return;
  }

  // Bare mode: walk every configured-but-unauthenticated interactive source —
  // and never claim success while a configured env-credential source (no
  // `login()`, but declared via a `not-configured` status) is unreadable.
  const config = await resolveConfig(descriptors);
  const sources = buildRegistry(config.selection);
  let walked = 0;
  const unready: { key: string; hint: string }[] = [];
  for (const { sourceKey: key } of config.selection) {
    const source = sources[key]!;
    if (!source.login) {
      const st = await source.status();
      if (st.state !== "ready") {
        unready.push({ key, hint: st.state === "not-configured" && st.detail ? credentialHint(st.detail) : "its credentials" });
      }
      continue;
    }
    if (await loginOne(out, key, source)) walked++;
  }

  if (unready.length > 0) {
    out.write(`\n`);
    for (const { key, hint } of unready) out.write(`  ${key}   needs ${hint} in your environment\n`);
    out.write(`\nNext: export ${unready.map((u) => u.hint).join(", ")}, then re-run rundown login\n`);
    return;
  }

  out.write(walked === 0 ? `\nAll configured sources already authenticated.\n` : `\nDone. Next: rundown status\n`);
}

// ── brief: the composed pipeline; emit one Brief as JSON on stdout ───────────

async function cmdBrief(windowOverride?: WindowSelector, sourceFilter?: string[]): Promise<void> {
  // Progress goes to stderr, and only when it's a terminal — a piped/agent run
  // gets clean silent streams; stdout stays reserved for the Brief JSON (ADR-0006).
  const onProgress = process.stderr.isTTY
    ? (message: string) => process.stderr.write(`${message}\n`)
    : undefined;
  const brief = await buildBrief({ windowOverride, sourceFilter, onProgress });
  // Bun.write awaits the flush, so the JSON is fully emitted before we exit.
  await Bun.write(Bun.stdout, JSON.stringify(brief) + "\n");
}

// ── dispatch ──────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// Options are parsed per command, not once globally: each command declares only
// the flags it accepts, so a flag a command doesn't own is a hard error rather
// than silently ignored (issue #30). parseArgs is strict, so it throws on any
// undeclared flag; parseCommandArgs translates that into a clean fail() naming
// the command. Only `brief` accepts flags today (--window, --source); the rest
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

const USAGE = `rundown — a readout of where you stand across your work sources

Usage:
  rundown brief [--window <span|date|range>] [--source <name>]…   compose and emit the Brief as JSON on stdout
  rundown login [<source>]                     authenticate every configured source, or just <source>
  rundown status                               per-source configured/authed diagnostic
  rundown init                                 write the annotated config template
  rundown --version                            print the version

Window:
  spans:  ${WINDOW_SPANS.join(" | ")}
  date:   YYYY-MM-DD                 (a single calendar day)
  range:  YYYY-MM-DD..YYYY-MM-DD     (explicit, end-inclusive)

Source:
  --source narrows this run to a subset of the configured sources; repeat it to
  keep several (--source graph --source linear). Omit it to run them all.`;

try {
  switch (command) {
    case "brief": {
      // Repeatable --source (`--source graph --source linear`) narrows this run
      // to a subset of the configured sources; absent = the full selection.
      const { values } = parseCommandArgs("brief", {
        window: { type: "string" },
        source: { type: "string", multiple: true },
      });
      await cmdBrief(parseWindow(values.window), values.source);
      break;
    }
    case "login": {
      const { positionals } = parseCommandArgs("login", {});
      await cmdLogin(positionals[0]);
      break;
    }
    case "status":
      parseCommandArgs("status", {});
      await cmdStatus();
      break;
    case "init":
      parseCommandArgs("init", {});
      await cmdInit();
      break;
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
