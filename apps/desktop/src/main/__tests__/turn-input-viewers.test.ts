import { describe, expect, it, vi } from "vitest";
import {
  TurnInputViewers,
  createdThreadViewersToMount,
  mountCreatedThreadOnTurnViewers,
  startTurnInputOutcome,
  steerInputOutcome,
} from "../federation/turn-input-viewers";

const THREADS = [
  { backend: "claude" as const, threadId: "t1" },
  { backend: "codex" as const, threadId: "t1" },
  { backend: "claude" as const, threadId: "t2" },
];
const VIEWERS = ["m5", "m3", "m7"];

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("TurnInputViewers", () => {
  it("matches a reference model over random accept, queue-start and queue-drop sequences", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = rng(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const tracker = new TurnInputViewers(10_000);
      // Reference: a turn's viewers are every sender whose input joined it,
      // directly or through a queue entry that started it.
      const turns = new Map<string, Set<string>>();
      const queued = new Map<string, { thread: typeof THREADS[number]; viewers: Set<string> }>();
      const key = (thread: typeof THREADS[number], turnId: string) => `${thread.backend}|${thread.threadId}|${turnId}`;
      for (let step = 0; step < 60; step += 1) {
        const thread = pick(THREADS);
        const roll = next();
        if (roll < 0.4) {
          const viewer = pick(VIEWERS);
          const turnId = pick(["u1", "u2"]);
          tracker.accepted(viewer, thread, { kind: "turn", turnId });
          const set = turns.get(key(thread, turnId)) ?? new Set();
          set.add(viewer);
          turns.set(key(thread, turnId), set);
        } else if (roll < 0.7) {
          const viewer = pick(VIEWERS);
          const queueEntryId = pick(["q1", "q2", "q3"]);
          tracker.accepted(viewer, thread, { kind: "queued", queueEntryId });
          const entry = queued.get(queueEntryId) ?? { thread, viewers: new Set() };
          entry.viewers.add(viewer);
          queued.set(queueEntryId, entry);
        } else if (roll < 0.9) {
          const queueEntryId = pick(["q1", "q2", "q3"]);
          const turnId = pick(["u1", "u2"]);
          tracker.queueEntryChanged({ ...thread, queueEntryId, status: "started", turnId });
          const entry = queued.get(queueEntryId);
          if (entry && entry.thread.backend === thread.backend && entry.thread.threadId === thread.threadId) {
            queued.delete(queueEntryId);
            const set = turns.get(key(thread, turnId)) ?? new Set();
            for (const viewer of entry.viewers) set.add(viewer);
            turns.set(key(thread, turnId), set);
          }
        } else {
          const queueEntryId = pick(["q1", "q2", "q3"]);
          tracker.queueEntryChanged({ ...thread, queueEntryId, status: pick(["cancelled", "failed", "terminal"]) });
          queued.delete(queueEntryId);
        }
        for (const probe of THREADS) {
          for (const turnId of ["u1", "u2"]) {
            expect(new Set(tracker.viewers({ ...probe, turnId })), `seed ${seed} step ${step}`)
              .toEqual(turns.get(key(probe, turnId)) ?? new Set());
          }
        }
      }
    }
  });

  it("answers nothing for a tool call without a turn id", () => {
    const tracker = new TurnInputViewers();
    tracker.accepted("m5", THREADS[0]!, { kind: "turn", turnId: "u1" });
    expect(tracker.viewers({ ...THREADS[0]! })).toEqual([]);
  });

  it("stays within its bound, forgetting the oldest turn first", () => {
    const tracker = new TurnInputViewers(2);
    for (const turnId of ["u1", "u2", "u3"]) tracker.accepted("m5", THREADS[0]!, { kind: "turn", turnId });
    expect(tracker.viewers({ ...THREADS[0]!, turnId: "u1" })).toEqual([]);
    expect(tracker.viewers({ ...THREADS[0]!, turnId: "u3" })).toEqual(["m5"]);
  });
});

