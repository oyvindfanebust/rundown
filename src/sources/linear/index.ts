// The Linear Source: read-only issues from a single Linear account via
// the GraphQL API, emitting kind:"issue" NormalizedItems. Remote + auth, but
// NON-interactive: there is no `login()` — its absence is the declaration the
// Aggregator reads (ADR-0002 §2) that auth is credential-only (a `LINEAR_API_KEY`
// in the env), so this source verifies in `status()` with a live `viewer` call
// and NEVER emits `not-authenticated`.
//
// All Linear backend content — issue title, description, comment/label/state/
// project/team/people names, `id`, `url` — is Untrusted, branded at this boundary
// with untrusted()/untrustedOpt() (mirror graph/index.ts). Only the structural
// fields {source, kind, timestamp} are trusted. Never unwrapped here (sole unwrap
// site is plan.ts; CLAUDE.md).
//
// Reads go through the SDK purely as a thin transport (client.client.rawRequest)
// with ONE hand-written GraphQL query that inlines every relation — NOT the SDK's
// lazy model accessors, which fire an N+1 round-trip per relation. Pages on
// pageInfo.hasNextPage/endCursor, same shape as graph's @odata.nextLink loop.

import type { NormalizedItem, Window } from "../../domain.ts";
import { normalizer, text } from "../normalize.ts";
import { statusOnlyError } from "../errors.ts";
import type { Source, SourceStatus } from "../source.ts";
import { linearClient } from "./auth.ts";

const KEY = "linear";
const PAGE_SIZE = 50; // Linear default; max 250

// The source's one normalizer — the only way this module makes a NormalizedItem.
const normalize = normalizer(KEY, { untitled: "(no title)" });

/** The three queryable relationships (mentions are notifications-only). */
type Relationship = "assigned" | "created" | "subscribed";
const RELATIONSHIPS: readonly Relationship[] = ["assigned", "created", "subscribed"];
const STATE_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;

const DEFAULT_RELATIONSHIPS: Relationship[] = ["assigned"];
const DEFAULT_STATES: string[] = ["unstarted", "started", "completed"];

/** Per-relationship `IssueFilter` fragment. */
const RELATIONSHIP_FILTER: Record<Relationship, Record<string, unknown>> = {
  assigned: { assignee: { isMe: { eq: true } } },
  created: { creator: { isMe: { eq: true } } },
  subscribed: { subscribers: { isMe: { eq: true } } },
};

/**
 * The thin transport this source needs: one raw GraphQL call returning the
 * response payload (`LinearRawResponse.data`). Matches `client.client.rawRequest`
 * and is the injectable seam for tests (mirrors claude-code-logs' injectable deps).
 */
export type LinearRequest = (query: string, variables?: Record<string, unknown>) => Promise<any>;

/** Injectable dependencies — the seam that makes the source unit-testable. */
export interface LinearDeps {
  /**
   * Transport factory. Returns null when no `LINEAR_API_KEY` is configured — the
   * "not-configured" signal `status()` reads. Default: the real Linear client.
   */
  transport?: () => LinearRequest | null;
}

/** The default transport: the real SDK client, used purely as a raw-GraphQL pipe. */
function defaultTransport(): LinearRequest | null {
  const client = linearClient();
  if (!client) return null;
  return async (query, variables) => {
    try {
      const res = await client.client.rawRequest(query, variables);
      return res.data;
    } catch (e) {
      // @linear/sdk throws a LinearError whose message echoes the backend GraphQL
      // error text (and whose .raw stringifies the whole response + our query).
      // A read() transport error propagates to cli.ts fail() → stderr, an
      // agent-readable channel, so scrub it to a status-only message (ADR-0004 §5).
      // The shared statusOnlyError owns that rule (sources/errors.ts).
      throw statusOnlyError("Linear", e);
    }
  };
}

const VIEWER_QUERY = `query { viewer { name email } }`;

// One query, every relation inlined — no lazy SDK accessors (those N+1).
const ISSUES_QUERY = `query Issues($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      description
      url
      priorityLabel
      estimate
      dueDate
      updatedAt
      state { name type }
      assignee { name }
      creator { name }
      team { key }
      project { name }
      labels { nodes { name } }
    }
  }
}`;

interface LinearIssue {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  priorityLabel?: string;
  estimate?: number;
  dueDate?: string;
  updatedAt?: string;
  state?: { name?: string; type?: string };
  assignee?: { name?: string } | null;
  creator?: { name?: string } | null;
  team?: { key?: string } | null;
  project?: { name?: string } | null;
  labels?: { nodes?: { name?: string }[] };
}

/** An issue is "open" while its workflow state is neither completed nor canceled. */
function isOpen(issue: LinearIssue): boolean {
  const type = issue.state?.type;
  return type !== "completed" && type !== "canceled";
}

/** UTC end-of-day anchor for a bare `YYYY-MM-DD` dueDate (a fixed convention). */
function dueDateInstant(dueDate: string): string {
  return `${dueDate}T23:59:59Z`;
}

