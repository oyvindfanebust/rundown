// Validate a Brief JSON document on stdin against the ADR-0005 contract.
// Used by scripts/e2e.sh as the acceptance assertion. Exits non-zero on any
// schema violation.
//
// The `kind` vocabulary is imported from the Brief contract (ADR-0011), never
// re-spelled here — a hand copy silently rejects valid Briefs the day a kind is added.

import { KINDS } from "../src/brief-contract.ts";

const text = await new Response(Bun.stdin.stream()).text();

let brief: any;
try {
  brief = JSON.parse(text);
} catch (e) {
  console.error(`INVALID: stdout is not valid JSON: ${e}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`INVALID: ${msg}`);
    process.exit(1);
  }
}

assert(brief.envelope?.window?.from && brief.envelope?.window?.to, "envelope.window missing");
assert(Array.isArray(brief.envelope?.sources), "envelope.sources missing");
assert(typeof brief.summary === "string", "summary must be a string");
assert(Array.isArray(brief.items), "items must be an array");

for (const it of brief.items) {
  assert(KINDS.includes(it.kind), `item.kind must be one of ${KINDS.join("/")}`);
  assert(typeof it.summary === "string", "item.summary must be a string");
  assert(Array.isArray(it.evidence), "item.evidence must be an array");
}

const pulled = brief.envelope.sources.reduce((n: number, s: any) => n + (s.itemCount ?? 0), 0);
console.log(
  `OK: schema-valid Brief — ${brief.envelope.sources.length} source(s), ${pulled} item(s) pulled, ${brief.items.length} extracted.`,
);
if (pulled === 0) {
  console.log("NOTE: zero items pulled — a genuinely empty window is valid (exit 0), but confirm this is expected.");
}
