import { test, expect, describe, afterEach } from "bun:test";
import { unwrap } from "../src/trust.ts";
import type { DebugEvent } from "../src/debug.ts";
import type { ChatMessage } from "../src/domain.ts";
import type { Source } from "../src/sources/source.ts";
import { SlackSource, SLACK_OPTIONS, tsToInstant, type SlackDeps, type SlackRequest } from "../src/sources/slack/index.ts";

const WINDOW = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };

// ── fixture helpers ────────────────────────────────────────────────────────────

/** Slack `ts` for an instant: epoch seconds with fraction, as Slack emits. */
function tsFor(iso: string): string {
  return String(Date.parse(iso) / 1000);
}

function match(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: { id: "C1", name: "general", is_channel: true },
    user: "U2",
    username: "alice",
    ts: tsFor("2026-07-08T12:00:00Z"),
    text: "Hello team",
    permalink: "https://acme.slack.com/archives/C1/p123",
    ...over,
  };
}

/** Which relationship a search query targets (mirrors the source's buildQuery). */
function relOf(query: string): "authored" | "mentions" | "dms" {
  if (query.includes("from:")) return "authored";
  if (query.includes("is:dm")) return "dms";
  return "mentions";
}

interface Store {
  authTest?: any;
  /** search hits keyed by relationship; an array of arrays is read as successive pages. */
  search?: Partial<Record<"authored" | "mentions" | "dms", any[]>>;
  /** search result pages keyed by relationship, served one per `cursor`. */
  pages?: Partial<Record<"authored" | "mentions" | "dms", any[][]>>;
  /** users.info bodies keyed by user id. */
  users?: Record<string, any>;
  /** users.list members, as one page. */
  directory?: any[];
}

/**
 * A fake transport dispatching over the Slack Web API methods. `search.messages` pages
 * the way Slack does: cursor paging only when the first call passes `cursor=*`, with the
 * next cursor in `messages.paging.next_cursor`.
 */
function fakeTransport(store: Store, calls: Array<{ method: string; params: Record<string, string> }> = []): (token: string) => SlackRequest {
  return () => async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "auth.test") return store.authTest ?? { ok: true, user: "Me", user_id: "U1" };
    if (method === "search.messages") {
      const rel = relOf(params.query!);
      const pages = store.pages?.[rel] ?? [store.search?.[rel] ?? []];
      if (params.cursor === undefined) return { ok: true, messages: { matches: pages[0], paging: { page: 1, pages: pages.length } } };
      const index = params.cursor === "*" ? 0 : Number(params.cursor.replace("page-", ""));
      const next = index + 1 < pages.length ? `page-${index + 1}` : "";
      return { ok: true, messages: { matches: pages[index] ?? [], paging: { next_cursor: next } } };
    }
    if (method === "users.info") return store.users?.[params.user!] ?? { ok: true, user: { name: params.user } };
    if (method === "users.list") return { ok: true, members: store.directory ?? [], response_metadata: { next_cursor: "" } };
    return { ok: false };
  };
}

function source(store: Store, options: Record<string, unknown> = {}, deps: Partial<SlackDeps> = {}): SlackSource {
  return new SlackSource(options, {
    appConfig: () => ({ clientId: "id", clientSecret: "secret" }),
    cachedAuth: async () => ({ accessToken: "xoxp-test", userId: "U1" }),
    transport: fakeTransport(store),
    ...deps,
  });
}

/** Read and narrow: the Slack source emits only ChatMessage records. */
async function readChat(s: SlackSource): Promise<ChatMessage[]> {
  const records = await s.read(WINDOW);
  expect(records.every((r) => r.type === "chat-message")).toBe(true);
  return records as ChatMessage[];
}

const textOf = (m: ChatMessage) => unwrap(m.text);
const namesOf = (people: ChatMessage["author"][] | undefined) =>
  (people ?? []).map((p) => (p.name === undefined ? undefined : unwrap(p.name)));

// ── declared surface ─────────────────────────────────────────────────────────

describe("SlackSource surface", () => {
  test("key, label, login, one option", () => {
    const s: Source = source({});
    expect(s.key).toBe("slack");
    expect(s.label).toBe("Slack");
    expect(typeof s.login).toBe("function");
    expect(Object.keys(SLACK_OPTIONS).sort()).toEqual(["relationships"]);
  });
});

// ── tsToInstant ────────────────────────────────────────────────────────────────

