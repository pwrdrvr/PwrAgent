import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_TAB_IDS,
  DETAILS_SEGMENT_IDS,
  contextTabIdForDetailsSegment,
  isContextTabId,
  resolveContextTabTarget,
  type ContextRailTabId,
  type ContextTabId,
  type DetailsSectionId,
  type DetailsSegmentId,
} from "../context-tab";

/**
 * The approved move table ("Composer Diet and Thread Details", section 05):
 * where each tab that Details took in now lives. Written out by hand so the
 * mapping is checked against the design, not against itself.
 */
const MERGED: Record<string, { segment: DetailsSegmentId; section?: DetailsSectionId }> = {
  info: { segment: "thread" },
  projects: { segment: "thread", section: "folders" },
  edits: { segment: "changes" },
  prs: { segment: "prs" },
  "pr-activity": { segment: "prs", section: "activity" },
  actions: { segment: "jobs", section: "commands" },
  subagents: { segment: "jobs", section: "subagents" },
  automations: { segment: "jobs", section: "scheduled" },
};

const SPINE_TABS: readonly ContextRailTabId[] = [
  "details", "todos", "research", "waiting", "pricing", "decisions", "providers", "connections",
];

// Every id a stored setting, deep link or reveal request can carry.
const EVERY_TAB_ID: readonly ContextTabId[] = [...CONTEXT_TAB_IDS, "connections"];

describe("old context tab ids", () => {
  it("each land on a spine tab, and the eight Details took in on their segment", () => {
    fc.assert(fc.property(fc.constantFrom(...EVERY_TAB_ID), (id) => {
      const target = resolveContextTabTarget(id);
      expect(SPINE_TABS).toContain(target.tab);
      // A segment exactly when Details is the tab.
      expect(target.segment !== undefined).toBe(target.tab === "details");
      const merged = MERGED[id];
      if (merged) {
        expect(target).toEqual({ tab: "details", ...merged });
      } else {
        expect(target).toEqual({ tab: id });
      }
    }), { numRuns: EVERY_TAB_ID.length * 4 });
  });

  it("store each segment under an id that resolves back to it and that older builds read", () => {
    fc.assert(fc.property(fc.constantFrom(...DETAILS_SEGMENT_IDS), (segment) => {
      const stored = contextTabIdForDetailsSegment(segment);
      // The persisted value keeps its shape: an id every build already knows.
      expect(isContextTabId(stored)).toBe(true);
      expect(resolveContextTabTarget(stored)).toMatchObject({ tab: "details", segment });
    }), { numRuns: DETAILS_SEGMENT_IDS.length * 4 });
  });

  it("leave every spine tab reachable from some old id", () => {
    const reached = new Set(EVERY_TAB_ID.map((id) => resolveContextTabTarget(id).tab));
    expect([...reached].sort()).toEqual([...SPINE_TABS].sort());
  });
});
