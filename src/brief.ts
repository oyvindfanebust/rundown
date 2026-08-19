// The composition root for `rundown brief` (ADR-0008 §2): resolve config →
// aggregate → plan → Brief. Wiring only — no domain logic, no argument parsing,
// no process I/O (that lives in cli.ts), so it is testable in isolation.

import { resolveConfig } from "./config.ts";
import type { WindowSelector } from "./temporal.ts";
import { aggregate } from "./aggregate.ts";
import { suppress } from "./suppress.ts";
import { plan } from "./plan.ts";
import { descriptors, buildRegistry } from "./sources/registry.ts";
import type { Brief } from "./domain.ts";
import { noDebug, type DebugSink } from "./debug.ts";

export interface BuildBriefOptions {
  windowOverride?: WindowSelector;
  /** Per-run `--source` narrowing: run only these configured sources (empty/undefined = all). */
  sourceFilter?: string[];
  now?: Date;
  /** Optional progress sink (trusted status only) — cli.ts routes this to stderr for TTYs. */
  onProgress?: (message: string) => void;
  /**
   * Structural debug sink (ADR-0015). Distinct from `onProgress`: that one carries
   * human-facing strings and is TTY-gated, this one carries typed trusted-scalar
   * events and is emitted whenever debug is on, piped or not.
   */
  onDebug?: DebugSink;
}

export async function buildBrief(opts: BuildBriefOptions = {}): Promise<Brief> {
  const progress = opts.onProgress ?? (() => {});
  const debug = opts.onDebug ?? noDebug;
  // The one clock for the whole run: read `now` once here and thread it, so every
  // stage shares a single instant. Downstream stages have no `= new Date()`.
  const now = opts.now ?? new Date();
  const config = await resolveConfig(descriptors, {
    windowOverride: opts.windowOverride,
    sourceFilter: opts.sourceFilter,
    now,
  });

  // Build only the selected sources, with their resolved config injected (#27).
  const sources = buildRegistry(config.selection, debug);

  const keys = config.selection.map((s) => s.sourceKey).join(", ");
  progress(`Pulling ${config.selection.length} source(s) (${keys}) for ${config.windowSpan}…`);
  const aggregated = await aggregate(config.window, config.selection, sources, now, debug);

  // Deterministic pre-model noise filter (#107, ADR-0017): configured rules drop
  // items here, before the bundle is rendered, so they cost no model attention and
  // no tokens. The per-rule audit rides into the Brief envelope via the Planner.
  const { bundle, suppressed } = suppress(aggregated, config.suppress);
  // One debug tally per configured rule, zero-count included — "why isn't my rule
  // firing" is exactly what --debug is for. The audit entries hold the config's own
  // rule objects, so reference identity recovers each rule's count.
  config.suppress.forEach((rule, i) => {
    debug({ kind: "suppress", rule: i + 1, count: suppressed.find((e) => e.rule === rule)?.count ?? 0 });
  });
  const suppressedTotal = suppressed.reduce((n, e) => n + e.count, 0);
  if (suppressedTotal > 0) {
    progress(`Suppressed ${suppressedTotal} item(s) via ${suppressed.length} config rule(s).`);
  }

  const total = bundle.sources.reduce((n, s) => n + s.itemCount, 0);
  if (total === 0) {
    progress("No items in window — emitting an empty rundown.");
  } else {
    progress(`Aggregated ${total} item(s); summarizing with Claude (this can take a bit)…`);
  }
  return plan(bundle, {
    windowIsPast: config.windowIsPast,
    timezone: config.timezone,
    guidance: config.guidance,
    suppressed,
  });
}
