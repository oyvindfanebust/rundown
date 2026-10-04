import { test, expect, describe } from "bun:test";
import { untrusted } from "../src/trust.ts";
import type { AnnotatedItem, Bucket, Bundle, CalendarEvent, ChatMessage, Email } from "../src/domain.ts";
import {
  calendarEventRecord,
  chatMessageRecord,
  emailRecord,
  type CalendarEventSpec,
  type ChatMessageSpec,
  type EmailSpec,
} from "../src/sources/normalize.ts";
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

// The trusted planning context most tests share; UTC keeps rendered instants
// byte-identical to the fixtures' `Z` timestamps.
const CTX = { windowIsPast: false, timezone: "UTC" };
const PAST_CTX = { windowIsPast: true, timezone: "UTC" };

// renderBundle returns {data, index} (the ref index feeds evidence resolution, #54);
// these tests assert on the rendered text.
const renderText = (b: Bundle) => renderBundle(b, "UTC").data;

function bundle(items: Bundle["items"]): Bundle {
  return { window, sources: [{ source: "graph", itemCount: items.length }], items };
}

/** A Slack message record in a channel, written by Ada, as the Slack source builds it. */
function chat(over: Partial<ChatMessageSpec> = {}, bucket: Bucket = "recent"): ChatMessage & { bucket: Bucket } {
  const record = chatMessageRecord({
    channelId: "C1",
    ts: "1783414800.000100",
    at: "2026-07-07T09:00:00Z",
    conversation: { kind: "channel", isExternal: false, name: "flow-mgmt" },
    author: { name: "Ada Lovelace", handle: "U2", isMe: false },
    mentionsMe: true,
    text: "Board meeting",
    ...over,
  });
  return { ...record, bucket };
}

/** An inbox mail record, as the Graph source builds it. */
function mailRecord(over: Partial<EmailSpec> = {}, bucket: Bucket = "recent"): Email & { bucket: Bucket } {
  const record = emailRecord({
    id: "m1",
    continuesFromBefore: false,
    at: "2026-07-07T11:00:00Z",
    folder: "inbox",
    subject: "Status",
    from: { name: "Kari Nord", handle: "kari@x.test", isMe: false },
    to: [],
    cc: [],
    body: "",
    importance: "normal",
    isRead: true,
    flagged: false,
    hasAttachments: false,
    inferenceClassification: "focused",
    ...over,
  });
  return { ...record, bucket };
}

const item = chat();

describe("renderBundle", () => {
  test("groups by bucket and unwraps untrusted fields", () => {
    const rendered = renderText(bundle([chat({ text: "Board meeting" })]));
    expect(rendered).toContain("RECENT");
    expect(rendered).toContain("title: Board meeting");
    expect(rendered).toContain("author: Ada Lovelace");
  });
});

describe("renderBundle — length caps", () => {
  test("truncates an oversized rendered field with a visible marker at 2,000 chars", () => {
    // Built past the record builder's own cap, so the render-time cap is what is tested.
    const oversized: AnnotatedItem = { ...chat(), text: untrusted("x".repeat(2_500)) };
    const rendered = renderText(bundle([oversized]));

    expect(rendered).toContain("…[truncated]");
    // title line: "  title: " + 2000 x's + marker, nothing beyond.
    const titleLine = rendered.split("\n").find((l) => l.startsWith("  title:"))!;
    expect(titleLine).toBe(`  title: ${"x".repeat(2_000)}…[truncated]`);
    expect(rendered).not.toContain("x".repeat(2_001));
  });

  test("leaves a field at or under the cap untouched", () => {
    const title = "x".repeat(2_000);
    const rendered = renderText(bundle([{ ...chat(), text: untrusted(title) }]));
    expect(rendered).toContain(`  title: ${title}`);
    expect(rendered).not.toContain("…[truncated]");
  });
});