describe("SlackSource tsToInstant", () => {
  test("converts Slack epoch ts to a strict ISO-8601 instant", () => {
    expect(tsToInstant("1749047412.123456")).toBe(new Date(1749047412.123456 * 1000).toISOString());
  });
});

// ── status() — the four states (ADR-0014 §6) ──────────────────────────────────

describe("SlackSource.status", () => {
  test("not-configured when app credentials are missing", async () => {
    const s = source({}, {}, { appConfig: () => null });
    expect(await s.status()).toEqual({ state: "not-configured", detail: "set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET" });
  });

  test("not-authenticated when configured but no cached token", async () => {
    const s = source({}, {}, { cachedAuth: async () => null });
    expect(await s.status()).toEqual({ state: "not-authenticated" });
  });

  test("ready with identity from auth.test when the token works", async () => {
    const s = source({ authTest: { ok: true, user: "Ada Lovelace" } });
    expect(await s.status()).toEqual({ state: "ready", identity: "Ada Lovelace" });
  });

  test("not-authenticated when the cached token is rejected (ok:false)", async () => {
    const s = source({ authTest: { ok: false, error: "invalid_auth" } });
    expect(await s.status()).toEqual({ state: "not-authenticated" });
  });

  test("transport error folds to a scrubbed not-configured (no backend bytes surfaced)", async () => {
    const s = source({}, {}, {
      transport: () => async () => {
        throw new Error("Slack request failed: 503");
      },
    });
    const st = await s.status();
    expect(st.state).toBe("not-configured");
    expect((st as { detail?: string }).detail).not.toContain("503");
  });
});

// ── read(): paging (#132) ─────────────────────────────────────────────────────

describe("SlackSource.read paging", () => {
  test("reads every page of a search: cursor=* first, then messages.paging.next_cursor", async () => {
    const at = (h: number) => tsFor(`2026-07-08T${String(h).padStart(2, "0")}:00:00Z`);
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    const store: Store = {
      pages: {
        authored: [
          [match({ user: "U1", ts: at(9), channel: { id: "P1", name: "one", is_channel: true } })],
          [match({ user: "U1", ts: at(10), channel: { id: "P2", name: "two", is_channel: true } })],
          [match({ user: "U1", ts: at(11), channel: { id: "P3", name: "three", is_channel: true } })],
        ],
      },
    };
    const s = source(store, { relationships: ["authored"] }, { transport: fakeTransport(store, calls) });
    const records = await readChat(s);
    expect(records.map((r) => unwrap(r.conversation.name!))).toEqual(["one", "two", "three"]);
    const cursors = calls.filter((c) => c.method === "search.messages").map((c) => c.params.cursor);
    expect(cursors).toEqual(["*", "page-1", "page-2"]);
  });
});

// ── read(): record mapping ─────────────────────────────────────────────────────

