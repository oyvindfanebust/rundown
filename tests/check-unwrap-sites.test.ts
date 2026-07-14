// CI gate for ADR-0004 §3's sole-unwrap-site rule: `scripts/check-unwrap-sites.sh`
// must fail when `unwrap` is imported or called anywhere under `src/` except its
// definition (`src/trust.ts`) and its sole legitimate caller (`src/plan.ts`), and
// must pass on the real tree. Comment prose that merely mentions "unwrap()" (e.g.
// the "NOT a new unwrap() site" notes in summarize.ts) must not trip it.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "check-unwrap-sites.sh");
const REPO_ROOT = join(import.meta.dir, "..");

function runCheck(srcDir: string) {
  const proc = Bun.spawnSync(["bash", SCRIPT, srcDir], { cwd: REPO_ROOT });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Build a throwaway src tree; returns its path. Caller cleans up. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "unwrap-gate-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const LEGIT = {
  "trust.ts": `export function unwrap<T>(value: T): T { return value; }\n`,
  "plan.ts": `import { unwrap } from "./trust.ts";\nexport const x = unwrap("ok");\n`,
};

test("passes when unwrap appears only in trust.ts and plan.ts", () => {
  const dir = fixture(LEGIT);
  try {
    expect(runCheck(dir).code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails with file:line when a disallowed file calls unwrap()", () => {
  const dir = fixture({
    ...LEGIT,
    "aggregate.ts": `import { unwrap } from "./trust.ts";\nconst leak = unwrap("boom");\n`,
  });
  try {
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("aggregate.ts");
    expect(r.stdout + r.stderr).toMatch(/aggregate\.ts:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails on a bare unwrap import even without a call", () => {
  const dir = fixture({
    ...LEGIT,
    "debug.ts": `import { unwrap } from "./trust.ts";\nexport const nothing = 1;\n`,
  });
  try {
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("debug.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails on an explicit-generic call unwrap<T>(...)", () => {
  const dir = fixture({
    ...LEGIT,
    "sneaky.ts": `import * as trust from "./trust.ts";\nconst v = trust.unwrap<string>("boom" as never);\n`,
  });
  try {
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("sneaky.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails in nested directories, not just top-level src files", () => {
  const dir = fixture({
    ...LEGIT,
    "sources/evil/index.ts": `import { unwrap } from "../../trust.ts";\nexport const v = unwrap("boom");\n`,
  });
  try {
    const r = runCheck(dir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("sources/evil/index.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("comment lines mentioning unwrap() do not trip the check", () => {
  const dir = fixture({
    ...LEGIT,
    "summarize.ts": [
      `// \`sealed\` is a pure transform — NOT a new unwrap() site (ADR-0004 §3).`,
      `/* block comment: never call unwrap( here */`,
      ` * doc-comment line: unwrap() is forbidden outside plan.ts`,
      `export const ok = 1;`,
      ``,
    ].join("\n"),
  });
  try {
    expect(runCheck(dir).code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real src/ tree passes (sole-unwrap-site invariant holds today)", () => {
  const r = runCheck(join(REPO_ROOT, "src"));
  expect(r.code).toBe(0);
});