describe("plan", () => {
  test("short-circuits an empty bundle with no model call", async () => {
    const { summarize, calls } = fakeSummarizer();
    const brief = await plan(bundle([]), CTX, { summarize });
    expect(brief.summary).toBe("");
    expect(brief.items).toEqual([]);
    expect(brief.envelope.sources).toEqual([{ source: "graph", itemCount: 0 }]);
    expect(calls).toHaveLength(0); // the empty-bundle short-circuit skips the Summarizer entirely
  });

  test("attaches the trusted envelope and the Summarizer's output", async () => {
    const { summarize } = fakeSummarizer();
    const brief = await plan(bundle([item]), CTX, { summarize });
    expect(brief.envelope.window).toEqual(window);
    expect(brief.envelope.timezone).toBe("UTC");
    expect(brief.summary).toContain("meeting");
    expect(brief.items[0]!.kind).toBe("commitment");
  });

  test("maps windowIsPast=false to the planning task", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), CTX, { summarize });
    expect(calls[0]!.instructions).toContain("plan my week");
  });

  test("maps windowIsPast=true to the retrospective task", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), PAST_CTX, { summarize });
    expect(calls[0]!.instructions).toContain("look-back");
    expect(calls[0]!.instructions).toContain("retrospective");
  });

  test("appends user guidance to the task instructions", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), { ...CTX, guidance: "focus on the launch" }, { summarize });
    expect(calls[0]!.instructions).toContain("Additional guidance from the user:");
    expect(calls[0]!.instructions).toContain("focus on the launch");
  });

  test("renders the bundle into the Summarizer's untrusted data string", async () => {
    const { summarize, calls } = fakeSummarizer();
    await plan(bundle([item]), CTX, { summarize });
    expect(calls[0]!.data).toContain("title: Board meeting");
  });
});

describe("plan — defang transform", () => {
  // A source item whose title itself carries the hostile markdown/URL text, so the
  // evidence quote below is a genuine verbatim substring of the rendered bundle (it
  // must survive evidence-quote verification once that lands, not just the
  // defang transform). This models a real hostile source, e.g. a meeting title
  // crafted for render-time exfiltration — not a fabricated quote.
  const hostileItem = chat({ text: "click here ![img](https://evil.example/?q=quote)" });

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
    const brief = await plan(bundle([hostileItem]), CTX, { summarize });

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
    const brief = await plan(bundle([item]), CTX, { summarize });
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
    const brief = await plan(bundle([item]), CTX, { summarize });

    expect(brief.summary).toBe(output.summary);
    expect(brief.items[0]!.summary).toBe(output.items[0]!.summary);
    expect(brief.items[0]!.when).toBe(output.items[0]!.when);
    expect(brief.items[0]!.evidence[0]!.quote).toBe(output.items[0]!.evidence[0]!.quote);
  });
});

