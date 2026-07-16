import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { untrusted, unwrap } from "../src/trust.ts";
import type { NormalizedItem } from "../src/domain.ts";
import type { Source } from "../src/sources/source.ts";
import {
  JiraSource,
  JIRA_OPTIONS,
  siteOrigin,
  adfToText,
  buildJql,
  defaultTransport,
  resolveCloudId,
  type JiraRequest,
  type FetchLike,
} from "../src/sources/jira/index.ts";

const WINDOW = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };
const SITE = "acme.atlassian.net";

// ── fixture helpers ────────────────────────────────────────────────────────────

/** A plain-text ADF description document. */
function adf(body: string): unknown {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] };
}

function issue(over: { id: string; fields?: Record<string, unknown>; key?: string }): Record<string, unknown> {
  return {
    id: over.id,
    key: over.key ?? "OYV-1",
    fields: {
      summary: "An issue",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      assignee: { displayName: "Me" },
      reporter: { displayName: "Me" },
      priority: { name: "Medium" },
      project: { key: "OYV", name: "rundown" },
      issuetype: { name: "Task" },
      duedate: null,
      labels: [],
      description: null,
      updated: "2026-07-10T00:00:00.000Z",
      ...over.fields,
    },
  };
}

/** Which relationship a JQL string targets. */
function relOf(jql: string): "assigned" | "created" | "watching" {
  if (jql.includes("assignee = currentUser()")) return "assigned";
  if (jql.includes("reporter = currentUser()")) return "created";
  return "watching";
}

/**
 * A single-page fake transport. `store[rel].standing` answers the no-`updated`
 * (standing) query; `store[rel].recent` answers the windowed (recent) query.
 */
function fakeTransport(store: Record<string, { standing?: any[]; recent?: any[] }>): JiraRequest {
  return async (path, init) => {
    if (path.includes("myself")) return { displayName: "Ada Lovelace" };
    const jql = (init?.body as any).jql as string;
    const rel = relOf(jql);
    const bucket = jql.includes("updated >=") ? "recent" : "standing";
    const issues = store[rel]?.[bucket] ?? [];
    return { issues, isLast: true, nextPageToken: null };
  };
}

function source(transport: JiraRequest | null, options: Record<string, unknown> = {}): JiraSource {
  return new JiraSource({ site: SITE, ...options }, { transport: () => transport });
}

/** A transport that records each search JQL into `sink` and returns no issues. */
function recordingTransport(sink: string[]): JiraRequest {
  return async (path, init) => {
    if (path.includes("myself")) return { displayName: "x" };
    sink.push((init?.body as any).jql);
    return { issues: [], isLast: true };
  };
}

// `id` is a real runtime box, never `===`-comparable across two separately-
// constructed boxes of the same string — so this test-only lookup compares by
// unwrapped value. (A test assertion helper, never a pattern to mirror in src/.)
function byId(items: NormalizedItem[], id: string): NormalizedItem | undefined {
  return items.find((i) => unwrap(i.id) === id);
}

// ── declared surface ─────────────────────────────────────────────────────────

describe("JiraSource surface", () => {
  test("key, label, no login, four options", () => {
    const s: Source = source(null);
    expect(s.key).toBe("jira");
    expect(s.label).toBe("Jira");
    expect(s.login).toBeUndefined(); // absence = non-interactive-auth declaration
    expect(Object.keys(JIRA_OPTIONS).sort()).toEqual(["projects", "relationships", "site", "statuses"]);
  });
});

// ── siteOrigin / adfToText units ──────────────────────────────────────────────

