// Pure string transforms for text that leaves the binary or meets the model (ADR-0022).
// No unwrap: every function here takes an already-unwrapped string. `label()` (label.ts),
// the Digester and the Summarizer share them, so the strip and the defang have one
// definition each.

// Invisible and smuggled Unicode, stripped from untrusted text before the model reads it
// and from every label before it leaves. Invisible codepoints let an attacker hide
// instructions that survive human review: the model sees them, a person does not.
// Stripped, by class:
//   • Tag block U+E0000–U+E007F: ASCII smuggling (hidden text encoded as invisible "tag"
//     codepoints, astral, so the regex needs the `u` flag)
//   • Bidi controls U+202A–U+202E, U+2066–U+2069, U+061C: rendered order can diverge from
//     logical order
//   • Standalone invisibles U+200B (ZWSP), U+2060 (word joiner), U+FEFF (BOM/ZWNBSP): split
//     or hide tokens
// Kept: U+200C (ZWNJ) and U+200D (ZWJ), which emoji ZWJ sequences and Persian, Arabic and
// Indic script shaping need. Every codepoint is written as an escape, never a literal, so the
// invisible bytes this constant exists to strip never appear in this file's source.
const INVISIBLE_UNICODE_RE = /[\u061C\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u{E0000}-\u{E007F}]/gu;

/** Remove invisible and smuggled codepoints. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, "");
}

// Every URL is defanged, with no allowlist: a trusted-versus-hostile URL cannot be told
// from the string alone. A markdown image that lands on a rendering surface fetches itself,
// which is zero-click exfiltration.
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const HTTPS_SCHEME_RE = /https:\/\//gi;
const HTTP_SCHEME_RE = /http:\/\//gi;

// What survives the wrapper strip is neutralized so no renderer parses it: a leftover image
// marker, an inline link or image opener, a reference definition, and anything that opens an
// HTML tag or autolink.
const IMAGE_MARKER_RE = /!\[/g;
const INLINE_OPENER_RE = /\]\(/g;
const REFERENCE_DEF_RE = /\]:/g;
const TAG_OPEN_RE = /<(?=[a-z/!?])/gi;

/**
 * Strip markdown image and link wrappers down to their visible text, discarding the URL,
 * then neutralize any bare URL scheme that remains, including one used as link text.
 * Images go before links, since `![alt](url)` also matches the link pattern on its tail.
 * Whatever markdown or HTML syntax is left (nested brackets, reference-style links, raw
 * tags, autolinks) is broken up so it renders as text. Text with no URLs or markup passes
 * through unchanged.
 */
export function defang(text: string): string {
  const withoutMarkdown = text.replace(MARKDOWN_IMAGE_RE, "$1").replace(MARKDOWN_LINK_RE, "$1");
  return withoutMarkdown
    .replace(HTTPS_SCHEME_RE, "hxxps://")
    .replace(HTTP_SCHEME_RE, "hxxp://")
    .replace(IMAGE_MARKER_RE, "[")
    .replace(INLINE_OPENER_RE, "] (")
    .replace(REFERENCE_DEF_RE, "] :")
    .replace(TAG_OPEN_RE, "&lt;");
}

// Whitespace plus the C0 and C1 control characters, which some readers treat as line breaks
// (NEL, the file and record separators) though JavaScript's `\s` does not match them.
const SPACE_RUN_RE = /[\s\u0000-\u001F\u007F-\u009F]+/g;

/** Collapse whitespace and control-character runs to one space and trim, so text stays on one line. */
export function oneLine(text: string): string {
  return text.replace(SPACE_RUN_RE, " ").trim();
}

/** The mark a clamped string ends in. */
export const ELLIPSIS = "…";

/** The mark a cut message body or chat text ends in, so the Summarizer knows text is missing. */
export const TRUNCATION_MARKER = "…[truncated]";

/**
 * Cut `text` to at most `max` UTF-16 units, the `mark` included, ending in `mark` (default
 * "…") when it was cut. A surrogate pair is never split.
 */
export function clamp(text: string, max: number, mark = ELLIPSIS): string {
  if (text.length <= max) return text;
  let end = max - mark.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${mark}`;
}
