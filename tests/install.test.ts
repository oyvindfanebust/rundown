import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh is the bootstrap path (ADR-0001 §2–§3), so it is exercised as a real
// bash run rather than read as text. HOME points at a temp dir and `curl` is a stub
// that fails, so the script reaches its pre-download output and then aborts without
// touching the network or the developer's ~/.config/rundown.

const ROOT = join(import.meta.dir, "..");

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

describe("install.sh", () => {
  let dir: string | undefined;

  function runInstaller(env: Record<string, string>): Run {
    dir = mkdtempSync(join(tmpdir(), "rundown-install-"));
    const stubDir = join(dir, "stub-bin");
    mkdirSync(stubDir);
    // A curl that fails: the download aborts under `set -e`, after every line the
    // script prints first.
    const curl = join(stubDir, "curl");
    writeFileSync(curl, "#!/usr/bin/env bash\nexit 22\n");
    chmodSync(curl, 0o755);
    const proc = Bun.spawnSync(["bash", "install.sh"], {
      cwd: ROOT,
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        ...env,
      },
    });
    return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? 0 };
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("parses", () => {
    const check = Bun.spawnSync(["bash", "-n", "install.sh"], { cwd: ROOT });
    expect(check.exitCode).toBe(0);
  });

  test("warns that a requested version is not a durable pin, naming the config file and field", () => {
    const r = runInstaller({ RUNDOWN_VERSION: "v0.1.0" });
    const out = r.stdout + r.stderr;
    expect(out).toContain("v0.1.0");
    expect(out).toContain("not durable on its own");
    expect(out).toContain("self-updates");
    expect(out).toContain(`"autoUpdate": false`);
    expect(out).toContain(`${dir}/.config/rundown/config.json`);
    // The stub curl aborts the install itself; the warning precedes the download.
    expect(r.exitCode).not.toBe(0);
  });

  test("says nothing about pinning on a default (latest) install", () => {
    const r = runInstaller({});
    const out = r.stdout + r.stderr;
    expect(out).not.toContain("autoUpdate");
    expect(out).not.toContain("not durable");
  });
});