describe("plan — evidence-quote verification", () => {
  // A title with irregular internal spacing so a line-wrapped quote (below) still
  // matches after whitespace normalization.
  const verifyItem = chat({ text: "Board meeting for Q3 planning" });

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
    const brief = await plan(bundle([verifyItem]), CTX, { summarize });

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
    const first = chat({ text: "Sounds good, I'll take a look this afternoon" });
    const second = mailRecord({
      id: "m2",
      at: "2026-07-07T11:00:00Z",
      subject: "Q3 budget figures — need your numbers by Friday",
      from: { name: "Kari Nord", handle: "kari@x.test", isMe: false },
    });

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
      const brief = await plan(bundle([first, second]), CTX, { summarize });

      expect(brief.items[0]!.evidence).toEqual([
        {
          source: "slack/message",
          fingerprint: first.fingerprint,
          where: "#flow-mgmt",
          who: ["Ada Lovelace"],
          relationship: "mentions",
          quote: "take a look this afternoon",
        },
      ]);
    });

    // #94: a DM's `where` and `who` read the same both ways, so without the
    // relationship a consumer attributes the user's own words to the counterpart.
    test("copies the item's relationship, so two entries from one DM differ by direction", async () => {
      const alice = { name: "Alice", handle: "U3", isMe: false };
      const me = { name: "Me", handle: "U1", isMe: true };
      const conversation = { kind: "dm" as const, isExternal: false, members: [alice] };
      const dm = chat({ channelId: "D1", conversation, author: alice, mentionsMe: false, text: "Can you look at the deploy?" });
      const reply = chat({
        channelId: "D1",
        ts: "1783415100.000100",
        at: "2026-07-07T09:05:00Z",
        conversation,
        author: me,
        mentionsMe: false,
        text: "Yes, on it after lunch",
      });
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "commitment",
            summary: "Deploy check",
            evidence: [
              { ref: 1, quote: "look at the deploy" },
              { ref: 2, quote: "on it after lunch" },
            ],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([dm, reply]), CTX, { summarize });

      const [incoming, outgoing] = brief.items[0]!.evidence;
      expect(incoming!.where).toBe("DM with Alice");
      expect(outgoing!.where).toBe("DM with Alice");
      expect(incoming!.who).toEqual(["Alice"]);
      expect(outgoing!.who).toEqual(["Alice"]);
      expect(incoming!.relationship).toBe("dms");
      expect(outgoing!.relationship).toBe("authored");
      expect(incoming).not.toEqual(outgoing!);
    });

    test("omits the field entirely for an item whose attribution has no relationship", async () => {
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "task",
            summary: "Budget numbers",
            evidence: [{ ref: 2, quote: "need your numbers by Friday" }],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([first, second]), CTX, { summarize });

      const entry = brief.items[0]!.evidence[0]!;
      expect(entry.relationship).toBeUndefined();
      expect(Object.keys(entry)).not.toContain("relationship");
    });

    test("defangs and truncates a hostile channel name like the other labels", async () => {
      const hostile = chat({
        conversation: {
          kind: "channel",
          isExternal: false,
          name: `![](https://evil.example/?q=where)${"w".repeat(150)}`,
        },
        text: "Sounds good, I'll take a look this afternoon",
      });
      const output: SummarizerOutput = {
        summary: "s",
        items: [
          {
            kind: "task",
            summary: "Hostile label",
            evidence: [{ ref: 1, quote: "take a look this afternoon" }],
          },
        ],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([hostile]), CTX, { summarize });

      const where = brief.items[0]!.evidence[0]!.where!;
      expect(where).not.toContain("https://");
      expect(where).not.toContain("![");
      // Clamped as it is filled, before the defang transform shortens it further.
      expect(where.length).toBeLessThanOrEqual(120);
      expect(where.trimEnd().endsWith("w")).toBe(true);
    });

    // #86: a large meeting used to kill the whole run — the code-filled `who` exceeded
    // the contract's cap and the final parse threw after the model call was spent.
    // Attribution is now clamped as it is filled, so the Brief survives.
    test("clamps an oversized who list to the contract cap instead of throwing", async () => {
      const crowded = mailRecord({
        subject: "All-hands: take a look this afternoon",
        from: { name: "Person 1", handle: "p1@x.test", isMe: false },
        to: Array.from({ length: 19 }, (_, i) => ({ name: `Person ${i + 2}`, handle: `p${i + 2}@x.test`, isMe: false })),
      });
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
      const brief = await plan(bundle([crowded]), CTX, { summarize });

      const who = brief.items[0]!.evidence[0]!.who!;
      expect(who).toHaveLength(8);
      // Most-salient-first, so the clamp keeps the head of the list.
      expect(who[0]).toBe("Person 1");
      expect(who[7]).toBe("Person 8");
    });

    test("truncates an over-long name and where label to the label cap", async () => {
      const longName = "N".repeat(150);
      const wordy = chat({
        conversation: { kind: "channel", isExternal: false, name: "W".repeat(150) },
        author: { name: longName, handle: "U2", isMe: false },
        text: "Sounds good, I'll take a look this afternoon",
      });
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
      const brief = await plan(bundle([wordy]), CTX, { summarize });

      const entry = brief.items[0]!.evidence[0]!;
      expect(entry.who).toEqual(["N".repeat(120)]);
      // `#` plus the name, clamped to the label cap.
      expect(entry.where).toBe(`#${"W".repeat(119)}`);
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
      const brief = await plan(bundle([first, second]), CTX, { summarize });

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
      const brief = await plan(bundle([first, second]), CTX, { summarize });

      expect(brief.items[0]!.evidence).toEqual([]);
    });

    test("omits where and who when a DM has no readable counterpart and the user wrote it", async () => {
      const bare = chat({
        channelId: "D1",
        conversation: { kind: "dm", isExternal: false, members: [] },
        author: { name: "Me", handle: "U1", isMe: true },
        mentionsMe: false,
        text: "Sounds good",
      });
      const output: SummarizerOutput = {
        summary: "s",
        items: [{ kind: "fyi", summary: "x", evidence: [{ ref: 1, quote: "Sounds good" }] }],
      };
      const { summarize } = fakeSummarizer(output);
      const brief = await plan(bundle([bare]), CTX, { summarize });

      expect(brief.items[0]!.evidence).toEqual([
        { source: "slack/message", fingerprint: bare.fingerprint, relationship: "authored", quote: "Sounds good" },
      ]);
    });

    // Refs are assigned in render order across the whole bundle, and the bundle renders
    // standing → recent → upcoming — so numbering crosses bucket-section boundaries.
    test("numbers items across buckets in render order, not per bucket", async () => {
      const standing = { ...mailRecord({ subject: "Standing item" }), bucket: "standing" as const };
      const rendered = renderBundle(bundle([first, standing]), "UTC");
      expect(rendered.data).toContain("- [1] [graph/message]"); // standing renders first
      expect(rendered.data).toContain("- [2] [slack/message]");
      expect(rendered.index.get(1)!.item.title).toBe("Standing item");
    });

    test("renders attribution for the model alongside extras", () => {
      const rendered = renderBundle(bundle([first]), "UTC");
      expect(rendered.data).toContain("  where: #flow-mgmt");
      expect(rendered.data).toContain("  who: Ada Lovelace");
      expect(rendered.data).toContain("  relationship: mentions");
    });
  });
});

