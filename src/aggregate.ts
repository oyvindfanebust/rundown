// The Aggregator (ADR-0003): pull the selected sources concurrently against one
// shared window, merge into a flat list, derive each item's bucket, and sort
// deterministically. Pure mechanism — it never interprets item content, reads no
// config, and makes no selection policy. Fail-hard: any unauth/error aborts the
// whole run (no partial bundle).

import type { AnnotatedItem, Bucket, Bundle, NormalizedItem, Window } from "./domain.ts";
import type { Selection } from "./config.ts";
import { narrateStatus, type Sources } from "./sources/source.ts";

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

/** Derive an item's temporal bucket by comparing its trusted timestamp to the window (ADR-0003 §4). */
export function bucketOf(item: NormalizedItem, window: Window, now: Date): Bucket {
  const t = Date.parse(item.timestamp);
  // The normalizer validates every structural instant, so a NaN
  // here means a source bypassed it — a bug, not data. Fail hard (ADR-0007 §6)
  // rather than the old silent `recent` fallback, which mislabelled instead of
  // surfacing the error. `source` is trusted; the raw timestamp is not echoed.
  if (Number.isNaN(t)) {
    throw new AggregateError(`Item from source "${item.source}" has an unparseable timestamp.`);
  }
  if (t < Date.parse(window.from)) return "standing";
  if (t > now.getTime()) return "upcoming";
  return "recent";
}

export async function aggregate(
  window: Window,
  selection: Selection[],
  sources: Sources,
  now: Date,
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
          const n = narrateStatus(st, { interactive: Boolean(source.login) });
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
  const perSource = await Promise.all(
    selection.map(async ({ sourceKey, options }) => {
      const source = sources[sourceKey]!;
      const items = await source.read(window, options);
      return { sourceKey, items };
    }),
  );

  const sourceCounts = perSource.map((p) => ({ source: p.sourceKey, itemCount: p.items.length }));

  // Annotate with bucket, keeping a stable insertion index for the tiebreak.
  // NB: ADR-0003 §5 named `id` as the tiebreak, but ADR-0004 branded `id` as
  // Untrusted with the prompt assembly as the SOLE unwrap site — so tool-capable
  // code must not unwrap it here. A stable structural index preserves determinism
  // without touching untrusted bytes.
  const indexed = perSource.flatMap((p) => p.items).map((item, i) => ({
    annotated: { ...item, bucket: bucketOf(item, window, now) } as AnnotatedItem,
    i,
  }));

  indexed.sort((a, b) => {
    const ta = Date.parse(a.annotated.timestamp);
    const tb = Date.parse(b.annotated.timestamp);
    if (ta !== tb) return ta - tb;
    if (a.annotated.source !== b.annotated.source) {
      return a.annotated.source < b.annotated.source ? -1 : 1;
    }
    return a.i - b.i;
  });

  return { window, sources: sourceCounts, items: indexed.map((x) => x.annotated) };
}
