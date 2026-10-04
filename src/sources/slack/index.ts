// The Slack Source (ADR-0014, ADR-0019): read-only messages the authenticated user
// wrote, was mentioned in, or received in a DM, via `search.messages` under a per-user
// `xoxp-` token, emitted as typed ChatMessage records, one per message (§1).
//
// A theme (what a conversation was about) is a summarization act, forbidden to a
// tool-less source (§3). The source emits per-message records with the trusted facts
// code can know (who wrote it, whether it is the user's, which conversation it belongs
// to) and hands every backend string to the record builder, which brands it Untrusted.
// Nothing is unwrapped here (the read sites are the Digester and label(); ADR-0022).
//
// Testability seam: every request flows through one injected `SlackRequest`
// (method, params) → parsed body, exactly the shape the real token-bearing caller
// has; auth presence rides `appConfig` + `cachedAuth`. Search paging, the query
// construction, the window-precise ts filter and the member lookup all stay inside the
// module, tested through `read()`.

import type { ChatMessage, Conversation, Window } from "../../domain.ts";
import { chatMessageRecord, type ChatMessageSpec, type PersonSpec } from "../normalize.ts";
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
const PAGE_SIZE = 100; // search.messages max per page

/** The three queryable relationships; each is one `search.messages` query family (§1). */
type Relationship = "authored" | "mentions" | "dms";
const RELATIONSHIPS: readonly Relationship[] = ["authored", "mentions", "dms"];
const DEFAULT_RELATIONSHIPS: Relationship[] = ["authored", "mentions", "dms"];

