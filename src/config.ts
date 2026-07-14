// Config resolution (ADR-0007): the thin composition-root step that loads and
// validates ~/.config/rundown/config.json (JSONC), then delegates window
// resolution to temporal.ts, producing the values handed to the
// Aggregator/Planner. Not a component — no module boundary of its own (ADR-0008 §2).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Window } from "./domain.ts";
import { validateOptionValue, type OptionSpec, type Sources } from "./sources/source.ts";
import { WINDOW_SPANS, resolveSelector, type WindowSpan, type WindowSelector } from "./temporal.ts";

export interface Selection {
  sourceKey: string;
  options: Record<string, unknown>;
}

export interface ResolvedConfig {
  timezone: string;
  /** Display label for the resolved window: a span name, or an explicit range literal. */
  windowSpan: string;
  window: Window;
  /** Whether the whole window lies in the past — the neutral fact the Planner maps to review-vs-plan. */
  windowIsPast: boolean;
  selection: Selection[];
  guidance?: string;
}

/** A user-facing, fail-hard config error (ADR-0007 §6). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configPath(): string {
  return process.env.RUNDOWN_CONFIG ?? join(homedir(), ".config", "rundown", "config.json");
}

/**
 * The directory holding rundown's per-user state — the single source of truth for
 * "where rundown keeps its config and its companion files" (e.g. the Graph MSAL
 * token cache). Derived from {@link configPath}, so `RUNDOWN_CONFIG` moves the whole
 * set together rather than splitting the config file from the state beside it.
 */
export function configDir(): string {
  return dirname(configPath());
}

// ── JSONC ──────────────────────────────────────────────────────────────────

/** Strip `//` and block comments and trailing commas, respecting string literals. */
export function stripJsonc(s: string): string {
  let out = "";
  let inStr = false;
  let strCh = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const c2 = s[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && c2 === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += s[i + 1] ?? "";
        i++;
      } else if (c === strCh) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      continue;
    }
    if (c === "/" && c2 === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      // Drop a trailing comma before this closer. We look *back* over the
      // already-emitted output (comments and whitespace stripped), so a comma
      // separated from the closer only by whitespace and/or comments is removed
      // — matching the old whole-text regex. And because commas inside string
      // literals were emitted via the `inStr` branch, not here, they are never
      // reached: string contents are left intact.
      let end = out.length;
      while (end > 0 && /\s/.test(out[end - 1]!)) end--;
      if (end > 0 && out[end - 1] === ",") out = out.slice(0, end - 1);
    }
    out += c;
  }
  return out;
}

// ── Timezone validation ──────────────────────────────────────────────────────

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function suggest(unknown: string, known: string[]): string {
  const near = known.find((k) => k.startsWith(unknown) || unknown.startsWith(k) || k.includes(unknown));
  return near ? ` — did you mean "${near}"?` : "";
}

function validateOption(sourceKey: string, name: string, spec: OptionSpec, value: unknown): void {
  const where = `option "${name}" for source "${sourceKey}"`;
  const err = validateOptionValue(spec, value, where);
  if (err) throw new ConfigError(err);
}

/** Parse + validate raw config text (strict fail-hard) against the injected source lookup. Returns the checked config. */
export function parseConfig(text: string, sources: Sources): {
  timezone?: string;
  window?: WindowSpan;
  selection: Selection[];
  guidance?: string;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new ConfigError(`config.json is not valid JSONC: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config.json must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  // timezone
  let timezone: string | undefined;
  if (obj.timezone !== undefined) {
    if (typeof obj.timezone !== "string" || !isValidTimezone(obj.timezone)) {
      throw new ConfigError(`Invalid "timezone": ${JSON.stringify(obj.timezone)} is not an IANA timezone.`);
    }
    timezone = obj.timezone;
  }

  // window
  let window: WindowSpan | undefined;
  if (obj.window !== undefined) {
    if (typeof obj.window !== "string" || !WINDOW_SPANS.includes(obj.window as WindowSpan)) {
      throw new ConfigError(
        `Invalid "window": ${JSON.stringify(obj.window)} — expected one of ${JSON.stringify(WINDOW_SPANS)}.`,
      );
    }
    window = obj.window as WindowSpan;
  }

  // guidance
  let guidance: string | undefined;
  if (obj.guidance !== undefined) {
    if (typeof obj.guidance !== "string") throw new ConfigError(`"guidance" must be a string.`);
    guidance = obj.guidance;
  }

  // sources — the one mandatory field
  if (obj.sources === undefined) {
    throw new ConfigError(`Missing required "sources". Minimum: {"sources": {"graph": {}}}.`);
  }
  if (typeof obj.sources !== "object" || obj.sources === null || Array.isArray(obj.sources)) {
    throw new ConfigError(`"sources" must be an object keyed by source name.`);
  }
  const configSources = obj.sources as Record<string, unknown>;
  const keys = Object.keys(configSources);
  if (keys.length === 0) {
    throw new ConfigError(`"sources" must select at least one source (e.g. {"graph": {}}).`);
  }

  const selection: Selection[] = [];
  for (const key of keys) {
    const source = sources[key];
    if (!source) {
      throw new ConfigError(`Unknown source "${key}"${suggest(key, Object.keys(sources))}.`);
    }
    const entry = configSources[key];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`Source "${key}" options must be an object.`);
    }
    const options = entry as Record<string, unknown>;
    const declared = Object.keys(source.options);
    for (const optName of Object.keys(options)) {
      const spec = source.options[optName];
      if (!spec) {
        throw new ConfigError(`Unknown ${`option "${optName}" for source "${key}"`}${suggest(optName, declared)}.`);
      }
      validateOption(key, optName, spec, options[optName]);
    }
    selection.push({ sourceKey: key, options });
  }

  return { timezone, window, selection, guidance };
}

// ── Load + resolve ─────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Per-invocation `--window` override (span or explicit range); overrides config's symbolic default. */
  windowOverride?: WindowSelector;
  now?: Date;
}

/** Load, validate, and resolve the config file into a ResolvedConfig against the injected source lookup. Fail-hard. */
export async function resolveConfig(sources: Sources, opts: ResolveOptions = {}): Promise<ResolvedConfig> {
  const path = configPath();
  if (!existsSync(path)) {
    throw new ConfigError(`No config at ${path}. Run \`rundown init\` to create one.`);
  }
  const parsed = parseConfig(await readFile(path, "utf-8"), sources);
  const now = opts.now ?? new Date();
  const timezone = parsed.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Config's `window` is symbolic-only (ADR-0007); an explicit range comes only from `--window`.
  const selector: WindowSelector = opts.windowOverride ?? { kind: "span", span: parsed.window ?? "this-week" };
  const window = resolveSelector(selector, timezone, now);
  const windowSpan = selector.kind === "span" ? selector.span : selector.label;
  // Reconcile `now` against the resolved window once, here — so the Planner never needs a clock.
  const windowIsPast = Date.parse(window.to) <= now.getTime();
  return { timezone, windowSpan, window, windowIsPast, selection: parsed.selection, guidance: parsed.guidance };
}
