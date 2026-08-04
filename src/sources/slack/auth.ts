// Slack auth — OAuth v2 authorization-code flow with a localhost redirect,
// following the Graph pattern (ADR-0014 §6): an admin-registered, admin-approved
// single-workspace app, and each user runs `rundown login` to mint a per-user
// `xoxp-` user token. Slack OAuth v2 has no PKCE, so the `client_secret` is
// presented at the code exchange (`oauth.v2.access`).
//
// App credentials (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET) are an env-only,
// org-provisioned pair — env-first and machine-local (ADR-0001 §4, ADR-0007 §3),
// NEVER read from the shareable config.json. The minted `xoxp-` is cached beside
// the resolved config (configDir), the same token-store location the Graph MSAL
// cache uses, so RUNDOWN_CONFIG relocates it with the config file — never in env
// or config.json.
//
// The localhost-OAuth capture (browser opener, redirect listener, the redirect-error
// scrub that keeps a hostile `error_description` off the agent-readable error
// channel, listener/timeout dance) is provider-neutral and already lives, tested,
// in graph/auth.ts as `awaitAuthCode`; Slack reuses it rather than duplicating the
// same mechanics. HTTP-level transport failures throw through the shared
// `statusOnlyError` scrub (sources/errors.ts), the single audited status-only
// surface every remote source shares.

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../config.ts";
import { statusOnlyError } from "../errors.ts";
import { awaitAuthCode } from "../graph/auth.ts";

/** Absolute path to the cached Slack user token — resolved per call so it tracks RUNDOWN_CONFIG. */
export function tokenPath(): string {
  return join(configDir(), "slack-token-cache.json");
}

/** The localhost redirect port. Must match the redirect URL registered on the Slack app. */
export const SLACK_REDIRECT_PORT = 53912;

const SLACK_API = "https://slack.com/api";
const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/** Shipped user scopes (ADR-0014 §6, #20): least-privilege, search-driven. */
export const BASE_SCOPES = ["search:read", "users:read"];

/**
 * The `*:history` family `conversations.replies` needs for the opt-in `threads`
 * reconstruction (ADR-0014 §5), one per channel type. Requested only when the
 * `threads` option is on, so enabling it is a user re-login against the
 * admin-approved `user_scope` ceiling, not an admin re-approval.
 */
export const HISTORY_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
];

/** The user scopes to request at login, given the resolved `threads` option. */
export function scopesFor(threads: boolean): string[] {
  return threads ? [...BASE_SCOPES, ...HISTORY_SCOPES] : [...BASE_SCOPES];
}

export interface SlackAppConfig {
  clientId: string;
  clientSecret: string;
}

/** Slack app credentials, env-only. Returns null when unconfigured. */
export function slackAppConfig(): SlackAppConfig | null {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

function requireAppConfig(): SlackAppConfig {
  const cfg = slackAppConfig();
  if (!cfg) {
    throw new Error(
      "Slack is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in your environment " +
        "(from your Slack app registration).",
    );
  }
  return cfg;
}

/** The cached per-user token plus the authed user id (the mention/`from:` query subject). */
export interface CachedAuth {
  accessToken: string;
  userId: string;
}

/** Read the cached Slack auth, or null when none is present / the file is unreadable. */
export async function readCachedAuth(): Promise<CachedAuth | null> {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<CachedAuth>;
    if (typeof parsed.accessToken === "string" && typeof parsed.userId === "string") {
      return { accessToken: parsed.accessToken, userId: parsed.userId };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the minted token beside the config, owner-only (0o600), like the Graph cache. */
export async function writeCachedAuth(auth: CachedAuth): Promise<void> {
  const path = tokenPath();
  await mkdir(configDir(), { recursive: true });
  await writeFile(path, JSON.stringify(auth));
  await chmod(path, 0o600);
}

/** Build the OAuth v2 authorize URL. User-token scopes ride `user_scope`, not `scope` (which is bot-only). */
export function authorizeUrl(clientId: string, scopes: string[], redirectUri: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("user_scope", scopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

/**
 * The minted user token + authed-user id from an `oauth.v2.access` response, or
 * null when the exchange did not succeed. The `xoxp-` lives at
 * `authed_user.access_token`; a bot `scope`/top-level `access_token` is ignored —
 * this source is user-token-only.
 */
export function tokenFromExchange(body: unknown): CachedAuth | null {
  const b = body as { ok?: unknown; authed_user?: { access_token?: unknown; id?: unknown } } | null;
  const accessToken = b?.authed_user?.access_token;
  const userId = b?.authed_user?.id;
  if (b?.ok === true && typeof accessToken === "string" && typeof userId === "string") {
    return { accessToken, userId };
  }
  return null;
}

/**
 * The raw Slack Web API caller: a token-bearing request that throws a status-only
 * error on an HTTP-level failure (ADR-0014 §7), and otherwise returns the parsed
 * body verbatim — including a Slack application-level `{ ok: false, error }`,
 * which the caller interprets (a rejected `auth.test` is a state, not a leak; a
 * failed data method is scrubbed to a generic failure). Never echoes a response
 * byte into a thrown message. 429s are retried within the `Retry-After` bound.
 */
export async function slackApi(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<any> {
  const MAX_RETRIES = 3;
  const url = `${SLACK_API}/${method}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
    if (r.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(r.headers.get("retry-after")) || 1;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    // Only the numeric HTTP status crosses into a thrown error (ADR-0004 §5); the
    // backend body — which a hostile party can shape — never does. The shared
    // statusOnlyError owns that scrub (sources/errors.ts).
    if (!r.ok) throw statusOnlyError("Slack", r);
    return r.json();
  }
}

/** Exchange an auth code for a user token via `oauth.v2.access` (client_secret presented, no PKCE). */
async function exchangeCode(cfg: SlackAppConfig, code: string, redirectUri: string): Promise<CachedAuth> {
  const r = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!r.ok) throw statusOnlyError("Slack", r);
  const auth = tokenFromExchange(await r.json());
  if (!auth) throw new Error("Slack token exchange returned no user token");
  return auth;
}

/**
 * Interactive login via the OAuth v2 code flow. `threads` widens the requested
 * `user_scope` to the `*:history` family (ADR-0014 §5). Mints and caches the
 * `xoxp-`, then confirms it with a live `auth.test` and returns the account name.
 */
export async function login(threads: boolean): Promise<string> {
  const cfg = requireAppConfig();
  const redirectUri = `http://localhost:${SLACK_REDIRECT_PORT}`;
  const authUrl = authorizeUrl(cfg.clientId, scopesFor(threads), redirectUri);
  const code = await awaitAuthCode(SLACK_REDIRECT_PORT, authUrl);
  const auth = await exchangeCode(cfg, code, redirectUri);
  await writeCachedAuth(auth);
  const test = await slackApi(auth.accessToken, "auth.test");
  return test?.ok && typeof test.user === "string" ? test.user : auth.userId;
}
