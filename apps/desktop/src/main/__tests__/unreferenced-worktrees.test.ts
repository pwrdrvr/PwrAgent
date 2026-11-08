import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  listManagedWorktrees,
  unreferencedWorktrees,
  type WorktreeRootReader,
} from "../app-server/unreferenced-worktrees";

/** A fake filesystem: every folder path, and which ones hold a `.git` file. */
function readerFor(folders: ReadonlyMap<string, boolean>): WorktreeRootReader {
  return {
    async listDirectories(folder) {
      return [...folders.keys()]
        .filter((candidate) => path.dirname(candidate) === folder)
        .map((candidate) => path.basename(candidate))
        .sort();
    },
    async isLinkedWorktree(folder) {
      return folders.get(folder) === true;
    },
  };
}

const segment = fc.constantFrom("a", "b", "k3m9", "repo", "web");

describe("unreferenced worktree discovery", () => {
  it("lists exactly the linked worktrees two levels under each root, up to the limit", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.boolean()), { maxLength: 24 }),
      fc.integer({ min: 0, max: 30 }),
      async (entries, limit) => {
        // Built with path.join so separators match the fake folders on Windows too.
        const root = path.join(path.sep, "home", "me", ".pwragent", "worktrees");
        const folders = new Map<string, boolean>();
        for (const [segments, linked] of entries) {
          // Every ancestor exists as a folder; only the leaf can be a worktree.
          for (let depth = 1; depth <= segments.length; depth++) {
            const folder = path.join(root, ...segments.slice(0, depth));
            const isLeaf = depth === segments.length;
            folders.set(folder, (folders.get(folder) ?? false) || (isLeaf && linked));
          }
        }
        const expected = [...folders].filter(([folder, linked]) =>
          linked && path.relative(root, folder).split(path.sep).length === 2).map(([folder]) => folder).sort();
        const found = await listManagedWorktrees([root], readerFor(folders), limit);
        expect(found.paths.length).toBe(Math.min(limit, expected.length));
        if (limit >= expected.length) expect([...found.paths].sort()).toEqual(expected);
        for (const value of found.paths) expect(expected).toContain(value);
        expect(found.truncated).toBe(expected.length > limit);
      },
    ));
  });

  it("reports a checkout only when no reference is it, inside it, or above it", () => {
    const pathOf = (segments: readonly string[]) => path.join("/w", ...segments);
    fc.assert(fc.property(
      fc.uniqueArray(fc.array(segment, { minLength: 2, maxLength: 2 }), { maxLength: 8, selector: (value) => value.join("/") }),
      fc.array(fc.array(segment, { minLength: 1, maxLength: 4 }), { maxLength: 8 }),
      (checkoutSegments, referenceSegments) => {
        const checkouts = checkoutSegments.map(pathOf);
        const references = new Set(referenceSegments.map(pathOf));
        // Model: compare segment prefixes, not strings.
        const prefix = (a: readonly string[], b: readonly string[]) => a.every((part, index) => b[index] === part);
        const expected = checkoutSegments
          .filter((checkout) => !referenceSegments.some((reference) => prefix(checkout, reference) || prefix(reference, checkout)))
          .map(pathOf);
        expect(unreferencedWorktrees(checkouts, references)).toEqual(expected);
      },
    ));
  });

  it("never reports more checkouts when a reference is added", () => {
    fc.assert(fc.property(
      fc.array(fc.array(segment, { minLength: 2, maxLength: 2 }), { maxLength: 8 }),
      fc.array(fc.array(segment, { minLength: 1, maxLength: 4 }), { maxLength: 6 }),
      fc.array(segment, { minLength: 1, maxLength: 4 }),
      (checkouts, references, extra) => {
        const all = checkouts.map((segments) => path.join("/w", ...segments));
        const before = unreferencedWorktrees(all, new Set(references.map((segments) => path.join("/w", ...segments))));
        const after = unreferencedWorktrees(all, new Set([...references, extra].map((segments) => path.join("/w", ...segments))));
        for (const value of after) expect(before).toContain(value);
      },
    ));
  });

  it("does not treat a sibling with a shared name prefix as covered", () => {
    expect(unreferencedWorktrees(["/w/k3m9/repo"], new Set(["/w/k3m9/repo-web"]))).toEqual(["/w/k3m9/repo"]);
  });
});
