// The normalizer (ADR-0002 §4): the shared NormalizedItem constructor —
// the branding + compaction ritual every Source repeated, spelled once. A source
// module makes ONE normalizer (`normalizer(source, {untitled})`) and hands each
// item's extracted fields to it; the normalizer owns the whole invariant: total
// branding via untrusted()/untrustedOpt(), String() id-coercion, title fallback +
// truncation, union compaction, and validating the structural
// instants (timestamp/end), the one operation that can throw: a non-ISO instant
// is backend garbage and fails hard here (ADR-0007 §6) rather than sliding through
// as a "trusted" string. Otherwise total, no I/O — and the sole trust.ts importer
// among sources: the only way a Source constructs
// a NormalizedItem. What stays at call sites is domain judgment only (e.g. graph's
// "normal" importance elision, linear's "No priority" elision, claude-code-logs'
// summary-over-firstPrompt title preference). ADR-0002 names the NormalizedItem
// *shape*; this deepens under it. Never unwrapped here (sole unwrap site is
// plan.ts; CLAUDE.md).

import type { NormalizedItem } from "../domain.ts";
import { untrusted, untrustedOpt } from "../trust.ts";

/** Max length for a free-text field (title / preview / description / …). */
export const TEXT_MAX = 200;

/**
 * The free-text marker (grilled design): truncate to {@link TEXT_MAX},
 * and let absence collapse — `""`/`null`/`undefined` → `undefined`, so compaction
 * can treat presence as signal.
 */
export function text(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  return v.slice(0, TEXT_MAX);
}

/**
 * Strict ISO-8601 instant shape: `YYYY-MM-DDTHH:mm` with optional
 * `:ss` (optional `.fraction`, any digit count) and an optional `Z` or numeric
 * `±HH:mm`/`±HHmm` offset. Chosen by inspecting what the three real sources
 * hand the normalizer today: Graph calendar's `dateTime` is pre-normalized to
 * `Z` (fraction stripped, offset-less values stamped `Z`) before it ever
 * reaches here; Graph mail's `receivedDateTime`/`sentDateTime` and Linear's
 * `updatedAt`/synthesized due-date instant are `Z`-suffixed, with 0 or 3-digit
 * fractions; Claude Code logs' transcript `timestamp` and index
 * `created`/`modified` are `Date#toISOString()` output (3-digit fraction +
 * `Z`). None of today's shapes carry a bare numeric offset or omit the
 * trailing `Z`/offset, but the grammar still accepts one, since that is still
 * strictly ISO-8601 and a plain engine-parseable string like `"July 1 2026"`
 * or an RFC-2822 date is not.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The structural-instant guard. `timestamp`/`end`
 * reach the normalizer as *verbatim backend strings* (transcript
 * `o.timestamp`, index `created`/`modified`, Linear `updatedAt`, …), yet they
 * are typed **trusted** and so bypass the `Untrusted<T>` unwrap tripwire. Left
 * unchecked they could carry NaN — silently mislabelling a bucket downstream
 * (ADR-0003 §4) — or arbitrary backend bytes with no type-level warning. A
 * shape check against {@link ISO_INSTANT} plus a `Date.parse` round-trip (for
 * semantic validity, e.g. rejecting month 13) constrains them to real
 * ISO-8601 instants here, the one place every source funnels through, making
 * ADR-0002 §5's "produced/constrained by rundown's own source module" true —
 * and true to the letter: `Date.parse` alone is engine-lenient (accepts
 * `"July 1 2026"`, RFC-2822, …), which the shape check now closes. Garbage
 * fails hard (ADR-0007 §6). The raw value is **never** echoed into the error:
 * it is backend-controlled, so it stays out of the error channel (CLAUDE.md).
 */
function instant(v: string, field: "timestamp" | "end", source: string): string {
  if (!ISO_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(
      `Source "${source}" emitted a structural ${field} that is not a strict ISO-8601 instant.`,
    );
  }
  return v;
}

/** The fields one item hands its normalizer: structural verbatim + bare backend content. */
export interface ItemSpec {
  kind: string;
  timestamp: string;
  end?: string;
  id: string | number | null | undefined;
  title: string | null | undefined;
  url?: string;
  extras?: Record<string, unknown>;
}

/**
 * The union compaction policy — "presence is signal": a value earns its
 * key by carrying information. `undefined`, `null`, `""`, `false`, and empty
 * arrays are absence and vanish; `0` and `true` are signal and stay. Declaration
 * order is preserved for deterministic rendering.
 */
function isSignal(v: unknown): boolean {
  if (v === undefined || v === null || v === "" || v === false) return false;
  return !(Array.isArray(v) && v.length === 0);
}

function compactExtras(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (isSignal(v)) out[k] = v;
  return out;
}

/**
 * Make a Source's normalizer: brand the backend content Untrusted
 * (`id`/`title`/`url`/`extras`), keep the structural core (`source`/`kind`/
 * `timestamp`/`end`) trusted — validating each instant via {@link instant} so a
 * non-ISO `timestamp`/`end` fails hard here — truncate every title (titles are hostile free text
 * by definition; no policy knob), fall back to `untitled` when the title is
 * absent, and compact `extras` — omitting it entirely when compaction empties it.
 */
export function normalizer(
  source: string,
  opts: { untitled?: string } = {},
): (spec: ItemSpec) => NormalizedItem {
  const untitled = opts.untitled ?? "(untitled)";
  return (spec) => {
    const extras = spec.extras === undefined ? undefined : compactExtras(spec.extras);
    const item: NormalizedItem = {
      source,
      kind: spec.kind,
      timestamp: instant(spec.timestamp, "timestamp", source),
      id: untrusted(String(spec.id ?? "")),
      title: untrusted(text(spec.title) ?? untitled),
      url: untrustedOpt(spec.url),
      extras: extras && Object.keys(extras).length > 0 ? untrusted(extras) : undefined,
    };
    if (spec.end !== undefined) item.end = instant(spec.end, "end", source);
    return item;
  };
}