describe("renderBundle — timezone (#106)", () => {
  test("renders instants as local wall time with an explicit offset, and names the zone", () => {
    const rendered = renderBundle(bundle([chat({ at: "2026-07-07T08:00:00Z" })]), "Europe/Oslo").data;
    expect(rendered).toContain("Tue 2026-07-07T10:00:00+02:00");
    expect(rendered).toContain("(times shown in Europe/Oslo)");
    // The window line is zoned too.
    expect(rendered).toContain("Window: 2026-07-06T02:00:00+02:00 to 2026-07-13T02:00:00+02:00");
  });
  // Date-only rendering is covered by the all-day event test under #148 below.
});

describe("plan — evidence fingerprint (#108)", () => {
  const output: SummarizerOutput = {
    summary: "One meeting.",
    items: [
      {
        kind: "commitment",
        summary: "Board meeting",
        evidence: [{ ref: 1, quote: "Board meeting" }],
      },
    ],
  };

  test("copies the cited record's fingerprint into the resolved entry, stable across runs", async () => {
    const first = await plan(bundle([chat()]), CTX, fakeSummarizer(output));
    const second = await plan(bundle([chat()]), CTX, fakeSummarizer(output));
    expect(first.items[0]!.evidence[0]!.fingerprint).toBe(item.fingerprint);
    // The dedup contract: same source item in two Briefs → equal fingerprints.
    expect(second.items[0]!.evidence[0]!.fingerprint).toBe(first.items[0]!.evidence[0]!.fingerprint!);
  });

  test("the model cannot supply a fingerprint — it is not in the Summarizer's schema", async () => {
    const { summarize, calls } = fakeSummarizer(output);
    await plan(bundle([item]), CTX, { summarize });
    // Never rendered to the model either: the digest is not in the bundle data.
    expect(calls[0]!.data).not.toContain(item.fingerprint);
  });
});

// ── Slack as typed ChatMessage records (#149) ──
//
// Until the Digester replaces the Planner, the Brief renders and cites a ChatMessage as
// it did the old Slack `message` item. The url line and the query family go, and the
// conversation's entryKey digest stands in for the channel id.

