import fs from "node:fs";
import WeightedUnitSequencer from "./weighted-unit-sequencer.mjs";

const costs = JSON.parse(fs.readFileSync(new URL("./linux-unit-costs.json", import.meta.url), "utf8"));
const rendererCosts = JSON.parse(fs.readFileSync(new URL("./linux-renderer-unit-costs.json", import.meta.url), "utf8"));

// Linux's two full-workspace lanes used to receive equal file counts, but the
// path hash concentrated long main-process and renderer files in one lane.
// Balance each project independently; keep Vitest's sort, pools and isolation.
// Other projects retain their existing hash ownership.
export default class LinuxUnitSequencer extends WeightedUnitSequencer {
  projectCosts = new Map([["desktop-main", costs], ["desktop-renderer", rendererCosts]]);
}
