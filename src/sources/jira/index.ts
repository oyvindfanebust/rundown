// The Jira (Cloud) Source (ADR-0013): read-only issues from a single Jira site via
// the REST API, emitting kind:"issue" NormalizedItems. Remote + auth, but
// non-interactive: there is no `login()` — its absence is the declaration the
// Aggregator reads (ADR-0002 §2) that auth is credential-only (JIRA_EMAIL +
// JIRA_API_TOKEN in the env), so this source verifies in `status()` with a live
// `myself` call and never emits `not-authenticated`.
//
// The closest existing template is the Linear source: both are issue trackers with
// token-only non-interactive auth, one paginated query, curated structured scope
// options (no raw query dialect), and the same standing+recent union, dedup-by-id,
// and open+dated→end-of-day timestamp rule. Jira differs in three structural ways:
// Basic auth (not a bearer key), a required per-source `site` option the token does
// not carry, and a raw-`fetch` transport over `POST /rest/api/3/search/jql` with
// nextPageToken/isLast pagination (there is no first-party JS SDK).
//
// Transport routing (ADR-0013 §5): Atlassian scoped API tokens authenticate only
// through the gateway `https://api.atlassian.com/ex/jira/{cloudId}/…`, not the
// instance URL, which rejects them with 401 AUTHENTICATED_FAILED. The default
// transport resolves `cloudId` once from the unauthenticated `/_edge/tenant_info`
// endpoint, prefers the gateway, and falls back to the instance URL on a 401 so
// classic-token support cannot regress. The permalink stays instance-based
// (`https://<site>/browse/<key>`) — the gateway is an API host, not a browser URL.
// `cloudId` is a non-secret structural identifier; its shape is validated and it
// never enters an error or log body.
//
// All Jira backend content — summary, description, status/assignee/reporter/project/
// issuetype names, `id`, the permalink — is Untrusted, branded at this boundary with
// untrusted()/untrustedOpt() (mirror linear/index.ts). Only the structural fields
// {source, kind, timestamp} are trusted. Never unwrapped here (sole unwrap site is
// plan.ts; CLAUDE.md).

import type { NormalizedItem, Window } from "../../domain.ts";
import { normalizer, text } from "../normalize.ts";
import { statusOnlyError } from "../errors.ts";
import type { OptionSchema, Source, SourceStatus } from "../source.ts";
import { basicAuthHeader, jiraCredentials } from "./auth.ts";

const KEY = "jira";
const PAGE_SIZE = 50;

// The source's one normalizer — the only way this module makes a NormalizedItem.
const normalize = normalizer(KEY, { untitled: "(no summary)" });

/** The three queryable relationships, named for Jira's own nouns (ADR-0013 §2). */
type Relationship = "assigned" | "created" | "watching";
const RELATIONSHIPS: readonly Relationship[] = ["assigned", "created", "watching"];

/** The fixed Jira-wide status-category vocabulary (`statusCategory.key`). */
const STATUS_CATEGORIES = ["new", "indeterminate", "done"] as const;

const DEFAULT_RELATIONSHIPS: Relationship[] = ["assigned"];
const DEFAULT_STATUSES: string[] = [...STATUS_CATEGORIES];

/** Per-relationship JQL fragment — the current user, by Jira's own noun. */
const RELATIONSHIP_JQL: Record<Relationship, string> = {
  assigned: "assignee = currentUser()",
  created: "reporter = currentUser()",
  watching: "watcher = currentUser()",
};

/** The `fields` requested explicitly on every search call (the new endpoint returns none by default). */
const FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "project",
  "issuetype",
  "duedate",
  "labels",
  "description",
  "updated",
];

/**
 * The thin transport this source needs: one raw request against a REST path,
 * returning the parsed JSON body. Two paths flow through it — `GET
 * /rest/api/3/myself` (status) and `POST /rest/api/3/search/jql` (read). This is
 * the injectable seam for tests (mirrors Linear's `LinearRequest`).
 */
export type JiraRequest = (path: string, init?: { method?: string; body?: unknown }) => Promise<any>;

