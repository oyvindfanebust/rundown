// The ubiquitous language — the shared vocabulary types every component speaks.
// One readable home for the domain nouns (CONTEXT.md is their prose definition).
// `Untrusted<T>` lives in trust.ts because it is a cross-cutting security
// primitive, not a domain noun.

import type { Untrusted } from "./trust.ts";
import type { BriefItem } from "./brief-contract.ts";

/** An absolute time window: two ISO-8601 instants. `to` is exclusive. */
export interface Window {
  from: string;
  to: string;
}

/**
 * Who and where — the attribution every source has, under a different name each time
 * (#54). Before this, `where`/`who` were buried in `extras` under five vocabularies
 * (`folder`, `project`+`team`, `channel`+`counterpart`, `projectPath`+`gitBranch`),
 * so the Brief had nothing uniform to carry and the model was asked for attribution
 * prose it could get wrong.
 *
 * Two ideas make it work:
 *
 * 1. Uniform slot, source-specific wording. Each source writes its own honest label
 *    into `where` — Slack decides between "#flow-mgmt" and "DM with Ada Lovelace",
 *    Graph mail says "Inbox" or "Sent". The container is
 *    not forced into a shared vocabulary it does not have.
 * 2. It splits the two audiences `extras` used to serve at once. `attribution` is
 *    human-facing: pre-formatted labels, code-copied into Brief evidence, never
 *    model-supplied. `extras` stays the summarizer's clustering material — ids,
 *    states, flags, roles. A `channel.id` in `extras` and a `where` of "#flow-mgmt"
 *    are not duplication: one is a join key, the other is a caption.
 *
 * Untrusted like every other backend-controlled field: display names and channel
 * names are source bytes, so they are branded here and defanged on the way out.
 * Code-copied means unfabricated, not trusted.
 */
export interface Attribution {
  /** Human label for the container this item lives in. Omitted when there is no honest one. */
  where?: string;
  /** People involved, most salient first. Roles stay in `extras` — this is caption text. */
  who?: string[];
  /** Why this item is the user's: authored | mentions | dms | assigned | created | … */
  relationship?: string;
}

/**
 * The common shape every Source emits (ADR-0002 §4). A thin structural-trusted
 * core the Aggregator groups/orders/attributes by, plus untrusted backend content.
 */
export interface NormalizedItem {
  // ── structural (trusted) — produced by rundown's own source module ──
  /** Registry key / provenance. */
  source: string;
  /** "event" | "message" | "issue" | "session" | … */
  kind: string;
  /** Primary instant (the ordering key), ISO-8601 with offset. */
  timestamp: string;
  /** Optional interval end (events, sessions). */
  end?: string;
  /**
   * `timestamp`/`end` encode a calendar date, not a clock time — an all-day event's
   * UTC-midnight bounds, a due date's synthetic end-of-day anchor. Set by the source
   * module (a domain judgment, not backend bytes); the renderer shows the UTC
   * calendar date instead of an offset-shifted wall time, which would land on the
   * wrong local day (#106).
   */
  dateOnly?: boolean;
  /**
   * Stable identity for cross-window dedup (#108): a truncated SHA-256 of
   * `source + kind + raw backend id`, computed by the normalizer. Trusted because it
   * is a one-way digest — no backend bytes survive into it — and structural because
   * rundown's own code derives it. Absent when the backend supplied no id. Same item
   * in two Briefs → same fingerprint; that is its whole contract.
   */
  fingerprint?: string;

  // ── untrusted (backend content) — a hostile backend controls these bytes ──
  id: Untrusted<string>;
  title: Untrusted<string>;
  url?: Untrusted<string>;
  /** Who and where, uniform across sources — the Brief's evidence attribution. */
  attribution?: Untrusted<Attribution>;
  /** All source-specific fields: people/roles, body/preview, status, … */
  extras?: Untrusted<Record<string, unknown>>;
}

/** The derived, structural-trusted temporal label on each bundled item (ADR-0003 §4). */
export type Bucket = "standing" | "recent" | "upcoming";

/** A NormalizedItem plus its derived bucket. */
export type AnnotatedItem = NormalizedItem & { bucket: Bucket };

/** One entry in the Bundle's provenance manifest — trusted scalars only. */
export interface SourceManifestEntry {
  source: string;
  itemCount: number;
}

/**
 * The single normalized structure the Aggregator hands toward the Summarizer
 * (ADR-0003 §3). Wholly untrusted (it carries `extras`); flows only
 * Aggregator → Summarizer as a sealed in-process value, never to the agent.
 */
export interface Bundle {
  window: Window;
  sources: SourceManifestEntry[];
  items: AnnotatedItem[];
}

// ── Brief (the Planner's output; ADR-0005 §2–4) ──

// The Brief's output contract — `ExtractedKind`, `Evidence`, `ExtractedItem`, and
// the `SummarizerOutput` pair — is defined once in brief-contract.ts (a Zod source
// of truth; ADR-0011); import it from there directly. `Brief` itself stays here —
// it wraps the summarizer's output in the trusted envelope, so it composes the
// contract's `BriefItem` (post-resolution) with the domain's Window/manifest.

/**
 * The Planner's output: a trusted envelope around an untrusted-derived core
 * (ADR-0005 §2). The Summarizer emits only `{summary, items}`; the Planner
 * attaches the `envelope` by copying the Bundle's trusted scalars plus the run's
 * timezone. `timezone` is the IANA zone bundle timestamps were rendered in for the
 * Summarizer — the zone the model's `when` phrasing is anchored to — so a consumer
 * never has to guess what clock a Brief speaks (#106).
 */
export interface Brief {
  envelope: {
    window: Window;
    sources: SourceManifestEntry[];
    timezone: string;
  };
  summary: string;
  items: BriefItem[];
}
