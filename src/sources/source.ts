// The Source interface + per-source option-schema declaration (ADR-0002 §2, §5).
// A Source is a read-only adapter for one backend / one auth boundary. The
// required surface is `read` + `status` (every source has a total readiness
// answer); `login` is the opt-in interactive-auth capability a source declares.

import type { NormalizedItem, Window } from "../domain.ts";

/** A single declared config option for a source (drives validation + the init template). */
export interface OptionSpec {
  type: "string[]" | "string" | "boolean" | "number";
  /** Allowed member values for enum-like options (e.g. graph `kinds` ⊆ {event, message}). */
  enum?: readonly string[];
  /** One-line annotation, surfaced verbatim in the `init` template. */
  description: string;
}

/** A source's declared option schema, keyed by option name. */
export type OptionSchema = Record<string, OptionSpec>;

/**
 * Validate one config value against its option spec. Returns the full,
 * user-facing error message on failure, or `null` when valid — the option-schema
 * module owns how to interpret its own `type`, so the switch lives here once.
 * `label` names the offending option in the message (e.g. the config seam's
 * `option "kinds" for source "graph"`). Does not throw; the caller decides.
 */
export function validateOptionValue(spec: OptionSpec, value: unknown, label: string): string | null {
  if (spec.type === "string[]") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return `${label} must be an array of strings.`;
    }
    if (spec.enum) {
      for (const v of value as string[]) {
        if (!spec.enum.includes(v)) {
          return `${label}: "${v}" is not one of ${JSON.stringify(spec.enum)}.`;
        }
      }
    }
  } else if (spec.type === "string" && typeof value !== "string") {
    return `${label} must be a string.`;
  } else if (spec.type === "boolean" && typeof value !== "boolean") {
    return `${label} must be a boolean.`;
  } else if (spec.type === "number" && typeof value !== "number") {
    return `${label} must be a number.`;
  }
  return null;
}

/**
 * The JSON literal fragment the `init` template seeds this option with — the
 * type-appropriate empty default (enum arrays list their allowed members). The
 * counterpart to {@link validateOptionValue}: one switch over `type`, owned here.
 */
export function optionTemplateDefault(spec: OptionSpec): string {
  if (spec.type === "string[]") return spec.enum ? JSON.stringify([...spec.enum]) : "[]";
  if (spec.type === "boolean") return "false";
  if (spec.type === "number") return "0";
  return '""';
}

/**
 * What `status()` reports for one source (ADR-0002 §2, ADR-0007 §7): a
 * discriminated union of the three readiness states, so the nonsensical
 * combinations (`!configured && authenticated`, "no auth applies" masquerading
 * as `authenticated: true`) are unrepresentable and the Aggregator pre-flight is
 * exhaustive. `identity` lives only where it is meaningful (a `ready` source).
 */
export type SourceStatus =
  | { state: "ready"; identity?: string }
  | { state: "not-authenticated" } // configured, interactive, not yet logged in
  | { state: "not-configured"; detail?: string };

/**
 * The user-facing rendering of one {@link SourceStatus}, in parts the three
 * surfaces (the Aggregator pre-flight, `rundown status`, `rundown login`) each
 * compose their own sentence from. Owning the glyph, readiness phrase, trailing
 * clause, and fix-it command here — beside the union, as {@link validateOptionValue}
 * lives beside {@link OptionSpec} — means a wording or CTA change is one edit, not
 * three scattered ones.
 */
export interface StatusNarration {
  /** Status glyph for the per-source `status` line. */
  glyph: "✓" | "✗" | "○";
  /** Bare readiness phrase, e.g. "ready" / "not authenticated" / "not configured". */
  label: string;
  /** Trailing clause: resolved identity, "(no auth required)", or the fix-it detail. */
  note?: string;
  /** The command that moves a not-ready source forward. Absent when already ready. */
  remedy?: string;
}

/**
 * Narrate a {@link SourceStatus}. `interactive` is whether the source has a
 * `login` (its presence is the interactive-auth declaration): it decides only how
 * a `ready`-without-identity source reads — an interactive source is simply
 * "ready", a no-auth local source is "ready (no auth required)".
 */
export function narrateStatus(status: SourceStatus, opts: { interactive: boolean }): StatusNarration {
  switch (status.state) {
    case "ready":
      return {
        glyph: "✓",
        label: "ready",
        note: status.identity ?? (opts.interactive ? undefined : "(no auth required)"),
      };
    case "not-authenticated":
      return { glyph: "✗", label: "not authenticated", remedy: "rundown login" };
    case "not-configured":
      return { glyph: "○", label: "not configured", note: status.detail, remedy: "rundown status" };
  }
}

export interface Source {
  /** Stable registry key / provenance (also the `NormalizedItem.source` value). */
  readonly key: string;
  /** Human-facing label. */
  readonly label: string;

  /**
   * The sole data operation. `window` is absolute; the resolved per-source config
   * is injected at construction (ADR-0002 §5), so `read` closes over `this.config`
   * rather than taking a per-call `options` argument.
   */
  read(window: Window): Promise<NormalizedItem[]>;

  /** Optional interactive auth — only sources with interactive login implement it. Returns identity. */
  login?(): Promise<string>;

  /**
   * Readiness/identity report — **required**: every source has a meaningful
   * total answer to "can I read you right now?" (a local source: always ready).
   * Closes over `this.config`, so no per-call argument (config injection, #27).
   */
  status(): Promise<SourceStatus>;
}

/**
 * A source lookup, keyed by registry key. The seam the Aggregator accepts as a
 * dependency (ADR-0008 §5): the `buildRegistry(selection)` output in production
 * (config-injected instances), an in-memory fake in tests. Injected at the
 * composition root, so no consumer reaches into the module-global registry.
 */
export type Sources = Record<string, Source>;

/**
 * A static source descriptor (ADR-0008 §5, #27): everything about a source that
 * exists before any config does — its key/label, its option schema (read by
 * `init` and config validation), whether it has interactive `login`, and a
 * `build` step that constructs a config-injected instance. The registry is a map
 * of these; `buildRegistry` composes the selected ones into a {@link Sources}.
 */
export interface SourceDescriptor {
  key: string;
  label: string;
  /** Declared per-source options — the config-validation + init-template surface, available without an instance. */
  options: OptionSchema;
  /** Whether the source has interactive `login()` — the static declaration read where no instance exists. */
  interactive: boolean;
  /** Construct the source with its resolved per-source config injected. */
  build(options: Record<string, unknown>): Source;
}

/** The static registry: source key → descriptor. Consumed by config validation, `init`, and `buildRegistry`. */
export type Descriptors = Record<string, SourceDescriptor>;
