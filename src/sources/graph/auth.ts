// Microsoft Graph auth — MSAL authorization-code flow with a localhost redirect.
// (Device-code flow is blocked by Conditional Access in the reference tenant.)
// Azure app identifiers are env-first and machine-local (ADR-0001 §4, ADR-0007
// §3); they are NEVER read from the shareable config.json. The MSAL token cache
// lives beside the resolved config (configDir), so RUNDOWN_CONFIG relocates it
// together with the config file rather than splitting the two apart.

import { PublicClientApplication, type Configuration } from "@azure/msal-node";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../config.ts";

/** Absolute path to the MSAL token cache — resolved per call so it tracks RUNDOWN_CONFIG. */
export function cachePath(): string {
  return join(configDir(), "graph-token-cache.json");
}

// Phase 1: delegated read-only permissions only, no admin consent required.
export const GRAPH_SCOPES = ["Calendars.Read", "Mail.Read", "User.Read"];

interface AzureConfig {
  tenantId: string;
  clientId: string;
}

/** Azure app identifiers, env-only. Returns null when unconfigured. */
export function azureConfig(): AzureConfig | null {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  if (tenantId && clientId) return { tenantId, clientId };
  return null;
}

function requireAzureConfig(): AzureConfig {
  const cfg = azureConfig();
  if (!cfg) {
    throw new Error(
      "Graph is not configured. Set AZURE_TENANT_ID and AZURE_CLIENT_ID in your environment " +
        "(from your Azure app registration).",
    );
  }
  return cfg;
}

const cachePlugin = {
  async beforeCacheAccess(ctx: { tokenCache: { deserialize(s: string): void } }) {
    const path = cachePath();
    if (existsSync(path)) {
      ctx.tokenCache.deserialize(await readFile(path, "utf-8"));
    }
  },
  async afterCacheAccess(ctx: { cacheHasChanged: boolean; tokenCache: { serialize(): string } }) {
    if (ctx.cacheHasChanged) {
      const path = cachePath();
      await mkdir(configDir(), { recursive: true });
      await writeFile(path, ctx.tokenCache.serialize());
      await chmod(path, 0o600);
    }
  },
};

/** How to launch a URL — a seam so the opener selection is testable without spawning. */
export type SpawnFn = (cmd: string[]) => void;

/**
 * The browser-opener command for a platform, or null when none is known.
 * Covers the ADR-0001 §3 targets: `open` on darwin, `xdg-open` on the linux binaries.
 */
export function openerCommand(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
      return "open";
    case "linux":
      return "xdg-open";
    default:
      return null;
  }
}

/**
 * Opens `url` in the user's browser. On an unsupported platform or a spawn failure,
 * falls back to printing the URL so the user can open it manually — login still works.
 * `spawn` is injectable so the opener selection is testable without launching a browser.
 */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: SpawnFn = (cmd) => {
    Bun.spawn(cmd);
  },
): void {
  const opener = openerCommand(platform);
  if (!opener) {
    process.stderr.write(
      `\nCould not detect a browser opener for platform "${platform}". ` +
        `Open this URL manually to sign in:\n${url}\n`,
    );
    return;
  }
  try {
    spawn([opener, url]);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `\nCould not launch a browser (${detail}). Open this URL manually to sign in:\n${url}\n`,
    );
  }
}

// The OAuth error code is a constrained enum (`access_denied`, `invalid_request`, …)
// per RFC 6749 §4.1.2.1, so it is safe to surface. `error_description` is free text
// the authorization server (or, during the redirect window, anyone who can reach
// localhost:53682 with a crafted GET) supplies verbatim — it must never cross into
// a thrown error's message, which propagates to cli.ts fail() → stderr, an
// agent-readable channel (ADR-0004 §5) — the same scrub motive as
// sources/errors.ts, but by allowlist-validation of a code rather than
// status-extraction, so it stays local here.
const OAUTH_ERROR_CODE = /^[a-z0-9_]{1,64}$/i;

/**
 * Builds the error rejected when a login redirect carries no auth code. Reads only
 * the `error` code (validated against OAUTH_ERROR_CODE) — never `error_description` —
 * so no externally-authorable free text can reach the thrown message.
 */
export function redirectError(params: URLSearchParams): Error {
  const code = params.get("error");
  const description = params.get("error_description");
  if (!code && !description) return new Error("No auth code in redirect");
  if (code && OAUTH_ERROR_CODE.test(code)) {
    return new Error(`Sign-in redirect returned an error: ${code}`);
  }
  return new Error("Sign-in redirect returned an error");
}

/**
 * Starts the OAuth redirect listener, translating a port-in-use failure (a second
 * concurrent login, or any squatter on the port) into a clear, actionable error.
 */
export function startRedirectListener(
  port: number,
  handler: (req: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  try {
    return Bun.serve({ port, fetch: handler });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot start the login redirect listener on port ${port} (${detail}). ` +
        `A previous login may still be running, or another process is using this port — ` +
        `close it and retry.`,
    );
  }
}

function createApp(): PublicClientApplication {
  const { tenantId, clientId } = requireAzureConfig();
  const config: Configuration = {
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
    cache: { cachePlugin },
  };
  return new PublicClientApplication(config);
}

/** Interactive login via auth-code flow. Only needed once; tokens refresh silently after. */
export async function login(): Promise<string> {
  const pca = createApp();
  const port = 53682;
  const redirectUri = `http://localhost:${port}`;
  const authUrl = await pca.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri });

  const code = await new Promise<string>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    let server: ReturnType<typeof Bun.serve>;
    const handler = (req: Request): Response => {
      const url = new URL(req.url);
      const authCode = url.searchParams.get("code");
      clearTimeout(timeout);
      // Force-close after the response flushes, so the listener never keeps the process alive.
      setTimeout(() => server.stop(true), 100);
      if (authCode) {
        resolve(authCode);
        return new Response("Signed in. You can close this tab.", {
          headers: { "content-type": "text/plain" },
        });
      }
      reject(redirectError(url.searchParams));
      // The browser response, unlike the rejected error, isn't an agent-readable
      // channel — the description may be shown to the human at the keyboard.
      const description = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      return new Response(`Login failed: ${description}`, { status: 400 });
    };
    try {
      server = startRedirectListener(port, handler);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    process.stderr.write(`\nOpening browser for sign-in (listening on ${redirectUri})...\n`);
    openBrowser(authUrl);
    timeout = setTimeout(() => {
      server.stop(true);
      reject(new Error("Timed out waiting for sign-in (5 min)"));
    }, 5 * 60_000);
  });

  const result = await pca.acquireTokenByCode({ code, scopes: GRAPH_SCOPES, redirectUri });
  if (!result) throw new Error("Token exchange returned no result");
  return result.account?.username ?? "unknown";
}

/** Silent token acquisition from the persisted cache. Throws if login is required. */
export async function getToken(): Promise<string> {
  const pca = createApp();
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) throw new Error("Not logged in. Run: rundown login");
  const account = accounts[0]!;
  try {
    const result = await pca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
    return result.accessToken;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Silent token refresh failed (${detail}). Run: rundown login`);
  }
}

/** The signed-in account username, or null when not authenticated / not configured. */
export async function signedInAccount(): Promise<string | null> {
  if (!azureConfig()) return null;
  try {
    const pca = createApp();
    const accounts = await pca.getTokenCache().getAllAccounts();
    return accounts[0]?.username ?? null;
  } catch {
    return null;
  }
}