describe("plan — Slack as ChatMessage records (#149)", () => {
  test("renders a channel message as a slack/message item with its old lines", () => {
    const record = chat({ text: "hi @Me" });
    const rendered = renderText(bundle([record]));
    expect(rendered).toContain("- [1] [slack/message] Tue 2026-07-07T09:00:00Z");
    for (const line of [
      "  title: hi @Me",
      "  where: #flow-mgmt",
      "  who: Ada Lovelace",
      "  relationship: mentions",
      `  channel: {"id":"${record.entryKey}","name":"flow-mgmt","type":"channel"}`,
      "  author: Ada Lovelace",
    ]) {
      expect(rendered).toContain(line);
    }
    expect(rendered).not.toContain("url:");
    expect(rendered).not.toContain("C1");
    expect(rendered).not.toContain("U2");
  });

  test("labels my DM with the counterpart and marks it authored", () => {
    const rendered = renderText(
      bundle([
        chat({
          channelId: "D1",
          conversation: { kind: "dm", isExternal: true, members: [{ name: "Bent Hansen", handle: "U9", isMe: false }] },
          author: { name: "Me", handle: "U1", isMe: true },
          mentionsMe: false,
          text: "on it",
        }),
      ]),
    );
    for (const line of [
      "  where: DM with Bent Hansen",
      "  who: Bent Hansen",
      "  relationship: authored",
      "  counterpart: Bent Hansen",
      "  fromMe: true",
      "  external: true",
    ]) {
      expect(rendered).toContain(line);
    }
  });

  test("labels a group DM generically and an empty message as having no text", () => {
    const rendered = renderText(
      bundle([
        chat({
          channelId: "G1",
          conversation: { kind: "group_dm", isExternal: false, members: [] },
          mentionsMe: false,
          text: "",
        }),
      ]),
    );
    expect(rendered).toContain("  title: (no message text)");
    expect(rendered).toContain("  where: Group DM");
    expect(rendered).toContain("  relationship: dms");
  });
});

// ── Graph mail as typed Email records (#147) ──
//
// The Graph source now emits mail as `Email` records. Until the Digester replaces the
// Planner, the Brief renders and cites them exactly as it did the old `message` items.

describe("plan — Graph mail as Email records (#147)", () => {
  function mail(over: Partial<EmailSpec> = {}): Email & { bucket: "recent" } {
    const record = emailRecord({
      id: "m1",
      groupId: "conv-1",
      continuesFromBefore: false,
      at: "2026-07-09T10:00:00Z",
      folder: "inbox",
      subject: "Re: launch",
      from: { name: "Carol", handle: "carol@x.test", isMe: false },
      to: [{ name: "Me", handle: "me@x.test", isMe: true }],
      cc: [],
      body: "Can you confirm the launch date by Friday?",
      importance: "high",
      isRead: false,
      flagged: false,
      hasAttachments: false,
      inferenceClassification: "focused",
      ...over,
    });
    return { ...record, bucket: "recent" };
  }

  test("renders an inbox message as a graph/message item with its old lines", () => {
    const rendered = renderText(bundle([mail()]));
    expect(rendered).toContain("- [1] [graph/message] Thu 2026-07-09T10:00:00Z");
    for (const line of [
      "  title: Re: launch",
      "  where: Inbox",
      "  who: Carol, Me",
      "  folder: inbox",
      "  from: Carol",
      "  to: Me",
      "  preview: Can you confirm the launch date by Friday?",
      "  importance: high",
      "  unread: true",
    ]) {
      expect(rendered).toContain(line);
    }
  });

  test("renders sent mail with recipients first and drops no-signal fields", () => {
    const rendered = renderText(
      bundle([
        mail({
          folder: "sent",
          from: { name: "Me", handle: "me@x.test", isMe: true },
          to: [{ name: "Carol", handle: "carol@x.test", isMe: false }],
          importance: "normal",
          isRead: true,
        }),
      ]),
    );
    expect(rendered).toContain("  where: Sent");
    expect(rendered).toContain("  who: Carol, Me");
    expect(rendered).not.toContain("importance:");
    expect(rendered).not.toContain("unread:");
  });

  test("falls back to the address when a person has no display name, as before", () => {
    const rendered = renderText(bundle([mail({ from: { handle: "noreply@x.test", isMe: false } })]));
    expect(rendered).toContain("  from: noreply@x.test");
    expect(rendered).toContain("  who: noreply@x.test, Me");
  });

  test("caps an address used as a caption like any other label", () => {
    const rendered = renderText(bundle([mail({ from: { handle: `${"a".repeat(300)}@x.test`, isMe: false } })]));
    expect(rendered).toContain(`  from: ${"a".repeat(255)}\n`);
  });

  test("cites a mail record with the old evidence shape and the record's fingerprint", async () => {
    const record = mail();
    const output: SummarizerOutput = {
      summary: "s",
      items: [{ kind: "task", summary: "Confirm the date", evidence: [{ ref: 1, quote: "confirm the launch date" }] }],
    };
    const brief = await plan(bundle([record]), CTX, fakeSummarizer(output));
    expect(brief.items[0]!.evidence).toEqual([
      {
        source: "graph/message",
        fingerprint: record.fingerprint,
        where: "Inbox",
        who: ["Carol", "Me"],
        quote: "confirm the launch date",
      },
    ]);
  });
});

