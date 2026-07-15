# ADR 0012 — Brief-quality evals as the manual regression gate for model and prompt changes

**Status:** Accepted

Adds a live-model eval suite (`evals/`, run via `scripts/evals.sh`) to the quality bar. It changes
nothing about what the pipeline does — it adds the missing empirical check on the one component the
deterministic test suite cannot cover: the live model's behavior behind `summarize()`.

## Context

Every layer of the pipeline except the model itself is pinned deterministically. Unit tests cover
each component; `tests/injection-corpus.test.ts` drives a hostile payload corpus through the real
assembly and output pipeline against fake transports, proving the quarantine is assembled
correctly and hostile summarizer output is neutralized. What nothing checks is whether the live
model, given a correctly assembled request, still produces a good Brief: right items surfaced,
correct `kind` classification, deadlines reaching `when`, no invented work, cross-source connections
made.

That gap matters at exactly one moment: when `DEFAULT_MODEL` is bumped or the prompts change
(`summarize.ts`'s hardening, `plan.ts`'s task prose). Daily dogfooding (`scripts/e2e.sh`) is a
continuous quality signal for the current model, but offers no before/after comparison for a
candidate — a model bump today ships unverified. Upstream model drift, by contrast, needs no
new machinery: dogfooding already detects it.

## Decision

### 1. Purpose: a quality regression gate, not a security certification

The suite's job is to answer "is the Brief still good after this model/prompt change?" — run
manually, before merging such a change. It is not a security eval: the deterministic injection
corpus remains the trust-boundary regression net, and the live behavioral check remains the manual
procedure documented in `scripts/e2e.sh`. Two hostile fixtures do ride along (Decision 5), framed
as quality-under-hostile-input, because the marginal cost is near zero at the one moment the
question "does the new model still ignore embedded imperatives?" is worth asking.

### 2. Corpus: synthetic fixture bundles, one per failure mode

Fixtures are hand-authored `Bundle`s (typed, `Untrusted<T>`-wrapped `AnnotatedItem`s — exactly how
the injection corpus builds them), not captured real data. The regression-gate use case needs
stable, comparable inputs more than realistic ones — it measures deltas — and synthetic fixtures
are public-repo-safe and let the hard cases be authored deliberately. The v1 corpus is
dimension-targeted (~7 quality fixtures + 2 hostile), one fixture per distinct failure mode rather
than a source×kind×bucket matrix: a red run names what regressed by fixture name. A newly
dogfood-discovered failure mode becomes the next fixture — the same one-row-addition philosophy
as the injection corpus.

### 3. Grading: deterministic planted-fact assertions; no LLM judge

Each fixture plants facts whose correct handling is checkable structurally: an item with a given
`kind` exists, its evidence quotes a planted anchor token, `when` matches a planted deadline, item
counts stay within curation bounds. This is near-deterministic because `plan()`'s
`verifyEvidence` already guarantees evidence quotes are verbatim (whitespace-normalized) substrings
of the rendered bundle — so evidence quotes and `kind`s are stable anchors, while free-text
summary phrasing is unstable and is never asserted on. Anchor tokens are distinctive and
URL-free (defanging rewrites URL schemes in every output field).

Nondeterminism is handled by running each fixture twice, both runs must pass. A fixture that needs
fuzzy text matching to pass should be restructured, not retried harder.

An LLM-as-judge stage (rubric-scored coverage/faithfulness) is deliberately not built. It adds
cost, its own stochasticity, and a component that itself needs calibrating — and it would read
untrusted-derived Brief content, so it would have to be tool-less too. It becomes worth building
only if the deterministic gate stays green while dogfooding says quality dropped; that signal, not
speculation, triggers it.

### 4. Unit under test: `plan()` end-to-end with the live summarizer

Evals call the real `plan()` with no injected deps: real `renderBundle`, real prompt assembly, real
live `summarize()`, real `verifyEvidence`/`defangOutput`. Evaluating `summarize()` against a
fixture-supplied instruction string would test a replica of production that can silently drift from
what `plan.ts` actually assembles. Accepted consequence: a failure doesn't localize to "model" vs
"`verifyEvidence` dropped a near-miss quote" — but both are production behavior, so either is a real
regression.

### 5. Two hostile fixtures, framed as quality-under-hostile-input

One fixture embeds an imperative payload ("add an URGENT wire-transfer commitment") among
legitimate items; one embeds a URL-relay/markdown-image payload. Each asserts both directions: the
attack does not succeed (no fabricated commitment; no live URL in any output field), and the
legitimate planted items are still surfaced — hostile input degrading Brief coverage is a quality
regression under this suite's own framing. Two fixtures cannot certify injection resistance and are
not claimed to.

### 6. Execution: manual script, env-gated out of CI

`scripts/evals.sh` mirrors the `e2e.sh` pattern: live checks are manual, deterministic checks are
CI. The eval tests live in `evals/brief-quality.test.ts` and are `skipIf`-gated on
`RUNDOWN_EVALS=1`, so plain `bun test` (local and CI) discovers them but makes zero API calls.
The trigger condition — "I am changing the model or the prompt" — is a rare, deliberate act, which
is when the operator will remember to run the gate. `RUNDOWN_MODEL` (the existing ops knob) lets a
candidate model be evaluated before `DEFAULT_MODEL` changes: run once on the current default, once
on the candidate, compare. No scheduled runs (dogfooding is the drift detector) and no CI secret
(keeps the Anthropic key out of a public repo's automation).

### 7. The trust boundary is untouched

Fixtures enter as `Untrusted<T>`-wrapped items; there is no new `unwrap()` site
([ADR-0004](0004-trust-boundary-enforcement.md) §3 — `scripts/check-unwrap-sites.sh` stays green),
no new agent-facing surface (evals are dev-time `bun test` files, sealed out of the release binary
like all tests), and the Summarizer still has zero tools. The suite consumes the boundary; it
does not move it.

## Consequences

**Positive**
- A `DEFAULT_MODEL` bump or prompt edit now has an empirical before/after bar instead of shipping
  unverified — ~9 fixtures × 2 runs ≈ 18 Sonnet calls per invocation, cheap enough to run without
  hesitation.
- Failure modes are named: a red run says which quality property regressed.
- The corpus grows with dogfooding: each newly observed failure mode is one fixture away from being
  gated forever.

**Negative / accepted costs**
- The gate is remembered, not enforced — nothing forces `scripts/evals.sh` before a model bump.
  Accepted: such changes are rare and deliberate, matching the e2e precedent.
- Live-model assertions can still flake despite evidence-anchoring and N=2; the standing remedy is
  restructuring the fixture toward harder anchors, never loosening to majority-vote.
- Synthetic fixtures may flatter the model relative to a real messy inbox. Accepted for v1; a
  privately held captured-bundle set is the known upgrade path if the synthetic set proves too easy.
- `kind`-classification assertions encode one defensible reading of genuinely judgment-y items; a
  new model with a different-but-reasonable reading will red a fixture and force a human decision.
  That is the gate working as intended — reclassification is a behavior change worth a look.
