# ADR 0011 — A single Zod source of truth for the Brief output contract

**Status:** Accepted

An implementation refactor of the Brief output contract fixed by [ADR-0005](0005-planning-layer.md)
§2–4. It changes *where* the contract is defined, not *what* the contract is: the Brief shape, the
four `kind`s, the `evidence` structure, and the trust boundary are all unchanged. It records the
decision to collapse three hand-synced representations into one.

## Context

The Brief's output contract — the `{summary, items}` pair the Summarizer emits, its `ExtractedItem`
shape, and the fixed `kind` enum ([ADR-0005](0005-planning-layer.md) §2–4) — was, until now,
spelled **three times**, by hand, in two files:

1. **TypeScript types** in `src/domain.ts` (`ExtractedKind`, `Evidence`, `ExtractedItem`,
   `SummarizerOutput`) — what the code compiles against.
2. **A hand-written JSON Schema** literal (`BRIEF_OUTPUT_SCHEMA`) in `src/plan.ts` — what the
   structured-output API validates the model's output against ([ADR-0005](0005-planning-layer.md) §6:
   structured output via the API's response format, **never a tool**).
3. **Prose** in `plan.ts`'s `ITEM_RULES`, listing each `kind` with its one-line meaning — what the
   model reads to classify items.

The `kind` vocabulary (`commitment` / `task` / `waiting` / `fyi`) was therefore written out **three
times**, and the field set (`kind`, `summary`, `when?`, `evidence`) twice. Nothing enforced their
agreement: adding a `kind`, renaming a field, or flipping `when` from optional to required in one
place left the other two silently stale. This is a **correctness hazard** — a JSON Schema that
drifts from the TS type produces model output the code mistypes; prose that drifts from the enum
mis-instructs the model — and the drift is invisible until it bites at runtime.

## Decision

### 1. `src/brief-contract.ts` is the single source of truth, defined in Zod v4

One new module owns the contract and imports **only** `zod`. From one Zod schema it derives all
three representations, so they cannot diverge:

- **The JSON Schema is generated**, not hand-written: `BRIEF_OUTPUT_SCHEMA = z.toJSONSchema(
  SummarizerOutputSchema, { reused: "inline" })`, post-processed to strip the generator's top-level
  `$schema` key. `z.strictObject(…)` is what makes every object node carry
  `additionalProperties: false` (required by the structured-output API); `reused: "inline"` keeps the
  schema flat (no `$defs`/`$ref`, since `Evidence`/`ExtractedItem` are each used once). The generated
  object is byte-for-byte equivalent (modulo key order) to the old hand-written literal — pinned by
  `tests/brief-contract.test.ts`, which asserts the shape empirically rather than trusting the
  generator.
- **The TypeScript types are inferred**: `Evidence`, `ExtractedItem`, `SummarizerOutput` are
  `z.infer<…>` of the schemas. `kind` infers as the `ExtractedKind` union (not `string`), and `when`
  infers as optional.
- **The prose is composed from the contract**: `KIND_DESCRIPTIONS: Record<ExtractedKind, string>`
  holds the one-line meaning of each `kind`; the Planner maps over it to build `ITEM_RULES`'
  classification bullets. `Record<ExtractedKind, …>` makes exhaustiveness a **typecheck** — adding a
  `kind` without a description fails to compile.

`domain.ts` re-exports the contract's types (so existing `import … from "./domain.ts"` sites keep
working) and keeps `Brief` itself — `Brief` wraps the Summarizer's output in the trusted envelope, so
it composes the contract with the domain's `Window`/manifest and belongs with the domain vocabulary.
`domain.ts` does not import `zod`.

### 2. The Summarizer stays generic; the trust boundary is untouched

`src/summarize.ts` is **not** touched. It remains the generic, task-agnostic primitive
([ADR-0005](0005-planning-layer.md) §1): it receives a **plain JSON Schema** as `schema`, does
`JSON.parse` + its bounded retry loop, and knows nothing of Zod, the Planner, or bundles. The
contract module hands it the generated schema exactly as the Planner handed it the hand-written one.

The [trust boundary](../../CONTEXT.md#trust-boundary) is unchanged in every dimension: no new
`unwrap()` site (the sole one stays in `plan.ts`'s Bundle rendering, [ADR-0004](0004-trust-boundary-enforcement.md)
§3), no `Untrusted<T>` in the contract, structured output still via the API response format and
never a tool ([ADR-0005](0005-planning-layer.md) §6), and the Summarizer still has zero tools. This
is a source-organization change, not a security change.

### 3. Accepting a runtime dependency (`zod`)

`rundown` had no runtime dependencies beyond the SDKs. Adding `zod` is a deliberate, justified cost:

- The structured-output API **needs a runtime JSON Schema object** regardless — the schema is not a
  compile-time-only artifact. Zod lets that runtime object and the compile-time types share one
  definition instead of being maintained as two.
- The contract is **tiny and central**: a two-object schema on the pipeline's output contract, edited
  rarely but wrong-silently when it drifts. The drift is exactly the class of bug a single source of
  truth eliminates.
- The codebase is **type-heavy** and leans on the typecheck as a load-bearing gate (the
  `Untrusted<T>` sole-unwrap guarantee is a dev-time typecheck). Zod's infer-from-schema fits that
  grain: the types stay first-class while the schema becomes generated rather than transcribed.
- Zod v4 ships `z.toJSONSchema` in-box, so no second codegen tool or build step is introduced.

## Consequences

**Positive**
- The `kind` enum and the `{kind, summary, when?, evidence}` shape are spelled **once**. Type, JSON
  Schema, and classification prose are now derivations of a single definition and cannot drift.
- Exhaustiveness of `KIND_DESCRIPTIONS` is a compile error, so a new `kind` can't ship
  under-documented to the model.
- The generated schema is pinned by an empirical test, so a future Zod upgrade that changes
  `toJSONSchema` output (e.g. re-introducing `$ref`, adding `title`) fails a test rather than
  silently shipping a schema the API rejects.

**Negative / accepted costs**
- One runtime dependency (`zod` v4) is added — accepted per Decision 3.
- The generated schema's key *order* differs from the old hand-written literal (semantically
  irrelevant for JSON Schema, but a larger textual diff on first introduction).
- `z.toJSONSchema`'s exact output is a Zod-version behavior; mitigated by the pinning test above.

The Brief contract lives in `src/brief-contract.ts` as the Zod source of truth;
[ADR-0005](0005-planning-layer.md) owns the content decisions (the envelope / untrusted-derived-core
split, the four `kind`s, the `evidence` quarantine, `when` as free-text) — this ADR only moved the
schema's *home*. The Summarizer's generic plain-JSON-Schema contract ([ADR-0005](0005-planning-layer.md)
§1) and the [trust boundary](../../CONTEXT.md#trust-boundary) ([ADR-0004](0004-trust-boundary-enforcement.md))
are untouched — see Decision 2.
