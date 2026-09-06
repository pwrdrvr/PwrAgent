import type { Profiler } from "node:inspector";
import { describe, expect, it } from "vitest";
import { joinCpuProfiles } from "../diagnostics/cpu-profile-history";

function window(startTime: number, name: string): Profiler.Profile {
  const callFrame = {
    functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1,
  };
  return {
    startTime,
    endTime: startTime + 20,
    nodes: [
      { id: 1, callFrame, children: [2] },
      { id: 2, callFrame: { ...callFrame, functionName: name }, hitCount: 2 },
    ],
    samples: [2, 2],
    timeDeltas: [10, 10],
  };
}

describe("joinCpuProfiles", () => {
  it("preserves frames from both sides of a rotation with one root and distinct ids", () => {
    const first = window(100, "beforeRotation");
    const second = window(120, "afterRotation");
    const merged = joinCpuProfiles([first, second]);
    const nodes = new Map(merged.nodes.map((node) => [node.id, node]));
    expect(nodes.size).toBe(merged.nodes.length);
    expect(merged.nodes.filter((node) => node.callFrame.functionName === "(root)")).toHaveLength(1);
    expect(merged.samples?.map((id) => nodes.get(id)?.callFrame.functionName)).toEqual([
      "beforeRotation", "beforeRotation", "afterRotation", "afterRotation",
    ]);
    expect(merged.nodes[0].children).toEqual([2, 3]);
    expect(merged.timeDeltas).toEqual([10, 10, 10, 10]);
    expect(merged.startTime).toBe(100);
    expect(merged.endTime).toBe(140);
    expect(second.samples).toEqual([2, 2]);
  });

  it("marks a stop/start gap instead of charging it to the following function", () => {
    const merged = joinCpuProfiles([window(100, "before"), window(150, "after")]);
    const names = new Map(merged.nodes.map((node) => [node.id, node.callFrame.functionName]));
    expect(merged.samples?.map((id) => names.get(id))).toEqual([
      "before", "before", "(unrecorded)", "after", "after",
    ]);
    expect(merged.timeDeltas).toEqual([10, 10, 30, 10, 10]);
    expect(merged.timeDeltas?.reduce((sum, delta) => sum + delta, 0)).toBe(70);
  });
});
