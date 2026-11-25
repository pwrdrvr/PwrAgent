import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  isDefaultProjectForgeAutomation,
  projectWatchesMergeBuilds,
  resolveProjectForgeAutomation,
  type ProjectForgeAutomation,
} from "../project-forge-automation";

const automationArb: fc.Arbitrary<ProjectForgeAutomation | undefined> = fc.option(fc.record({
  paused: fc.boolean(),
  autoFixMergeConflicts: fc.boolean(),
  autoFixCiFailures: fc.boolean(),
  prWatches: fc.boolean(),
  prOffers: fc.boolean(),
  neverMerge: fc.constantFrom(undefined, true as const),
  refuseThreadMessages: fc.boolean(),
  wakeupPolicy: fc.constantFrom("hold" as const, "discard" as const),
  mergeBuildWatches: fc.constantFrom(undefined, "default" as const, "on" as const, "off" as const),
}, { requiredKeys: ["paused", "autoFixMergeConflicts", "autoFixCiFailures", "prWatches", "prOffers", "refuseThreadMessages", "wakeupPolicy"] }),
{ nil: undefined });

describe("projectWatchesMergeBuilds", () => {
  it("watches only where PR watches may wake threads, and then as the project says, else as Git settings say", () => {
    fc.assert(fc.property(automationArb, fc.boolean(), (automation, globalDefault) => {
      // The rule, stated independently.
      const prWatchesAllowed = automation === undefined || (!automation.paused && automation.prWatches);
      const choice = automation?.mergeBuildWatches;
      const expected = prWatchesAllowed && (choice === "on" || (choice !== "off" && globalDefault));
      expect(projectWatchesMergeBuilds(automation, globalDefault)).toBe(expected);
    }));
  });
});

describe("the project's merge build choice", () => {
  it("reads on and off, treats anything else as the default, and stores nothing for the default", () => {
    expect(resolveProjectForgeAutomation({ mergeBuildWatches: "on" }).mergeBuildWatches).toBe("on");
    expect(resolveProjectForgeAutomation({ mergeBuildWatches: "off" }).mergeBuildWatches).toBe("off");
    for (const value of [undefined, "default", "sometimes", 1, null]) {
      expect(resolveProjectForgeAutomation({ mergeBuildWatches: value })).toEqual(DEFAULT_PROJECT_FORGE_AUTOMATION);
    }
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, mergeBuildWatches: "default" })).toBe(true);
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, mergeBuildWatches: "on" })).toBe(false);
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, mergeBuildWatches: "off" })).toBe(false);
  });
});
