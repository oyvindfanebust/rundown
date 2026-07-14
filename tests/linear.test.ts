import { test, expect, describe } from "bun:test";
import { untrusted, unwrap } from "../src/trust.ts";
import type { NormalizedItem } from "../src/domain.ts";
import type { Source } from "../src/sources/source.ts";
import { LinearSource, scrubbedTransportError, type LinearRequest } from "../src/sources/linear/index.ts";

const WINDOW = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };

// ── fixture helpers ────────────────────────────────────────────────────────────

function issue(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "i",
    identifier: "ENG-1",
    title: "An issue",
    description: undefined,
    url: "https://linear.app/acme/issue/ENG-1",
    priorityLabel: "No priority",
    estimate: undefined,
    dueDate: undefined,
    updatedAt: "2026-07-10T00:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    assignee: { name: "Me" },
    creator: { name: "Me" },
    team: { key: "OYV" },
    project: { name: "rundown" },
    labels: { nodes: [] },
    ...over,
  };
}

/** Which relationship an IssueFilter targets. */
function relOf(filter: any): "assigned" | "created" | "subscribed" {
  if (filter.assignee) return "assigned";
  if (filter.creator) return "created";
  return "subscribed";
}

/**
 * A single-page fake transport. `store[rel].standing` answers the no-updatedAt
 * (standing) query; `store[rel].recent` answers the windowed (recent) query.
 */
function fakeTransport(store: Record<string, { standing?: any[]; recent?: any[] }>): LinearRequest {
  return async (query, variables) => {
    if (query.includes("viewer")) return { viewer: { name: "Ada Lovelace" } };
    const filter = (variables as any).filter;
    const rel = relOf(filter);
    const bucket = filter.updatedAt ? "recent" : "standing";
    const nodes = store[rel]?.[bucket] ?? [];
    return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
  };
}

function source(transport: LinearRequest | null): LinearSource {
  return new LinearSource({ transport: () => transport });
}

// `id` is now a real runtime box, never `===`-comparable across two
// separately-constructed boxes of the same string — so this test-only lookup
// compares by unwrapped value. (This is a test assertion helper, not a
// production leak path — never a pattern to mirror in src/.)
function byId(items: NormalizedItem[], id: string): NormalizedItem | undefined {
  return items.find((i) => unwrap(i.id) === id);
}

// ── declared surface ─────────────────────────────────────────────────────────

describe("LinearSource surface", () => {
  test("key, label, no login, four options", () => {
    const s: Source = source(null);
    expect(s.key).toBe("linear");
    expect(s.label).toBe("Linear");
    expect(s.login).toBeUndefined(); // absence = non-interactive-auth declaration
    expect(Object.keys(s.options).sort()).toEqual(["projects", "relationships", "states", "teams"]);
  });
});

// ── status() ────────────────────────────────────────────────────────────────

describe("LinearSource.status", () => {
  test("not-configured when no API key (null transport)", async () => {
    expect(await source(null).status()).toEqual({
      state: "not-configured",
      detail: "set LINEAR_API_KEY",
    });
  });

  test("ready with viewer.name identity when the key works", async () => {
    const s = source(fakeTransport({}));
    expect(await s.status()).toEqual({ state: "ready", identity: "Ada Lovelace" });
  });

  test("not-configured (rejected) when the viewer query throws", async () => {
    const s = source(async () => {
      throw new Error("401 Unauthorized");
    });
    expect(await s.status()).toEqual({
      state: "not-configured",
      detail: "LINEAR_API_KEY was rejected — check the key",
    });
  });

  test("never emits not-authenticated", async () => {
    for (const t of [null, fakeTransport({})]) {
      const st = await source(t).status();
      expect(st.state).not.toBe("not-authenticated");
    }
  });
});

// ── read(): window / field mapping ────────────────────────────────────────────

