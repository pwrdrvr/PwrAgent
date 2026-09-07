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
      "beforeRotation", "beforeRotation", "(root)", "afterRotation", "afterRotation",
    ]);
    expect(merged.nodes[0].children).toEqual([2, 3]);
    expect(merged.timeDeltas).toEqual([10, 10, 0, 10, 10]);
    expect(merged.startTime).toBe(100);
    expect(merged.endTime).toBe(140);
    expect(second.samples).toEqual([2, 2]);
  });

  it.each([120, 125])("brackets the gap when the preceding recording stops at %s", (endTime) => {
    const before = window(100, "before");
    before.endTime = endTime;
    const merged = joinCpuProfiles([before, window(150, "after")]);
    const names = new Map(merged.nodes.map((node) => [node.id, node.callFrame.functionName]));
    let timestamp = merged.startTime;
    const timestamps = merged.timeDeltas!.map((delta) => timestamp += delta);
    // DevTools renders a sample until the next reconstructed timestamp.
    const frames = merged.samples!.slice(0, -1).map((id, index) => ({
      name: names.get(id),
      start: timestamps[index],
      end: timestamps[index + 1],
    }));
    expect(frames).toEqual([
      { name: "before", start: 110, end: 120 },
      { name: "before", start: 120, end: endTime },
      { name: "(unrecorded)", start: endTime, end: 150 },
      { name: "(root)", start: 150, end: 160 },
      { name: "after", start: 160, end: 170 },
    ]);
    expect(merged.timeDeltas).toEqual([10, 10, endTime - 120, 150 - endTime, 10, 10]);
  });

  it("shares each V8 meta node and its samples across windows without duplicating root edges", () => {
    function withMetaNodes(start: number, name: string): Profiler.Profile {
      const profile = window(start, name);
      for (const [index, functionName] of ["(garbage collector)", "(idle)", "(program)"].entries()) {
        const id = index + 3;
        profile.nodes.push({
          id,
          callFrame: { ...profile.nodes[0].callFrame, functionName },
          hitCount: 1,
        });
        profile.nodes[0].children!.push(id);
      }
      profile.samples = [2, 3, 2, 4, 5];
      profile.timeDeltas = [2, 2, 2, 2, 2];
      return profile;
    }
    const first = withMetaNodes(100, "firstStack");
    const second = withMetaNodes(150, "secondStack");
    const original = structuredClone([first, second]);
    const merged = joinCpuProfiles([first, second]);
    for (const name of ["(garbage collector)", "(idle)", "(program)"]) {
      const meta = merged.nodes.filter((node) => node.callFrame.functionName === name);
      expect(meta).toHaveLength(1);
      expect(meta[0].hitCount).toBe(2);
      expect(merged.nodes[0].children!.filter((id) => id === meta[0].id)).toHaveLength(1);
      expect(merged.samples!.filter((id) => id === meta[0].id)).toHaveLength(2);
    }
    // DevTools selects one GC id. Both collections must be recognized as GC
    // while preserving their distinct interrupted JavaScript stacks.
    const gcId = merged.nodes.find((node) => node.callFrame.functionName === "(garbage collector)")!.id;
    const names = new Map(merged.nodes.map((node) => [node.id, node.callFrame.functionName]));
    const interrupted = merged.samples!.flatMap((id, index) =>
      id === gcId ? [names.get(merged.samples![index - 1])] : [],
    );
    expect(interrupted).toEqual(["firstStack", "secondStack"]);
    expect([first, second]).toEqual(original);
  });
});
