// PROTOTYPE (map #117, ticket #130). Throwaway. Pulls one real Slack week with the
// shipped scopes (search:read, users:read), maps it to ChatConversation entries, and
// returns each entry with the raw search matches it was built from. Also measures what
// the missing im:read / mpim:read scopes cost (#126). Output holds real messages: the
// caller writes it outside the repo.

import { readCachedAuth, slackApi } from "../../src/sources/slack/auth.ts";
import type { ChatConversation } from "./output.ts";
import { clampPeople, digest, label, zoned, type Pair, type Raw } from "./shape.ts";

type Query = "authored" | "mentions" | "dms" | "group-dms";

interface Author {
  name?: string;
  isBot: boolean;
  deleted: boolean;
  /** Guest account (single- or multi-channel). */
  guest: boolean;
  /** From another workspace: Slack Connect. */
  external: boolean;
}

export interface SlackWeek {
  pairs: Pair<ChatConversation>[];
  raw: Raw;
  stats: Record<string, unknown>;
}

export async function slackWeek(from: string, to: string): Promise<SlackWeek | null> {
  const auth = await readCachedAuth();
  if (!auth) return null;
  const call = (method: string, params: Record<string, string> = {}) => slackApi(auth.accessToken, method, params);
  const self = await call("auth.test");
  const me = auth.userId;

  // ── Search, every page ──
  //
  // search.messages pages by cursor only when the first call passes cursor=*, and the
  // next cursor is in messages.paging, not response_metadata. src/sources/slack reads
  // response_metadata, so it stops after the first 100 matches.
  const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
  const bounds = `after:${shift(from, -1)} before:${shift(to, 1)}`;
  const queries: Record<Query, string> = {
    authored: `from:<@${me}> ${bounds}`,
    mentions: `<@${me}> ${bounds}`,
    dms: `is:dm ${bounds}`,
    "group-dms": `is:mpim ${bounds}`,
  };
  const totals: Record<string, number> = {};
  const firstPageOnly: Record<string, number> = {};
  const byId = new Map<string, Raw>();
  for (const [q, query] of Object.entries(queries) as [Query, string][]) {
    let cursor = "*";
    let pages = 0;
    while (cursor) {
      const b = await call("search.messages", { query, count: "100", cursor });
      if (!b.ok) throw new Error(`search.messages ${b.error}`);
      pages++;
      totals[q] = b.messages?.total ?? 0;
      for (const m of b.messages?.matches ?? []) {
        if (pages === 1) firstPageOnly[q] = (firstPageOnly[q] ?? 0) + 1;
        const t = Date.parse(new Date(Number.parseFloat(m.ts) * 1000).toISOString());
        if (t < Date.parse(from) || t >= Date.parse(to)) continue;
        const id = `${m.channel?.id}:${m.ts}`;
        const prev = byId.get(id);
        if (prev) prev._found.push(q);
        else byId.set(id, { _found: [q], ...m });
      }
      cursor = b.messages?.paging?.next_cursor || "";
    }
  }

  // ── Authors ──
  const authors = new Map<string, Author | null>();
  async function author(id?: string): Promise<Author | null> {
    if (!id) return null;
    if (!authors.has(id)) {
      const b = await call("users.info", { user: id });
      const u = b.ok ? b.user : null;
      authors.set(id, u && {
        name: u.profile?.real_name || u.profile?.display_name || u.real_name || u.name || undefined,
        isBot: !!u.is_bot || id === "USLACKBOT",
        deleted: !!u.deleted,
        guest: !!u.is_restricted || !!u.is_ultra_restricted,
        external: !!u.team_id && u.team_id !== self.team_id,
      });
    }
    return authors.get(id)!;
  }

  const msgs = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const m of msgs) m._author = await author(m.user);

  // ── Conversations ──
  const convs = new Map<string, Raw[]>();
  for (const m of msgs) convs.set(m.channel.id, [...(convs.get(m.channel.id) ?? []), m]);

  const USER_ID = /^[UW][A-Z0-9]{6,}$/;
  const kindOf = (c: Raw): ChatConversation["kind"] => (c.is_im ? "dm" : c.is_mpim ? "group-dm" : "channel");
  const at = (ts: string) => zoned(new Date(Number.parseFloat(ts) * 1000).toISOString());
  const mentionsMe = (m: Raw) => m._found.includes("mentions") || (m.text ?? "").includes(`<@${me}>`);

  const gaps = { dmNoCounterpart: 0, groupDms: 0, groupDmMembersNamed: 0, groupDmMembersUnknown: 0 };
  const pairs: Pair<ChatConversation>[] = [];
  for (const [channelId, list] of convs) {
    const c = list[0]!.channel;
    const kind = kindOf(c);
    const last = list[list.length - 1]!;

    // People other than the user, last author first. A DM's counterpart is the IM's
    // `name` (a user id), with no im:read needed. A group DM's members need mpim:read
    // (conversations.members); without it only the authors seen in the window are known.
    const people: string[] = [];
    const seen = new Set<string>([me]);
    const add = async (id?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const a = await author(id);
      if (a?.name) people.push(a.name);
    };
    if (kind === "dm" && USER_ID.test(c.name ?? "")) await add(c.name);
    for (const m of [...list].reverse()) await add(m.user);
    if (kind === "dm" && !people.length) gaps.dmNoCounterpart++;
    if (kind === "group-dm") {
      // mpdm-<handle>--<handle>--…-<n>: one handle per member, the user included.
      const members = (c.name ?? "").replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").length;
      gaps.groupDms++;
      gaps.groupDmMembersNamed += people.length;
      gaps.groupDmMembersUnknown += Math.max(0, members - 1 - people.length);
    }

    const fromYou = list.filter((m) => m.user === me).length;
    const mentions = list.filter(mentionsMe).length;
    const continues = list.some((m) => {
      const thread = (m.permalink as string | undefined)?.match(/thread_ts=([\d.]+)/)?.[1];
      return !!thread && Date.parse(new Date(Number.parseFloat(thread) * 1000).toISOString()) < Date.parse(from);
    });
    const lastAuthor = last._author as Author | null;
    const entry: ChatConversation = {
      id: digest(`slack\nconversation\n${channelId}`),
      type: "chat",
      kind,
      ...(kind === "channel" ? { channel: label(c.name)! } : {}),
      ...(c.is_ext_shared || c.is_pending_ext_shared ? { external: true as const } : {}),
      messages: list.length,
      ...(fromYou ? { fromYou } : {}),
      ...(mentions ? { mentionsYou: mentions } : {}),
      firstAt: at(list[0]!.ts),
      lastAt: at(last.ts),
      ...(last.user === me
        ? { lastFromYou: true as const }
        : { lastFrom: label(lastAuthor?.name ?? last.username) ?? "(unknown)" }),
      ...(clampPeople(people, "people", "morePeople") as Pick<ChatConversation, "people" | "morePeople">),
      ...(continues ? { continuesFromBefore: true as const } : {}),
      summary: "(not generated: needs the Summarizer)",
    };
    pairs.push({ entry, raw: list });
  }
  pairs.sort((a, b) => b.entry.lastAt.localeCompare(a.entry.lastAt));

  // ── What the shapes look like ──
  const count = <T>(xs: T[], f: (x: T) => string) => {
    const o: Record<string, number> = {};
    for (const x of xs) o[f(x)] = (o[f(x)] ?? 0) + 1;
    return o;
  };
  const authorList = [...authors.values()].filter(Boolean) as Author[];
  const stats = {
    searchTotals: totals,
    shippedSourceWouldRead: firstPageOnly,
    records: msgs.length,
    foundBy: count(msgs, (m) => m._found.join("+")),
    entries: count(pairs, (p) => p.entry.kind),
    external: pairs.filter((p) => p.entry.external).length,
    authors: {
      total: authorList.length,
      bots: authorList.filter((a) => a.isBot).length,
      guests: authorList.filter((a) => a.guest).length,
      deleted: authorList.filter((a) => a.deleted).length,
      otherWorkspace: authorList.filter((a) => a.external).length,
      unresolved: [...authors.values()].filter((a) => !a).length,
    },
    messages: {
      byBots: msgs.filter((m) => m._author?.isBot).length,
      noUser: msgs.filter((m) => !m.user).length,
      emptyText: msgs.filter((m) => !(m.text ?? "").trim()).length,
      withFiles: msgs.filter((m) => m.files?.length).length,
      withAttachments: msgs.filter((m) => m.attachments?.length).length,
      inThread: msgs.filter((m) => /thread_ts=/.test(m.permalink ?? "")).length,
      typeSubtype: count(msgs, (m) => `${m.type}/${m.subtype ?? "-"}`),
    },
    scopeGaps: gaps,
    oneMessageEntries: pairs.filter((p) => p.entry.messages === 1).length,
  };
  return { pairs, raw: { team: self.team_id, matches: msgs }, stats };
}