describe("siteOrigin", () => {
  test("bare host gains https and loses trailing slash", () => {
    expect(siteOrigin("acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(siteOrigin("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net");
  });
  test("blank / non-string → undefined", () => {
    expect(siteOrigin("  ")).toBeUndefined();
    expect(siteOrigin(undefined)).toBeUndefined();
    expect(siteOrigin(42)).toBeUndefined();
  });
});

describe("adfToText", () => {
  test("collects text leaves in order; null/empty → undefined", () => {
    expect(adfToText(adf("Ship the thing"))).toBe("Ship the thing");
    expect(adfToText(null)).toBeUndefined();
    expect(adfToText({ type: "doc", content: [] })).toBeUndefined();
  });
});

// ── status() ────────────────────────────────────────────────────────────────

describe("JiraSource.status", () => {
  test("not-configured, listing the missing site option, when transport is null", async () => {
    const st = await source(null).status();
    expect(st.state).toBe("not-configured");
    // SITE is set in `source()`; env secrets are not, so the detail names them.
    expect((st as any).detail).toContain("set");
    expect((st as any).detail).toContain("JIRA_EMAIL");
  });

  test("ready with myself.displayName identity when the credential works", async () => {
    expect(await source(fakeTransport({})).status()).toEqual({ state: "ready", identity: "Ada Lovelace" });
  });

  test("not-configured (rejected) when the myself call throws", async () => {
    const s = source(async () => {
      throw new Error("401 Unauthorized");
    });
    expect(await s.status()).toEqual({
      state: "not-configured",
      detail: "JIRA_EMAIL/JIRA_API_TOKEN was rejected — check the credentials",
    });
  });

  test("never emits not-authenticated", async () => {
    for (const t of [null, fakeTransport({})]) {
      const st = await source(t).status();
      expect(st.state).not.toBe("not-authenticated");
    }
  });
});

// ── read(): field mapping ─────────────────────────────────────────────────────

describe("JiraSource.read mapping", () => {
  test("open + duedate → UTC end-of-day timestamp; end omitted", async () => {
    const items = await source(
      fakeTransport({ assigned: { standing: [issue({ id: "due", fields: { duedate: "2026-07-20" } })] } }),
    ).read(WINDOW);
    const item = byId(items, "due")!;
    expect(item.timestamp).toBe("2026-07-20T23:59:59Z");
    expect(item.end).toBeUndefined();
  });

  test("open + undated → timestamp = updated", async () => {
    const items = await source(fakeTransport({ assigned: { standing: [issue({ id: "nodue" })] } })).read(WINDOW);
    expect(byId(items, "nodue")!.timestamp).toBe("2026-07-10T00:00:00.000Z");
  });

  test("done issue uses updated even when it has a duedate", async () => {
    const done = issue({
      id: "done",
      fields: { duedate: "2026-07-20", status: { name: "Done", statusCategory: { key: "done" } } },
    });
    const items = await source(fakeTransport({ assigned: { standing: [done] } })).read(WINDOW);
    expect(byId(items, "done")!.timestamp).toBe("2026-07-10T00:00:00.000Z");
  });

  test("brands all backend content Untrusted, builds the permalink, omits empty extras", async () => {
    const full = issue({
      id: "full",
      key: "OYV-9",
      fields: {
        summary: "Ship it",
        description: adf("D".repeat(500)),
        priority: { name: "High" },
        duedate: "2026-07-20",
        labels: ["Feature", "Bug"],
      },
    });
    const item = byId(await source(fakeTransport({ assigned: { standing: [full] } })).read(WINDOW), "full")!;
    expect(item.source).toBe("jira"); // trusted structural
    expect(item.kind).toBe("issue");
    expect(item.id).toEqual(untrusted("full"));
    expect(item.title).toEqual(untrusted("Ship it"));
    expect(item.url).toEqual(untrusted("https://acme.atlassian.net/browse/OYV-9"));
    expect(item.extras).toEqual(
      untrusted({
        key: "OYV-9",
        status: { name: "In Progress", category: "indeterminate" },
        assignee: "Me",
        reporter: "Me",
        priority: "High",
        project: { key: "OYV", name: "rundown" },
        issuetype: "Task",
        duedate: "2026-07-20",
        labels: ["Feature", "Bug"],
        relationship: "assigned",
        description: "D".repeat(200), // truncated ~200
      }),
    );
  });

  test("omits empty labels and absent description", async () => {
    const item = byId(await source(fakeTransport({ assigned: { standing: [issue({ id: "bare" })] } })).read(WINDOW), "bare")!;
    const extras = unwrap(item.extras!) as any;
    expect(extras.labels).toBeUndefined();
    expect(extras.description).toBeUndefined();
    expect(extras.relationship).toBe("assigned");
  });
});

// ── read(): union / dedup ──────────────────────────────────────────────────────

describe("JiraSource.read union + dedup", () => {
  test("unions standing + recent and dedups by id", async () => {
    const A = issue({ id: "A" });
    const B = issue({ id: "B" });
    const C = issue({ id: "C" });
    const items = await source(fakeTransport({ assigned: { standing: [A, B], recent: [B, C] } })).read(WINDOW);
    expect(items.map((i) => unwrap(i.id)).sort()).toEqual(["A", "B", "C"]);
    expect(items).toHaveLength(3);
  });

  test("dedups across relationships; first-seen relationship wins", async () => {
    const items = await source(
      fakeTransport({
        assigned: { standing: [issue({ id: "dup" })] },
        created: { standing: [issue({ id: "dup" })] },
      }),
      { relationships: ["assigned", "created"] },
    ).read(WINDOW);
    expect(items).toHaveLength(1);
    expect((unwrap(byId(items, "dup")!.extras!) as any).relationship).toBe("assigned");
  });

  test("default is assigned-only: created/watching not queried without opt-in", async () => {
    const jqls: string[] = [];
    await source(recordingTransport(jqls)).read(WINDOW);
    expect([...new Set(jqls.map(relOf))]).toEqual(["assigned"]);
  });

  test("read throws when unconfigured (null transport)", async () => {
    await expect(source(null).read(WINDOW)).rejects.toThrow(/JIRA_EMAIL/);
  });
});

// ── read(): JQL construction ───────────────────────────────────────────────────

describe("JiraSource.read JQL", () => {
  test("standing query has no updated bound; recent query is windowed", async () => {
    const jqls: string[] = [];
    await source(recordingTransport(jqls)).read(WINDOW);
    expect(jqls).toHaveLength(2); // assigned × {standing, recent}
    const standing = jqls.find((j) => !j.includes("updated"))!;
    const recent = jqls.find((j) => j.includes("updated"))!;
    expect(standing).toContain("assignee = currentUser()");
    expect(standing).not.toContain("statusCategory"); // default = all three → no clause
    expect(recent).toContain(`updated >= "2026-07-06 00:00"`);
    expect(recent).toContain(`updated < "2026-07-13 00:00"`);
  });

  test("statuses (strict subset), projects, and relationships flow into the JQL", async () => {
    const jqls: string[] = [];
    await source(recordingTransport(jqls), {
      relationships: ["created", "watching"],
      statuses: ["new", "indeterminate"],
      projects: ["OYV"],
    }).read(WINDOW);
    expect(jqls.every((j) => j.includes(`statusCategory in ("new", "indeterminate")`))).toBe(true);
    expect(jqls.every((j) => j.includes(`project in ("OYV")`))).toBe(true);
    expect(jqls.some((j) => j.includes("reporter = currentUser()"))).toBe(true);
    expect(jqls.some((j) => j.includes("watcher = currentUser()"))).toBe(true);
    expect(jqls.some((j) => j.includes("assignee = currentUser()"))).toBe(false); // not selected
  });

  test("buildJql omits the statusCategory clause when all three categories are selected", () => {
    const all = buildJql("assigned", ["new", "indeterminate", "done"], undefined, null);
    expect(all).toBe("assignee = currentUser()");
  });
});

// ── read(): pagination ─────────────────────────────────────────────────────────

describe("JiraSource.read pagination", () => {
  test("follows nextPageToken while isLast is false", async () => {
    const page1 = [issue({ id: "p1" })];
    const page2 = [issue({ id: "p2" })];
    const transport: JiraRequest = async (path, init) => {
      if (path.includes("myself")) return { displayName: "x" };
      const body = init?.body as any;
      if (!body.jql.includes("updated")) {
        // standing query paginates across two pages
        return body.nextPageToken === "tok-1"
          ? { issues: page2, isLast: true, nextPageToken: null }
          : { issues: page1, isLast: false, nextPageToken: "tok-1" };
      }
      return { issues: [], isLast: true };
    };
    const items = await source(transport).read(WINDOW);
    expect(items.map((i) => unwrap(i.id)).sort()).toEqual(["p1", "p2"]);
  });
});

// ── transport errors scrub the backend response body ─────────────────────────
// The status-only scrub of a Jira transport error is centralized in statusOnlyError
// (sources/errors.ts) and tested exhaustively there (tests/errors.test.ts) across the
// Response (.status) shape. defaultTransport's non-ok branch is a one-liner over that
// helper, so the scrub is not re-tested here (ADR-0004 §5, ADR-0013 §6).

// ── cloudId resolution + gateway routing (ADR-0013 §5) ────────────────────────
// Scoped API tokens authenticate only through the api.atlassian.com/ex/jira/{cloudId}
// gateway, not the instance URL. The default transport resolves cloudId from the
// unauthenticated /_edge/tenant_info endpoint, prefers the gateway, and falls back to
// the instance URL on a 401 so classic-token support cannot regress. These exercise
// the seam below the injected `deps.transport` used by the tests above, with a fake
// `fetch` so the routing is unit-testable offline.

const CLOUD_ID = "578ccb7d-3e4f-4d73-84ac-f25955e1e729"; // any UUID-shaped string
const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
const TENANT_INFO = `https://${SITE}/_edge/tenant_info`;

interface FakeRoute {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

/** A fake `fetch`: `route(url, init)` decides the response; every call is recorded. */
function fakeFetch(route: (url: string, init: any) => FakeRoute): {
  fetch: FetchLike;
  calls: { url: string; init: any }[];
} {
  const calls: { url: string; init: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = route(url, init);
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return { ok: r.ok ?? (status >= 200 && status < 300), status, json: async () => r.body };
  };
  return { fetch, calls };
}

describe("resolveCloudId", () => {
  test("parses a UUID cloudId from tenant_info", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { cloudId: CLOUD_ID } }));
    expect(await resolveCloudId(`https://${SITE}`, fetch)).toBe(CLOUD_ID);
    expect(calls[0]!.url).toBe(TENANT_INFO);
  });

  test("a malformed/missing cloudId fails clean, with no backend body bytes", async () => {
    const { fetch } = fakeFetch(() => ({ body: { cloudId: "<b>not-a-uuid</b>" } }));
    await expect(resolveCloudId(`https://${SITE}`, fetch)).rejects.toThrow(/^Jira request failed$/);
    const missing = fakeFetch(() => ({ body: {} }));
    await expect(resolveCloudId(`https://${SITE}`, missing.fetch)).rejects.toThrow(/^Jira request failed$/);
  });

  test("a non-ok tenant_info reduces to status only", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 503 }));
    await expect(resolveCloudId(`https://${SITE}`, fetch)).rejects.toThrow("Jira request failed: 503");
  });
});