/**
 * The minimal `fetch` shape the transport needs, injected so cloudId resolution and
 * gateway routing are unit-testable offline. The global `fetch` satisfies it.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/** The scoped-token gateway origin; the REST path is prefixed with `/rest/api/3/…`. */
const GATEWAY_ORIGIN = "https://api.atlassian.com/ex/jira";

/** cloudId is a UUID; validate its shape before it feeds a request URL (ADR-0013 §5). */
function isCloudId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Resolve the site's `cloudId` from the unauthenticated `/_edge/tenant_info`
 * endpoint. The response is backend content: only a UUID-shaped `cloudId` is read
 * out, and any failure (non-ok, or a malformed/absent cloudId) reduces to the
 * shared status-only scrub — no body bytes cross into the thrown message
 * (ADR-0004 §5, ADR-0013 §5). `origin` is the bare instance origin from `siteOrigin`.
 */
export async function resolveCloudId(origin: string, fetchImpl: FetchLike): Promise<string> {
  const r = await fetchImpl(`${origin}/_edge/tenant_info`);
  if (!r.ok) throw statusOnlyError("Jira", r);
  const cloudId = (await r.json())?.cloudId;
  if (!isCloudId(cloudId)) throw statusOnlyError("Jira", undefined);
  return cloudId;
}

/** Injectable dependencies — the seam that makes the source unit-testable. */
export interface JiraDeps {
  /**
   * Transport factory. Returns null when the source is not fully configured —
   * either env secret or the `site` option missing — the "not-configured" signal
   * `status()` reads. Default: a real Basic-auth `fetch` against the site.
   */
  transport?: () => JiraRequest | null;
}

/**
 * Normalize the `site` option to a bare origin (no trailing slash). Accepts
 * `your-domain.atlassian.net` or a full `https://…` origin; returns undefined when
 * absent or blank. Feeds both the request base URL and the item permalink.
 */
