# ADR 0017 — Suppression rules: a deterministic pre-model noise filter

**Status:** Accepted

This ADR adds config-level suppression rules (#107): user-authored rules that drop recurring
non-task noise from the Bundle before it is rendered for the Summarizer. It extends
[ADR-0007](0007-config-personalization-layer.md) (a new config key) and operates under
[ADR-0004](0004-trust-boundary-enforcement.md), whose leak-path audit it widens by two named
primitives; it does not amend either.

## Context

rundown surfaces every actionable-looking item, and some recurring sources are never tasks:
automated release-pipeline mail keeps appearing as waiting-on-you, and a deliberately-unanswered
recurring meeting keeps getting flagged. The daily consumer worked around both with standing
ignore-list memories, so signal quality lived in the consuming agent instead of rundown's config,
and a fresh agent reintroduced the noise.

The existing `guidance` key can ask the model to ignore such items, but compliance is model
discretion — the noise returns on a bad day or a model bump — and the items still cost bundle
tokens every run. A recurring calendar series also has no name a prose instruction can state
reliably.

## Decision

### 1. A `suppress` config key, filtered between Aggregator and Planner

`suppress` is an array of rules in `config.json`, validated fail-hard like every other key
(ADR-0007 §6). Filtering is a pure step (`src/suppress.ts`) applied in the composition root
between `aggregate` and `plan`, so the Aggregator stays config-blind (ADR-0003) and the removed
items never reach the rendered bundle: zero model discretion, negative token cost.

A rule carries `sender` and/or `title` (case-insensitive substring), and/or `series` (exact
seriesFingerprint), optionally scoped by `source`. Criteria within a rule AND; rules OR. A rule
with no matching criterion is a config error — a bare or source-only rule would suppress
everything in scope, which is never what a typo meant. Substring matching, not regex or glob, for
now: it covers the reported cases and is trivially explainable; regex can be added later behind
the same key.

### 2. Boolean comparison primitives in trust.ts, not a new unwrap site

`title` and `sender` matching runs against `Untrusted<T>` fields, and ADR-0004 §3 allows exactly
one `unwrap()` caller. The filter therefore matches through two primitives defined in
`src/trust.ts` next to `unwrap` itself — `untrustedIncludes` and `untrustedExtrasInclude` — which
compute the comparison inside trust.ts and let only a boolean escape. The needle is user-authored
config; the haystack never leaves the module.

The leak-path audit widens from "call sites of `unwrap()`" to "call sites of `unwrap()` plus these
primitives" — still a short greppable list, and `scripts/check-unwrap-sites.sh` is untouched. A
`withUntrusted(value, callback)` form was rejected: a callback receiving raw bytes is an unwrap in
disguise. The primitives leak one bit per call, but both the query (the pattern) and the readout
(which items vanish) are controlled by the user, not by the party who authored the bytes; a
hostile backend gains no channel.

### 3. A series is named by a trusted digest, closing the loop through the Brief

`calendarView` expands recurrences into occurrences with per-occurrence ids, so the per-item
`fingerprint` (ADR-0016) cannot name a series. The Graph source now fetches `seriesMasterId`, and
the normalizer digests it exactly like the item fingerprint — `SHA-256(source + "\n" +
"event-series" + "\n" + raw series id)`, first 16 hex chars — into `seriesFingerprint`, a trusted
structural scalar carrying no backend bytes. The fixed `event-series` kind component keeps the
digest out of every per-item fingerprint namespace.

`resolveEvidence` code-copies it into Brief evidence beside `fingerprint`, so the consumer copies
the value from a noisy Brief straight into a `series` rule; no raw-id surface exists anywhere.
Matching is then trusted-vs-trusted equality — the primitives of §2 are not involved. Like
`fingerprint`, the field is never rendered to the model.

The sender ADDRESS gets the same non-rendered treatment: mail items carry it as a branded
structural `sender` field (the display name in `extras.from` is unstable — "GitHub" vs
`notifications@github.com`), and a `sender` rule matches either. Keeping the address out of the
rendered bundle means this ADR changes no rendered byte and does not trigger the ADR-0012 eval
gate; exposing it to the model would be a separate, eval-gated decision.

### 4. The audit trail is counts and digests, never suppressed content

The Brief envelope gains `suppressed`: one `{rule, count, fingerprints}` entry per rule that
matched at least one item. The rule is the user's own config object echoed verbatim (trusted);
the fingerprints are ADR-0016 digests. The issue's sketch of a collapsed list of suppressed items
was rejected: emitting their titles would be a channel of raw untrusted bytes into the Brief that
bypasses the summarize → verify → defang pipeline entirely. `sources[].itemCount` is recomputed
after filtering, so it keeps meaning "items the Summarizer saw" and the audit accounts for the
difference. Per-rule tallies (zero counts included) also go to the debug sink (ADR-0015) as a
scalar `suppress` event.

## Consequences

- The consumer's standing ignore-list memories move into `suppress` rules; a fresh agent inherits
  them from config.
- `series` rules are keyed on Graph ids, so #111's immutable-id migration rotates every
  seriesFingerprint once. That migration MUST treat config `series` rules as part of its blast
  radius: silent rotation would silently un-suppress a series, the worst failure mode this
  feature can have. This obligation is recorded here and on #111.
- An over-broad substring rule hides real items. The mitigations are the envelope audit (count +
  fingerprints per rule), the `suppress` debug events, and JSONC comment-toggling of rules; a
  `--no-suppress` flag was considered and rejected to keep the agent-facing CLI surface fixed.
- `resolveEvidence` accretes a third code-copied field, after attribution and `fingerprint` —
  more weight for the evidence-resolution seam design (#103, #96).
