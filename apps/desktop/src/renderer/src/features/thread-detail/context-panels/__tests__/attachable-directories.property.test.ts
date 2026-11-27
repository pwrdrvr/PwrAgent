import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { listAttachableDirectories } from "../DetailsFoldersSection";

const paths = ["/a", "/b", "/c", "/d", "/e"];
const pathArb = fc.constantFrom(...paths);

const trackedArb = fc.array(fc.record({
  key: fc.string({ minLength: 1, maxLength: 4 }),
  kind: fc.constant("directory" as const),
  label: fc.string({ maxLength: 4 }),
  path: fc.option(pathArb, { nil: undefined }),
  localAvailability: fc.option(fc.constant("unconfigured" as const), { nil: undefined }),
}), { maxLength: 8 });

const linkedArb = fc.array(fc.record({
  id: fc.string({ minLength: 1, maxLength: 4 }),
  kind: fc.constantFrom("local" as const, "worktree" as const),
  label: fc.string({ maxLength: 4 }),
  path: pathArb,
  worktreePath: fc.option(pathArb, { nil: undefined }),
}), { maxLength: 4 });

describe("listAttachableDirectories", () => {
  it("offers exactly the local tracked projects whose path no linked folder holds, in order", () => {
    fc.assert(fc.property(trackedArb, linkedArb, (tracked, linked) => {
      const offered = listAttachableDirectories(tracked, linked);
      const held = new Set(linked.flatMap((directory) => [directory.path, directory.worktreePath]));
      // Oracle: a filter of the input, so order and duplicates are the input's.
      expect(offered).toEqual(tracked.filter((directory) => directory.path !== undefined
        && directory.localAvailability === undefined
        && !held.has(directory.path)));
      for (const directory of offered) {
        expect(held.has(directory.path)).toBe(false);
      }
    }));
  });
});
