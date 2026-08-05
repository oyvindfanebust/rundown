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
import { statusOnlyError, statusOf } from "../errors.ts";
import { noDebug, type DebugSink } from "../../debug.ts";
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
  /** Structural diagnostics sink (ADR-0015); defaults to the no-op. */
  debug?: DebugSink;
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

/**
 * A Slack user id (`U…`, or `W…` on enterprise grid). Used to recognize a user id
 * sitting in a field that normally holds a name: `search.messages` documents that for
 * IM results `channel.name` carries the target user's id rather than a channel name.
 * That prose is legacy and contradicts the response schema on the same page, so this
 * is written to work either way — a value shaped like a user id is resolved to a name,
 * anything else leaves the counterpart unknown.
 */
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

/**
 * The other party in a DM, resolved to a display name, or undefined when it cannot be
 * determined. Only 1:1 DMs are resolvable this way: a group DM's `channel.name` is an
 * `mpdm-…` composite whose format the search docs never specify, so its members stay
 * unknown rather than guessed at.
 *
 * This exists because ADR-0014 §4 conflated two different people. It defines `author`
 * as "for `authored` this is the user; for `dms`/`mentions` the counterpart" — but the
 * author of a message is simply whoever wrote it, and this source is anchored on the
 * user's own participation, so most DM messages were written BY the user. Attributing
 * those to their author names the user, not the person they were talking to.
 */
async function dmCounterpart(
  channel: SlackChannel | undefined,
  type: string,
  authors: AuthorCache,
): Promise<string | undefined> {
  if (type !== "dm") return undefined;
  const name = channel?.name;
  return name && USER_ID.test(name) ? await authors.name(name) : undefined;
}

/**
 * Slack's own wording for the uniform attribution slot (#54). A message body is the
 * case that motivated the field: "give me a shout when you're free" says nothing about
 * who or where on its own.
 *
 * `where` is a channel's `#name`, or a DM's counterpart. A DM whose counterpart could
 * not be resolved gets no label rather than a misleading one — the author is NOT a
 * fallback, since on the user's own outgoing DM the author is the user themselves,
 * which is exactly the "DM with <the user>" bug ADR-0014 §4 was amended for.
 *
 * `who` is most-salient-first: on a DM that is the counterpart (the person the
 * conversation is with), not the author, who is usually the user. On a channel it is
 * the author. The normalizer dedupes, so an incoming DM whose author and counterpart
 * are the same person yields one name.
 */
