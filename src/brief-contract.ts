// The Brief output contract — the single source of truth for what the Summarizer
// emits ({summary, items}). A Zod schema generates BOTH the runtime JSON Schema the
// structured-output API needs AND the TypeScript types every component speaks, and
// the per-kind descriptions the Planner weaves into its task prose. This kills the
// prior three-way drift (hand-written TS type + hand-written JSON Schema + prose
// enum), where the `kind` vocabulary was spelled three times (ADR-0011).
//
// It imports ONLY zod: it is the contract's definition, upstream of domain.ts.
// summarize.ts stays generic — it receives this plain JSON Schema, never Zod.

import { z } from "zod";

/** The nature-of-attention axis — a fixed enum, model-classified (ADR-0005 §3). */
export const KINDS = ["commitment", "task", "waiting", "fyi"] as const;

/** The nature-of-attention axis — a fixed enum, model-classified (ADR-0005 §3). */
export type ExtractedKind = (typeof KINDS)[number];

/**
 * The one-line meaning of each `kind`, keyed by kind. The Planner maps over these
 * to build the classification bullet list in its task prose, so the prose and the
 * schema enum can never drift. `Record<ExtractedKind, …>` makes exhaustiveness a
 * typecheck: adding a KIND without a description fails to compile.
 */
export const KIND_DESCRIPTIONS: Record<ExtractedKind, string> = {
  commitment: "you are (or were) expected somewhere at a time (a meeting, an event).",
  task: "an action you owe (a reply, a decision, prep); collapse related ones.",
  waiting: "you are blocked on someone else's action (the GTD \"waiting-for\").",
  fyi: "worth knowing, no action from you.",
};

// `strictObject` is what makes every generated object node carry
// `additionalProperties: false` — required by the structured-output API. Verified
// empirically against z.toJSONSchema (see tests/brief-contract.test.ts).

// ── Length caps on Brief output strings ──
//
// Caps here are the Zod source of truth (ADR-0011): they flow into BOTH the
// generated JSON Schema handed to the structured-output API (as `maxLength`, a
// soft steer) AND the runtime `.parse()` in plan.ts (the hard guarantee — the API's
// constraint is best-effort, same reasoning as the shape check it rides along with).
// Settled numbers: top-level summary 4,000; item summary 500; when 100; quote 300.

/** An attributed verbatim snippet. `quote` is the Layer-2 injection quarantine. */
export const Evidence = z.strictObject({
  source: z.string(),
  quote: z.string().max(300),
});

/** One salient work-item, curated by the Summarizer for planning (ADR-0005 §4). */
export const ExtractedItem = z.strictObject({
  kind: z.enum(KINDS),
  summary: z.string().max(500),
  /** Optional, human-phrased timing ("Thu 9am", "due Fri") — approximate, not authoritative. */
  when: z.string().max(100).optional(),
  evidence: z.array(Evidence),
});

/** The `{summary, items}` pair the Summarizer emits — its structured-output schema. */
export const SummarizerOutputSchema = z.strictObject({
  summary: z.string().max(4_000),
  items: z.array(ExtractedItem),
});

// ── Inferred TypeScript types (the second half of "single source of truth") ──

export type Evidence = z.infer<typeof Evidence>;
export type ExtractedItem = z.infer<typeof ExtractedItem>;
export type SummarizerOutput = z.infer<typeof SummarizerOutputSchema>;

/**
 * The generated JSON Schema handed to the Summarizer's structured-output API. Built
 * from SummarizerOutputSchema via Zod v4's z.toJSONSchema. `reused: "inline"` keeps
 * the schema flat (no `$defs`/`$ref`) since Evidence/ExtractedItem are each used
 * once; the generator's top-level `$schema` key is stripped so the emitted object
 * matches exactly what the API accepted from the old hand-written schema.
 */
export const BRIEF_OUTPUT_SCHEMA: Record<string, unknown> = (() => {
  const generated = z.toJSONSchema(SummarizerOutputSchema, { reused: "inline" }) as Record<
    string,
    unknown
  >;
  const { $schema, ...rest } = generated;
  return rest;
})();
