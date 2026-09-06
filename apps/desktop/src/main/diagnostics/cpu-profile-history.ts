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
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const startTime = profiles[0].startTime;
  let sampleTime = startTime;
  let nextId = 2;
  let gapId: number | undefined;
  for (const profile of profiles) {
    const ids = new Map<number, number>();
    const profileRoot = profile.nodes[0];
    for (const node of profile.nodes) {
      ids.set(node.id, node === profileRoot ? root.id : nextId++);
    }
    for (const node of profile.nodes) {
      const children = node.children?.map((id) => ids.get(id)!);
      if (node === profileRoot) {
        root.children!.push(...(children ?? []));
      } else {
        nodes.push({ ...node, id: ids.get(node.id)!, children });
      }
    }
    if (profile.startTime > sampleTime) {
      if (gapId === undefined) {
        gapId = nextId++;
        nodes.push({
          id: gapId,
          callFrame: { ...root.callFrame, functionName: "(unrecorded)" },
        });
        root.children!.push(gapId);
      }
      samples.push(gapId);
      timeDeltas.push(profile.startTime - sampleTime);
      sampleTime = profile.startTime;
    }
    let timestamp = profile.startTime;
    for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
      timestamp += profile.timeDeltas![index];
      samples.push(ids.get(profile.samples![index])!);
      timeDeltas.push(timestamp - sampleTime);
      sampleTime = timestamp;
    }
  }
  return { nodes, startTime, endTime: profiles.at(-1)!.endTime, samples, timeDeltas };
}