describe("defaultTransport gateway routing", () => {
  const saved = { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
  beforeAll(() => {
    process.env.JIRA_EMAIL = "ada@example.com";
    process.env.JIRA_API_TOKEN = "test-token";
  });
  afterAll(() => {
    if (saved.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = saved.email;
    if (saved.token === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = saved.token;
  });

  test("returns null when the site option is missing", () => {
    expect(defaultTransport(undefined)).toBeNull();
  });

  test("resolves cloudId and targets the gateway base with the Basic-auth header", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url === TENANT_INFO ? { body: { cloudId: CLOUD_ID } } : { body: { displayName: "Ada" } },
    );
    const request = defaultTransport(SITE, fetch)!;
    expect((await request("/rest/api/3/myself")).displayName).toBe("Ada");
    expect(calls[0]!.url).toBe(TENANT_INFO);
    expect(calls[1]!.url).toBe(`${GATEWAY}/rest/api/3/myself`);
    expect(calls[1]!.init!.headers.Authorization).toMatch(/^Basic /);
  });

  test("resolves cloudId at most once across multiple requests", async () => {
    let tenantHits = 0;
    const { fetch } = fakeFetch((url) => {
      if (url === TENANT_INFO) {
        tenantHits++;
        return { body: { cloudId: CLOUD_ID } };
      }
      return { body: { issues: [], isLast: true } };
    });
    const request = defaultTransport(SITE, fetch)!;
    await request("/rest/api/3/myself");
    await request("/rest/api/3/search/jql", { method: "POST", body: {} });
    expect(tenantHits).toBe(1);
  });

  test("falls back to the instance URL on a gateway 401 and stays there", async () => {
    const targets: string[] = [];
    const { fetch } = fakeFetch((url) => {
      if (url === TENANT_INFO) return { body: { cloudId: CLOUD_ID } };
      targets.push(url);
      if (url.startsWith(GATEWAY)) return { ok: false, status: 401 };
      return { body: { displayName: "Classic" } };
    });
    const request = defaultTransport(SITE, fetch)!;
    expect((await request("/rest/api/3/myself")).displayName).toBe("Classic");
    expect(targets[0]!).toBe(`${GATEWAY}/rest/api/3/myself`); // gateway tried first
    expect(targets[1]!).toBe(`https://${SITE}/rest/api/3/myself`); // retried on instance
    expect((await request("/rest/api/3/myself")).displayName).toBe("Classic");
    expect(targets[2]!).toBe(`https://${SITE}/rest/api/3/myself`); // sticky: no repeat gateway attempt
    expect(targets).toHaveLength(3);
  });

  test("a non-401 gateway error scrubs to status only and does not fall back", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url === TENANT_INFO ? { body: { cloudId: CLOUD_ID } } : { ok: false, status: 500 },
    );
    const request = defaultTransport(SITE, fetch)!;
    await expect(request("/rest/api/3/myself")).rejects.toThrow("Jira request failed: 500");
    expect(calls.some((c) => c.url.startsWith(`https://${SITE}/rest`))).toBe(false); // instance never hit
  });
});
