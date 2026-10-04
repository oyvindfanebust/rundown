// The live digest eval runner (ADR-0012; ADR-0023 to follow): drives each fixture bundle
// through the real `digest()` with the real, live Summarizer (real rendering, prompt
// assembly, output parse, id join and defang) and grades the emitted digest. Production is
// the unit under test; only the source data is synthetic.
//
// Not part of the deterministic gate: without RUNDOWN_EVALS=1 every test here is skipped,
// so plain `bun test` (and CI) makes no API calls. Run via `scripts/evals.sh`, manually,
// before merging a DEFAULT_MODEL bump or a prompt change. Set RUNDOWN_MODEL to eval a
// candidate model before changing the default.
//
// Flake policy: each fixture runs RUNS_PER_FIXTURE times and every run must pass. Grading
// is deterministic (word runs, terms, patterns, counts) with no LLM judge, so a red here is
// a regression, not phrasing luck.

import { test, describe } from "bun:test";
import { digest } from "../src/digester.ts";
import { CTX, FIXTURES } from "./fixtures.ts";

const ENABLED = process.env.RUNDOWN_EVALS === "1";
const RUNS_PER_FIXTURE = 2;
// One live call per run over a small bundle; the runs go in parallel. Generous, so a slow
// run is not a false red.
const TIMEOUT_MS = 240_000;

describe("digest evals (live model)", () => {
  for (const fixture of FIXTURES) {
    test.skipIf(!ENABLED)(
      fixture.name,
      async () => {
        const digests = await Promise.all(Array.from({ length: RUNS_PER_FIXTURE }, () => digest(fixture.bundle, CTX)));
        const failures: string[] = [];
        digests.forEach((d, i) => {
          try {
            fixture.assert(d);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failures.push(`run ${i + 1}/${RUNS_PER_FIXTURE}: ${message}\nDigest: ${JSON.stringify(d, null, 2)}`);
          }
        });
        if (failures.length > 0) {
          throw new Error(`[${fixture.name}] failure mode: ${fixture.failureMode}\n${failures.join("\n\n")}`);
        }
      },
      TIMEOUT_MS,
    );
  }
});
