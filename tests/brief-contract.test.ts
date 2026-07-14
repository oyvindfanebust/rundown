import { test, expect, describe } from "bun:test";
import {
  BRIEF_OUTPUT_SCHEMA,
  KINDS,
  KIND_DESCRIPTIONS,
  SummarizerOutputSchema,
} from "../src/brief-contract.ts";

// These assertions pin the GENERATED JSON Schema to exactly what the
// structured-output API accepted from the old hand-written schema. They are the
// empirical proof that Zod's z.toJSONSchema + z.strictObject produce the shape the
// API needs (additionalProperties:false everywhere, optional `when`, flat/no-$ref),
// so the single source of truth in brief-contract.ts can be trusted (ADR-0011).

const schema = BRIEF_OUTPUT_SCHEMA as Record<string, any>;

describe("BRIEF_OUTPUT_SCHEMA (generated)", () => {
  test("top-level object seals additional properties and requires summary+items", () => {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(["items", "summary"]);
  });

  test("item schema seals additional properties; requires kind/summary/evidence; `when` optional", () => {
    const item = schema.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(["evidence", "kind", "summary"]);
    expect(item.properties.when).toBeDefined();
    expect(item.required).not.toContain("when");
  });

  test("evidence item schema seals additional properties; requires source+quote", () => {
    const evidence = schema.properties.items.items.properties.evidence.items;
    expect(evidence.additionalProperties).toBe(false);
    expect([...evidence.required].sort()).toEqual(["quote", "source"]);
  });

  test("kind is a closed string enum matching KINDS", () => {
    const kind = schema.properties.items.items.properties.kind;
    expect(kind.type).toBe("string");
    expect(kind.enum).toEqual([...KINDS]);
  });

  test("no $defs / $ref / $schema anywhere (flat, inline, generator-noise-free)", () => {
    const forbidden = ["$defs", "$ref", "$schema"];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === "object") {
        for (const key of Object.keys(node)) {
          expect(forbidden).not.toContain(key);
          walk((node as Record<string, unknown>)[key]);
        }
      }
    };
    walk(schema);
  });
});

describe("SummarizerOutputSchema (length caps)", () => {
  // The one honest, minimal-valid shape every oversized-field test perturbs — proves
  // the caps, not the rest of the shape.
  const base = () => ({
    summary: "ok",
    items: [{ kind: "task" as const, summary: "ok", evidence: [{ source: "graph", quote: "ok" }] }],
  });

  test("top-level summary over 4,000 chars fails the parse", () => {
    const value = { ...base(), summary: "a".repeat(4_001) };
    expect(() => SummarizerOutputSchema.parse(value)).toThrow();
  });

  test("top-level summary at exactly 4,000 chars passes", () => {
    const value = { ...base(), summary: "a".repeat(4_000) };
    expect(() => SummarizerOutputSchema.parse(value)).not.toThrow();
  });

  test("item summary over 500 chars fails the parse", () => {
    const value = base();
    value.items[0]!.summary = "a".repeat(501);
    expect(() => SummarizerOutputSchema.parse(value)).toThrow();
  });

  test("item `when` over 100 chars fails the parse", () => {
    const value = { ...base(), items: [{ ...base().items[0]!, when: "a".repeat(101) }] };
    expect(() => SummarizerOutputSchema.parse(value)).toThrow();
  });

  test("evidence quote over 300 chars fails the parse", () => {
    const value = base();
    value.items[0]!.evidence[0]!.quote = "a".repeat(301);
    expect(() => SummarizerOutputSchema.parse(value)).toThrow();
  });
});

describe("KIND_DESCRIPTIONS", () => {
  test("has exactly the KINDS keys, all non-empty", () => {
    expect(Object.keys(KIND_DESCRIPTIONS).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      expect(KIND_DESCRIPTIONS[kind].length).toBeGreaterThan(0);
    }
  });
});