export function siteOrigin(site: unknown): string | undefined {
  if (typeof site !== "string") return undefined;
  const trimmed = site.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The default transport: a Basic-auth `fetch` that prefers the scoped-token gateway
 * and falls back to the instance URL on a 401 (ADR-0013 §5). `cloudId` resolves at
 * most once (cached in the closure), lazily on the first request, so both `status()`
 * and `read()` reuse it. `fetchImpl` is injectable for tests; production uses the
 * global `fetch`.
 */
export function defaultTransport(site: unknown, fetchImpl: FetchLike = fetch): JiraRequest | null {
  const origin = siteOrigin(site);
  const credentials = jiraCredentials();
  if (!origin || !credentials) return null;
  const authorization = basicAuthHeader(credentials.email, credentials.token);

  // Resolve cloudId at most once per transport instance.
  let cloudId: Promise<string> | undefined;
  const gatewayBase = () => (cloudId ??= resolveCloudId(origin, fetchImpl)).then((id) => `${GATEWAY_ORIGIN}/${id}`);

  // Prefer the gateway; a 401 there flips this to the instance URL for good (classic
  // tokens authenticate against the instance, scoped tokens against the gateway).
  let base: "gateway" | "instance" = "gateway";

  const call = async (root: string, path: string, init?: { method?: string; body?: unknown }) => {
    const hasBody = init?.body !== undefined;
    return fetchImpl(`${root}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(init!.body) : undefined,
    });
  };

  return async (path, init) => {
    if (base === "gateway") {
      const r = await call(await gatewayBase(), path, init);
      if (r.ok) return r.json();
      // A 401 means this token is not accepted at the gateway (a classic token);
      // fall back to the instance URL and stay there. Any other status is a real
      // failure, scrubbed to status-only (ADR-0004 §5, ADR-0013 §6).
      if (r.status !== 401) throw statusOnlyError("Jira", r);
      base = "instance";
    }
    const r = await call(origin, path, init);
    if (!r.ok) throw statusOnlyError("Jira", r);
    return r.json();
  };
}

/**
 * The `not-configured` detail: which pieces are still missing. Named separately
 * from env secrets vs the config option because Jira is the first source that can
 * be half-configured — secrets set, `site` missing (ADR-0013 §7).
 */
function missingConfigDetail(site: unknown): string {
  const parts: string[] = [];
  const env: string[] = [];
  if (!process.env.JIRA_EMAIL) env.push("JIRA_EMAIL");
  if (!process.env.JIRA_API_TOKEN) env.push("JIRA_API_TOKEN");
  if (env.length) parts.push(env.join(" and "));
  if (!siteOrigin(site)) parts.push(`the "site" option in config.json`);
  return `set ${parts.join(", ")}`;
}

// ── Jira row shapes (the external HTTP contract, mirrored for mapping + fixtures) ──

interface JiraIssue {
  id: string;
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    priority?: { name?: string } | null;
    project?: { key?: string; name?: string } | null;
    issuetype?: { name?: string } | null;
    duedate?: string | null;
    labels?: string[];
    description?: unknown; // Atlassian Document Format (a rich-text tree) or null
    updated?: string;
  };
}

/** An issue is "open" while its status category is not `done` (ADR-0013 §3). */
function isOpen(issue: JiraIssue): boolean {
  return issue.fields?.status?.statusCategory?.key !== "done";
}

/** UTC end-of-day anchor for a bare `YYYY-MM-DD` due date (a fixed convention). */
function dueDateInstant(dueDate: string): string {
  return `${dueDate}T23:59:59Z`;
}

/**
 * Flatten an Atlassian Document Format description to plain text: collect every
 * `text` leaf in traversal order and join with spaces. API v3 returns `description`
 * as an ADF tree, not a string, so text lives only in these leaves; a null/absent/
 * non-tree value collapses to undefined and the normalizer's compaction drops it.
 */
export function adfToText(node: unknown): string | undefined {
  const parts: string[] = [];
  const walk = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(node);
  const joined = parts.join(" ").trim();
  return joined || undefined;
}

/** JQL datetime literal (`"YYYY-MM-DD HH:mm"`) from an ISO instant. */
function jqlDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Build the JQL for one relationship, given the resolved scope options. `statuses`
 * only earns a clause when it is a strict subset — all three (the default) needs no
 * `statusCategory` filter. The recent query bounds `updated` by the window; the
 * standing query has no `updated` bound (open issues are standing commitments,
 * ADR-0013 §3). Every value comes from a fixed enum or a user-authored config
 * option, never Untrusted backend content, so this is not an injection vector.
 */
export function buildJql(
  relationship: Relationship,
  statuses: string[],
  projects: string[] | undefined,
  window: Window | null,
): string {
  const clauses: string[] = [RELATIONSHIP_JQL[relationship]];
  if (statuses.length > 0 && statuses.length < STATUS_CATEGORIES.length) {
    clauses.push(`statusCategory in (${statuses.map((s) => `"${s}"`).join(", ")})`);
  }
  if (projects?.length) {
    clauses.push(`project in (${projects.map((p) => `"${p}"`).join(", ")})`);
  }
  // JQL naive datetimes are interpreted in the query user's timezone (there is no
  // offset in the JQL grammar); a small skew against the UTC window boundary is an
  // accepted limitation for a planning tool (ADR-0013 §4 timestamp discussion).
  if (window) {
    clauses.push(`updated >= "${jqlDateTime(window.from)}"`);
    clauses.push(`updated < "${jqlDateTime(window.to)}"`);
  }
  return clauses.join(" AND ");
}

/** Jira's declared option schema — exposed on the static descriptor (registry.ts). */
export const JIRA_OPTIONS: OptionSchema = {
  site: {
    type: "string",
    description:
      'Required. Your Jira Cloud site, e.g. "your-domain.atlassian.net" (or a full https:// origin). Not a secret.',
  },
  relationships: {
    type: "string[]",
    enum: RELATIONSHIPS,
    description:
      'Which relationships to pull. Options: "assigned", "created", "watching". Omit for "assigned" only.',
  },
  statuses: {
    type: "string[]",
    enum: STATUS_CATEGORIES,
    description:
      'Which status categories to include. Options: "new", "indeterminate", "done". Omit for all three.',
  },
  projects: {
    type: "string[]",
    description: 'Restrict to these project keys (e.g. "OYV"). Omit for all projects.',
  },
};

export class JiraSource implements Source {
  readonly key = KEY;
  readonly label = "Jira";

  private readonly config: Record<string, unknown>;
  private readonly transport: () => JiraRequest | null;

  constructor(options: Record<string, unknown> = {}, deps: JiraDeps = {}) {
    this.config = options;
    this.transport = deps.transport ?? (() => defaultTransport(options.site));
  }

  // Non-interactive auth (no login()): verify the credential with a live myself call.
  async status(): Promise<SourceStatus> {
    const request = this.transport();
    if (!request) return { state: "not-configured", detail: missingConfigDetail(this.config.site) };
    try {
      const me = await request("/rest/api/3/myself");
      return { state: "ready", identity: me?.displayName };
    } catch {
      return { state: "not-configured", detail: "JIRA_EMAIL/JIRA_API_TOKEN was rejected — check the credentials" };
    }
  }

  async read(window: Window): Promise<NormalizedItem[]> {
    const request = this.transport();
    if (!request) {
      throw new Error(
        'Jira is not configured. Set JIRA_EMAIL and JIRA_API_TOKEN, and the "site" option in config.json.',
      );
    }
    const origin = siteOrigin(this.config.site);

    const relationships = ((this.config.relationships as string[] | undefined) ?? DEFAULT_RELATIONSHIPS).filter(
      (r): r is Relationship => (RELATIONSHIPS as readonly string[]).includes(r),
    );
    const statuses = (this.config.statuses as string[] | undefined) ?? DEFAULT_STATUSES;
    const projects = this.config.projects as string[] | undefined;

    // For each (relationship × {standing, recent}) run a paginated query, tagging
    // each issue with the relationship that surfaced it, then union + dedup by id.
    const byId = new Map<string, NormalizedItem>();
    for (const relationship of relationships) {
      for (const window_ of [null, window]) {
        const jql = buildJql(relationship, statuses, projects, window_);
        const issues = await this.paginate(request, jql);
        for (const issue of issues) {
          if (byId.has(issue.id)) continue; // first-seen relationship wins (deterministic order)
          byId.set(issue.id, normalizeIssue(issue, relationship, origin));
        }
      }
    }
    return [...byId.values()];
  }

  private async paginate(request: JiraRequest, jql: string): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const body: Record<string, unknown> = { jql, fields: FIELDS, maxResults: PAGE_SIZE };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const data = await request("/rest/api/3/search/jql", { method: "POST", body });
      issues.push(...(data?.issues ?? []));
      nextPageToken = data?.isLast === false ? data?.nextPageToken : undefined;
    } while (nextPageToken);
    return issues;
  }
}

/** Map one Jira issue through the normalizer; only domain judgment lives here. */
function normalizeIssue(issue: JiraIssue, relationship: Relationship, origin: string | undefined): NormalizedItem {
  const f = issue.fields ?? {};
  const duedate = f.duedate ?? undefined;
  // Open + dated → UTC end-of-day anchor (future=upcoming, overdue=standing/recent);
  // everything else (undated, recently-updated, done) → updated. Mirrors Linear.
  const timestamp = isOpen(issue) && duedate ? dueDateInstant(duedate) : f.updated ?? "";
  return normalize({
    kind: "issue",
    timestamp,
    id: issue.id,
    title: f.summary,
    // There is no permalink field; construct it from the site + key (ADR-0013 §4).
    url: origin && issue.key ? `${origin}/browse/${issue.key}` : undefined,
    extras: {
      key: issue.key,
      status: f.status ? { name: f.status.name, category: f.status.statusCategory?.key } : undefined,
      assignee: f.assignee?.displayName,
      reporter: f.reporter?.displayName,
      priority: f.priority?.name,
      project: f.project ? { key: f.project.key, name: f.project.name } : undefined,
      issuetype: f.issuetype?.name,
      duedate,
      labels: f.labels ?? [],
      relationship,
      description: text(adfToText(f.description)),
    },
  });
}
