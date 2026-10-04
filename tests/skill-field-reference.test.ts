// The `rundown` skill's field reference must match the digest contract (ADR-0021 §3, #151):
// every field `DIGEST_FIELDS` lists, in schema order, with the same trust class. A field
// added to or removed from the contract, or a changed class, fails here until
// `skills/rundown/SKILL.md` is updated to match.
//
// The reference is the markdown table under the `## Field reference` heading. Each row is
// `` | `path` | class | meaning | ``.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIGEST_FIELDS, type DigestField } from "../src/digest-contract.ts";

const SKILL_PATH = join(import.meta.dir, "..", "skills", "rundown", "SKILL.md");

interface ReferenceRow {
  path: string;
  trust: string;
  meaning: string;
}

/** The rows of the table under `## Field reference`, in document order. */
function referenceRows(markdown: string): ReferenceRow[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Field reference");
  if (start === -1) throw new Error('SKILL.md has no "## Field reference" heading.');
  const rows: ReferenceRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m) rows.push({ path: m[1]!, trust: m[2]!, meaning: m[3]! });
  }
  return rows;
}

/** Every difference between the reference rows and the contract's field list. */
function mismatches(rows: ReferenceRow[], fields: readonly DigestField[]): string[] {
  const out: string[] = [];
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const contractPaths = new Set(fields.map((f) => f.path));
  for (const f of fields) {
    const row = byPath.get(f.path);
    if (row === undefined) out.push(`missing: ${f.path} (${f.trust})`);
    else if (row.trust !== f.trust) out.push(`class: ${f.path} is ${f.trust}, the skill says ${row.trust}`);
  }
  for (const r of rows) if (!contractPaths.has(r.path)) out.push(`not in the contract: ${r.path}`);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.path)) out.push(`duplicate: ${r.path}`);
    seen.add(r.path);
  }
  // Order is checked once the paths and classes agree, so it is reported on its own.
  if (out.length === 0) {
    const order = rows.map((r) => r.path).join(",");
    if (order !== fields.map((f) => f.path).join(",")) out.push("order: rows are not in schema order");
  }
  return out;
}

const skill = readFileSync(SKILL_PATH, "utf8");

describe("the skill's field reference", () => {
  test("lists every digest field in schema order with its trust class", () => {
    expect(mismatches(referenceRows(skill), DIGEST_FIELDS)).toEqual([]);
  });

  test("gives every field a meaning", () => {
    const blank = referenceRows(skill).filter((r) => r.meaning === "");
    expect(blank.map((r) => r.path)).toEqual([]);
  });
});

describe("the check", () => {
  const rows = referenceRows(skill);

  test("fails when the contract gains a field", () => {
    const fields = [...DIGEST_FIELDS, { path: "mail[].newField", trust: "trusted" as const, description: "x" }];
    expect(mismatches(rows, fields)).toEqual(["missing: mail[].newField (trusted)"]);
  });

  test("fails when a field's class changes", () => {
    const fields = DIGEST_FIELDS.map((f) => (f.path === "mail[].subject" ? { ...f, trust: "trusted" as const } : f));
    expect(mismatches(rows, fields)).toEqual(["class: mail[].subject is trusted, the skill says label"]);
  });

  test("fails when the contract drops a field", () => {
    const fields = DIGEST_FIELDS.filter((f) => f.path !== "chat[].external");
    expect(mismatches(rows, fields)).toEqual(["not in the contract: chat[].external"]);
  });
});
