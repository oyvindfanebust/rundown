// The debug logging channel (ADR-0015): an opt-in, structural-only diagnostic
// stream on stderr, enabled by `--debug` or `RUNDOWN_DEBUG`.
//
// This is a trust-boundary surface, and it sits beside `trust.ts` and
// `sources/errors.ts` for that reason: anything written here reaches stderr, an
// agent-readable channel, so it must carry only trusted structural signal — never
// a byte an external party can author (ADR-0004 §3, §5).
//
// The guarantee is INHERITED, not newly invented. `Untrusted<T>` is nominally
// opaque (a TypeScript `private` field), so it is not assignable to `string` or
// `number`. Every field of every event below is a plain scalar, so handing an
// untrusted value to the sink is a COMPILE ERROR. The only way to raw bytes stays
// `unwrap()`, whose sole call site is the summarizer-prompt assembly in `plan.ts`
// (enforced by `scripts/check-unwrap-sites.sh`); nothing in this module imports it.
//
// Two rules keep the union honest as it grows — both close a leak that a naive
// logger would open:
//
//  1. NO free `error` / `message` / `detail` string field. That is precisely where
//     a caught backend error gets stringified (`String(e)`), which is the leak
//     `statusOnlyError` exists to prevent. Where an event needs a code, it carries
//     a numeric `httpStatus` read through the shared `statusOf` scrub.
//  2. Host and path SHAPE only — never a populated URL or query string, which can
//     carry user or query content. A `path` field is a control-plane filesystem
//     path (the config file, a log directory), not a backend-authored value.
//
// The union is CLOSED and source-agnostic: every remote source emits the same
// `http` event, parameterized by a `source` key, so it does not grow per source.
// It grows only for a genuinely new KIND of structural signal — and that edit is
// the boundary review, the same discipline as the sole-unwrap-site rule.

/**
 * One debug event. Every field is a trusted structural scalar; see the module
 * header for why that is the whole guarantee.
 */
export type DebugEvent =
  /** Which config file was used, and whether `RUNDOWN_CONFIG` chose it. */
  | { kind: "config-path"; path: string; provenance: "default" | "env" }
  /** One completed HTTP request: host + path shape + status. Never a full URL. */
  | { kind: "http"; source: string; method: string; host: string; pathShape: string; status: number }
  /** The outcome of a source's live credential check. */
  | { kind: "auth-verify"; source: string; outcome: "ready" | "rejected"; httpStatus?: number }
  /** One source's read: wall time and how many items it returned. */
  | { kind: "source-run"; source: string; ms: number; itemCount: number }
  /** One page fetched by a paginating source. */
  | { kind: "pagination"; source: string; page: number; items: number }
  /** A transport routing decision (e.g. Jira's gateway-vs-instance fallback). */
  | { kind: "route"; source: string; via: string; reason?: "preferred" | "fallback" }
  /** A local source's filesystem scan: which directory, how many files. */
  | { kind: "scan"; source: string; path: string; fileCount: number };

/**
 * The debug sink. Sources and the composition root receive one and emit into it;
 * `cli.ts` owns the single implementation that writes to stderr.
 */
export type DebugSink = (event: DebugEvent) => void;

/**
 * The off switch, as a value rather than an `undefined` every call site must
 * branch on. Debug being disabled is the common case, so it must cost nothing at
 * the call site and never change control flow.
 */
export const noDebug: DebugSink = () => {};

/**
 * Whether debug is on: the `--debug` flag OR `RUNDOWN_DEBUG` in the environment
 * (ADR-0015 §2). The env var follows the `RUNDOWN_MODEL`/`RUNDOWN_CONFIG`
 * convention and survives across a sequence of commands; `0`, `false`, and empty
 * read as off so `RUNDOWN_DEBUG=0` does what it looks like.
 */
export function debugEnabled(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag) return true;
  const v = env.RUNDOWN_DEBUG;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** The host of an origin, for the `http` event. Falls back to the raw origin if unparseable. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Render one event as a single stderr line. The sole formatter — call sites emit
 * structure, never prose, so the wording cannot drift and every line is greppable.
 */
export function formatDebugEvent(e: DebugEvent): string {
  switch (e.kind) {
    case "config-path":
      return `[debug] config  path=${e.path} provenance=${e.provenance}`;
    case "http":
      return `[debug] ${e.source}  http ${e.method} ${e.host}${e.pathShape} → ${e.status}`;
    case "auth-verify":
      return `[debug] ${e.source}  auth-verify ${e.outcome}${e.httpStatus !== undefined ? ` (HTTP ${e.httpStatus})` : ""}`;
    case "source-run":
      return `[debug] ${e.source}  source-run ${e.ms}ms ${e.itemCount} item(s)`;
    case "pagination":
      return `[debug] ${e.source}  page ${e.page} → ${e.items} item(s)`;
    case "route":
      return `[debug] ${e.source}  route via=${e.via}${e.reason ? ` (${e.reason})` : ""}`;
    case "scan":
      return `[debug] ${e.source}  scan path=${e.path} files=${e.fileCount}`;
  }
}

/**
 * Build the stderr sink, or the no-op when debug is off. Unlike the `onProgress`
 * progress sink this is NOT gated on `stderr.isTTY` (ADR-0015 §4): progress is
 * ambient noise a piped run should not see, but debug is explicitly requested and
 * its main use is capturing signal from a piped or CI run. stdout stays reserved
 * for the Brief (ADR-0006) either way.
 */
export function makeDebugSink(enabled: boolean, write: (s: string) => void): DebugSink {
  if (!enabled) return noDebug;
  return (event) => write(`${formatDebugEvent(event)}\n`);
}
