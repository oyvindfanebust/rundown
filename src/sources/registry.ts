// The static source registry (ADR-0008 §5): a plain map literal, source key →
// Source instance. Adding a source later is one import + one entry — explicit,
// typed, greppable. No self-registration, no dynamic discovery.

import type { Sources } from "./source.ts";
import { GraphSource } from "./graph/index.ts";
import { ClaudeCodeLogsSource } from "./claude-code-logs/index.ts";
import { LinearSource } from "./linear/index.ts";

export const registry: Sources = {
  graph: new GraphSource(),
  "claude-code-logs": new ClaudeCodeLogsSource(),
  linear: new LinearSource(),
};

/** Registered source keys, in a stable order (used by init/status). */
export function registeredKeys(): string[] {
  return Object.keys(registry);
}
