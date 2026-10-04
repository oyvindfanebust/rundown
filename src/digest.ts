// The composition root for `rundown digest` (ADR-0008 §2): resolve config → aggregate →
// digest. Wiring only: no domain logic, no argument parsing, no process I/O (that lives in
// cli.ts), so it is testable in isolation.

import { resolveConfig } from "./config.ts";
import type { WindowSelector } from "./temporal.ts";
import { aggregate } from "./aggregate.ts";
import { digest } from "./digester.ts";
import type { Digest } from "./digest-contract.ts";
import { descriptors, buildRegistry } from "./sources/registry.ts";
import { noDebug, type DebugSink } from "./debug.ts";

export interface BuildDigestOptions {
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

export async function buildDigest(opts: BuildDigestOptions = {}): Promise<Digest> {
  const progress = opts.onProgress ?? (() => {});
  const debug = opts.onDebug ?? noDebug;
  // The run's single clock: read once here. It resolves the window and becomes the digest's
  // `generatedAt`, so the two can never disagree. Downstream stages have no `new Date()`.
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
  const bundle = await aggregate(config.window, config.selection, sources, debug);

  if (bundle.records.length === 0) {
    progress("No records in the window; emitting an empty digest.");
  } else {
    progress(`Read ${bundle.records.length} record(s); grouping them into digest entries…`);
  }
  return digest(
    bundle,
    { window: config.window, timezone: config.timezone, generatedAt: now.toISOString() },
    { onProgress: progress },
  );
}
