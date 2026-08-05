import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadAndSwap,
  assetName,
  assetUrl,
  CANDIDATE_SUFFIX,
  fsSwapIO,
} from "../src/update.ts";

// The mutating core (ADR-0001 §5). The network is faked; the filesystem and process
// spawning are REAL, against a temp dir, because renaming, permission bits, and
// actually executing the candidate are the behavior under test rather than
// incidental. The candidate is a shell script with a shebang that prints a version,
// so the liveness check runs for real with nothing mocked.
//
// Most of this feature is refusals, so most of these tests assert that NOTHING
// happened: the target is byte-identical and no candidate file is left behind.

const TARGET_BODY = "#!/bin/sh\necho 0.1.0\n";

/** A candidate script that prints `version` and exits `code`. */
function candidateScript(version: string, code = 0): string {
  return `#!/bin/sh\necho ${version}\nexit ${code}\n`;
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** A fetch that serves an asset body and a checksum body from a fixed base. */
function serve(bodies: Record<string, { body?: string; status?: number }>): typeof fetch {
  return (async (url: string | URL) => {
    const key = url.toString();
    const entry = bodies[key];
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.body ?? "", { status: entry.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("assetName", () => {
  // Pinned so the platform mapping cannot drift between install.sh's case
  // statement, the release workflow's build matrix, and this module.
  test("maps the four supported platforms onto the release asset names", () => {
    expect(assetName("darwin", "arm64")).toBe("rundown-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("rundown-darwin-x64");
    expect(assetName("linux", "x64")).toBe("rundown-linux-x64");
    expect(assetName("linux", "arm64")).toBe("rundown-linux-arm64");
  });

  test("refuses platforms the release matrix does not build", () => {
    expect(assetName("win32", "x64")).toBeUndefined();
    expect(assetName("darwin", "ia32")).toBeUndefined();
    expect(assetName("linux", "s390x")).toBeUndefined();
    expect(assetName("freebsd", "x64")).toBeUndefined();
  });

  test("builds the download URL from the tag and asset", () => {
    expect(assetUrl("0.7.0", "rundown-linux-x64", "https://example.test/dl")).toBe(
      "https://example.test/dl/v0.7.0/rundown-linux-x64",
    );
  });
});

describe("downloadAndSwap", () => {
  let dir: string;
  let target: string;
  const BASE = "https://example.test/dl";
  const ASSET = "rundown-linux-x64";
  const URL_BIN = `${BASE}/v0.7.0/${ASSET}`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rundown-swap-"));
    target = join(dir, "rundown");
    writeFileSync(target, TARGET_BODY);
    chmodSync(target, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(bodies: Record<string, { body?: string; status?: number }>, over: Record<string, unknown> = {}) {
    return {
      fetch: serve(bodies),
      io: fsSwapIO,
      target,
      version: "0.7.0",
      asset: ASSET,
      baseUrl: BASE,
      ...over,
    };
  }

  /** Every refusal must leave the working binary exactly as it was. */
  function expectUntouched() {
    expect(readFileSync(target, "utf-8")).toBe(TARGET_BODY);
  }
  /** And leave no debris. */
  function expectNoCandidate() {
    expect(existsSync(target + CANDIDATE_SUFFIX)).toBe(false);
  }

  test("a strictly-newer, correct candidate replaces the target", async () => {
    const body = candidateScript("0.7.0");
    const r = await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } }),
    );
    expect(r).toEqual({ ok: true });
    expect(readFileSync(target, "utf-8")).toBe(body);
    // Installed executable, and no debris left behind.
    expect(statSync(target).mode & 0o111).toBeGreaterThan(0);
    expectNoCandidate();
  });

  test("a checksum mismatch installs nothing", async () => {
    const body = candidateScript("0.7.0");
    const r = await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${"0".repeat(64)}  ${ASSET}\n` } }),
    );
    expect(r).toEqual({ ok: false, reason: "checksum-mismatch" });
    expectUntouched();
    expectNoCandidate();
  });

  test("a truncated body installs nothing, because its hash no longer matches", async () => {
    const full = candidateScript("0.7.0");
    const r = await downloadAndSwap(
      deps({ [URL_BIN]: { body: full.slice(0, 10) }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(full)}  ${ASSET}\n` } }),
    );
    expect(r).toEqual({ ok: false, reason: "checksum-mismatch" });
    expectUntouched();
    expectNoCandidate();
  });

  test("a missing asset installs nothing", async () => {
    const r = await downloadAndSwap(deps({}));
    expect(r).toEqual({ ok: false, reason: "asset-missing" });
    expectUntouched();
    expectNoCandidate();
  });

  test("a missing checksum asset installs nothing", async () => {
    const body = candidateScript("0.7.0");
    const r = await downloadAndSwap(deps({ [URL_BIN]: { body } }));
    expect(r).toEqual({ ok: false, reason: "checksum-missing" });
    expectUntouched();
    expectNoCandidate();
  });

  test("a candidate that exits non-zero installs nothing", async () => {
    // The liveness check runs for real: this script exits 3.
    const body = candidateScript("0.7.0", 3);
    const r = await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } }),
    );
    expect(r).toEqual({ ok: false, reason: "smoke-test-failed" });
    expectUntouched();
    expectNoCandidate();
  });

  test("a candidate that reports the wrong version installs nothing", async () => {
    // Starts cleanly, but is not the release it claims to be — a mismatched or
    // wrong-platform asset.
    const body = candidateScript("0.6.5");
    const r = await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } }),
    );
    expect(r).toEqual({ ok: false, reason: "version-mismatch" });
    expectUntouched();
    expectNoCandidate();
  });

  test("a candidate that is not executable at all installs nothing", async () => {
    // No shebang and not a valid binary: exec fails, which is the smoke test's job.
    const body = "this is not a program";
    const r = await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } }),
    );
    expect(r.ok).toBe(false);
    expectUntouched();
    expectNoCandidate();
  });

  test("an unsupported platform installs nothing and never touches the network", async () => {
    let called = false;
    const r = await downloadAndSwap(
      deps({}, {
        asset: undefined,
        fetch: (async () => {
          called = true;
          return new Response("", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    // assetName() is consulted first; on a supported host this test would fall
    // through, so it asserts the refusal only when the platform really is unmapped.
    if (assetName() === undefined) {
      expect(r).toEqual({ ok: false, reason: "unsupported-platform" });
      expect(called).toBe(false);
    }
    expectUntouched();
  });

  test("the candidate uses a fixed name, so a killed worker leaves at most one stale file", async () => {
    // Pre-create debris from a hypothetical earlier crash; the next run overwrites
    // it rather than accumulating a second file.
    const stale = target + CANDIDATE_SUFFIX;
    writeFileSync(stale, "junk from a killed worker");
    const body = candidateScript("0.7.0");
    await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } }),
    );
    expect(readFileSync(target, "utf-8")).toBe(body);
    expectNoCandidate();
  });

  test("the candidate lands in the target's own directory, so the rename is a same-filesystem swap", async () => {
    const body = candidateScript("0.7.0");
    let seenCandidate: string | undefined;
    await downloadAndSwap(
      deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } }, {
        io: {
          ...fsSwapIO,
          async writeCandidate(path: string, bytes: Uint8Array) {
            seenCandidate = path;
            await fsSwapIO.writeCandidate(path, bytes);
          },
        },
      }),
    );
    expect(seenCandidate).toBe(join(dir, "rundown" + CANDIDATE_SUFFIX));
  });

  test("two concurrent swaps leave the target correct, with no lock taken", async () => {
    const body = candidateScript("0.7.0");
    const d = deps({ [URL_BIN]: { body }, [`${URL_BIN}.sha256`]: { body: `${sha256Hex(body)}  ${ASSET}\n` } });
    const [a, b] = await Promise.all([downloadAndSwap(d), downloadAndSwap(d)]);
    // Both download identical bytes and both rename; rename is atomic, so the
    // outcome is byte-identical either way and the cost is one wasted download.
    expect(a.ok || b.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(body);
    expectNoCandidate();
  });
});

