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

// ── The two evidence shapes: what the model emits vs what the CLI emits ──
//
// SPIKE (#54): the model is asked for a POINTER, not prose. `ref` is the
// rundown-generated item number rendered into the bundle (`- [7] [slack/message] …`),
// so plan.ts can resolve the quote back to the exact item that produced it and fill
// attribution by code. The model never names its source, so it cannot fabricate one.

/** What the Summarizer emits per evidence entry: an item pointer and a snippet. */
export const Evidence = z.strictObject({
  /**
   * The bracketed item number from the rendered bundle. Resolved and stripped in plan.ts.
   *
   * No `.min(1)`: the structured-output API rejects `minimum`/`maximum` on an integer
   * node ("For 'integer' type, properties maximum, minimum are not supported"), and
   * this schema is generated straight into that request. The bound is not lost — an
   * out-of-range ref simply misses the render index and the entry is dropped, which is
   * a stronger guard than a schema hint anyway.
   */
  ref: z.number().int(),
  quote: z.string().max(300),
});

/** Longest single attribution label — one `where`, or one name in `who`. */
export const LABEL_MAX = 120;

/** Most names a `who` list carries. It is a caption, not a roster (#86). */
export const WHO_MAX = 8;

/**
 * What the CLI emits per evidence entry. Every field except `quote` is code-filled from
 * the resolved item, so none of it can be fabricated by the model (#54): `source` is
 * the item's `source/kind`, and `where`/`who`/`relationship` are its `Attribution`.
 *
 * The invariant these fields serve: a consumer must be able to attribute every quote it
 * renders. `where` and `who` alone do not carry that — both sides of a Slack DM produce
 * the same caption — so `relationship` says why the item is the user's, and an entry the
 * user wrote reads `authored` (#94).
 *
 * Sources produce attribution at whatever size the backend has — a 60-person meeting
 * has 60 attendees. {@link LABEL_MAX} and {@link WHO_MAX} are exported so plan.ts can
 * clamp to exactly these numbers as it fills the fields (#86); the caps below then
 * have nothing left to reject, and stay the enforced backstop for code-filled fields,
 * which never pass through the model-output `.parse()`.
 */
export const BriefEvidence = z.strictObject({
  source: z.string(),
  /** Container label ("#flow-mgmt", "DM with Ada Lovelace", "Inbox"), when the source has an honest one. */
  where: z.string().max(LABEL_MAX).optional(),
  /** People involved, most salient first — so a clamp keeps the useful end. */
  who: z.array(z.string().max(LABEL_MAX)).max(WHO_MAX).optional(),
  /** Why the item is the user's ("authored", "mentions", "dms", "assigned", …), when the source knows. */
  relationship: z.string().max(LABEL_MAX).optional(),
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

/** An ExtractedItem after evidence resolution — what lands in the Brief. */
export const BriefItem = ExtractedItem.extend({ evidence: z.array(BriefEvidence) });

/** The `{summary, items}` pair the Summarizer emits — its structured-output schema. */
export const SummarizerOutputSchema = z.strictObject({
  summary: z.string().max(4_000),
  items: z.array(ExtractedItem),
});

/** The post-resolution `{summary, items}` pair — parsed in plan.ts so caps stay enforced. */
export const BriefOutputSchema = z.strictObject({
  summary: z.string().max(4_000),
  items: z.array(BriefItem),
});

// ── Inferred TypeScript types (the second half of "single source of truth") ──

export type Evidence = z.infer<typeof Evidence>;
export type BriefEvidence = z.infer<typeof BriefEvidence>;
export type ExtractedItem = z.infer<typeof ExtractedItem>;
export type BriefItem = z.infer<typeof BriefItem>;
export type SummarizerOutput = z.infer<typeof SummarizerOutputSchema>;
export type BriefOutput = z.infer<typeof BriefOutputSchema>;

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
  stripIntegerBounds(rest);
  return rest;
})();

/**
 * Delete `minimum`/`maximum` from every `"integer"` node, in place.
 *
 * Zod's `.int()` records the JS safe-integer range, so `z.number().int()` generates
 * `{type: "integer", minimum: -9007199254740991, maximum: 9007199254740991}` — and the
 * structured-output API rejects the request outright: "For 'integer' type, properties
 * maximum, minimum are not supported". Found by running the eval corpus live; no unit
 * test could have caught it, since the constraint lives in the API, not the generator.
 *
 * Dropping them costs nothing real. They were never a meaningful bound (they are the
 * language's own integer range, not a domain rule), the runtime `.parse()` still
 * enforces them locally, and `evidence.ref`'s actual validity is decided by whether it
 * hits plan.ts's render index.
 */
function stripIntegerBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) stripIntegerBounds(child);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "integer") {
    delete record.minimum;
    delete record.maximum;
  }
  for (const value of Object.values(record)) stripIntegerBounds(value);
}
