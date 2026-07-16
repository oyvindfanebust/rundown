// The composition root for `rundown brief` (ADR-0008 §2): resolve config →
// aggregate → plan → Brief. Wiring only — no domain logic, no argument parsing,
// no process I/O (that lives in cli.ts), so it is testable in isolation.

import { resolveConfig } from "./config.ts";
import type { WindowSelector } from "./temporal.ts";
import { aggregate } from "./aggregate.ts";
import { plan } from "./plan.ts";
import { registry } from "./sources/registry.ts";
import type { Brief } from "./domain.ts";

export interface BuildBriefOptions {
  windowOverride?: WindowSelector;
  /** Per-run `--source` narrowing: run only these configured sources (empty/undefined = all). */
  sourceFilter?: string[];
  now?: Date;
  /** Optional progress sink (trusted status only) — cli.ts routes this to stderr for TTYs. */
  onProgress?: (message: string) => void;
}

export async function buildBrief(opts: BuildBriefOptions = {}): Promise<Brief> {
  const progress = opts.onProgress ?? (() => {});
  // The one clock for the whole run: read `now` once here and thread it, so every
  // stage shares a single instant. Downstream stages have no `= new Date()`.
  const now = opts.now ?? new Date();
  const config = await resolveConfig(registry, {
    windowOverride: opts.windowOverride,
    sourceFilter: opts.sourceFilter,
    now,
  });

  const keys = config.selection.map((s) => s.sourceKey).join(", ");
  progress(`Pulling ${config.selection.length} source(s) (${keys}) for ${config.windowSpan}…`);
  const bundle = await aggregate(config.window, config.selection, registry, now);

  const total = bundle.sources.reduce((n, s) => n + s.itemCount, 0);
  if (total === 0) {
    progress("No items in window — emitting an empty rundown.");
  } else {
    progress(`Aggregated ${total} item(s); summarizing with Claude (this can take a bit)…`);
  }
  return plan(bundle, config.windowIsPast, config.guidance);
}
