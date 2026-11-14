import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isPathWithin } from "../path-within";

// `path.relative` never starts an outside path with `..` followed by anything
// but a separator, so a descendant named `..cache` is still a descendant.
// Testing for a bare `..` prefix called it outside, and a diff header then
// named the file by its absolute path.

const segment = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9._-]{0,6}$/u),
  fc.stringMatching(/^\.\.[a-z0-9._-]{1,6}$/u),
);

describe("isPathWithin", () => {
  it("counts a descendant whose name starts with two dots", () => {
    expect(isPathWithin("/repo", "/repo/..cache/a.md")).toBe(true);
    expect(isPathWithin("/repo", "/repo/..env")).toBe(true);
  });

  it("property: a path is within a root exactly when it descends from it", () => {
    const scenario = fc.record({
      root: fc.array(segment, { minLength: 1, maxLength: 3 }),
      child: fc.array(segment, { maxLength: 3 }),
      up: fc.nat({ max: 3 }),
    });
    fc.assert(
      fc.property(scenario, ({ root, child, up }) => {
        const rootPath = path.join("/", ...root);
        const descendant = path.join(rootPath, ...child);
        expect(isPathWithin(rootPath, descendant)).toBe(child.length > 0);

        // Leaving the root by `up` levels, then entering a sibling.
        const outside = path.join(rootPath, ...Array(up + 1).fill(".."), "elsewhere");
        const outsideIsInside = path.relative(rootPath, outside).split(path.sep)[0] !== "..";
        expect(isPathWithin(rootPath, outside)).toBe(outsideIsInside);
      }),
      { numRuns: 300 },
    );
  });
});