/** Build the `IssueFilter` for one relationship, given the resolved scope options. */
function buildFilter(
  relationship: Relationship,
  states: string[],
  teams: string[] | undefined,
  projects: string[] | undefined,
  window: Window | null,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    ...RELATIONSHIP_FILTER[relationship],
    state: { type: { in: states } },
  };
  if (teams?.length) filter.team = { key: { in: teams } };
  if (projects?.length) filter.project = { name: { in: projects } };
  // recent query: bound by the window; standing query: no updatedAt bound.
  if (window) filter.updatedAt = { gte: window.from, lt: window.to };
  return filter;
}

export class LinearSource implements Source {
  readonly key = KEY;
  readonly label = "Linear";
  readonly options = {
    relationships: {
      type: "string[]" as const,
      enum: RELATIONSHIPS,
      description:
        'Which relationships to pull. Options: "assigned", "created", "subscribed". Omit for "assigned" only.',
    },
    states: {
      type: "string[]" as const,
      enum: STATE_TYPES,
      description:
        'Which workflow state types to include. Omit for active + recently-completed ("unstarted", "started", "completed").',
    },
    teams: {
      type: "string[]" as const,
      description: 'Restrict to these team keys (e.g. "OYV"). Omit for all teams.',
    },
    projects: {
      type: "string[]" as const,
      description: "Restrict to these project names. Omit for all projects.",
    },
  };

  private readonly transport: () => LinearRequest | null;

  constructor(deps: LinearDeps = {}) {
    this.transport = deps.transport ?? defaultTransport;
  }

  // Non-interactive auth (no login()): verify the credential with a live viewer call.
  async status(): Promise<SourceStatus> {
    const request = this.transport();
    if (!request) return { state: "not-configured", detail: "set LINEAR_API_KEY" };
    try {
      const data = await request(VIEWER_QUERY);
      return { state: "ready", identity: data?.viewer?.name };
    } catch {
      return { state: "not-configured", detail: "LINEAR_API_KEY was rejected — check the key" };
    }
  }

  async read(window: Window, options: Record<string, unknown> = {}): Promise<NormalizedItem[]> {
    const request = this.transport();
    if (!request) throw new Error("Linear is not configured. Set LINEAR_API_KEY in your environment.");

    const relationships = ((options.relationships as string[] | undefined) ?? DEFAULT_RELATIONSHIPS).filter(
      (r): r is Relationship => (RELATIONSHIPS as readonly string[]).includes(r),
    );
    const states = (options.states as string[] | undefined) ?? DEFAULT_STATES;
    const teams = options.teams as string[] | undefined;
    const projects = options.projects as string[] | undefined;

    // For each (relationship × {standing, recent}) run a paginated query, tagging
    // each node with the relationship that surfaced it, then union + dedup by id.
    const byId = new Map<string, NormalizedItem>();
    for (const relationship of relationships) {
      for (const window_ of [null, window]) {
        const filter = buildFilter(relationship, states, teams, projects, window_);
        const nodes = await this.paginate(request, filter);
        for (const issue of nodes) {
          if (byId.has(issue.id)) continue; // first-seen relationship wins (deterministic order)
          byId.set(issue.id, normalizeIssue(issue, relationship));
        }
      }
    }
    return [...byId.values()];
  }

  private async paginate(request: LinearRequest, filter: Record<string, unknown>): Promise<LinearIssue[]> {
    const nodes: LinearIssue[] = [];
    let after: string | undefined;
    do {
      const data = await request(ISSUES_QUERY, { filter, after });
      const conn = data?.issues;
      if (!conn) break;
      nodes.push(...(conn.nodes ?? []));
      after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : undefined;
    } while (after);
    return nodes;
  }
}

/** Map one Linear issue through the normalizer; only domain judgment lives here. */
function normalizeIssue(issue: LinearIssue, relationship: Relationship): NormalizedItem {
  // Open + dated → UTC end-of-day anchor (future=upcoming, overdue=standing/recent);
  // everything else (undated, recently-updated, completed) → updatedAt.
  const timestamp =
    isOpen(issue) && issue.dueDate ? dueDateInstant(issue.dueDate) : issue.updatedAt ?? issue.dueDate ?? "";
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name).filter((n): n is string => Boolean(n));
  return normalize({
    kind: "issue",
    timestamp,
    id: issue.id,
    title: issue.title,
    url: issue.url,
    extras: {
      identifier: issue.identifier,
      state: issue.state ? { name: issue.state.name, type: issue.state.type } : undefined,
      assignee: issue.assignee?.name,
      creator: issue.creator?.name,
      // Domain judgment stays caller-side: "No priority" is Linear's default, not signal.
      priority: issue.priorityLabel === "No priority" ? undefined : issue.priorityLabel,
      labels,
      project: issue.project?.name,
      team: issue.team?.key,
      dueDate: issue.dueDate,
      estimate: issue.estimate,
      relationship,
      description: text(issue.description),
    },
  });
}