describe("SlackSource.read records", () => {
  test("maps a channel message: kind, name, author, text, instant; trusted digests only", async () => {
    const ts = tsFor("2026-07-08T12:00:00Z");
    const s = source({
      search: { mentions: [match({ ts, text: "hi <@U1>", channel: { id: "C1", name: "general", is_channel: true } })] },
      users: {
        U1: { ok: true, user: { profile: { real_name: "Me Myself" } } },
        U2: { ok: true, user: { profile: { real_name: "Alice Example" } } },
      },
    });
    const [m] = await readChat(s);
    expect(m!.source).toBe("slack");
    expect(m!.at).toBe(tsToInstant(ts));
    expect(m!.conversation.kind).toBe("channel");
    expect(m!.conversation.isExternal).toBe(false);
    expect(unwrap(m!.conversation.name!)).toBe("general");
    expect(m!.conversation.members).toBeUndefined();
    expect(unwrap(m!.author.name!)).toBe("Alice Example");
    expect(unwrap(m!.author.handle)).toBe("U2");
    expect(m!.author.isMe).toBe(false);
    expect(m!.byMe).toBe(false);
    expect(m!.mentionsMe).toBe(true);
    expect(textOf(m!)).toBe("hi @Me Myself");
    expect(m!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(m!.entryKey).toMatch(/^[0-9a-f]{16}$/);
    expect(m!.entryKey).not.toBe(m!.fingerprint);
    expect(m!.continuesFromBefore).toBe(false);
    // No permalink, channel id or ts survives into the record.
    const json = JSON.stringify(m);
    expect(json).not.toContain("acme.slack.com");
    expect(json).not.toContain(ts);
  });

  test("author isMe and byMe come from the auth.test user id", async () => {
    const s = source({
      search: {
        authored: [match({ user: "U1", ts: tsFor("2026-07-08T09:00:00Z"), channel: { id: "C1", name: "a", is_channel: true } })],
        mentions: [match({ user: "U2", ts: tsFor("2026-07-08T09:01:00Z"), channel: { id: "C2", name: "b", is_channel: true } })],
      },
    });
    const records = await readChat(s);
    const mine = records.find((r) => unwrap(r.conversation.name!) === "a")!;
    const theirs = records.find((r) => unwrap(r.conversation.name!) === "b")!;
    expect(mine.author.isMe).toBe(true);
    expect(mine.byMe).toBe(true);
    expect(theirs.author.isMe).toBe(false);
    expect(theirs.byMe).toBe(false);
  });

  test("mentionsMe is false for my own message that does not mention me", async () => {
    const s = source({ search: { authored: [match({ user: "U1", text: "shipping today" })] } });
    const [m] = await readChat(s);
    expect(m!.mentionsMe).toBe(false);
  });

  test("messages in one channel share an entryKey; another channel gets another", async () => {
    const s = source({
      search: {
        authored: [
          match({ user: "U1", ts: tsFor("2026-07-08T09:00:00Z"), channel: { id: "C1", name: "a", is_channel: true } }),
          match({ user: "U1", ts: tsFor("2026-07-08T09:05:00Z"), channel: { id: "C1", name: "a", is_channel: true } }),
          match({ user: "U1", ts: tsFor("2026-07-08T09:10:00Z"), channel: { id: "C2", name: "b", is_channel: true } }),
        ],
      },
    });
    const [a1, a2, b] = await readChat(s);
    expect(a1!.entryKey).toBe(a2!.entryKey);
    expect(a1!.fingerprint).not.toBe(a2!.fingerprint);
    expect(b!.entryKey).not.toBe(a1!.entryKey);
  });

  test("a Slack Connect channel is external", async () => {
    const s = source({
      search: { authored: [match({ user: "U1", channel: { id: "C1", name: "partner", is_channel: true, is_ext_shared: true } })] },
    });
    expect((await readChat(s))[0]!.conversation.isExternal).toBe(true);
  });

  test("keeps file-only and bot messages: empty text, no user id", async () => {
    const s = source({
      search: { dms: [match({ user: undefined, username: "deploybot", text: "", channel: { id: "D1", name: "U1", is_im: true } })] },
    }, { relationships: ["dms"] });
    const [m] = await readChat(s);
    expect(textOf(m!)).toBe("");
    expect(unwrap(m!.author.handle)).toBe("");
    expect(unwrap(m!.author.name!)).toBe("deploybot");
    expect(m!.byMe).toBe(false);
  });

  test("falls back to the search username when users.info cannot resolve a name, and omits a name when neither does", async () => {
    const s = source({
      search: {
        authored: [
          match({ user: "U7", username: "bob", ts: tsFor("2026-07-08T09:00:00Z") }),
          match({ user: "UQXGH0T7G", username: undefined, ts: tsFor("2026-07-08T09:01:00Z") }),
        ],
      },
      users: { U7: { ok: false, error: "user_not_found" }, UQXGH0T7G: { ok: false, error: "user_not_found" } },
    });
    const [bob, unknown] = await readChat(s);
    expect(unwrap(bob!.author.name!)).toBe("bob");
    expect(unknown!.author.name).toBeUndefined();
  });

  test("prefers real_name, then display_name, then name from users.info", async () => {
    const s = source({
      search: {
        authored: [
          match({ ts: tsFor("2026-07-08T09:00:00Z"), user: "U_R" }),
          match({ ts: tsFor("2026-07-08T09:01:00Z"), user: "U_D" }),
          match({ ts: tsFor("2026-07-08T09:02:00Z"), user: "U_N" }),
        ],
      },
      users: {
        U_R: { ok: true, user: { profile: { real_name: "Real Name" }, name: "handle" } },
        U_D: { ok: true, user: { profile: { display_name: "Display Name" }, name: "handle" } },
        U_N: { ok: true, user: { name: "just-handle" } },
      },
    });
    expect((await readChat(s)).map((m) => unwrap(m.author.name!))).toEqual(["Real Name", "Display Name", "just-handle"]);
  });
});

// ── read(): conversation members ───────────────────────────────────────────────

describe("SlackSource.read conversation members", () => {
  test("a DM's counterpart comes from the IM's channel.name, even when only the user wrote", async () => {
    const s = source({
      search: { dms: [match({ user: "U1", channel: { id: "D1", name: "U024BE7LH", is_im: true } })] },
      users: { U024BE7LH: { ok: true, user: { profile: { real_name: "Bent Hansen" } } } },
    }, { relationships: ["dms"] });
    const [m] = await readChat(s);
    expect(m!.conversation.kind).toBe("dm");
    expect(m!.conversation.name).toBeUndefined();
    expect(namesOf(m!.conversation.members)).toEqual(["Bent Hansen"]);
    expect(unwrap(m!.conversation.members![0]!.handle)).toBe("U024BE7LH");
    expect(m!.conversation.members![0]!.isMe).toBe(false);
  });

  test("group-DM members come from the mpdm- name, mapped through users.list, the user included", async () => {
    const s = source({
      search: { dms: [match({ user: "U2", channel: { id: "G1", name: "mpdm-me--ada.l--bent_h-1", is_mpim: true } })] },
      directory: [
        { id: "U1", name: "me", profile: { real_name: "Me Myself" } },
        { id: "U2", name: "ada.l", profile: { real_name: "Ada Lovelace" } },
        { id: "U3", name: "bent_h", profile: { display_name: "Bent" } },
        { id: "U4", name: "carol", profile: { real_name: "Carol" } },
      ],
    }, { relationships: ["dms"] });
    const [m] = await readChat(s);
    expect(m!.conversation.kind).toBe("group_dm");
    expect(m!.conversation.name).toBeUndefined();
    expect(namesOf(m!.conversation.members)).toEqual(["Me Myself", "Ada Lovelace", "Bent"]);
    expect(m!.conversation.members!.map((p) => p.isMe)).toEqual([true, false, false]);
    expect(m!.conversation.members!.map((p) => unwrap(p.handle))).toEqual(["U1", "U2", "U3"]);
  });

  test("a group DM whose name does not parse falls back to the authors seen in the window", async () => {
    const g = { id: "G1", name: "some-new-format", is_mpim: true };
    const s = source({
      search: {
        dms: [
          match({ user: "U2", ts: tsFor("2026-07-08T09:00:00Z"), channel: g }),
          match({ user: "U1", ts: tsFor("2026-07-08T09:01:00Z"), channel: g }),
          match({ user: "U2", ts: tsFor("2026-07-08T09:02:00Z"), channel: g }),
        ],
      },
      users: {
        U1: { ok: true, user: { profile: { real_name: "Me Myself" } } },
        U2: { ok: true, user: { profile: { real_name: "Ada Lovelace" } } },
      },
    }, { relationships: ["dms"] });
    const records = await readChat(s);
    for (const m of records) expect(namesOf(m.conversation.members)).toEqual(["Ada Lovelace", "Me Myself"]);
  });

  test("a group DM with a handle users.list does not know falls back to the authors seen", async () => {
    const s = source({
      search: { dms: [match({ user: "U2", channel: { id: "G1", name: "mpdm-me--ada.l--ghost-1", is_mpim: true } })] },
      directory: [
        { id: "U1", name: "me", profile: { real_name: "Me Myself" } },
        { id: "U2", name: "ada.l", profile: { real_name: "Ada Lovelace" } },
      ],
      users: { U2: { ok: true, user: { profile: { real_name: "Ada Lovelace" } } } },
    }, { relationships: ["dms"] });
    expect(namesOf((await readChat(s))[0]!.conversation.members)).toEqual(["Ada Lovelace"]);
  });

  test("a DM whose channel.name is not a user id falls back to the authors seen", async () => {
    const s = source({
      search: { dms: [match({ user: "U024BE7LH", channel: { id: "D1", name: "", is_im: true } })] },
      users: { U024BE7LH: { ok: true, user: { profile: { real_name: "Bent Hansen" } } } },
    }, { relationships: ["dms"] });
    expect(namesOf((await readChat(s))[0]!.conversation.members)).toEqual(["Bent Hansen"]);
  });

  test("a DM fallback never names the user as their own counterpart", async () => {
    const s = source({
      search: { dms: [match({ user: "U1", channel: { id: "D1", name: "", is_im: true } })] },
    }, { relationships: ["dms"] });
    expect((await readChat(s))[0]!.conversation.members).toEqual([]);
  });

  test("users.list is not called when there is no group DM", async () => {
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    const store: Store = { search: { authored: [match({ user: "U1" })] } };
    await readChat(source(store, {}, { transport: fakeTransport(store, calls) }));
    expect(calls.some((c) => c.method === "users.list")).toBe(false);
  });

  test("calls no conversations.* method", async () => {
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    const store: Store = {
      search: {
        dms: [
          match({ user: "U2", ts: tsFor("2026-07-08T09:00:00Z"), channel: { id: "D1", name: "U024BE7LH", is_im: true } }),
          match({ user: "U2", ts: tsFor("2026-07-08T09:01:00Z"), channel: { id: "G1", name: "mpdm-me--ada-1", is_mpim: true } }),
        ],
      },
    };
    await readChat(source(store, {}, { transport: fakeTransport(store, calls) }));
    expect(calls.filter((c) => c.method.startsWith("conversations."))).toEqual([]);
  });
});

// ── read(): Slack reference tokens in message text ──────────────────────────────
//
// Slack encodes references inside message text as angle-bracket tokens. Left raw,
// a mention reaches the summarizer as `<@U12345>`, an unreadable id where a name
// belongs, so the source rewrites them to readable text.
describe("SlackSource.read message text tokens", () => {
  async function textFor(text: string, store: Partial<Store> = {}): Promise<string> {
    const s = source({
      search: { authored: [match({ text })] },
      users: { U2: { ok: true, user: { profile: { real_name: "Alice Example" } } } },
      ...store,
    });
    return textOf((await readChat(s))[0]!);
  }

  test("rewrites a bare user mention to the resolved display name", async () => {
    expect(await textFor("hey <@U9> can you look?", {
      users: {
        U2: { ok: true, user: { name: "alice" } },
        U9: { ok: true, user: { profile: { real_name: "Bent Hansen" } } },
      },
    })).toBe("hey @Bent Hansen can you look?");
  });

  test("uses the inline label when the mention carries one (no lookup needed)", async () => {
    expect(await textFor("thanks <@U9|bent>")).toBe("thanks @bent");
  });

  test("keeps the bare id (bracket-stripped) when the user cannot be resolved", async () => {
    const out = await textFor("ping <@U404>", {
      users: { U2: { ok: true, user: { name: "alice" } }, U404: { ok: false, error: "user_not_found" } },
    });
    expect(out).toBe("ping @U404");
    expect(out).not.toContain("<@");
  });

  test("rewrites channel, special, and subteam mentions", async () => {
    expect(await textFor("see <#C5|eng-platform> <!here> <!subteam^S1|@leads>")).toBe(
      "see #eng-platform @here @leads",
    );
  });

  test("rewrites a labelled link to its label and unwraps a bare link", async () => {
    expect(await textFor("docs <https://example.test/x|the spec> and <https://example.test/y>")).toBe(
      "docs the spec and https://example.test/y",
    );
  });
});

// ── read(): window filter ──────────────────────────────────────────────────────

describe("SlackSource.read window", () => {
  test("drops a match whose ts falls outside [from, to) despite the coarse search bounds", async () => {
    const s = source({
      search: {
        authored: [
          match({ ts: tsFor("2026-07-08T12:00:00Z"), channel: { id: "C1", name: "inside", is_channel: true } }),
          match({ ts: tsFor("2026-07-02T12:00:00Z"), channel: { id: "C2", name: "before", is_channel: true } }),
          match({ ts: tsFor("2026-07-20T12:00:00Z"), channel: { id: "C3", name: "after", is_channel: true } }),
        ],
      },
    });
    expect((await readChat(s)).map((m) => unwrap(m.conversation.name!))).toEqual(["inside"]);
  });
});

// ── read(): query construction ─────────────────────────────────────────────────

describe("SlackSource.read query", () => {
  function recordQueries(options: Record<string, unknown>) {
    const queries: string[] = [];
    const s = source({}, options, {
      transport: () => async (method, params = {}) => {
        if (method === "search.messages") {
          queries.push(params.query!);
          return { ok: true, messages: { matches: [], paging: { next_cursor: "" } } };
        }
        return { ok: true };
      },
    });
    return { s, queries };
  }

  test("builds from:/mention/is:dm queries with day-padded window bounds", async () => {
    const { s, queries } = recordQueries({ relationships: ["authored", "mentions", "dms"] });
    await s.read(WINDOW);
    expect(queries.some((q) => q.startsWith("from:<@U1>"))).toBe(true);
    expect(queries.some((q) => q.startsWith("<@U1>"))).toBe(true);
    expect(queries.some((q) => q.startsWith("is:dm"))).toBe(true);
    expect(queries.every((q) => q.includes("after:2026-07-05") && q.includes("before:2026-07-14"))).toBe(true);
  });

  test("dms is on by default: all three relationships run", async () => {
    const { s, queries } = recordQueries({});
    await s.read(WINDOW);
    expect([...new Set(queries.map(relOf))].sort()).toEqual(["authored", "dms", "mentions"]);
  });

  test("a configured relationships list still narrows the queries", async () => {
    const { s, queries } = recordQueries({ relationships: ["authored"] });
    await s.read(WINDOW);
    expect(queries.map(relOf)).toEqual(["authored"]);
  });
});

// ── read(): union + dedup ───────────────────────────────────────────────────────

describe("SlackSource.read union + dedup", () => {
  test("a message found by several queries is one record, deduped by channel id + ts", async () => {
    const ts = tsFor("2026-07-08T12:00:00Z");
    const dm = { id: "D1", name: "U024BE7LH", is_im: true };
    const hit = match({ user: "U024BE7LH", ts, channel: dm, text: "can you look, <@U1>?" });
    const s = source({ search: { authored: [], mentions: [hit], dms: [{ ...hit }] } });
    const records = await readChat(s);
    expect(records).toHaveLength(1);
    expect(records[0]!.mentionsMe).toBe(true);
  });

  test("the same ts in two channels is two records", async () => {
    const ts = tsFor("2026-07-08T12:00:00Z");
    const s = source({
      search: {
        authored: [
          match({ user: "U1", ts, channel: { id: "C1", name: "a", is_channel: true } }),
          match({ user: "U1", ts, channel: { id: "C2", name: "b", is_channel: true } }),
        ],
      },
    });
    expect(await readChat(s)).toHaveLength(2);
  });

  test("a message found only by the mentions query is mentionsMe even when its text does not show it", async () => {
    // Search also matches mentions inside blocks and attachments, which `text` does not carry.
    const s = source({ search: { mentions: [match({ user: "U2", text: "see the attached" })] } }, { relationships: ["mentions"] });
    expect((await readChat(s))[0]!.mentionsMe).toBe(true);
  });
});

// ── read(): auth guards ─────────────────────────────────────────────────────────

describe("SlackSource.read auth guards", () => {
  test("throws when app credentials are missing", async () => {
    const s = source({}, {}, { appConfig: () => null });
    await expect(s.read(WINDOW)).rejects.toThrow(/not configured/i);
  });

  test("throws when there is no cached token", async () => {
    const s = source({}, {}, { cachedAuth: async () => null });
    await expect(s.read(WINDOW)).rejects.toThrow(/not authenticated|rundown login/i);
  });
});

// ── debug channel (ADR-0015) ───────────────────────────────────────────────────
// Every remote source emits `http` and `auth-verify` (§6); `source-run` is the
// Aggregator's. The events carry trusted structural scalars only, so the assertions
// below check both halves: that the signal is there, and that no channel name,
// display name, message body, or populated query rides along with it.

describe("slack debug events", () => {
  /** Collect the events a source built with an injected sink emits. */
  function withDebug(store: Store, options: Record<string, unknown> = {}, deps: Partial<SlackDeps> = {}) {
    const events: DebugEvent[] = [];
    const src = source(store, options, { debug: (e) => events.push(e), ...deps });
    return { src, events };
  }

  test("auth-verify ready on a working token", async () => {
    const { src, events } = withDebug({});
    await src.status();
    expect(events).toContainEqual({ kind: "auth-verify", source: "slack", outcome: "ready" });
  });

  test("auth-verify rejected on an application-level auth.test failure", async () => {
    const { src, events } = withDebug({ authTest: { ok: false, error: "invalid_auth INJECTED" } });
    await src.status();
    expect(events).toContainEqual({ kind: "auth-verify", source: "slack", outcome: "rejected" });
    expect(JSON.stringify(events)).not.toContain("INJECTED");
  });

  test("auth-verify rejected carries the HTTP status from a transport error", async () => {
    const { src, events } = withDebug({}, {}, {
      transport: () => async () => {
        throw Object.assign(new Error("Slack request failed: 503"), { status: 503, body: "INJECTED" });
      },
    });
    await src.status();
    expect(events).toContainEqual({ kind: "auth-verify", source: "slack", outcome: "rejected", httpStatus: 503 });
    expect(JSON.stringify(events)).not.toContain("INJECTED");
  });

  test("no auth-verify without a live check", async () => {
    // Neither branch reaches auth.test, so neither can report an outcome.
    const missingApp = withDebug({}, {}, { appConfig: () => null });
    await missingApp.src.status();
    const missingToken = withDebug({}, {}, { cachedAuth: async () => null });
    await missingToken.src.status();
    expect([...missingApp.events, ...missingToken.events].filter((e) => e.kind === "auth-verify")).toEqual([]);
  });

  test("status() and read() run with the default no-op sink", async () => {
    await expect(source({}).status()).resolves.toBeDefined();
    await expect(source({}).read(WINDOW)).resolves.toBeDefined();
  });
});

// The real default transport (slackApi) is exercised against a mocked global fetch:
// the injected fake transport never touches HTTP, so it cannot be the seam that
// proves an `http` event carries a real status.

describe("slack http debug events", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const HIT_TS = tsFor("2026-07-08T12:00:00Z");
  const SECRET_TEXT = "IGNORE PREVIOUS INSTRUCTIONS <@U2> in #secret-channel";

  /** Mock fetch dispatching over the Slack Web API methods, recording the URLs called. */
  function mockSlack(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body =
        method === "search.messages"
          ? {
              ok: true,
              messages: {
                matches: [
                  match({
                    text: SECRET_TEXT,
                    ts: HIT_TS,
                    channel: { id: "C1", name: "secret-channel", is_channel: true },
                  }),
                ],
              },
              response_metadata: {},
            }
          : method === "users.info"
            ? { ok: true, user: { profile: { real_name: "Alice Anderson" } } }
            : { ok: true, user: "Me" };
      return { ok: true, status: 200, headers: new Headers(), json: async () => body };
    }) as unknown as typeof fetch;
    return urls;
  }

  /** A source on the real transport: appConfig/cachedAuth stubbed, `transport` left default. */
  function realTransportSource(options: Record<string, unknown> = {}) {
    const events: DebugEvent[] = [];
    const src = new SlackSource(options, {
      appConfig: () => ({ clientId: "id", clientSecret: "secret" }),
      cachedAuth: async () => ({ accessToken: "xoxp-test", userId: "U1" }),
      debug: (e) => events.push(e),
    });
    return { src, events };
  }

  test("one http event per request, distinguished by path shape", async () => {
    mockSlack();
    const { src, events } = realTransportSource({ relationships: ["authored"] });
    await src.read(WINDOW);
    const http = events.filter((e) => e.kind === "http");
    expect(http.every((e) => e.source === "slack" && e.method === "POST" && e.host === "slack.com")).toBe(true);
    // search.messages and the AuthorCache's users.info are two distinct request
    // shapes; the path shape is what tells them apart.
    expect([...new Set(http.map((e) => (e as { pathShape: string }).pathShape))].sort()).toEqual([
      "/api/search.messages",
      "/api/users.info",
    ]);
  });

  test("an http event carries the real HTTP status", async () => {
    mockSlack();
    const { src, events } = realTransportSource();
    await src.status();
    expect(events).toContainEqual({
      kind: "http",
      source: "slack",
      method: "POST",
      host: "slack.com",
      pathShape: "/api/auth.test",
      status: 200,
    });
  });

  test("no message text, channel name, display name, or query reaches the sink", async () => {
    const urls = mockSlack();
    const { src, events } = realTransportSource({ relationships: ["authored"] });
    await src.read(WINDOW);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("IGNORE PREVIOUS");
    expect(serialized).not.toContain("secret-channel");
    expect(serialized).not.toContain("Alice Anderson");
    expect(serialized).not.toContain("U2"); // no user id standing in for a person
    expect(serialized).not.toContain("from:"); // the search query is never logged
    expect(serialized).not.toContain("?"); // no query string at all
    // The query really was on the wire — the event just does not carry it.
    expect(urls.some((u) => u.endsWith("/api/search.messages"))).toBe(true);
  });
});
