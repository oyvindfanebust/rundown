// The Brief-quality eval runner (ADR-0012): drives each fixture bundle through the
// real plan() — real renderBundle, real prompt assembly, real live summarize(), real
// verifyEvidence/defangOutput — and applies the fixture's assertions to the emitted
// Brief. The unit under test is production end-to-end; the only fake thing is the
// source data.
//
// Not part of the deterministic gate: without RUNDOWN_EVALS=1 every test here is
// skipped, so plain `bun test` (and CI) makes zero API calls. Run via
// `scripts/evals.sh` — manually, before merging any DEFAULT_MODEL bump or prompt
// change. Set RUNDOWN_MODEL to eval a candidate model before changing the default.
//
// Flake policy (ADR-0012 §3): each fixture runs RUNS_PER_FIXTURE times and every run
// must pass. Assertions are anchored on evidence quotes / kinds / counts (near-
// deterministic), so a red here is a real regression, not phrasing luck — and a
// fixture that needs fuzzy text matching to pass should be restructured, not retried
// harder.

import { test, describe } from "bun:test";
import { plan } from "../src/plan.ts";
import { FIXTURES } from "./fixtures.ts";

const ENABLED = process.env.RUNDOWN_EVALS === "1";
const RUNS_PER_FIXTURE = 2;
// Live Sonnet with adaptive thinking over a small bundle: comfortably under a minute
// per call; the two runs go in parallel. Generous so a slow run isn't a false red.
const TIMEOUT_MS = 240_000;

describe("brief quality evals (live model)", () => {
  for (const fixture of FIXTURES) {
    test.skipIf(!ENABLED)(
      fixture.name,
      async () => {
        const briefs = await Promise.all(
          Array.from({ length: RUNS_PER_FIXTURE }, () => plan(fixture.bundle, fixture.windowIsPast)),
        );
        const failures: string[] = [];
        briefs.forEach((brief, i) => {
          try {
            fixture.assert(brief);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failures.push(
              `run ${i + 1}/${RUNS_PER_FIXTURE}: ${message}\nBrief: ${JSON.stringify(brief, null, 2)}`,
            );
          }
        });
        if (failures.length > 0) {
          throw new Error(
            `[${fixture.name}] failure mode: ${fixture.failureMode}\n${failures.join("\n\n")}`,
          );
        }
      },
      TIMEOUT_MS,
    );
  }
});
