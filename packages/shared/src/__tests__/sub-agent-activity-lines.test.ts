import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applySubAgentActivityChanges,
  subAgentActivityChanges,
  type SubAgentActivityLine,
} from "../sub-agent-activity-lines";

/**
 * The oracle is the current set itself: a window that saw every change holds
 * exactly the lines of the sub-agents running now. The work budget: a change
 * names only the lines that differ, so a tool call by one of many running
 * sub-agents sends one line, not all of them.
 */
const monitorId = fc.constantFrom("a", "b", "c", "d", "e", "f");
const lineSet = fc.uniqueArray(
  fc.record({ monitorId, activity: fc.constantFrom("Reading app.css", "Running ls", "Searching for query(") }),
  { selector: (line) => line.monitorId, maxLength: 6 },
);

describe("sub-agent activity changes", () => {
  it("rebuild the current lines from the published ones, naming only what differs", () => {
    fc.assert(fc.property(fc.array(lineSet, { minLength: 1, maxLength: 12 }), (snapshots) => {
      let published: ReadonlyMap<string, string> = new Map();
      for (const current of snapshots) {
        const changes = subAgentActivityChanges(published, current);
        const expected = new Map(current.map((line: SubAgentActivityLine) => [line.monitorId, line.activity]));
        const differing = current.filter((line) => published.get(line.monitorId) !== line.activity);
        const ended = [...published.keys()].filter((id) => !expected.has(id));
        if (!changes) {
          expect(differing).toEqual([]);
          expect(ended).toEqual([]);
          continue;
        }
        expect(changes.activities).toEqual(differing);
        expect(changes.cleared ?? []).toEqual(ended);
        const next = applySubAgentActivityChanges(published, changes);
        expect(new Map(next)).toEqual(expected);
        // Redelivery changes nothing and keeps the same map.
        expect(applySubAgentActivityChanges(next, changes)).toBe(next);
        published = next;
      }
    }));
  });

  it("sends one line when one of many running sub-agents moves on", () => {
    const running = ["a", "b", "c", "d", "e"].map((id) => ({ monitorId: id, activity: `Running step 1 in ${id}` }));
    const published = new Map(running.map((line) => [line.monitorId, line.activity]));
    const moved = running.map((line) => line.monitorId === "c" ? { ...line, activity: "Running step 2 in c" } : line);
    expect(subAgentActivityChanges(published, moved)).toEqual({
      activities: [{ monitorId: "c", activity: "Running step 2 in c" }],
    });
  });
});
