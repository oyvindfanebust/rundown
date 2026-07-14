import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// cli.ts is the bounded context's ONLY external surface (ADR-0008 §4): it parses
// args, dispatches the five commands, and owns emission (stdout/stderr/exit code).
// Its dispatch runs at module load off process.argv, so it is exercised the way it
// actually runs — in a fresh subprocess — rather than imported. This is the same
// spawn shape graph-auth.test.ts uses, but keyed off `process.execPath` (the bun
// running this suite) so it does not depend on `bun` being on $PATH.

const ROOT = join(import.meta.dir, "..");

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Every run pins RUNDOWN_CONFIG at a caller-chosen path, so a dispatch test never
// reads the developer's real ~/.config/rundown/config.json.
function run(args: string[], configPath: string, entrypoint = "src/cli.ts"): Run {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.RUNDOWN_CONFIG = configPath;
  // Neutralize inherited credentials so `graph`/`linear` report a deterministic
  // (unconfigured) state, offline — no live MSAL or Linear network calls.
  delete env.AZURE_TENANT_ID;
  delete env.AZURE_CLIENT_ID;
  delete env.LINEAR_API_KEY;
  const proc = Bun.spawnSync([process.execPath, entrypoint, ...args], { cwd: ROOT, env });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? 0 };
}

