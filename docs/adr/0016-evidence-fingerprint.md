# ADR 0016 — Evidence fingerprint: stable item identity for cross-window dedup

**Status:** Retired ([#117](https://github.com/oyvindfanebust/rundown/issues/117))

Removed in [#150](https://github.com/oyvindfanebust/rundown/issues/150) with the Brief's evidence,
so evidence fingerprints are gone. Stable digests survive as digest entry ids, a one-way digest of
the source group id ([ADR-0020](0020-aggregation-and-digest-entries.md) §5). The rest of this ADR
is the record of the removed design.

This ADR gives Brief evidence entries a stable identity so a consumer can dedup mechanically
across overlapping Briefs (#108): a `fingerprint` field, a truncated digest of the cited source
item's backend id, computed by the normalizer and copied by code. It extends
[ADR-0005](0005-planning-layer.md) §4 (the code-filled evidence shape) and operates under
[ADR-0004](0004-trust-boundary-enforcement.md); it does not amend either.

## Context

Overlapping windows return overlapping items with no marker that an item appeared in a previous
Brief. The daily consumer runs `--window today` and `--window this-week` on the same morning, and
its gap-reconciliation flow runs per-day briefs plus a `last-week` backstop; the same source item
can surface in several of those Briefs, and the consumer dedups by hand against vault-side state.

Window precision cannot fix this. The Bundle is not a time-slice of activity: `standing` items
(open commitments untouched this window) and `upcoming` items appear in every brief until they
close or pass, by design, and `today`/`this-week` overlap on purpose. Identity is what lets
overlapping views coexist safely.

## Decision

### 1. Identity lives on evidence entries, not Brief items

A Brief item is a model-curated merge of source items and has no honest single identity. An
evidence entry resolves to exactly one source item (ADR-0005 §4's `ref` resolution), so identity
attaches there, next to the attribution fields that are already code-filled.

### 2. A digest of the backend id, not the id itself

`fingerprint` is the first 16 hex chars (64 bits) of `SHA-256(source + "\n" + kind + "\n" + raw
backend id)`. Emitting the raw id was rejected: backend ids are untrusted bytes (`Untrusted<string>`,
ADR-0004 §1), and emitting them verbatim would open a new hostile-bytes output channel needing
defang treatment and length caps — Graph message ids alone run past 150 chars. A one-way digest
carries no backend bytes, so the field is structurally trusted, compact, and constant-shape
(`/^[0-9a-f]{16}$/`).

The cost is deliberate: a fingerprint cannot be joined back to the backend object. Its whole
contract is equality — same source item, same fingerprint. If a consumer ever needs a real
backend pointer, that is a separate trust decision (the structural-`url` territory of ADR-0004
§5), not a loosening of this field.

### 3. Computed in the normalizer, copied in the Planner

The normalizer (`normalize.ts`, the sole trust.ts importer among sources) computes the
fingerprint from the raw id before branding it `Untrusted`. That placement makes `fingerprint` a
trusted structural scalar like `timestamp`, so `resolveEvidence` in plan.ts copies it with no new
`unwrap()` call — the sole-unwrap-site audit (ADR-0004 §3) is untouched. An absent backend id
produces no fingerprint; a shared digest of the empty string would alias unrelated items.

### 4. Keyed on identity, never on version

The digest input is `source + kind + id` and nothing else. Folding in `timestamp` was rejected:
dedup wants identity, not version — a rescheduled meeting or an updated issue must still match
its earlier appearance. A change-detection signal, if ever wanted, is a separate field.

### 5. Invisible to the model

`fingerprint` is not in the Summarizer's output schema and is never rendered into the bundle, so
the model can neither fabricate one nor be influenced by it. The prompt and rendered bundle are
byte-identical to before, so this change does not trigger the ADR-0012 eval gate.

## Consequences

- Consumers dedup by comparing `evidence[].fingerprint` across Briefs; an item with no verified
  evidence carries no identity and falls back to text-level judgment.
- Per-source stability follows the backend id's stability: Graph event instances, Slack
  `channel:ts` composites, Linear/Jira issue ids, and Claude Code session ids are stable; Graph
  mail ids change when a message moves folders. That gap is accepted here and tracked as a
  follow-up (switching Graph to `Prefer: IdType="ImmutableId"`, a one-time id migration that
  deserves its own decision, optionally with `conversationId` for thread-level grouping).
- The digest is not a secret and not collision-proof against an adversary; 64 bits is a
  dedup key for one user's work items, not an integrity mechanism. A backend that lies about ids
  can already fabricate the items themselves.