describe("LinearSource.read mapping", () => {
  test("open + dueDate → UTC end-of-day timestamp; end omitted", async () => {
    const items = await source(
      fakeTransport({ assigned: { standing: [issue({ id: "due", dueDate: "2026-07-20" })] } }),
    ).read(WINDOW, {});
    const item = byId(items, "due")!;
    expect(item.timestamp).toBe("2026-07-20T23:59:59Z");
    expect(item.end).toBeUndefined();
  });

  test("open + undated → timestamp = updatedAt", async () => {
    const items = await source(
      fakeTransport({ assigned: { standing: [issue({ id: "nodue" })] } }),
    ).read(WINDOW, {});
    expect(byId(items, "nodue")!.timestamp).toBe("2026-07-10T00:00:00.000Z");
  });

  test("completed issue uses updatedAt even when it has a dueDate", async () => {
    const done = issue({
      id: "done",
      dueDate: "2026-07-20",
      state: { name: "Done", type: "completed" },
    });
    const items = await source(fakeTransport({ assigned: { standing: [done] } })).read(WINDOW, {});
    expect(byId(items, "done")!.timestamp).toBe("2026-07-10T00:00:00.000Z");
  });

  test("brands all backend content Untrusted and omits empty/default extras", async () => {
    const full = issue({
      id: "full",
      identifier: "ENG-9",
      title: "Ship it",
      description: "D".repeat(500),
      priorityLabel: "High",
      estimate: 3,
      dueDate: "2026-07-20",
      labels: { nodes: [{ name: "Feature" }, { name: "Bug" }] },
    });
    const item = byId(await source(fakeTransport({ assigned: { standing: [full] } })).read(WINDOW, {}), "full")!;
    expect(item.source).toBe("linear"); // trusted structural
    expect(item.kind).toBe("issue");
    expect(item.id).toEqual(untrusted("full"));
    expect(item.title).toEqual(untrusted("Ship it")); // no identifier prefix
    expect(item.url).toEqual(untrusted("https://linear.app/acme/issue/ENG-1"));
    expect(item.extras).toEqual(
      untrusted({
        identifier: "ENG-9",
        state: { name: "In Progress", type: "started" },
        assignee: "Me",
        creator: "Me",
        priority: "High",
        labels: ["Feature", "Bug"],
        project: "rundown",
        team: "OYV",
        dueDate: "2026-07-20",
        estimate: 3,
        relationship: "assigned",
        description: "D".repeat(200), // truncated ~200
      }),
    );
  });

  test('omits "No priority", empty labels, and unset estimate/description', async () => {
    const item = byId(await source(fakeTransport({ assigned: { standing: [issue({ id: "bare" })] } })).read(WINDOW, {}), "bare")!;
    const extras = unwrap(item.extras!) as any;
    expect(extras.priority).toBeUndefined();
    expect(extras.labels).toBeUndefined();
    expect(extras.estimate).toBeUndefined();
    expect(extras.description).toBeUndefined();
    expect(extras.relationship).toBe("assigned");
  });

  test("estimate: 0 is a real estimate and survives compaction (accepted delta)", async () => {
    const zero = issue({ id: "zero", estimate: 0 });
    const item = byId(await source(fakeTransport({ assigned: { standing: [zero] } })).read(WINDOW, {}), "zero")!;
    expect((unwrap(item.extras!) as any).estimate).toBe(0);
  });
});

// ── read(): union / dedup ──────────────────────────────────────────────────────

