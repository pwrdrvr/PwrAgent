import { readFileSync } from "node:fs";
import WeightedUnitSequencer from "./weighted-unit-sequencer.mjs";

const costs = JSON.parse(readFileSync(new URL("./windows-main-unit-costs.json", import.meta.url), "utf8"));

export default class WindowsMainUnitSequencer extends WeightedUnitSequencer {
  projectCosts = new Map([["desktop-main", costs]]);
}
