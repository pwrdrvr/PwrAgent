import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInManagedWorktreeRoot } from "../app-server/managed-worktree-ownership";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("managed checkout ownership, with the filesystem as oracle", () => {
  it("uses physical containment rather than the apparent path or a shared prefix", async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "managed-checkout-")));
    temporary.push(base);
    const root = path.join(base, "worktrees");
    const inside = path.join(root, "id", "repo");
    const outside = path.join(base, "outside");
    const sibling = path.join(base, "worktrees-other", "repo");
    for (const directory of [inside, outside, sibling]) await mkdir(directory, { recursive: true });
    const escape = path.join(root, "escape");
    const alias = path.join(base, "alias");
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
    await symlink(inside, alias, process.platform === "win32" ? "junction" : "dir");
    const cases = [
      [inside, true], [outside, false], [sibling, false], [escape, false], [alias, true],
      [root, false], [path.join(root, "missing"), false],
    ] as const;
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: cases.length - 1 }), { minLength: 7, maxLength: 20 }),
      async (order) => {
        for (const index of order) {
          const [checkout, managed] = cases[index]!;
          expect(await isInManagedWorktreeRoot(checkout, [path.join(base, "unavailable"), root])).toBe(managed);
        }
      }), { numRuns: 20 });
  });
});
