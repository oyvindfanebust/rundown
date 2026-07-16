import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  tokenPath,
  scopesFor,
  authorizeUrl,
  tokenFromExchange,
  readCachedAuth,
  writeCachedAuth,
  slackAppConfig,
  BASE_SCOPES,
  HISTORY_SCOPES,
} from "../src/sources/slack/auth.ts";

// tokenPath()/configDir() read RUNDOWN_CONFIG at call time; save + restore around
// each test so a temp store never leaks into another test or the real config.
const ORIGINAL_CONFIG = process.env.RUNDOWN_CONFIG;
afterEach(() => {
  if (ORIGINAL_CONFIG === undefined) delete process.env.RUNDOWN_CONFIG;
  else process.env.RUNDOWN_CONFIG = ORIGINAL_CONFIG;
});

describe("slack auth tokenPath", () => {
  test("resolves under the RUNDOWN_CONFIG directory", () => {
    const sandbox = join("/tmp", "rundown-slack-sandbox");
    process.env.RUNDOWN_CONFIG = join(sandbox, "config.json");
    expect(tokenPath()).toBe(join(sandbox, "slack-token-cache.json"));
  });

  test("defaults beside the default config when RUNDOWN_CONFIG is unset", () => {
    delete process.env.RUNDOWN_CONFIG;
    expect(tokenPath()).toBe(join(homedir(), ".config", "rundown", "slack-token-cache.json"));
  });
});

describe("slack auth scopesFor", () => {
  test("base scopes only when threads is off", () => {
    expect(scopesFor(false)).toEqual(BASE_SCOPES);
    expect(scopesFor(false)).not.toContain("channels:history");
  });

  test("adds the *:history family when threads is on", () => {
    const scopes = scopesFor(true);
    for (const s of [...BASE_SCOPES, ...HISTORY_SCOPES]) expect(scopes).toContain(s);
  });
});

describe("slack auth authorizeUrl", () => {
  test("puts user-token scopes on user_scope (not scope) and carries the redirect", () => {
    const url = new URL(authorizeUrl("cid-123", ["search:read", "users:read"], "http://localhost:53912"));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("user_scope")).toBe("search:read,users:read");
    expect(url.searchParams.get("scope")).toBeNull(); // bot scopes only; never set here
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:53912");
  });
});

describe("slack auth tokenFromExchange", () => {
  test("extracts the user access_token + id from a successful exchange", () => {
    expect(
      tokenFromExchange({ ok: true, authed_user: { id: "U1", access_token: "xoxp-abc" }, access_token: "xoxb-bot" }),
    ).toEqual({ accessToken: "xoxp-abc", userId: "U1" });
  });

  test("returns null when the exchange failed or carried no user token", () => {
    expect(tokenFromExchange({ ok: false, error: "invalid_code" })).toBeNull();
    expect(tokenFromExchange({ ok: true, authed_user: {} })).toBeNull();
    expect(tokenFromExchange(null)).toBeNull();
  });
});

describe("slack auth token cache", () => {
  test("round-trips the cached auth and writes it owner-only (0o600)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-cache-"));
    process.env.RUNDOWN_CONFIG = join(dir, "config.json");
    try {
      expect(await readCachedAuth()).toBeNull(); // nothing cached yet
      await writeCachedAuth({ accessToken: "xoxp-xyz", userId: "U9" });
      expect(await readCachedAuth()).toEqual({ accessToken: "xoxp-xyz", userId: "U9" });
      expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for a malformed cache file rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-cache-"));
    process.env.RUNDOWN_CONFIG = join(dir, "config.json");
    try {
      await Bun.write(tokenPath(), "{ not valid json");
      expect(await readCachedAuth()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("slack auth slackAppConfig", () => {
  const savedId = process.env.SLACK_CLIENT_ID;
  const savedSecret = process.env.SLACK_CLIENT_SECRET;
  afterEach(() => {
    if (savedId === undefined) delete process.env.SLACK_CLIENT_ID;
    else process.env.SLACK_CLIENT_ID = savedId;
    if (savedSecret === undefined) delete process.env.SLACK_CLIENT_SECRET;
    else process.env.SLACK_CLIENT_SECRET = savedSecret;
  });

  test("reads the env pair, and is null when either is missing", () => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "secret";
    expect(slackAppConfig()).toEqual({ clientId: "cid", clientSecret: "secret" });
    delete process.env.SLACK_CLIENT_SECRET;
    expect(slackAppConfig()).toBeNull();
  });
});
