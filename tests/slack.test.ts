import { test, expect, describe } from "bun:test";
import { untrusted, unwrap } from "../src/trust.ts";
import type { NormalizedItem } from "../src/domain.ts";
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
  /** search hits keyed by relationship. */
  search?: Partial<Record<"authored" | "mentions" | "dms", any[]>>;
  /** users.info bodies keyed by user id. */
  users?: Record<string, any>;
  /** conversations.replies message lists keyed by `${channel}:${threadTs}`. */
  replies?: Record<string, any[]>;
}

/** A single-page fake transport dispatching over the Slack Web API methods. */
function fakeTransport(store: Store): (token: string) => SlackRequest {
  return () => async (method, params = {}) => {
    if (method === "auth.test") return store.authTest ?? { ok: true, user: "Me", user_id: "U1" };
    if (method === "search.messages") {
      const matches = store.search?.[relOf(params.query!)] ?? [];
      return { ok: true, messages: { matches }, response_metadata: {} };
    }
    if (method === "users.info") return store.users?.[params.user!] ?? { ok: true, user: { name: params.user } };
    if (method === "conversations.replies") {
      return { ok: true, messages: store.replies?.[`${params.channel}:${params.ts}`] ?? [] };
    }
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

// `id`/extras are runtime boxes, never `===`-comparable across boxes — look up by unwrapped value.
function byId(items: NormalizedItem[], id: string): NormalizedItem | undefined {
  return items.find((i) => unwrap(i.id) === id);
}

// ── declared surface ─────────────────────────────────────────────────────────

describe("SlackSource surface", () => {
  test("key, label, has interactive login, two options", () => {
    const s: Source = source({});
    expect(s.key).toBe("slack");
    expect(s.label).toBe("Slack");
    expect(typeof s.login).toBe("function"); // presence = interactive-auth declaration
    expect(Object.keys(SLACK_OPTIONS).sort()).toEqual(["relationships", "threads"]);
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

// ── read(): field mapping + branding ───────────────────────────────────────────

describe("SlackSource.read mapping", () => {
  test("brands all backend content Untrusted; extras carry the grouping keys", async () => {
    const ts = tsFor("2026-07-08T12:00:00Z");
    const s = source({
      search: { authored: [match({ ts })] },
      users: { U2: { ok: true, user: { profile: { real_name: "Alice Example" } } } },
    });
    const items = await s.read(WINDOW);
    const item = byId(items, `C1:${ts}`)!;
    expect(item.source).toBe("slack"); // trusted structural
    expect(item.kind).toBe("message");
    expect(item.timestamp).toBe(tsToInstant(ts));
    expect(item.end).toBeUndefined(); // Slack messages have no interval end (§2)
    expect(item.id).toEqual(untrusted(`C1:${ts}`));
    expect(item.title).toEqual(untrusted("Hello team")); // the body IS the content line (§4)
    expect(item.url).toEqual(untrusted("https://acme.slack.com/archives/C1/p123"));
    expect(item.extras).toEqual(
      untrusted({
        channel: { id: "C1", name: "general", type: "public" },
        author: "Alice Example",
        relationship: "authored",
      }),
    );
  });

  test("derives channel type from the is_* flags and carries threadTs", async () => {
    const ts = tsFor("2026-07-08T09:00:00Z");
    const s = source({
      search: {
        authored: [
          match({ ts, channel: { id: "D1", is_im: true }, thread_ts: tsFor("2026-07-08T08:00:00Z") }),
        ],
      },
    });
    const extras = unwrap((await s.read(WINDOW)).find((i) => unwrap(i.id).startsWith("D1"))!.extras!) as any;
    expect(extras.channel.type).toBe("dm");
    expect(extras.threadTs).toBe(tsFor("2026-07-08T08:00:00Z"));
  });

  test("group_dm and private channel types", async () => {
    const s = source({
      search: {
        authored: [
          match({ ts: tsFor("2026-07-08T09:00:00Z"), channel: { id: "G1", is_mpim: true } }),
          match({ ts: tsFor("2026-07-08T09:05:00Z"), channel: { id: "C9", is_private: true } }),
        ],
      },
    });
    const items = await s.read(WINDOW);
    expect((unwrap(items.find((i) => unwrap(i.id).startsWith("G1"))!.extras!) as any).channel.type).toBe("group_dm");
    expect((unwrap(items.find((i) => unwrap(i.id).startsWith("C9"))!.extras!) as any).channel.type).toBe("private");
  });

  test("falls back to the search username, then the id, when users.info cannot resolve a name", async () => {
    const s = source({
      search: { authored: [match({ user: "U7", username: "bob", users: undefined })] },
      users: { U7: { ok: false, error: "user_not_found" } },
    });
    const extras = unwrap((await s.read(WINDOW))[0]!.extras!) as any;
    expect(extras.author).toBe("bob");
  });
});

// ── read(): window filter ──────────────────────────────────────────────────────

describe("SlackSource.read window", () => {
  test("drops a match whose ts falls outside [from, to) despite the coarse search bounds", async () => {
    const s = source({
      search: {
        authored: [
          match({ ts: tsFor("2026-07-08T12:00:00Z"), channel: { id: "C1" } }), // inside
          match({ ts: tsFor("2026-07-02T12:00:00Z"), channel: { id: "C2" } }), // before window
          match({ ts: tsFor("2026-07-20T12:00:00Z"), channel: { id: "C3" } }), // after window
        ],
      },
    });
    const items = await s.read(WINDOW);
    expect(items.map((i) => unwrap(i.id).split(":")[0]).sort()).toEqual(["C1"]);
  });
});

// ── read(): query construction ─────────────────────────────────────────────────

describe("SlackSource.read query", () => {
  test("builds from:/mention/is:dm queries with day-padded window bounds", async () => {
    const queries: string[] = [];
    const s = source({}, { relationships: ["authored", "mentions", "dms"] }, {
      transport: () => async (method, params = {}) => {
        if (method === "auth.test") return { ok: true, user: "Me" };
        if (method === "search.messages") {
          queries.push(params.query!);
          return { ok: true, messages: { matches: [] }, response_metadata: {} };
        }
        return { ok: true };
      },
    });
    await s.read(WINDOW);
    expect(queries.some((q) => q.startsWith("from:<@U1>"))).toBe(true);
    expect(queries.some((q) => q.startsWith("<@U1>"))).toBe(true);
    expect(queries.some((q) => q.startsWith("is:dm"))).toBe(true);
    expect(queries.every((q) => q.includes("after:2026-07-05") && q.includes("before:2026-07-14"))).toBe(true);
  });

  test("default relationships are authored + mentions; dms is opt-in", async () => {
    const seen: string[] = [];
    const s = source({}, {}, {
      transport: () => async (method, params = {}) => {
        if (method === "auth.test") return { ok: true, user: "Me" };
        if (method === "search.messages") {
          seen.push(relOf(params.query!));
          return { ok: true, messages: { matches: [] }, response_metadata: {} };
        }
        return { ok: true };
      },
    });
    await s.read(WINDOW);
    expect([...new Set(seen)].sort()).toEqual(["authored", "mentions"]);
  });
});

// ── read(): union + dedup ───────────────────────────────────────────────────────

describe("SlackSource.read union + dedup", () => {
  test("unions relationships and dedups by channel+ts; first-seen relationship wins", async () => {
    const ts = tsFor("2026-07-08T12:00:00Z");
    const dup = match({ ts, channel: { id: "C1", name: "general" } });
    const s = source(
      { search: { authored: [dup], mentions: [match({ ...dup })] } },
      { relationships: ["authored", "mentions"] },
    );
    const items = await s.read(WINDOW);
    expect(items).toHaveLength(1);
    expect((unwrap(byId(items, `C1:${ts}`)!.extras!) as any).relationship).toBe("authored");
  });
});

// ── read(): pagination ─────────────────────────────────────────────────────────

describe("SlackSource.read pagination", () => {
  test("follows response_metadata.next_cursor", async () => {
    const page1 = [match({ ts: tsFor("2026-07-08T12:00:00Z"), channel: { id: "P1" } })];
    const page2 = [match({ ts: tsFor("2026-07-09T12:00:00Z"), channel: { id: "P2" } })];
    const s = source({}, {}, {
      transport: () => async (method, params = {}) => {
        if (method === "auth.test") return { ok: true, user: "Me" };
        if (method === "users.info") return { ok: true, user: { name: "x" } };
        if (method === "search.messages") {
          return params.cursor === "c1"
            ? { ok: true, messages: { matches: page2 }, response_metadata: { next_cursor: "" } }
            : { ok: true, messages: { matches: page1 }, response_metadata: { next_cursor: "c1" } };
        }
        return { ok: true };
      },
    });
    const items = await s.read(WINDOW);
    expect(items.map((i) => unwrap(i.id).split(":")[0]).sort()).toEqual(["P1", "P2"]);
  });
});

// ── read(): the threads option (§5) ─────────────────────────────────────────────

describe("SlackSource.read threads", () => {
  test("off by default: conversations.replies is never called", async () => {
    let repliesCalled = false;
    const s = source({}, {}, {
      transport: () => async (method, params = {}) => {
        if (method === "auth.test") return { ok: true, user: "Me" };
        if (method === "users.info") return { ok: true, user: { name: "x" } };
        if (method === "conversations.replies") {
          repliesCalled = true;
          return { ok: true, messages: [] };
        }
        if (method === "search.messages")
          return { ok: true, messages: { matches: [match({ thread_ts: tsFor("2026-07-08T11:00:00Z") })] }, response_metadata: {} };
        return { ok: true };
      },
    });
    await s.read(WINDOW);
    expect(repliesCalled).toBe(false);
  });

  test("on: reconstructs the thread, deduped against search, replies carry no url", async () => {
    const rootTs = tsFor("2026-07-08T11:00:00Z");
    const hitTs = tsFor("2026-07-08T11:30:00Z");
    const newTs = tsFor("2026-07-08T11:45:00Z");
    const s = source(
      {
        search: { authored: [match({ ts: hitTs, thread_ts: rootTs })] },
        users: { U2: { ok: true, user: { name: "alice" } }, U3: { ok: true, user: { name: "carol" } } },
        replies: {
          [`C1:${rootTs}`]: [
            { user: "U2", ts: rootTs, text: "root", thread_ts: rootTs },
            { user: "U2", ts: hitTs, text: "the hit", thread_ts: rootTs }, // already returned by search → dedup
            { user: "U3", ts: newTs, text: "a reply", thread_ts: rootTs },
          ],
        },
      },
      { threads: true },
    );
    const items = await s.read(WINDOW);
    // matched hit + root + new reply = 3, hit not double-counted
    expect(items.map((i) => unwrap(i.id).split(":")[1]).sort()).toEqual([rootTs, hitTs, newTs].sort());
    const rootItem = byId(items, `C1:${rootTs}`)!;
    expect(rootItem.url).toBeUndefined(); // reconstructed replies have no permalink
    const extras = unwrap(rootItem.extras!) as any;
    expect(extras.relationship).toBe("authored"); // carried from the surfacing hit
    expect(extras.threadTs).toBe(rootTs);
    expect(extras.channel).toEqual({ id: "C1", name: "general", type: "public" });
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

  test("login() passes the threads option through to the OAuth scope request", async () => {
    let requestedThreads: boolean | undefined;
    const s = source({}, { threads: true }, {
      login: async (threads) => {
        requestedThreads = threads;
        return "Me";
      },
    });
    expect(await s.login()).toBe("Me");
    expect(requestedThreads).toBe(true);
  });
});