describe("cli", () => {
  let dir: string | undefined;

  // A fresh temp dir per test; `missing` points at a config that does not exist,
  // `written` at one holding the given JSON.
  function missing(): string {
    dir = mkdtempSync(join(tmpdir(), "rundown-cli-"));
    return join(dir, "config.json");
  }
  function written(json: string): string {
    const path = missing();
    writeFileSync(path, json);
    return path;
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  describe("--version", () => {
    test("prints the dev-fallback version when run from source and exits 0", () => {
      const r = run(["--version"], missing());
      expect(r.stdout).toBe("0.0.0-dev\n");
      expect(r.exitCode).toBe(0);
    });

    test("-v is the same", () => {
      const r = run(["-v"], missing());
      expect(r.stdout).toBe("0.0.0-dev\n");
      expect(r.exitCode).toBe(0);
    });

    test("release stamping: `bun build --define RUNDOWN_VERSION` overrides the dev fallback (ADR-0001 §7)", () => {
      // Mirrors the release workflow's mechanism without compiling a full binary:
      // bundle with the define, then run the bundle.
      const outDir = mkdtempSync(join(tmpdir(), "rundown-stamp-"));
      try {
        const build = Bun.spawnSync(
          [
            process.execPath,
            "build",
            "src/cli.ts",
            "--target=bun",
            "--define",
            'RUNDOWN_VERSION="9.9.9"',
            "--outfile",
            join(outDir, "cli.js"),
          ],
          { cwd: ROOT },
        );
        expect(build.exitCode).toBe(0);
        const r = run(["--version"], missing(), join(outDir, "cli.js"));
        expect(r.stdout).toBe("9.9.9\n");
        expect(r.exitCode).toBe(0);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  describe("usage fallback", () => {
    test("unknown command prints usage on stderr and exits non-zero", () => {
      const r = run(["wat"], missing());
      expect(r.stderr).toContain("Usage:");
      expect(r.exitCode).toBe(1);
    });

    test("no command prints usage on stderr and exits 0", () => {
      const r = run([], missing());
      expect(r.stderr).toContain("Usage:");
      expect(r.exitCode).toBe(0);
    });
  });

  describe("brief --window parse", () => {
    test("a bad --window fails cleanly on stderr before any source runs", () => {
      // parseWindow runs before the pipeline, so this needs no config.
      const r = run(["brief", "--window", "yesterday"], missing());
      expect(r.stderr).toContain("Invalid --window");
      expect(r.stdout).toBe("");
      expect(r.exitCode).toBe(1);
    });
  });

  describe("init", () => {
    test("writes the annotated template, then leaves an existing file untouched", () => {
      const path = missing();

      const first = run(["init"], path);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain(`Wrote ${path}`);

      const template = readFileSync(path, "utf-8");
      // Structural landmarks + one entry per registered source (renderSourceEntry).
      expect(template).toContain(`"timezone"`);
      expect(template).toContain(`"sources"`);
      expect(template).toContain(`"guidance"`);
      expect(template).toContain(`"graph"`);
      expect(template).toContain(`"claude-code-logs"`);
      expect(template).toContain(`"linear"`);

      const second = run(["init"], path);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already exists");
      // The existing file is left byte-for-byte untouched.
      expect(readFileSync(path, "utf-8")).toBe(template);
    });
  });

  // Each remaining command routes to its own distinct handler. The deep behaviors
  // (aggregation, auth walks) are covered elsewhere; here we only assert dispatch.
  describe("command routing", () => {
    test("brief reaches the pipeline and surfaces the missing-config error on stderr", () => {
      const r = run(["brief"], missing());
      expect(r.stderr).toContain("No config");
      expect(r.exitCode).toBe(1);
    });

    test("status reaches its own diagnostic renderer (invalid config on stdout)", () => {
      // ConfigError is caught inside cmdStatus and rendered as a diagnostic line,
      // distinct from the raw fail() path brief/login take.
      const r = run(["status"], missing());
      expect(r.stdout).toContain("✗ invalid");
      expect(r.stdout).toContain("No config");
      expect(r.exitCode).toBe(1);
    });

    test("login reaches cmdLogin: a no-interactive-source config walks to completion", () => {
      // claude-code-logs declares no `login`, so cmdLogin skips it and reports the
      // nothing-to-do message — output unique to the login handler, and offline.
      const r = run(["login"], written(`{"timezone":"UTC","sources":{"claude-code-logs":{}}}`));
      expect(r.stdout).toContain("All configured sources already authenticated.");
      expect(r.exitCode).toBe(0);
    });
  });

  // The optional `login <source>` positional targets one registry key
  // directly, independent of config.json — pre-authenticating a source is
  // legitimate before it's even added to the config's `sources` selection.
  describe("login <source> positional", () => {
    test("bare `login` behavior is unchanged (covered above); a positional dispatches to that source specifically", () => {
      // graph is interactive (declares `login`), and AZURE_TENANT_ID/AZURE_CLIENT_ID
      // are neutralized, so cmdLogin's targeted path reaches Graph's own
      // "authenticating…" line before Graph's login() rejects on its own missing
      // config — proof the dispatch targeted Graph, not a walk over all sources.
      const r = run(["login", "graph"], missing());
      expect(r.stdout).toContain("graph   authenticating");
      expect(r.stderr).toContain("AZURE_TENANT_ID");
      expect(r.exitCode).toBe(1);
    });

    test("naming a non-interactive source (no login()) errors precisely and exits non-zero", () => {
      // linear declares no `login` — it's credential-only (LINEAR_API_KEY, deleted
      // from the env above), so targeting it is a precise, structural error.
      const r = run(["login", "linear"], missing());
      expect(r.stderr).toContain("linear authenticates via LINEAR_API_KEY — nothing to log in");
      expect(r.exitCode).toBe(1);
    });

    test("naming a no-auth source (no login(), never not-configured) still errors, differently worded", () => {
      // claude-code-logs is local + always ready — "nothing to log in" for a
      // different structural reason than linear's declared env-credential.
      const r = run(["login", "claude-code-logs"], missing());
      expect(r.stderr).toContain("claude-code-logs requires no authentication — nothing to log in");
      expect(r.exitCode).toBe(1);
    });

    test("an unknown source key is a hard error listing the registered keys", () => {
      const r = run(["login", "bogus"], missing());
      expect(r.stderr).toContain('Unknown source "bogus"');
      expect(r.stderr).toContain("graph");
      expect(r.stderr).toContain("claude-code-logs");
      expect(r.stderr).toContain("linear");
      expect(r.exitCode).toBe(1);
    });
  });

  // The login walk must never print a bare success while a configured
  // env-credential source (no `login()`, but currently `not-configured`) is
  // unreadable — `status` stays the full diagnostic; `login` just refuses to lie.
  describe("login: honest exit summary for env-credential sources", () => {
    test("a configured, unreadable linear gets a named fix-it line instead of a bare Done", () => {
      const r = run(["login"], written(`{"timezone":"UTC","sources":{"claude-code-logs":{},"linear":{}}}`));
      expect(r.stdout).toContain("linear   needs LINEAR_API_KEY in your environment");
      expect(r.stdout).toContain("Next: export LINEAR_API_KEY, then re-run rundown login");
      expect(r.stdout).not.toContain("All configured sources already authenticated.");
      expect(r.stdout).not.toContain("Done. Next: rundown status");
      expect(r.exitCode).toBe(0);
    });
  });
});