describe("turn input outcomes", () => {
  it.each([
    [{ turnId: "u1" }, { kind: "turn", turnId: "u1" }],
    [{ turnId: "u1", queueStatus: "started" }, { kind: "turn", turnId: "u1" }],
    [{ turnId: "", queueStatus: "queued", queueEntryId: "q1" }, { kind: "queued", queueEntryId: "q1" }],
    [{ turnId: "", queueStatus: "queued" }, { kind: "none" }],
  ])("a start %o is %o", (response, outcome) => {
    expect(startTurnInputOutcome(response)).toEqual(outcome);
  });

  it.each([
    [{ turnId: "u1", disposition: "steered" }, { kind: "turn", turnId: "u1" }],
    [{ turnId: "u1" }, { kind: "turn", turnId: "u1" }],
    [{ turnId: "u1", disposition: "held" }, { kind: "turn", turnId: "u1" }],
    [{ turnId: "u1", disposition: "queued", queueEntryId: "q1" }, { kind: "queued", queueEntryId: "q1" }],
    [{ ok: true, turnId: "u1", disposition: "queued", requestId: "q2" }, { kind: "queued", queueEntryId: "q2" }],
    [{ turnId: "u1", disposition: "scheduled" }, { kind: "none" }],
    [{ ok: true, turnId: "u1", disposition: "interrupted" }, { kind: "none" }],
    [{ ok: false, turnId: "u1", disposition: "steered" }, { kind: "none" }],
  ])("a steer %o is %o", (response, outcome) => {
    expect(steerInputOutcome(response)).toEqual(outcome);
  });
});

describe("createdThreadViewersToMount", () => {
  const instances = ["owner", "m5", "m3"];
  // Every viewer subset, every place the thread lands, with and without a
  // viewer that mounted it as its grouping root.
  const subsets = [[], ["m5"], ["m3"], ["m5", "m3"], ["m5", "m5"], ["owner", "m5"]];
  const cases = subsets.flatMap((viewers) => instances.flatMap((createdOn) =>
    [undefined, "m5", "m3"].map((alreadyMountedOn) => ({ viewers, createdOn, alreadyMountedOn }))));

  it.each(cases)("viewers $viewers, created on $createdOn, already on $alreadyMountedOn", (params) => {
    // Oracle: a viewer needs the mount unless it is the owner running the
    // tool, the thread's own instance, or already holds it.
    const expected = instances.filter((viewer) => params.viewers.includes(viewer)
      && viewer !== "owner" && viewer !== params.createdOn && viewer !== params.alreadyMountedOn);
    expect(createdThreadViewersToMount({
      viewers: params.viewers,
      createdOn: params.createdOn,
      localInstanceId: "owner",
      ...(params.alreadyMountedOn ? { alreadyMountedOn: params.alreadyMountedOn } : {}),
    }).sort()).toEqual(expected.sort());
  });
});

describe("mountCreatedThreadOnTurnViewers", () => {
  it("mounts the created thread on each viewer of the turn, by its owner's ref and parent", async () => {
    const tracker = new TurnInputViewers();
    tracker.accepted("m5", { backend: "claude", threadId: "parent" }, { kind: "turn", turnId: "u1" });
    tracker.accepted("m3", { backend: "claude", threadId: "parent" }, { kind: "turn", turnId: "u1" });
    const mount = vi.fn(async () => ({ mounted: true }));
    const mounted = await mountCreatedThreadOnTurnViewers({
      viewers: tracker,
      turn: { backend: "claude", threadId: "parent", turnId: "u1" },
      created: {
        backend: "claude",
        threadId: "child",
        instanceId: "m3",
        instanceLabel: "M3 / default",
        title: "PwrAgnt",
        parent: { backend: "claude", threadId: "parent", instanceId: "owner" },
      },
      localInstanceId: "owner",
      mount,
    });
    expect(mounted).toEqual(["m5"]);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith("m5", {
      ref: { backend: "claude", threadId: "child", target: { scope: "remote", instanceId: "m3" } },
      instanceLabel: "M3 / default",
      summary: {
        source: "claude", id: "child", title: "PwrAgnt", titleSource: "fallback",
        linkedDirectories: [], inbox: { inInbox: false },
        parentThreadId: "parent", parentThreadBackend: "claude", parentThreadInstanceId: "owner",
      },
    });
  });

  it("reports a refused mount and still mounts on the other viewers", async () => {
    const tracker = new TurnInputViewers();
    for (const viewer of ["m5", "m7"]) tracker.accepted(viewer, { backend: "codex", threadId: "p" }, { kind: "turn", turnId: "u1" });
    const onError = vi.fn();
    const mounted = await mountCreatedThreadOnTurnViewers({
      viewers: tracker,
      turn: { backend: "codex", threadId: "p", turnId: "u1" },
      created: { backend: "codex", threadId: "c", instanceId: "owner", instanceLabel: "M2 / default" },
      localInstanceId: "owner",
      mount: async (viewer) => {
        if (viewer === "m5") throw new Error("offline");
      },
      onError,
    });
    expect(mounted).toEqual(["m7"]);
    expect(onError).toHaveBeenCalledWith("m5", expect.any(Error));
  });
});
