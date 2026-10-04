// The Aggregator (ADR-0020): pull the selected sources concurrently against one
// shared window, merge into a flat list, filter it to the window, and sort
// deterministically. Pure mechanism: it never reads record content, reads no
// config, and makes no selection policy. Grouping into digest entries is the
// Digester's, since the mail merge reads untrusted sender and subject. Fail-hard:
// any unauth/error aborts the whole run (no partial bundle).

import { eventBoundInstant, instantOf, type Bundle, type SourceRecord, type Window } from "./domain.ts";
import type { Selection } from "./config.ts";
import { narrateStatus, type Sources } from "./sources/source.ts";
import { noDebug, type DebugSink } from "./debug.ts";

export class AggregateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateError";
  }
}

/** Exhaustiveness guard: a future `SourceStatus` state becomes a compile error here. */
function assertNever(x: never): never {
  throw new AggregateError(`Unhandled source status: ${JSON.stringify(x)}`);
}

/**
 * Whether a record belongs to the window `[from, to)`, read from its trusted instants only.
 * A message counts by its own time. A timed event counts when it overlaps the window, so a
 * meeting that started before it stays. An all-day event is kept as the source returned
 * it: its dates are local calendar days, and the source selected them against the window
 * in the user's timezone, which the Aggregator does not know.
 */
export function inWindow(record: SourceRecord, window: Window): boolean {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const t = (instant: string) => {
    const ms = Date.parse(instant);
    // The normalizer validates every structural instant, so a NaN here means a source
    // bypassed it: a bug, not data. `source` is trusted; the raw value is not echoed.
    if (Number.isNaN(ms)) {
      throw new AggregateError(`Record from source "${record.source}" has an unparseable timestamp.`);
    }
    return ms;
  };
  switch (record.type) {
    case "email":
    case "chat-message": {
      const at = t(record.at);
      return at >= from && at < to;
    }
    case "calendar-event": {
      if (record.isAllDay) return true;
      const start = t(eventBoundInstant(record, record.start));
      const end = t(eventBoundInstant(record, record.end));
      return start < to && (end > from || start >= from);
    }
  }
}

export async function aggregate(
  window: Window,
  selection: Selection[],
  sources: Sources,
  debug: DebugSink = noDebug,
): Promise<Bundle> {
  // Pre-flight status() before any read (ADR-0003 §6): abort early with an
  // actionable error rather than pulling a partial set.
  await Promise.all(
    selection.map(async ({ sourceKey }) => {
      const source = sources[sourceKey];
      if (!source) throw new AggregateError(`Unknown source "${sourceKey}".`);
      const st = await source.status();
      switch (st.state) {
        case "ready":
          return;
        case "not-authenticated":
        case "not-configured": {
          // One narration owns the wording + fix-it CTA; the pre-flight
          // just frames it as an abort.
          const n = narrateStatus(st);
          throw new AggregateError(
            `Source "${sourceKey}" is ${n.label}${n.note ? ` — ${n.note}` : ""}. Run \`${n.remedy}\`.`,
          );
        }
        default:
          return assertNever(st);
      }
    }),
  );

  // Read concurrently; any rejection aborts the whole run (fail-hard, no partial bundle).
  // Each source closes over its injected config (#27), so `read` takes only the window.
  const perSource = await Promise.all(
    selection.map(async ({ sourceKey }) => {
      const source = sources[sourceKey]!;
      // Per-source wall time + count: which source is slow, and which returned
      // nothing (ADR-0015 §6). Both are trusted structural scalars.
      const started = Date.now();
      const items = await source.read(window);
      debug({ kind: "source-run", source: sourceKey, ms: Date.now() - started, itemCount: items.length });
      return { sourceKey, items };
    }),
  );

  const sourceCounts = perSource.map((p) => ({ source: p.sourceKey, itemCount: p.items.length }));

  // Keep a stable insertion index for the tiebreak. Records carry no trusted id the
  // Aggregator may read (ids stay Untrusted, and the Aggregator never unwraps), so a
  // structural index keeps the order deterministic without touching untrusted bytes.
  const indexed = perSource
    .flatMap((p) => p.items)
    .filter((record) => inWindow(record, window))
    .map((record, i) => ({ record, i }));

  indexed.sort((a, b) => {
    const ta = Date.parse(instantOf(a.record));
    const tb = Date.parse(instantOf(b.record));
    if (ta !== tb) return ta - tb;
    if (a.record.source !== b.record.source) {
      return a.record.source < b.record.source ? -1 : 1;
    }
    return a.i - b.i;
  });

  return { window, sources: sourceCounts, records: indexed.map((x) => x.record) };
}
