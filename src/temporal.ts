// Temporal resolution (ADR-0010): turn a window selector — a symbolic span
// (this-week, …), a single date, or an explicit inclusive range — plus a
// timezone and the current instant into an absolute {@link Window} of two
// instants. Owns the calendar/timezone arithmetic so config.ts stays load →
// validate → delegate. Public surface: parseWindowSelector + resolveSelector.

import type { Window } from "./domain.ts";

export const WINDOW_SPANS = ["today", "this-week", "next-week", "last-week"] as const;
export type WindowSpan = (typeof WINDOW_SPANS)[number];

/**
 * A window selector from the CLI/config: either a symbolic {@link WindowSpan} or
 * an explicit, end-**inclusive** calendar-date range (ADR-0010). `config.json`'s
 * `window` field stays symbolic-only; explicit ranges are a per-invocation
 * `--window` escape hatch. The `label` on a range is the literal string used for
 * progress/status display (e.g. `"2026-07-06..2026-07-12"` or `"2026-07-14"`).
 */
export type WindowSelector =
  | { kind: "span"; span: WindowSpan }
  | { kind: "range"; from: Ymd; to: Ymd; label: string };

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** A user-facing, fail-hard window-selector error (ADR-0010). */
export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

// ── Window resolution ────────────────────────────────────────────────────────

/** The local calendar date (in `tz`) of instant `at`, plus its day-of-week (0=Sun). */
function localDate(tz: string, at: Date): Ymd & { dow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow };
}

function addDays({ y, m, d }: Ymd, days: number): Ymd {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** UTC offset (minutes) of `tz` at instant `at`. */
function tzOffsetMinutes(tz: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** The absolute instant of local midnight on `ymd` in `tz`. */
function zonedMidnight(tz: string, ymd: Ymd): string {
  const approx = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0));
  const off = tzOffsetMinutes(tz, approx);
  return new Date(approx.getTime() - off * 60_000).toISOString();
}

/** Resolve a symbolic span against a timezone into two absolute instants. */
function resolveWindow(span: WindowSpan, tz: string, now: Date): Window {
  const today = localDate(tz, now);
  const mondayOffset = today.dow === 0 ? -6 : 1 - today.dow;
  let start: Ymd;
  let days: number;
  if (span === "today") {
    start = today;
    days = 1;
  } else if (span === "this-week") {
    start = addDays(today, mondayOffset);
    days = 7;
  } else if (span === "last-week") {
    start = addDays(today, mondayOffset - 7);
    days = 7;
  } else {
    start = addDays(today, mondayOffset + 7);
    days = 7;
  }
  return { from: zonedMidnight(tz, start), to: zonedMidnight(tz, addDays(start, days)) };
}

// ── Explicit date windows (ADR-0010) ─────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fmtYmd({ y, m, d }: Ymd): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parse one `YYYY-MM-DD` token, rejecting non-real dates (e.g. `2026-02-30`). */
function parseYmd(token: string, raw: string): Ymd {
  const m = token.match(DATE_RE);
  if (!m) {
    throw new WindowError(
      `Invalid --window ${JSON.stringify(raw)}: ${JSON.stringify(token)} is not a YYYY-MM-DD date (dates only, no time).`,
    );
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Round-trip through a UTC date: a non-real date (2026-02-30, 2026-13-01) rolls over and won't match.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new WindowError(`Invalid --window ${JSON.stringify(raw)}: ${JSON.stringify(token)} is not a real calendar date.`);
  }
  return { y, m: mo, d };
}

/**
 * Parse a `--window` value into a {@link WindowSelector} (fail-hard, WindowError).
 * Accepts a symbolic span, a single `YYYY-MM-DD` date (shorthand for `date..date`),
 * or an inclusive `YYYY-MM-DD..YYYY-MM-DD` range. No half-open ranges, no datetimes.
 */
export function parseWindowSelector(raw: string): WindowSelector {
  if (WINDOW_SPANS.includes(raw as WindowSpan)) {
    return { kind: "span", span: raw as WindowSpan };
  }
  if (raw.includes("..")) {
    const parts = raw.split("..");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      throw new WindowError(
        `Invalid --window range ${JSON.stringify(raw)}: use "YYYY-MM-DD..YYYY-MM-DD" — both ends are required (no half-open ranges) and the end is inclusive.`,
      );
    }
    const from = parseYmd(parts[0]!, raw);
    const to = parseYmd(parts[1]!, raw);
    if (Date.UTC(from.y, from.m - 1, from.d) > Date.UTC(to.y, to.m - 1, to.d)) {
      throw new WindowError(`Invalid --window range ${JSON.stringify(raw)}: start ${fmtYmd(from)} is after end ${fmtYmd(to)}.`);
    }
    return { kind: "range", from, to, label: `${fmtYmd(from)}..${fmtYmd(to)}` };
  }
  if (DATE_RE.test(raw)) {
    const d = parseYmd(raw, raw);
    return { kind: "range", from: d, to: d, label: fmtYmd(d) };
  }
  throw new WindowError(
    `Invalid --window ${JSON.stringify(raw)}. Expected a span (${WINDOW_SPANS.join(", ")}), a date "YYYY-MM-DD", or an inclusive range "YYYY-MM-DD..YYYY-MM-DD".`,
  );
}

/**
 * Resolve a {@link WindowSelector} into the absolute {@link Window}. A range's
 * inclusive end date becomes an exclusive `to` at midnight of `end + 1 day`, so
 * the internal `Window` keeps its exclusive-`to` contract untouched.
 */
export function resolveSelector(sel: WindowSelector, tz: string, now: Date): Window {
  if (sel.kind === "span") return resolveWindow(sel.span, tz, now);
  return { from: zonedMidnight(tz, sel.from), to: zonedMidnight(tz, addDays(sel.to, 1)) };
}
