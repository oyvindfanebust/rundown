// Preloaded into a spawned `rundown` (`bun --preload`) by the CLI tests. A Bun
// runtime plugin swaps `src/sources/registry.ts` for `offline-registry.ts`, so
// the CLI runs unchanged against a fake registry with one offline source.

import { plugin } from "bun";
import { join } from "node:path";

const FAKE = join(import.meta.dir, "offline-registry.ts");

plugin({
  name: "offline-registry",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]sources[\\/]registry\.ts$/ }, () => ({
      contents: `export * from ${JSON.stringify(FAKE)};`,
      loader: "ts",
    }));
  },
});
