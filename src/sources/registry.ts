// The static source registry (ADR-0008 §5, #27): a map of source key → static
// SourceDescriptor. A descriptor holds everything true of a source before any
// config exists — its key/label, its option schema, and a `build` step that
// constructs a config-injected instance.
// The composition root (`src/root.ts`) receives this map as an argument and builds
// the selected sources from it with `buildRegistry` (`source.ts`).
// Adding a source is one import + one descriptor entry — explicit, typed,
// greppable. No self-registration, no dynamic discovery.

import type { Descriptors } from "./source.ts";
import { GraphSource, GRAPH_OPTIONS } from "./graph/index.ts";
import { SlackSource, SLACK_OPTIONS } from "./slack/index.ts";

export const descriptors: Descriptors = {
  graph: {
    key: "graph",
    label: "Microsoft Graph (calendar + mail)",
    options: GRAPH_OPTIONS,
    build: (options, debug) => new GraphSource(options, { debug }),
  },
  slack: {
    key: "slack",
    label: "Slack",
    options: SLACK_OPTIONS,
    build: (options, debug) => new SlackSource(options, { debug }),
  },
};

/** Registered source keys, in a stable order (used by init/status/login). */
export function registeredKeys(): string[] {
  return Object.keys(descriptors);
}
