// PROTOTYPE (map #117, ticket #122). Writes sample-week.json from the typed sample.
import { sampleWeek } from "./sample-week.ts";

await Bun.write(new URL("./sample-week.json", import.meta.url), JSON.stringify(sampleWeek, null, 2) + "\n");