function slackAttribution(args: {
  channelName: string | undefined;
  type: string;
  counterpart: string | undefined;
  author: string | undefined;
  fromMe: boolean;
  relationship: Relationship;
}): { where?: string; who: Array<string | undefined>; relationship: string } {
  const { channelName, type, counterpart, author, fromMe, relationship } = args;
  const where =
    type === "dm"
      ? counterpart && `DM with ${counterpart}`
      : type === "group_dm"
        ? "Group DM"
        : channelName && `#${channelName}`;
  return {
    ...(where ? { where } : {}),
    who: type === "dm" ? [counterpart, fromMe ? undefined : author] : [author],
    relationship,
  };
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
  private readonly debug: DebugSink;

  constructor(options: Record<string, unknown> = {}, deps: SlackDeps = {}) {
    this.config = options;
    this.appConfig = deps.appConfig ?? slackAppConfig;
    this.cachedAuth = deps.cachedAuth ?? readCachedAuth;
    // The default transport threads the sink into `slackApi`, which owns the fetch and
    // so is the only place a real HTTP status exists (ADR-0015 §6).
    this.debug = deps.debug ?? noDebug;
    this.transport = deps.transport ?? ((token) => (method, params) => slackApi(token, method, params, this.debug));
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
      if (res?.ok) {
        this.debug({ kind: "auth-verify", source: KEY, outcome: "ready" });
        return { state: "ready", identity: typeof res.user === "string" ? res.user : undefined };
      }
      // A rejected token is a meaningful state, not a leak — no `res.error` surfaced.
      // The event says so too: an application-level rejection arrives over HTTP 200,
      // so there is no status to carry and Slack's own `error` code is backend content.
      this.debug({ kind: "auth-verify", source: KEY, outcome: "rejected" });
      return { state: "not-authenticated" };
    } catch (e) {
      // A scrubbed transport error (network/HTTP) can't confirm readiness. Fold it
      // onto the existing union (no shared-schema change, ADR-0014 §8) as a
      // not-configured with a status-only detail — the raw error never surfaced.
      // The HTTP status the transport error already carries is read through the shared
      // `statusOf` scrub, the same one the thrown-error channel uses (ADR-0015 §5).
      this.debug({ kind: "auth-verify", source: KEY, outcome: "rejected", httpStatus: statusOf(e) });
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
        byId.set(id, await normalizeMatch(m, channelId, instant, relationship, authors, auth.userId));
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
          byId.set(
            id,
            await normalizeReply(reply, channelId, channel, threadTs, instant, relationship, authors, auth.userId),
          );
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
 * caching each id — including the misses — so a busy channel resolves each author
 * at most once.
 */
class AuthorCache {
  private readonly cache = new Map<string, string | undefined>();
  constructor(private readonly request: SlackRequest) {}

  /** The display name for a user id, or undefined when it cannot be resolved. */
  async name(userId: string): Promise<string | undefined> {
    if (!this.cache.has(userId)) this.cache.set(userId, await this.fetchName(userId));
    return this.cache.get(userId);
  }

  /**
   * The `author` extra: a display name (ADR-0014 §4), falling back to the
   * search-supplied `username`. When neither yields a name the key is left
   * undefined so compaction drops it — a raw Slack id is not a display name, and
   * emitting one put an unresolved id into a Brief summary as if it were a person.
   */
  async resolve(userId: string | undefined, fallback: string | undefined): Promise<string | undefined> {
    if (!userId) return fallback;
    return (await this.name(userId)) ?? fallback;
  }

  private async fetchName(userId: string): Promise<string | undefined> {
    try {
      const body = await this.request("users.info", { user: userId });
      if (!body?.ok) return undefined;
      const u = body.user ?? {};
      return u.profile?.real_name || u.profile?.display_name || u.real_name || u.name || undefined;
    } catch {
      return undefined;
    }
  }
}

// ── Slack reference tokens in message text ──
//
// Slack encodes references inside message text as angle-bracket tokens: `<@U123>`
// for a user, `<#C123|general>` for a channel, `<!here>`, `<!subteam^S1|@leads>`,
// and `<https://url|label>` for a link. The message body IS the item's content line
// (ADR-0014 §4), so left raw a mention reaches the summarizer as an id where a name
// belongs. Rewriting happens before the body is handed to the normalizer, so the
// substituted names are branded Untrusted with the rest of the title — this is a
// transform over raw backend bytes, not an unwrap.
const USER_TOKEN = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;
const CHANNEL_TOKEN = /<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g;
const SUBTEAM_TOKEN = /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g;
const SPECIAL_TOKEN = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const LINK_TOKEN = /<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g;

/** `@name`, tolerating a label that already carries the sigil (subteam labels do). */
function mention(label: string): string {
  return label.startsWith("@") ? label : `@${label}`;
}

/**
 * Rewrite Slack's reference tokens to readable text. Bare user mentions cost a
 * `users.info` lookup (cached, and only for the ids actually present); the
 * pipe-labelled forms carry their own label and need none. An unresolvable id keeps
 * the id but loses the brackets, which is what Slack itself renders.
 */
async function readableText(
  raw: string | undefined,
  authors: AuthorCache,
): Promise<string | undefined> {
  if (!raw) return raw;
  const names = new Map<string, string | undefined>();
  for (const m of raw.matchAll(USER_TOKEN)) {
    if (!m[2] && !names.has(m[1]!)) names.set(m[1]!, await authors.name(m[1]!));
  }
  return raw
    .replace(SUBTEAM_TOKEN, (_all, label?: string) => mention(label || "group"))
    .replace(SPECIAL_TOKEN, (_all, kind: string) => `@${kind}`)
    .replace(USER_TOKEN, (_all, id: string, label?: string) => mention(label || names.get(id) || id))
    .replace(CHANNEL_TOKEN, (_all, id: string, label?: string) => `#${label || id}`)
    .replace(LINK_TOKEN, (_all, url: string, label?: string) => label || url);
}

/** Map one search hit through the normalizer; only domain judgment lives here. */
async function normalizeMatch(
  m: SlackMatch,
  channelId: string,
  instant: string,
  relationship: Relationship,
  authors: AuthorCache,
  selfId: string,
): Promise<NormalizedItem> {
  const type = channelType(m.channel);
  const counterpart = await dmCounterpart(m.channel, type, authors);
  const author = await authors.resolve(m.user, m.username);
  const fromMe = m.user === selfId;
  return normalize({
    kind: "message",
    timestamp: instant,
    id: messageId(channelId, m.ts!),
    title: await readableText(m.text, authors),
    url: m.permalink,
    attribution: slackAttribution({
      channelName: m.channel?.name,
      type,
      counterpart,
      author,
      fromMe,
      relationship,
    }),
    extras: {
      // A DM's channel has no human name, so the counterpart is its label. Omitted
      // when unresolvable — better an absent label than the author standing in for it.
      channel: { id: channelId, name: m.channel?.name, type },
      counterpart,
      threadTs: m.thread_ts,
      author,
      // Whether the user wrote it. The source is anchored on the user's own
      // participation, so most messages are theirs; without this the summarizer reads
      // the author of the user's own DM message as the person they were talking to.
      fromMe,
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
  selfId: string,
): Promise<NormalizedItem> {
  const type = channelType(channel);
  const counterpart = await dmCounterpart(channel, type, authors);
  const author = await authors.resolve(reply.user, undefined);
  const fromMe = reply.user === selfId;
  return normalize({
    kind: "message",
    timestamp: instant,
    id: messageId(channelId, reply.ts!),
    title: await readableText(reply.text, authors),
    // conversations.replies carries no permalink; a reconstructed reply has no url.
    attribution: slackAttribution({
      channelName: channel.name,
      type,
      counterpart,
      author,
      fromMe,
      relationship,
    }),
    extras: {
      channel: { id: channelId, name: channel.name, type },
      counterpart,
      threadTs,
      author,
      fromMe,
      relationship,
    },
  });
}
