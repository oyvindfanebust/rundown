// The Slack Source (ADR-0014): read-only messages the authenticated user
// participated in, via `search.messages` under a per-user `xoxp-` token, emitting
// kind:"message" NormalizedItems — one message = one item (§1). Slack is
// retrospective, so items land in `recent`/`standing`, never `upcoming` (§2).
//
// A theme (what a thread or DM was about) is a summarization act, forbidden to a
// tool-less source (§3); the source emits dumb per-message items plus the grouping
// keys (`channel`, `threadTs`, `author`, `relationship`) the Summarizer clusters
// on. Message bodies are the archetypal injection vector, so the body rides the
// item title through the normalizer's `text()` marker as ordinary Untrusted
// content — every backend field is branded at this boundary, and nothing is
// unwrapped here (the sole unwrap site is plan.ts; CLAUDE.md).
//
// Testability seam: every request flows through one injected `SlackRequest`
// (method, params) → parsed body, exactly the shape the real token-bearing caller
// has; auth presence rides `appConfig` + `cachedAuth`. Pagination on
// `response_metadata.next_cursor`, the search-query construction, the
// window-precise ts filter, and the thread reconstruction all stay inside the
// module, tested through `read()`.

import type { NormalizedItem, Window } from "../../domain.ts";
import { normalizer } from "../normalize.ts";
import { statusOnlyError } from "../errors.ts";
import type { OptionSchema, Source, SourceStatus } from "../source.ts";
import {
  slackAppConfig,
  readCachedAuth,
  slackApi,
  login as slackLogin,
  type SlackAppConfig,
  type CachedAuth,
} from "./auth.ts";

const KEY = "slack";
const PAGE_SIZE = 100; // search.messages / conversations.replies max per page
const MAX_THREAD_REPLIES = 200; // runaway-thread cap (ADR-0014 §5): a huge thread must not flood the brief.

// The source's one normalizer — the only way this module makes a NormalizedItem.
const normalize = normalizer(KEY, { untitled: "(no message text)" });

/** The three queryable relationships; each is one `search.messages` query family (§1). */
type Relationship = "authored" | "mentions" | "dms";
const RELATIONSHIPS: readonly Relationship[] = ["authored", "mentions", "dms"];
const DEFAULT_RELATIONSHIPS: Relationship[] = ["authored", "mentions"];

/** Slack's declared option schema — exposed on the static descriptor (registry.ts). */
export const SLACK_OPTIONS: OptionSchema = {
  relationships: {
    type: "string[]",
    enum: RELATIONSHIPS,
    description:
      'Which relationships to pull. Options: "authored", "mentions", "dms". Omit for "authored" + "mentions" (dms opt-in).',
  },
  threads: {
    type: "boolean",
    description:
      "Reconstruct full threads around matched messages (needs a re-login for *:history scopes). Omit for off.",
  },
};

/** The thin transport this source needs: one Slack Web API call returning the parsed body. */
export type SlackRequest = (method: string, params?: Record<string, string>) => Promise<any>;

/** Injectable dependencies — the seam that makes the read + status paths unit-testable. */
export interface SlackDeps {
  /** App credentials probe (default: the real env read). */
  appConfig?: () => SlackAppConfig | null;
  /** Cached-token probe (default: the real token-store read). */
  cachedAuth?: () => Promise<CachedAuth | null>;
  /** Transport factory bound to a token (default: the real `slackApi` caller). */
  transport?: (token: string) => SlackRequest;
  /** Interactive login (default: the real OAuth flow). */
  login?: (threads: boolean) => Promise<string>;
}

// ── Slack row shapes (the external HTTP contract, mirrored for mapping + fixtures) ──

interface SlackChannel {
  id?: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}
interface SlackMatch {
  channel?: SlackChannel;
  user?: string;
  username?: string;
  ts?: string;
  text?: string;
  permalink?: string;
  thread_ts?: string;
}
interface SlackReply {
  user?: string;
  ts?: string;
  text?: string;
  thread_ts?: string;
}

/** Channel type ∈ public/private/dm/group_dm, derived from the is_* flags (ADR-0014 §4). */
function channelType(c: SlackChannel | undefined): string {
  if (c?.is_im) return "dm";
  if (c?.is_mpim) return "group_dm";
  if (c?.is_private) return "private";
  return "public";
}

/** Slack's `ts` ("1749047412.123456", epoch seconds) → a strict ISO-8601 instant (ADR-0014 §4). */
export function tsToInstant(ts: string): string {
  return new Date(Number.parseFloat(ts) * 1000).toISOString();
}

/** The stable message identity and dedup key: channel id + ts (ADR-0014 §1, §4). */
function messageId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

/**
 * The `search.messages` query for one relationship, scoped to the window with
 * day-granular `after:`/`before:` bounds (a coarse pre-filter; the exact instant
 * cut is applied client-side in {@link inWindow}). `authored`/`mentions` key on
 * the authed user id; `dms` narrows to direct messages.
 */