describe("LinearSource.read union + dedup", () => {
  test("unions standing + recent and dedups by id", async () => {
    const A = issue({ id: "A" });
    const B = issue({ id: "B" });
    const C = issue({ id: "C" });
    const items = await source(
      fakeTransport({ assigned: { standing: [A, B], recent: [B, C] } }),
    ).read(WINDOW, {});
    // `id` boxes aren't string-coercible for a value-sort anymore (default
    // Array#sort would coerce via the redacted toString(), making it a no-op) — sort
    // by unwrapped value so this stays an order-independent comparison.
    expect(items.map((i) => unwrap(i.id)).sort()).toEqual(["A", "B", "C"]);
    expect(items).toHaveLength(3);
  });

  test("dedups across relationships; first-seen relationship wins", async () => {
    const dup = issue({ id: "dup" });
    const items = await source(
      fakeTransport({
        assigned: { standing: [dup] },
        created: { standing: [issue({ ...dup })] },
      }),
    ).read(WINDOW, { relationships: ["assigned", "created"] });
    expect(items).toHaveLength(1);
    expect((unwrap(byId(items, "dup")!.extras!) as any).relationship).toBe("assigned");
  });

  test("default is assigned-only: created/subscribed not queried without opt-in", async () => {
    const seen: string[] = [];
    const transport: LinearRequest = async (query, variables) => {
      if (query.includes("viewer")) return { viewer: { name: "x" } };
      seen.push(relOf((variables as any).filter));
      return { issues: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };
    await source(transport).read(WINDOW, {});
    expect([...new Set(seen)]).toEqual(["assigned"]);
  });

  test("read throws when unconfigured (null transport)", async () => {
    await expect(source(null).read(WINDOW, {})).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

// ── read(): filter construction ────────────────────────────────────────────────

describe("LinearSource.read filter", () => {
  test("standing query has no updatedAt bound; recent query is windowed", async () => {
    const filters: any[] = [];
    const transport: LinearRequest = async (query, variables) => {
      if (query.includes("viewer")) return { viewer: { name: "x" } };
      filters.push((variables as any).filter);
      return { issues: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };
    await source(transport).read(WINDOW, {});
    expect(filters).toHaveLength(2); // assigned × {standing, recent}
    const standing = filters.find((f) => !f.updatedAt)!;
    const recent = filters.find((f) => f.updatedAt)!;
    expect(standing.state).toEqual({ type: { in: ["unstarted", "started", "completed"] } }); // default states
    expect(standing.assignee).toEqual({ isMe: { eq: true } });
    expect(recent.updatedAt).toEqual({ gte: WINDOW.from, lt: WINDOW.to });
  });

  test("teams/projects/states/relationships options flow into the filter", async () => {
    const filters: any[] = [];
    const transport: LinearRequest = async (query, variables) => {
      if (query.includes("viewer")) return { viewer: { name: "x" } };
      filters.push((variables as any).filter);
      return { issues: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };
    await source(transport).read(WINDOW, {
      relationships: ["created", "subscribed"],
      states: ["backlog"],
      teams: ["OYV"],
      projects: ["rundown"],
    });
    expect(filters.every((f) => f.state.type.in[0] === "backlog")).toBe(true);
    expect(filters.every((f) => f.team.key.in[0] === "OYV")).toBe(true);
    expect(filters.every((f) => f.project.name.in[0] === "rundown")).toBe(true);
    expect(filters.some((f) => f.creator)).toBe(true);
    expect(filters.some((f) => f.subscribers)).toBe(true);
    expect(filters.some((f) => f.assignee)).toBe(false); // not selected
  });
});

// ── read(): pagination ─────────────────────────────────────────────────────────

describe("LinearSource.read pagination", () => {
  test("follows pageInfo.hasNextPage / endCursor", async () => {
    const page1 = [issue({ id: "p1" })];
    const page2 = [issue({ id: "p2" })];
    const transport: LinearRequest = async (query, variables) => {
      if (query.includes("viewer")) return { viewer: { name: "x" } };
      const after = (variables as any).after;
      if (filterIsStanding(variables)) {
        return after === "cursor-1"
          ? { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: page2 } }
          : { issues: { pageInfo: { hasNextPage: true, endCursor: "cursor-1" }, nodes: page1 } };
      }
      return { issues: { pageInfo: { hasNextPage: false }, nodes: [] } };
    };
    const items = await source(transport).read(WINDOW, {});
    // Sort by unwrapped value (see the dedup test above for why).
    expect(items.map((i) => unwrap(i.id)).sort()).toEqual(["p1", "p2"]);
  });
});

function filterIsStanding(variables: unknown): boolean {
  return !(variables as any).filter.updatedAt;
}

// ── transport errors scrub the backend response body ─────────────────────────
// The default transport wraps @linear/sdk's rawRequest, which throws a
// LinearError whose message echoes the backend GraphQL error text (and whose
// .raw stringifies the full response + request). That error propagates through
// read() to cli.ts fail() → stderr, an agent-readable channel: it must carry
// only a generic description + HTTP status, no response-body bytes (ADR-0004 §5).

describe("Linear transport error scrubbing", () => {
  test("reduces a LinearError to status only — no backend message, data, or query", () => {
    // Shape mirrors @linear/sdk's LinearError: .status + backend content fields.
    const err = Object.assign(new Error("Entity not found - INJECTED backend text"), {
      status: 400,
      data: { secret: "leak-me" },
      query: "query Issues { issues { nodes { title } } }",
      errors: [{ message: "INJECTED backend text" }],
    });
    const scrubbed = scrubbedTransportError(err);
    expect(scrubbed.message).toContain("400");
    expect(scrubbed.message).not.toContain("INJECTED");
    expect(scrubbed.message).not.toContain("leak-me");
    expect(scrubbed.message).not.toContain("issues");
  });

  test("reads the HTTP status from a raw GraphQLClientError (.response.status)", () => {
    const err = Object.assign(new Error('GraphQL Error: {"response":{"data":"leak"}}'), {
      response: { status: 429, data: "leak" },
    });
    const scrubbed = scrubbedTransportError(err);
    expect(scrubbed.message).toContain("429");
    expect(scrubbed.message).not.toContain("leak");
  });

  test("falls back to a generic message when no status is present", () => {
    const scrubbed = scrubbedTransportError(new Error("some raw backend detail"));
    expect(scrubbed.message.length).toBeGreaterThan(0);
    expect(scrubbed.message).not.toContain("backend detail");
  });
});
