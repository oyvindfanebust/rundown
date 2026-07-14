// Linear auth — the OAuth-swappable seam. A client factory,
// not a raw header string: the SDK owns `Authorization` construction (a personal
// API key is sent verbatim, with NO `Bearer` prefix). The key is env-first and
// machine-local (ADR-0001 §4, ADR-0007 §3) — it is a secret and NEVER lives in
// the shareable config.json.
//
// OAuth later swaps `linearClient()` to `new LinearClient({ accessToken })` and
// adds `login()` to index.ts; `read()`/`status()` are untouched.

import { LinearClient } from "@linear/sdk";

/** The Linear personal API key, env-only. Returns null when unconfigured. */
export function linearApiKey(): string | null {
  return process.env.LINEAR_API_KEY ?? null;
}

/** A Linear client built from the env key, or null when no key is set. */
export function linearClient(): LinearClient | null {
  const apiKey = linearApiKey();
  return apiKey ? new LinearClient({ apiKey }) : null; // SDK sends the raw key, no "Bearer"
}