function buildQuery(relationship: Relationship, userId: string, window: Window): string {
  const parts: string[] = [`after:${dayBefore(window.from)}`, `before:${dayAfter(window.to)}`];
  switch (relationship) {
    case "authored":
      parts.unshift(`from:<@${userId}>`);
      break;
    case "mentions":
      parts.unshift(`<@${userId}>`);
      break;
    case "dms":
      parts.unshift("is:dm");
      break;
  }
  return parts.join(" ");
}

/** UTC calendar day one day before/after an instant, as `YYYY-MM-DD` — the padded search bounds. */
function dayBefore(instant: string): string {
  return shiftDay(instant, -1);
}
function dayAfter(instant: string): string {
  return shiftDay(instant, 1);
}
function shiftDay(instant: string, days: number): string {
  const d = new Date(Date.parse(instant) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Whether a message instant lies in the window `[from, to)` — the precise cut the coarse bounds can't make. */
function inWindow(instant: string, window: Window): boolean {
  const t = Date.parse(instant);
  return t >= Date.parse(window.from) && t < Date.parse(window.to);
}

export class SlackSource implements Source {
  readonly key = KEY;
  readonly label = "Slack";

  private readonly config: Record<string, unknown>;
  private readonly appConfig: () => SlackAppConfig | null;
  private readonly cachedAuth: () => Promise<CachedAuth | null>;
  private readonly transport: (token: string) => SlackRequest;
  private readonly loginFn: (threads: boolean) => Promise<string>;

  constructor(options: Record<string, unknown> = {}, deps: SlackDeps = {}) {
    this.config = options;
    this.appConfig = deps.appConfig ?? slackAppConfig;
    this.cachedAuth = deps.cachedAuth ?? readCachedAuth;
    this.transport = deps.transport ?? ((token) => (method, params) => slackApi(token, method, params));
    this.loginFn = deps.login ?? slackLogin;
  }

  private threadsEnabled(): boolean {
    return this.config.threads === true;
  }

  login(): Promise<string> {
    // The requested user_scope depends on the `threads` option (ADR-0014 §5).
    return this.loginFn(this.threadsEnabled());
  }

  // Interactive auth: a live auth.test reports the four states (ADR-0014 §6),
  // mapped onto the three-variant SourceStatus (no shared-schema change, §8).
  //
  // One deliberate reconciliation of the §6 wording: §6's parenthetical lumps "no
  // cached token" into not-configured, but this returns not-authenticated for a
  // configured-but-never-logged-in user — which is what the SourceStatus contract
  // itself defines not-authenticated as ("configured, interactive, not yet logged
  // in", source.ts) and what the Graph reference source does. It also points the
  // user at the right remedy (`rundown login`, not-authenticated's CTA) rather than
  // "rundown status". not-configured stays for the one thing the user fixes with an
  // env var: missing app credentials.
  async status(): Promise<SourceStatus> {
    if (this.appConfig() === null) {
      return { state: "not-configured", detail: "set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET" };
    }
    const auth = await this.cachedAuth();
    if (!auth) return { state: "not-authenticated" }; // configured, interactive, not yet logged in
    try {
      const res = await this.transport(auth.accessToken)("auth.test");
      if (res?.ok) return { state: "ready", identity: typeof res.user === "string" ? res.user : undefined };
      // A rejected token is a meaningful state, not a leak — no `res.error` surfaced.
      return { state: "not-authenticated" };
    } catch {
      // A scrubbed transport error (network/HTTP) can't confirm readiness. Fold it
      // onto the existing union (no shared-schema change, ADR-0014 §8) as a
      // not-configured with a status-only detail — the raw error never surfaced.
      return { state: "not-configured", detail: "Slack could not be reached — check your connection" };
    }
  }

  async read(window: Window): Promise<NormalizedItem[]> {
    if (this.appConfig() === null) {
      throw new Error("Slack is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in your environment.");
    }
    const auth = await this.cachedAuth();
    if (!auth) throw new Error("Slack is not authenticated. Run: rundown login");
    const request = this.transport(auth.accessToken);

    const relationships = ((this.config.relationships as string[] | undefined) ?? DEFAULT_RELATIONSHIPS).filter(
      (r): r is Relationship => (RELATIONSHIPS as readonly string[]).includes(r),
    );

    // Union across relationships, dedup by message identity; first-seen relationship wins.
    const byId = new Map<string, NormalizedItem>();
    const authors = new AuthorCache(request);
    // Distinct (channel, threadTs) among the hits, for the opt-in thread pass (§5).
    const threads = new Map<string, { channelId: string; channel: SlackChannel; threadTs: string; relationship: Relationship }>();

    for (const relationship of relationships) {
      const matches = await this.searchAll(request, buildQuery(relationship, auth.userId, window));
      for (const m of matches) {
        const channelId = m.channel?.id;
        const ts = m.ts;
        if (!channelId || !ts) continue;
        const instant = tsToInstant(ts);
        if (!inWindow(instant, window)) continue; // precise window cut past the coarse day bounds
        const id = messageId(channelId, ts);
        if (byId.has(id)) continue; // first-seen relationship wins
        byId.set(id, await normalizeMatch(m, channelId, instant, relationship, authors));
        if (this.threadsEnabled() && m.thread_ts) {
          const key = messageId(channelId, m.thread_ts);
          if (!threads.has(key)) {
            threads.set(key, { channelId, channel: m.channel ?? {}, threadTs: m.thread_ts, relationship });
          }
        }
      }
    }

    if (this.threadsEnabled()) {
      // Reconstruct each matched thread in full (§5). Replies are not window-filtered
      // — a thread is a unit, so its whole conversation is emitted for the summarizer
      // to cluster; the Aggregator still buckets each reply by its own timestamp.
      for (const { channelId, channel, threadTs, relationship } of threads.values()) {
        const replies = await this.repliesAll(request, channelId, threadTs);
        for (const reply of replies) {
          const ts = reply.ts;
          if (!ts) continue;
          const id = messageId(channelId, ts);
          if (byId.has(id)) continue; // deduped against what search already returned
          const instant = tsToInstant(ts);
          byId.set(id, await normalizeReply(reply, channelId, channel, threadTs, instant, relationship, authors));
        }
      }
    }

    return [...byId.values()];
  }

  /** Paginate `search.messages` on `response_metadata.next_cursor`. */
  private async searchAll(request: SlackRequest, query: string): Promise<SlackMatch[]> {
    const out: SlackMatch[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = { query, count: String(PAGE_SIZE) };
      if (cursor) params.cursor = cursor;
      const body = await request("search.messages", params);
      if (!body?.ok) throw statusOnlyError("Slack", body); // scrubbed: no backend body bytes
      out.push(...(body.messages?.matches ?? []));
      cursor = body.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** Paginate `conversations.replies`, bounded by {@link MAX_THREAD_REPLIES} (§5 runaway cap). */
  private async repliesAll(request: SlackRequest, channelId: string, threadTs: string): Promise<SlackReply[]> {
    const out: SlackReply[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = { channel: channelId, ts: threadTs, limit: String(PAGE_SIZE) };
      if (cursor) params.cursor = cursor;
      const body = await request("conversations.replies", params);
      if (!body?.ok) throw statusOnlyError("Slack", body); // scrubbed
      out.push(...(body.messages ?? []));
      cursor = body.has_more ? body.response_metadata?.next_cursor || undefined : undefined;
    } while (cursor && out.length < MAX_THREAD_REPLIES);
    return out.slice(0, MAX_THREAD_REPLIES);
  }
}

/**
 * Resolves a user id to a display name via `users.info` (the `users:read` scope),
 * caching each id so a busy channel doesn't re-resolve the same author. Falls back
 * to the search-supplied `username`, then the raw id, when resolution fails.
 */
class AuthorCache {
  private readonly cache = new Map<string, string | undefined>();
  constructor(private readonly request: SlackRequest) {}

  async resolve(userId: string | undefined, fallback: string | undefined): Promise<string | undefined> {
    if (!userId) return fallback;
    if (!this.cache.has(userId)) {
      this.cache.set(userId, await this.fetchName(userId));
    }
    return this.cache.get(userId) ?? fallback ?? userId;
  }

  private async fetchName(userId: string): Promise<string | undefined> {
    try {
      const body = await this.request("users.info", { user: userId });
      if (!body?.ok) return undefined;
      const u = body.user ?? {};
      return u.profile?.real_name || u.real_name || u.name || undefined;
    } catch {
      return undefined;
    }
  }
}

/** Map one search hit through the normalizer; only domain judgment lives here. */
async function normalizeMatch(
  m: SlackMatch,
  channelId: string,
  instant: string,
  relationship: Relationship,
  authors: AuthorCache,
): Promise<NormalizedItem> {
  return normalize({
    kind: "message",
    timestamp: instant,
    id: messageId(channelId, m.ts!),
    title: m.text,
    url: m.permalink,
    extras: {
      channel: { id: channelId, name: m.channel?.name, type: channelType(m.channel) },
      threadTs: m.thread_ts,
      author: await authors.resolve(m.user, m.username),
      relationship,
    },
  });
}

/** Map one reconstructed thread reply — same shape as a match, minus search-only fields (§5). */
async function normalizeReply(
  reply: SlackReply,
  channelId: string,
  channel: SlackChannel,
  threadTs: string,
  instant: string,
  relationship: Relationship,
  authors: AuthorCache,
): Promise<NormalizedItem> {
  return normalize({
    kind: "message",
    timestamp: instant,
    id: messageId(channelId, reply.ts!),
    title: reply.text,
    // conversations.replies carries no permalink; a reconstructed reply has no url.
    extras: {
      channel: { id: channelId, name: channel.name, type: channelType(channel) },
      threadTs,
      author: await authors.resolve(reply.user, undefined),
      relationship,
    },
  });
}