/** Slack's declared option schema — exposed on the static descriptor (registry.ts). */
export const SLACK_OPTIONS: OptionSchema = {
  relationships: {
    type: "string[]",
    enum: RELATIONSHIPS,
    description:
      'Which relationships to pull. Options: "authored", "mentions", "dms". Omit for all three.',
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
  login?: () => Promise<string>;
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
  is_ext_shared?: boolean;
}
interface SlackMatch {
  channel?: SlackChannel;
  user?: string;
  username?: string;
  ts?: string;
  text?: string;
  permalink?: string;
}

/** The conversation kind, from the is_* flags. Private channels are channels. */
function kindOf(c: SlackChannel | undefined): Conversation["kind"] {
  if (c?.is_im) return "dm";
  if (c?.is_mpim) return "group_dm";
  return "channel";
}

/**
 * A Slack user id (`U…`, or `W…` on enterprise grid). `search.messages` documents that
 * for IM results `channel.name` carries the counterpart's user id rather than a name.
 * That prose is legacy and contradicts the response schema on the same page, so a value
 * not shaped like a user id is treated as unreadable.
 */
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

/**
 * The handles in a group DM's name, `mpdm-<handle>--<handle>--…-<n>`, one per member
 * with the user among them. Undefined when the name does not have that shape, since the
 * format is undocumented.
 */
function mpdmHandles(name: string | undefined): string[] | undefined {
  const m = /^mpdm-(.+)-\d+$/.exec(name ?? "");
  if (!m) return undefined;
  const handles = m[1]!.split("--");
  return handles.length >= 2 && handles.every((h) => h !== "") ? handles : undefined;
}

/** Slack's `ts` ("1749047412.123456", epoch seconds) → a strict ISO-8601 instant (ADR-0014 §4). */
export function tsToInstant(ts: string): string {
  return new Date(Number.parseFloat(ts) * 1000).toISOString();
}

/** The dedup key: channel id + ts (ADR-0014 §1). */
function messageId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

/** One deduplicated search match inside the window. */
interface Hit {
  match: SlackMatch;
  channelId: string;
  ts: string;
  at: string;
  /** The `mentions` query found it. */
  mentioned: boolean;
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

/**
 * The next page cursor from a response's cursor field, or "" at the end. A cursor that
 * does not move would page forever, so it also counts as the end.
 */
function nextCursor(next: unknown, current: string): string {
  return typeof next === "string" && next !== current ? next : "";
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
  private readonly loginFn: () => Promise<string>;
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

  login(): Promise<string> {
    return this.loginFn();
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

  async read(window: Window): Promise<ChatMessage[]> {
    if (this.appConfig() === null) {
      throw new Error("Slack is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in your environment.");
    }
    const auth = await this.cachedAuth();
    if (!auth) throw new Error("Slack is not authenticated. Run: rundown login");
    const request = this.transport(auth.accessToken);

    const relationships = ((this.config.relationships as string[] | undefined) ?? DEFAULT_RELATIONSHIPS).filter(
      (r): r is Relationship => (RELATIONSHIPS as readonly string[]).includes(r),
    );

    // Union across relationships, dedup by channel id + ts.
    const hits = new Map<string, Hit>();
    for (const relationship of relationships) {
      for (const match of await this.searchAll(request, buildQuery(relationship, auth.userId, window))) {
        const channelId = match.channel?.id;
        const ts = match.ts;
        if (!channelId || !ts) continue;
        const at = tsToInstant(ts);
        if (!inWindow(at, window)) continue; // precise window cut past the coarse day bounds
        const id = messageId(channelId, ts);
        const hit = hits.get(id) ?? { match, channelId, ts, at, mentioned: false };
        if (relationship === "mentions") hit.mentioned = true;
        hits.set(id, hit);
      }
    }

    const people = new People(request, auth.userId);
    // The authors seen per conversation, first-seen order: the members fallback.
    const authorsSeen = new Map<string, string[]>();
    for (const { channelId, match } of hits.values()) {
      const seen = authorsSeen.get(channelId) ?? [];
      if (match.user && !seen.includes(match.user)) seen.push(match.user);
      authorsSeen.set(channelId, seen);
    }

    const records: ChatMessage[] = [];
    for (const hit of hits.values()) {
      records.push(await toRecord(hit, people, authorsSeen.get(hit.channelId) ?? []));
    }
    return records;
  }

  /**
   * Read every page of one search. `search.messages` pages by cursor only when the
   * first call passes `cursor=*`, and returns the next cursor in
   * `messages.paging.next_cursor`, empty on the last page (#132).
   */
  private async searchAll(request: SlackRequest, query: string): Promise<SlackMatch[]> {
    const out: SlackMatch[] = [];
    let cursor = "*";
    do {
      const body = await request("search.messages", { query, count: String(PAGE_SIZE), cursor });
      if (!body?.ok) throw statusOnlyError("Slack", body); // scrubbed: no backend body bytes
      out.push(...(body.messages?.matches ?? []));
      cursor = nextCursor(body.messages?.paging?.next_cursor, cursor);
    } while (cursor !== "");
    return out;
  }
}

/** A Slack user's display name: real name, then display name, then handle. */
function displayName(u: any): string | undefined {
  return u?.profile?.real_name || u?.profile?.display_name || u?.real_name || u?.name || undefined;
}

/**
 * The people this read meets, as the `users:read` scope sees them. A user id resolves to
 * a display name via `users.info`, cached per id, misses included, so a busy channel
 * resolves each author once. A group-DM handle resolves through the `users.list`
 * directory, fetched once and only when a group DM is read. `isMe` compares a user id
 * with the `auth.test` one.
 */
class People {
  private readonly names = new Map<string, string | undefined>();
  private directory?: Promise<Map<string, { id: string; name?: string }>>;
  constructor(
    private readonly request: SlackRequest,
    readonly selfId: string,
  ) {}

  /** The display name for a user id, or undefined when it cannot be resolved. */
  async name(userId: string): Promise<string | undefined> {
    if (!this.names.has(userId)) this.names.set(userId, await this.fetchName(userId));
    return this.names.get(userId);
  }

  /** A person by user id, named when the id resolves. */
  async byId(userId: string): Promise<PersonSpec> {
    return { handle: userId, name: await this.name(userId), isMe: userId === this.selfId };
  }

  /**
   * A message's author: the user id resolved to a name, else the search-supplied
   * `username`. A raw id is never used as a name, so an unresolved author has none.
   */
  async author(userId: string | undefined, username: string | undefined): Promise<PersonSpec> {
    if (!userId) return { handle: "", name: username, isMe: false };
    return { handle: userId, name: (await this.name(userId)) ?? username, isMe: userId === this.selfId };
  }

  /** Group-DM members by handle, or undefined when any handle is not in the directory. */
  async byHandles(handles: string[]): Promise<PersonSpec[] | undefined> {
    this.directory ??= this.fetchDirectory();
    const directory = await this.directory;
    const members: PersonSpec[] = [];
    for (const handle of handles) {
      const user = directory.get(handle);
      if (!user) return undefined;
      members.push({ handle: user.id, name: user.name, isMe: user.id === this.selfId });
    }
    return members;
  }

  private async fetchName(userId: string): Promise<string | undefined> {
    try {
      const body = await this.request("users.info", { user: userId });
      return body?.ok ? displayName(body.user) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Every workspace user by handle (`users.list`, all pages). A failed page ends the
   * directory where it is: an unknown handle sends its group DM to the authors-seen
   * fallback rather than failing the read.
   */
  private async fetchDirectory(): Promise<Map<string, { id: string; name?: string }>> {
    const directory = new Map<string, { id: string; name?: string }>();
    let cursor = "";
    try {
      do {
        const params: Record<string, string> = { limit: "200" };
        if (cursor) params.cursor = cursor;
        const body = await this.request("users.list", params);
        if (!body?.ok) break;
        for (const u of body.members ?? []) {
          if (typeof u?.id === "string" && typeof u?.name === "string") {
            directory.set(u.name, { id: u.id, name: displayName(u) });
            if (!this.names.has(u.id)) this.names.set(u.id, displayName(u));
          }
        }
        cursor = nextCursor(body.response_metadata?.next_cursor, cursor);
      } while (cursor);
    } catch {
      // Keep what was read; see above.
    }
    return directory;
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
  people: People,
): Promise<string | undefined> {
  if (!raw) return raw;
  const names = new Map<string, string | undefined>();
  for (const m of raw.matchAll(USER_TOKEN)) {
    if (!m[2] && !names.has(m[1]!)) names.set(m[1]!, await people.name(m[1]!));
  }
  return raw
    .replace(SUBTEAM_TOKEN, (_all, label?: string) => mention(label || "group"))
    .replace(SPECIAL_TOKEN, (_all, kind: string) => `@${kind}`)
    .replace(USER_TOKEN, (_all, id: string, label?: string) => mention(label || names.get(id) || id))
    .replace(CHANNEL_TOKEN, (_all, id: string, label?: string) => `#${label || id}`)
    .replace(LINK_TOKEN, (_all, url: string, label?: string) => label || url);
}

/** Whether the text carries a mention token for the user's id. */
function textMentions(raw: string | undefined, selfId: string): boolean {
  for (const m of (raw ?? "").matchAll(USER_TOKEN)) if (m[1] === selfId) return true;
  return false;
}

/**
 * A conversation's members: a DM's counterpart from the IM name, a group DM's members
 * from its `mpdm-` name. When the name cannot be read, the authors seen in the window,
 * without the user for a DM.
 * Channels have none: their membership is not the conversation's participants.
 */
async function membersOf(
  channel: SlackChannel | undefined,
  kind: Conversation["kind"],
  people: People,
  authorsSeen: string[],
): Promise<PersonSpec[] | undefined> {
  if (kind === "channel") return undefined;
  const name = channel?.name;
  if (kind === "dm" && name && USER_ID.test(name)) return [await people.byId(name)];
  if (kind === "group_dm") {
    const handles = mpdmHandles(name);
    const members = handles && (await people.byHandles(handles));
    if (members) return members;
  }
  // A DM's members are its counterpart, so the user is never one of them.
  const seen = kind === "dm" ? authorsSeen.filter((id) => id !== people.selfId) : authorsSeen;
  return Promise.all(seen.map((id) => people.byId(id)));
}

/** Map one search hit to a record; the builder brands and validates it. */
async function toRecord(hit: Hit, people: People, authorsSeen: string[]): Promise<ChatMessage> {
  const { match: m, channelId, ts, at } = hit;
  const kind = kindOf(m.channel);
  const spec: ChatMessageSpec = {
    channelId,
    ts,
    at,
    conversation: {
      kind,
      isExternal: m.channel?.is_ext_shared === true,
      name: m.channel?.name,
      members: await membersOf(m.channel, kind, people, authorsSeen),
    },
    author: await people.author(m.user, m.username),
    mentionsMe: hit.mentioned || textMentions(m.text, people.selfId),
    text: await readableText(m.text, people),
  };
  return chatMessageRecord(spec);
}
