import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  rankProjectCardPeers,
  revealInFileManagerLabel,
  splitProjectPath,
  thisMachineLabel,
} from "../project-header-card";

const segment = fc.stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/);

describe("splitProjectPath", () => {
  it("rejoins to the path without its trailing separators, and the tail is the folder name", () => {
    fc.assert(fc.property(
      fc.constantFrom("/", "\\"),
      fc.constantFrom("", "/", "~/", "C:\\", "\\\\server\\share\\"),
      fc.array(segment, { minLength: 1, maxLength: 6 }),
      fc.nat(2),
      (separator, root, segments, trailing) => {
        const path = root + segments.join(separator) + separator.repeat(trailing);
        const { head, tail } = splitProjectPath(path);
        expect(head + tail).toBe(path.replace(/[\\/]+$/, ""));
        expect(tail).toBe(segments.at(-1));
        expect(tail).not.toMatch(/[\\/]/);
      },
    ));
  });

  it("keeps a bare root whole", () => {
    expect(splitProjectPath("/")).toEqual({ head: "", tail: "/" });
    expect(splitProjectPath("PwrAgnt")).toEqual({ head: "", tail: "PwrAgnt" });
  });
});

describe("platform labels", () => {
  it("names the file manager and the machine per platform", () => {
    expect(revealInFileManagerLabel("darwin")).toBe("Show in Finder");
    expect(revealInFileManagerLabel("win32")).toBe("Show in File Explorer");
    expect(revealInFileManagerLabel("linux")).toBe("Show in Files");
    expect(thisMachineLabel("darwin")).toBe("This Mac");
    expect(thisMachineLabel("win32")).toBe("This PC");
    expect(thisMachineLabel(undefined)).toBe("This machine");
  });
});

type Target = { instanceId: string; availability: "available" | "offline" | "unsupported" };
const instanceIds = ["a", "b", "c", "d", "e"];

const targetsArb = fc.shuffledSubarray(instanceIds, { minLength: 0 }).chain((ids) =>
  fc.tuple(...ids.map((instanceId) => fc.record({
    instanceId: fc.constant(instanceId),
    availability: fc.constantFrom<Target["availability"]>("available", "offline", "unsupported"),
  }))));
const threadsArb = fc.array(fc.record({
  instanceId: fc.option(fc.constantFrom(...instanceIds), { nil: undefined }),
  updatedAt: fc.integer({ min: 0, max: 50 }),
}), { maxLength: 12 }).map((rows) => rows.map((row) => ({
  updatedAt: row.updatedAt,
  federation: row.instanceId === undefined
    ? undefined
    : {
        ref: {
          backend: "codex" as const,
          target: { scope: "remote" as const, instanceId: row.instanceId },
          threadId: "t",
        },
        instanceLabel: row.instanceId,
      },
})));

/** Obviously correct: pick the most recent remaining peer, one at a time. */
function oracle(
  targets: readonly Target[],
  threads: { updatedAt: number; instanceId?: string }[],
  limit: number,
): string[] {
  const newest = (id: string) => {
    const times = threads.filter((thread) => thread.instanceId === id).map((thread) => thread.updatedAt);
    return times.length ? Math.max(...times) : undefined;
  };
  const pool = targets.filter((target) => target.availability === "available");
  const out: string[] = [];
  while (out.length < limit && pool.length > 0) {
    let best = 0;
    for (let index = 1; index < pool.length; index += 1) {
      const candidate = newest(pool[index]!.instanceId);
      const current = newest(pool[best]!.instanceId);
      if (candidate !== undefined && (current === undefined || candidate > current)) best = index;
    }
    out.push(pool.splice(best, 1)[0]!.instanceId);
  }
  return out;
}

describe("rankProjectCardPeers", () => {
  it("offers the most recently used available peers, menu order breaking ties", () => {
    fc.assert(fc.property(targetsArb, threadsArb, fc.nat(4), (targets, threads, limit) => {
      const { peers, more } = rankProjectCardPeers(targets, threads, limit);
      const flat = threads.map((thread) => ({
        updatedAt: thread.updatedAt,
        instanceId: thread.federation?.ref.target.instanceId,
      }));
      expect(peers.map((peer) => peer.instanceId)).toEqual(oracle(targets, flat, limit));
      // "Other machines…" exactly when the full menu lists something the card does not.
      expect(more).toBe(targets.length > peers.length);
    }));
  });
});
