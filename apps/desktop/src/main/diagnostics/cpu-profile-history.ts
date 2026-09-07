import type { Profiler } from "node:inspector";

// CDP returns a new node-id namespace on every Profiler.stop. Keep one root
// when joining windows, remap every reference, and preserve monotonic sample
// timestamps. A stop/start gap must not be charged to the next JS function.
export function joinCpuProfiles(
  profiles: readonly [Profiler.Profile, ...Profiler.Profile[]],
): Profiler.Profile {
  if (profiles.length === 1) return profiles[0];
  const root: Profiler.ProfileNode = {
    id: 1,
    callFrame: {
      functionName: "(root)",
      scriptId: "0",
      url: "",
      lineNumber: -1,
      columnNumber: -1,
    },
    children: [],
  };
  const nodes = [root];
  const nodesById = new Map([[root.id, root]]);
  const metaIds = new Map<string, number>();
  const metaNames = new Set(["(garbage collector)", "(idle)", "(program)"]);
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const startTime = profiles[0].startTime;
  let sampleTime = startTime;
  let nextId = 2;
  let gapId: number | undefined;
  let previousEndTime: number | undefined;
  const appendSample = (id: number, timestamp: number): void => {
    samples.push(id);
    timeDeltas.push(timestamp - sampleTime);
    sampleTime = timestamp;
  };
  for (const profile of profiles) {
    const ids = new Map<number, number>();
    const profileRoot = profile.nodes[0];
    const topLevelIds = new Set(profileRoot.children);
    for (const node of profile.nodes) {
      if (node === profileRoot) {
        ids.set(node.id, root.id);
      } else if (topLevelIds.has(node.id) && metaNames.has(node.callFrame.functionName)) {
        // DevTools keeps only one reference for each V8 meta node. In
        // particular, every GC sample must use its selected GC node's id.
        const name = node.callFrame.functionName;
        const id = metaIds.get(name) ?? nextId++;
        metaIds.set(name, id);
        ids.set(node.id, id);
      } else {
        ids.set(node.id, nextId++);
      }
    }
    for (const node of profile.nodes) {
      const children = node.children?.map((id) => ids.get(id)!);
      const id = ids.get(node.id)!;
      const existing = nodesById.get(id);
      if (existing) {
        existing.children = [...new Set([...(existing.children ?? []), ...(children ?? [])])];
        if (existing !== root && node.hitCount !== undefined) {
          existing.hitCount = (existing.hitCount ?? 0) + node.hitCount;
        }
      } else {
        const merged = { ...node, id, children };
        nodes.push(merged);
        nodesById.set(id, merged);
      }
    }
    if (previousEndTime !== undefined) {
      if (profile.startTime > previousEndTime) {
        if (gapId === undefined) {
          gapId = nextId++;
          nodes.push({
            id: gapId,
            callFrame: { ...root.callFrame, functionName: "(unrecorded)" },
          });
          root.children!.push(gapId);
        }
        // Samples describe the frame FROM their timestamp until the next
        // sample. Close the preceding stack when its recorder stopped.
        appendSample(gapId, previousEndTime);
      }
      // End the gap exactly when recording resumed. The root boundary also
      // prevents a previous window's stack carrying into this window's first
      // sampling interval (or into a GC sample with no interrupted JS stack).
      appendSample(root.id, profile.startTime);
    }
    let timestamp = profile.startTime;
    for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
      timestamp += profile.timeDeltas![index];
      appendSample(ids.get(profile.samples![index])!, timestamp);
    }
    previousEndTime = profile.endTime;
  }
  return { nodes, startTime, endTime: profiles.at(-1)!.endTime, samples, timeDeltas };
}
