// Validate a digest JSON document on stdin against the digest contract (ADR-0021).
// Used by scripts/e2e.sh as the acceptance assertion. Exits non-zero on any schema
// violation. The schema is imported from the contract, never re-spelled here.

import { DigestSchema } from "../src/digest-contract.ts";

const text = await new Response(Bun.stdin.stream()).text();

let raw: unknown;
try {
  raw = JSON.parse(text);
} catch (e) {
  console.error(`INVALID: stdout is not valid JSON: ${e}`);
  process.exit(1);
}

const parsed = DigestSchema.safeParse(raw);
if (!parsed.success) {
  console.error(`INVALID: ${parsed.error.message}`);
  process.exit(1);
}

const { counts, unsummarized } = parsed.data;
const records = counts.meetings.records + counts.mail.records + counts.chat.records;
const entries = counts.meetings.entries + counts.mail.entries + counts.chat.entries;
console.log(
  `OK: schema-valid digest: ${records} record(s) in ${entries} entr${entries === 1 ? "y" : "ies"}` +
    `${unsummarized ? `, ${unsummarized} unsummarized` : ""}.`,
);
if (records === 0) {
  console.log("NOTE: zero records. An empty window is valid (exit 0); confirm this is expected.");
}