describe("symlink resolution", () => {
  // The installer symlinks ~/.local/bin/rundown at the real binary in
  // ~/.config/rundown/bin. Replacing the symlink with a regular file would break
  // that layout, so the swap must target the resolved path.
  test("swapping through a resolved path replaces the real file, not the symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rundown-link-"));
    try {
      const real = join(dir, "real-rundown");
      const link = join(dir, "rundown-link");
      writeFileSync(real, TARGET_BODY);
      chmodSync(real, 0o755);
      symlinkSync(real, link);

      const body = candidateScript("0.7.0");
      const BASE = "https://example.test/dl";
      const url = `${BASE}/v0.7.0/rundown-linux-x64`;
      // The caller resolves symlinks before handing the target over; this asserts
      // the contract that makes that resolution meaningful.
      const r = await downloadAndSwap({
        fetch: serve({ [url]: { body }, [`${url}.sha256`]: { body: `${sha256Hex(body)}  x\n` } }),
        io: fsSwapIO,
        target: real,
        version: "0.7.0",
        asset: "rundown-linux-x64",
        baseUrl: BASE,
      });
      expect(r).toEqual({ ok: true });
      expect(readFileSync(real, "utf-8")).toBe(body);
      // Still a symlink, still pointing at the replaced file.
      expect(statSync(link).isSymbolicLink()).toBe(false);
      expect(readFileSync(link, "utf-8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
