// `label()`: the second of the two places untrusted bytes are read (ADR-0022). A label is
// source text that code copies into the digest: a subject, a meeting title, a name, a
// channel, a room, a location. It is unfabricated, not trusted, so it leaves only stripped
// of smuggled codepoints, defanged, on one line and clamped. The other read site is the
// Digester's unwrap for Summarizer input and grouping (digester.ts).

import { unwrap, type Untrusted } from "./trust.ts";
import { clamp, defang, oneLine, stripInvisible } from "./sanitize.ts";

/** Longest subject or meeting title in the digest. */
export const TITLE_MAX = 255;

/** Longest name, channel name, room or location in the digest. */
export const NAME_MAX = 120;

/**
 * The label form of an untrusted string: invisible codepoints stripped, URLs and markup
 * defanged, whitespace and control-character runs (newlines included) collapsed to one
 * space, trimmed, and clamped to `max` with a trailing "…". Returns `undefined` when
 * nothing is left, so an empty name is absent rather than an empty string.
 */
export function label(value: Untrusted<string> | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = oneLine(defang(stripInvisible(unwrap(value))));
  return text === "" ? undefined : clamp(text, max);
}
