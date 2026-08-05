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
function run(args: string[], configPath: string, entrypoint = "src/cli.ts", extraEnv: Record<string, string> = {}): Run {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.RUNDOWN_CONFIG = configPath;
  // Neutralize inherited credentials so `graph`/`linear`/`jira` report a
  // deterministic (unconfigured) state, offline — no live MSAL, Linear, or Jira
  // network calls.
  delete env.AZURE_TENANT_ID;
  delete env.AZURE_CLIENT_ID;
  delete env.LINEAR_API_KEY;
  delete env.JIRA_EMAIL;
  delete env.JIRA_API_TOKEN;
  Object.assign(env, extraEnv);
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

  describe("brief --source", () => {
    test("a --source not in the config fails cleanly on stderr before summarizing", () => {
      const path = written(`{"timezone":"UTC","sources":{"graph":{}}}`);
      const r = run(["brief", "--source", "linear"], path);
      expect(r.stderr).toContain(`--source "linear" is not a configured source`);
      expect(r.stdout).toBe("");
      expect(r.exitCode).toBe(1);
    });
  });

  // Flags are parsed per command (issue #30): a brief-only flag on any other
  // command is a hard error, not silently ignored. Each command declares only
  // the flags it accepts, so this covers --window and --source on all three.
  describe("brief-only flags rejected on other commands", () => {
    const brief_only: Array<[string, string]> = [
      ["--source", "graph"],
      ["--window", "today"],
    ];
    for (const cmd of ["status", "login", "init"]) {
      for (const [flag, value] of brief_only) {
        test(`${cmd} ${flag} fails hard on stderr`, () => {
          const r = run([cmd, flag, value], missing());
          expect(r.stderr).toContain(`rundown ${cmd}: option ${flag} is not valid here`);
          expect(r.stdout).toBe("");
          expect(r.exitCode).toBe(1);
        });
      }
    }
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
      expect(template).toContain(`"jira"`);
      // Credential-only sources document their env secrets in the auth line (§7),
      // rather than the misleading "No auth required" a non-interactive source used
      // to print — the site option is documented via its own option description.
      expect(template).toContain("set LINEAR_API_KEY in your environment");
      expect(template).toContain("set JIRA_EMAIL, JIRA_API_TOKEN in your environment");
      // The autoUpdate off-switch ships commented, documenting the default and the
      // durable half of pinning a version (ADR-0001 §5).
      expect(template).toContain(`// "autoUpdate": true,`);
      expect(template).toContain("Default true");
      expect(template).toContain("RUNDOWN_VERSION");
      // The field ships commented out; that the template still loads is asserted
      // through the subprocess seam below, not by parsing in-process (tests/brief.test.ts
      // mock.module's the registry, and that mock leaks across files).

      const second = run(["init"], path);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already exists");
      // The existing file is left byte-for-byte untouched.
      expect(readFileSync(path, "utf-8")).toBe(template);
    });
  });

  // Config validation is exercised where the user meets it: a real config file in a
  // temp dir, read by a real `rundown status` subprocess (ADR-0007 §6, fail-hard).
  describe("config validation through the CLI", () => {
    test("a non-boolean autoUpdate is rejected, naming the field and the expected values", () => {
      const path = written(`{"autoUpdate": "no", "sources": {"graph": {}}}`);
      const r = run(["status"], path);
      expect(r.stdout).toContain("✗ invalid");
      expect(r.stdout).toContain(`"autoUpdate" must be true or false; got "no"`);
      expect(r.exitCode).toBe(1);
    });

    test("autoUpdate: false is accepted", () => {
      const path = written(`{"timezone":"UTC","autoUpdate": false, "sources": {"graph": {}}}`);
      const r = run(["status"], path);
      expect(r.stdout).toContain("✓ valid");
    });

    test("an unknown top-level key is a hard error naming the key, with a did-you-mean", () => {
      const path = written(`{"autoUpdates": false, "sources": {"graph": {}}}`);
      const r = run(["status"], path);
      expect(r.stdout).toContain("✗ invalid");
      expect(r.stdout).toContain(`Unknown config key "autoUpdates" — did you mean "autoUpdate"?`);
      expect(r.exitCode).toBe(1);
    });

    test("an unknown top-level key with no near miss still names the key and the known keys", () => {
      const path = written(`{"gibberish": 1, "sources": {"graph": {}}}`);
      const r = run(["status"], path);
      expect(r.stdout).toContain(`Unknown config key "gibberish"`);
      expect(r.stdout).toContain("Known keys: timezone, window, guidance, autoUpdate, sources.");
      expect(r.exitCode).toBe(1);
    });

    test("the template `rundown init` writes loads as valid", () => {
      const path = missing();
      expect(run(["init"], path).exitCode).toBe(0);
      const r = run(["status"], path);
      expect(r.stdout).toContain("✓ valid");
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

    test("naming jira (credential-only, half-configurable) names its env secrets in the error", () => {
      // jira declares no `login` — it's credential-only (JIRA_EMAIL/JIRA_API_TOKEN,
      // deleted from the env above). Built config-independently ({}), so `site` is
      // also unset; the error names the env secrets that authenticate it.
      const r = run(["login", "jira"], missing());
      expect(r.stderr).toContain("jira authenticates via JIRA_EMAIL");
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
      expect(r.stderr).toContain("jira");
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

  // ── debug channel (ADR-0015) ───────────────────────────────────────────────

  describe("--debug", () => {
    const CONFIG = JSON.stringify({ timezone: "UTC", window: "this-week", sources: { "claude-code-logs": {} } });

    test("is off by default — no debug lines on stderr", () => {
      const r = run(["status"], written(CONFIG));
      expect(r.stderr).not.toContain("[debug]");
      expect(r.stdout).not.toContain("[debug]");
    });

    test("--debug emits the config-path event on stderr, naming the env provenance", () => {
      const r = run(["status", "--debug"], written(CONFIG));
      expect(r.stderr).toContain("[debug] config  path=");
      // The harness sets RUNDOWN_CONFIG, so provenance must read `env`.
      expect(r.stderr).toContain("provenance=env");
    });

    test("RUNDOWN_DEBUG=1 turns it on without the flag", () => {
      const r = run(["status"], written(CONFIG), "src/cli.ts", { RUNDOWN_DEBUG: "1" });
      expect(r.stderr).toContain("[debug]");
    });

    test("RUNDOWN_DEBUG=0 leaves it off", () => {
      const r = run(["status"], written(CONFIG), "src/cli.ts", { RUNDOWN_DEBUG: "0" });
      expect(r.stderr).not.toContain("[debug]");
    });

    test("all four config-touching commands accept the flag", () => {
      // A command that does not declare --debug fails with "option --debug is not
      // valid here" (issue #30), so a clean run proves the flag is declared.
      // A missing config makes every command fail fast at config resolution —
      // which happens AFTER flag parsing, so this still proves the flag parsed.
      // (brief especially: a valid config would run the real pipeline.)
      for (const cmd of ["status", "init", "login", "brief"]) {
        const r = run([cmd, "--debug"], missing());
        expect(r.stderr).not.toContain("is not valid here");
      }
    });

    test("--version rejects the flag (it reads no config and does no I/O)", () => {
      const r = run(["--version", "--debug"], missing());
      // --version short-circuits before parsing, so it simply prints the version
      // rather than growing a debug surface.
      expect(r.stdout).not.toContain("[debug]");
    });

    test("debug goes to stderr only — stdout stays the command's own output", () => {
      const r = run(["init", "--debug"], missing());
      expect(r.stderr).toContain("[debug]");
      expect(r.stdout).not.toContain("[debug]");
      expect(r.stdout).toContain("Wrote ");
    });

    test("debug is not TTY-gated: a piped run still captures it", () => {
      // Bun.spawnSync pipes both streams, so stderr is not a TTY here. Progress is
      // suppressed in that case by design; debug must not be (ADR-0015 §4).
      const r = run(["status", "--debug"], written(CONFIG));
      expect(r.stderr).toContain("[debug]");
    });
  });
});
