// The composition root (ADR-0008 §2) for `digest`, `status` and `login`. It takes
// the source descriptors and the Summarizer as arguments, so nothing here imports a
// production source or the model call: cli.ts passes the static registry and the
// real `summarize`, and tests pass fakes. Wiring only: no domain logic, no argument
// parsing, no process I/O. Each command returns data or events; cli.ts renders them.

import { resolveConfig, ConfigError } from "./config.ts";
import type { WindowSelector } from "./temporal.ts";
import { aggregate } from "./aggregate.ts";
import { digest } from "./digester.ts";
import type { Digest } from "./digest-contract.ts";
import type { summarize } from "./summarize.ts";
import { buildRegistry, type Descriptors, type Source, type SourceStatus } from "./sources/source.ts";
import { noDebug, type DebugSink } from "./debug.ts";

/** What the root is composed from: the source descriptors and the Summarizer. */
export interface RootDeps {
  descriptors: Descriptors;
  summarize: typeof summarize;
}

export interface DigestOptions {
  windowOverride?: WindowSelector;
  /** Per-run `--source` narrowing: run only these configured sources (empty/undefined = all). */
  sourceFilter?: string[];
  now?: Date;
  /** Optional progress sink (trusted status only) — cli.ts routes this to stderr for TTYs. */
  onProgress?: (message: string) => void;
  /**
   * Structural debug sink (ADR-0015). Distinct from `onProgress`: that one carries
   * human-facing strings and is TTY-gated, this one carries typed trusted-scalar
   * events and is emitted whenever debug is on, piped or not.
   */
  onDebug?: DebugSink;
}

export interface StatusOptions {
  /** The environment the summarizer credential is read from (ADR-0009 §4). */
  env: Record<string, string | undefined>;
  onDebug?: DebugSink;
}

/** The single next step `status` recommends, in priority order. */
export type StatusNext = "export-key" | "login" | "fix-config" | "digest";

export type StatusReport =
  | { kind: "invalid-config"; message: string }
  | {
      kind: "ok";
      timezone: string;
      windowSpan: string;
      /** Whether ANTHROPIC_API_KEY is set. */
      summarizerKey: boolean;
      /** Each selected source's status, in config order. */
      sources: { key: string; status: SourceStatus }[];
      /** The keys of the sources that report `not-authenticated`. */
      unauthenticated: string[];
      next: StatusNext;
    };

export interface LoginOptions {
  /** A registry key to log in alone, independent of config; absent walks the configured selection. */
  only?: string;
  /** Receives each source's progress, so the caller can render it before an interactive login blocks. */
  onEvent: (event: LoginEvent) => void;
  onDebug?: DebugSink;
}

export type LoginEvent =
  | { key: string; phase: "already"; identity?: string }
  | { key: string; phase: "authenticating" }
  | { key: string; phase: "authenticated"; identity: string };

export interface LoginResult {
  /** Whether this was a `login <source>` run rather than a walk over the configured selection. */
  targeted: boolean;
  /** How many sources were newly authenticated. */
  authenticated: number;
}

export interface Rundown {
  digest(opts?: DigestOptions): Promise<Digest>;
  status(opts: StatusOptions): Promise<StatusReport>;
  login(opts: LoginOptions): Promise<LoginResult>;
}

export function composeRundown({ descriptors, summarize }: RootDeps): Rundown {
  return {
    async digest(opts = {}) {
      const progress = opts.onProgress ?? (() => {});
      const debug = opts.onDebug ?? noDebug;
      // The run's single clock: read once here. It resolves the window and becomes the digest's
      // `generatedAt`, so the two can never disagree. Downstream stages have no `new Date()`.
      const now = opts.now ?? new Date();
      const config = await resolveConfig(descriptors, {
        windowOverride: opts.windowOverride,
        sourceFilter: opts.sourceFilter,
        now,
      });

      // Build only the selected sources, with their resolved config injected (#27).
      const sources = buildRegistry(descriptors, config.selection, debug);

      const keys = config.selection.map((s) => s.sourceKey).join(", ");
      progress(`Pulling ${config.selection.length} source(s) (${keys}) for ${config.windowSpan}…`);
      const bundle = await aggregate(config.window, config.selection, sources, debug);

      if (bundle.records.length === 0) {
        progress("No records in the window; emitting an empty digest.");
      } else {
        progress(`Read ${bundle.records.length} record(s); grouping them into digest entries…`);
      }
      return digest(
        bundle,
        { window: config.window, timezone: config.timezone, generatedAt: now.toISOString() },
        { summarize, onProgress: progress },
      );
    },

    async status({ env, onDebug }) {
      let config;
      try {
        config = await resolveConfig(descriptors);
      } catch (e) {
        if (e instanceof ConfigError) return { kind: "invalid-config", message: e.message };
        throw e;
      }

      const summarizerKey = Boolean(env.ANTHROPIC_API_KEY);
      // Build the selected sources (config injected) to query their live status (#27).
      const built = buildRegistry(descriptors, config.selection, onDebug ?? noDebug);
      const sources: { key: string; status: SourceStatus }[] = [];
      for (const { sourceKey } of config.selection) {
        sources.push({ key: sourceKey, status: await built[sourceKey]!.status() });
      }
      const unauthenticated = sources.filter((s) => s.status.state === "not-authenticated").map((s) => s.key);
      const allReady = sources.every((s) => s.status.state === "ready");

      const next: StatusNext = !summarizerKey
        ? "export-key"
        : unauthenticated.length > 0
          ? "login"
          : !allReady
            ? "fix-config"
            : "digest";

      return {
        kind: "ok",
        timezone: config.timezone,
        windowSpan: config.windowSpan,
        summarizerKey,
        sources,
        unauthenticated,
        next,
      };
    },

    async login({ only, onEvent, onDebug }) {
      const debug = onDebug ?? noDebug;

      // Log in one source, reporting progress before the interactive step blocks.
      // Returns whether it newly authenticated (false when it was already ready).
      async function loginOne(key: string, source: Source): Promise<boolean> {
        const st = await source.status();
        if (st.state === "ready") {
          onEvent({ key, phase: "already", identity: st.identity });
          return false;
        }
        onEvent({ key, phase: "authenticating" });
        const identity = await source.login();
        onEvent({ key, phase: "authenticated", identity });
        return true;
      }

      // Targeted mode: one registered source, independent of the user's config
      // selection — pre-authenticating a source before adding it to config.json is
      // legitimate, and the registry key is the only thing that needs resolving.
      if (only !== undefined) {
        const descriptor = descriptors[only];
        if (!descriptor) {
          throw new Error(`Unknown source "${only}". Registered sources: ${Object.keys(descriptors).join(", ")}`);
        }
        // Config-independent: build with empty config (#27). A source that needs config
        // reports `not-configured` from status(), which the login paths already narrate.
        const authenticated = (await loginOne(only, descriptor.build({}, debug))) ? 1 : 0;
        return { targeted: true, authenticated };
      }

      // Bare mode: walk every configured-but-unauthenticated source.
      const config = await resolveConfig(descriptors);
      const sources = buildRegistry(descriptors, config.selection, debug);
      let authenticated = 0;
      for (const { sourceKey } of config.selection) {
        if (await loginOne(sourceKey, sources[sourceKey]!)) authenticated++;
      }
      return { targeted: false, authenticated };
    },
  };
}
