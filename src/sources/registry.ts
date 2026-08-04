// The static source registry (ADR-0008 §5, #27): a map of source key → static
// SourceDescriptor. A descriptor holds everything true of a source before any
// config exists — its key/label, its option schema, whether it has interactive
// login, and a `build` step that constructs a config-injected instance.
// `buildRegistry(selection)` is the composition step at the composition root: it
// turns the validated config selection into live, config-injected Sources.
// Adding a source is one import + one descriptor entry — explicit, typed,
// greppable. No self-registration, no dynamic discovery.

import type { Descriptors, Sources } from "./source.ts";
import { noDebug, type DebugSink } from "../debug.ts";
import type { Selection } from "../config.ts";
import { GraphSource, GRAPH_OPTIONS } from "./graph/index.ts";
import { ClaudeCodeLogsSource, CLAUDE_CODE_LOGS_OPTIONS } from "./claude-code-logs/index.ts";
import { LinearSource, LINEAR_OPTIONS } from "./linear/index.ts";
import { JiraSource, JIRA_OPTIONS } from "./jira/index.ts";
import { SlackSource, SLACK_OPTIONS } from "./slack/index.ts";

export const descriptors: Descriptors = {
  graph: {
    key: "graph",
    label: "Microsoft Graph (calendar + mail)",
    options: GRAPH_OPTIONS,
    interactive: true,
    build: (options, debug) => new GraphSource(options, { debug }),
  },
  "claude-code-logs": {
    key: "claude-code-logs",
    label: "Claude Code session logs",
    options: CLAUDE_CODE_LOGS_OPTIONS,
    interactive: false,
    build: (_options, debug) => new ClaudeCodeLogsSource(undefined, { debug }),
  },
  linear: {
    key: "linear",
    label: "Linear",
    options: LINEAR_OPTIONS,
    interactive: false,
    credentials: ["LINEAR_API_KEY"],
    build: (options, debug) => new LinearSource(options, { debug }),
  },
  jira: {
    key: "jira",
    label: "Jira",
    options: JIRA_OPTIONS,
    interactive: false,
    credentials: ["JIRA_EMAIL", "JIRA_API_TOKEN"],
    build: (options, debug) => new JiraSource(options, { debug }),
  },
  slack: {
    key: "slack",
    label: "Slack",
    options: SLACK_OPTIONS,
    interactive: true,
    build: (options) => new SlackSource(options),
  },
};

/** Registered source keys, in a stable order (used by init/status/login). */
export function registeredKeys(): string[] {
  return Object.keys(descriptors);
}

/**
 * The composition step (ADR-0008 §5): build the selected sources with their
 * resolved per-source config injected, keyed by source key. `status()`/`read()`
 * on each instance then close over `this.config` (#27). The output is the
 * {@link Sources} the Aggregator consumes. `debug` is the per-invocation debug
 * sink (ADR-0015 §4), injected the same way and defaulting to the no-op.
 */
export function buildRegistry(selection: Selection[], debug: DebugSink = noDebug): Sources {
  const out: Sources = {};
  for (const { sourceKey, options } of selection) {
    out[sourceKey] = descriptors[sourceKey]!.build(options, debug);
  }
  return out;
}