// ── Graph calendar as typed CalendarEvent records (#148) ──
//
// Until the Digester replaces the Planner, the Brief renders and cites a CalendarEvent
// as it did the old `event` item: same kind, span, who and extras keys. The url and
// categories lines go; a rooms line joins, and location keeps only what it says beyond
// the rooms.

describe("plan — Graph calendar as CalendarEvent records (#148)", () => {
  function meeting(over: Partial<CalendarEventSpec> = {}): CalendarEvent & { bucket: "recent" } {
    const record = calendarEventRecord({
      id: "e1",
      groupId: "series-1",
      continuesFromBefore: false,
      isAllDay: false,
      start: "2026-07-08T09:00:00Z",
      end: "2026-07-08T09:30:00Z",
      title: "Launch review",
      organizer: { name: "Alice", handle: "alice@x.test", isMe: false },
      isOrganizer: false,
      attendees: [
        { name: "Bob", handle: "bob@x.test", isMe: false, response: "accepted", optional: false },
        { handle: "nameless@x.test", isMe: false, response: "none", optional: true },
      ],
      rooms: ["Fjord"],
      myResponse: "tentativelyAccepted",
      showAs: "busy",
      isCancelled: false,
      isOnlineMeeting: true,
      recurring: true,
      ...over,
    });
    return { ...record, bucket: "recent" };
  }

  test("renders a timed event as a graph/event item with its old lines", () => {
    const rendered = renderText(bundle([meeting()]));
    expect(rendered).toContain("- [1] [graph/event] Wed 2026-07-08T09:00:00Z – 2026-07-08T09:30:00Z");
    for (const line of [
      "  title: Launch review",
      "  who: Alice, Bob",
      "  organizer: Alice",
      "  attendees: Bob",
      "  rooms: Fjord",
      "  showAs: busy",
      "  myResponse: tentativelyAccepted",
    ]) {
      expect(rendered).toContain(line);
    }
    expect(rendered).not.toContain("url:");
    expect(rendered).not.toContain("location:");
    expect(rendered).not.toContain("where:");
    expect(rendered).not.toContain("allDay:");
    expect(rendered).not.toContain("cancelled:");
    // Addresses never leave as captions on events.
    expect(rendered).not.toContain("nameless@x.test");
  });

  test("renders an all-day event as its calendar dates and a cancelled one as cancelled", () => {
    const rendered = renderBundle(
      bundle([meeting({ isAllDay: true, start: "2026-07-07", end: "2026-07-10", isCancelled: true })]),
      "America/New_York",
    ).data;
    expect(rendered).toContain("[graph/event] Tue 2026-07-07 – Thu 2026-07-09");
    expect(rendered).toContain("  allDay: true");
    expect(rendered).toContain("  cancelled: true");
    expect(rendered).not.toContain("2026-07-06");
  });

  test("renders a free-text location after the rooms", () => {
    const rendered = renderText(bundle([meeting({ location: "Café Fjord" })]));
    expect(rendered).toContain("  rooms: Fjord\n  location: Café Fjord\n");
  });

  test("renders an event with an empty organizer without an organizer line", () => {
    const rendered = renderText(bundle([meeting({ organizer: { isMe: false } })]));
    expect(rendered).toContain("  who: Bob");
    expect(rendered).not.toContain("organizer:");
  });

  test("cites an event with the old evidence shape and the record's fingerprint", async () => {
    const record = meeting();
    const output: SummarizerOutput = {
      summary: "s",
      items: [{ kind: "commitment", summary: "Launch review", evidence: [{ ref: 1, quote: "Launch review" }] }],
    };
    const brief = await plan(bundle([record]), CTX, fakeSummarizer(output));
    expect(brief.items[0]!.evidence).toEqual([
      { source: "graph/event", fingerprint: record.fingerprint, who: ["Alice", "Bob"], quote: "Launch review" },
    ]);
  });
});
