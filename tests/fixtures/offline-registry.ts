// A test-only source registry for the CLI spawn tests. It stands in for
// `src/sources/registry.ts` when a spawned `rundown` is started with
// `offline-preload.ts`, and holds one source, `offline`, that is always ready,
// reads nothing and needs no network. It is not a production source: nothing in
// `src/` imports this file, so the release binary never contains it.

import type { Descriptors, Source, Sources } from "../../src/sources/source.ts";
import type { Selection } from "../../src/config.ts";
import { noDebug, type DebugSink } from "../../src/debug.ts";

function offlineSource(): Source {
  return {
    key: "offline",
    label: "Offline test source",
    async status() {
      return { state: "ready", identity: "offline@example.test" };
    },
    async login() {
      return "offline@example.test";
    },
    async read() {
      return [];
    },
  };
}

export const descriptors: Descriptors = {
  offline: {
    key: "offline",
    label: "Offline test source",
    options: {},
    build: () => offlineSource(),
  },
};

export function registeredKeys(): string[] {
  return Object.keys(descriptors);
}

export function buildRegistry(selection: Selection[], debug: DebugSink = noDebug): Sources {
  const out: Sources = {};
  for (const { sourceKey, options } of selection) out[sourceKey] = descriptors[sourceKey]!.build(options, debug);
  return out;
}
