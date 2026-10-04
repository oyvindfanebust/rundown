// PROTOTYPE (map #117). Throwaway. Helpers shared by real-week.ts and slack-week.ts.

import { createHash } from "node:crypto";

export const TZ = "Europe/Oslo";
export const LABEL_MAX = 120;
export const TITLE_MAX = 255;
export const WHO_MAX = 8;

export const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function defang(t: string): string {
  return t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https:\/\//gi, "hxxps://")
    .replace(/http:\/\//gi, "hxxp://");
}

/** Defang, then clamp to `max`, marking a cut with "…" so a shortened label never passes for the whole one. */
export function label(t?: string, max = LABEL_MAX): string | undefined {
  if (!t) return undefined;
  const d = defang(t);
  return d.length > max ? `${d.slice(0, max - 1)}…` : d;
}

/** An instant rendered in TZ with its offset, e.g. 2026-10-01T13:00:00+02:00. */
export function zoned(iso: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const off = Math.round((local - d.getTime()) / 60000);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

/** `people` clamped to WHO_MAX plus the overflow count, both omitted when empty. */
export function clampPeople(names: string[], key: "people" | "attendees", moreKey: "morePeople" | "moreAttendees") {
  return {
    ...(names.length ? { [key]: names.slice(0, WHO_MAX).map((n) => label(n)!) } : {}),
    ...(names.length > WHO_MAX ? { [moreKey]: names.length - WHO_MAX } : {}),
  };
}

export type Raw = Record<string, any>;
export interface Pair<E> { entry: E; raw: Raw[] }
