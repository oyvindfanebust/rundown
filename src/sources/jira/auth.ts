// Jira auth — the OAuth-swappable seam (ADR-0013 §5). Jira Cloud authenticates
// with HTTP Basic over base64("<email>:<api_token>"): the email is part of the
// credential, so it lives beside the token in the env, never in the shareable
// config.json (ADR-0001 §4, ADR-0007 §3). Both are secrets and are read only here.
//
// OAuth later swaps `jiraCredentials()`/`basicAuthHeader()` for a bearer-token
// factory and adds `login()` to index.ts; `read()`/`status()` are untouched.

/** The Basic-auth credential pair, env-only. Returns null when either half is unset. */
export function jiraCredentials(): { email: string; token: string } | null {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  return email && token ? { email, token } : null;
}

/** The `Authorization: Basic …` header value for a credential pair. */
export function basicAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}
