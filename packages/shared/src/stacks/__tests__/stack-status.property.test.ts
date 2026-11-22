import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseGhStackCatalog } from "../catalog";
import { inferPullRequestStacks, stackLayerBinding, stackLayerHealth } from "../stack-status";

describe("read-only stack derivation", () => {
  it("reads v1's optional fields and refuses to interpret later schemas", () => {
    const catalog = { schemaVersion: 1, stacks: [{ id: "linked", number: 3, trunk: { branch: "main" }, branches: [
      { branch: "model", pullRequest: { number: 72, merged: true, mergedHead: "a".repeat(40) } },
      { branch: "ui", base: "b".repeat(40) },
    ] }] };
    expect(parseGhStackCatalog(JSON.stringify(catalog))).toMatchObject({
      status: "ok", catalog: { repository: "", ...catalog },
    });
    expect(parseGhStackCatalog(JSON.stringify({ ...catalog, schemaVersion: 2 }))).toEqual({
      status: "catalog_schema_unknown", schemaVersion: 2,
    });
  });

  it("binds a branch independently of observation order against an exhaustive ownership oracle", () => {
    const branch = "feature";
    const candidates = fc.array(fc.record({ checkout: fc.boolean(), attachment: fc.boolean(), peer: fc.boolean() }), { maxLength: 6 });
    fc.assert(fc.property(candidates, fc.integer({ min: 0, max: 2 }), (bindings, checkoutCount) => {
      const worktrees = Array.from({ length: checkoutCount }, (_, i) => ({ path: `/${i}`, branch }));
      const threads = bindings.map((binding, i) => ({
        key: String(i), title: String(i), paths: binding.checkout ? ["/0"] : [],
        attached: binding.attachment ? [42] : [],
        ...(binding.peer ? { remote: true as const } : {}),
      }));
      const owners = threads.filter((thread) => thread.paths.length && worktrees.length);
      const holders = threads.filter((thread) => thread.attached.length);
      const canAssign = checkoutCount <= 1 && owners.length <= 1 && holders.length <= 1;
      const expected = canAssign ? owners[0] ?? (checkoutCount === 0 ? holders[0] : undefined) : undefined;
      const input = { branch, pullRequest: 42, worktrees, threads };
      const result = stackLayerBinding(input);
      expect(result).toEqual(stackLayerBinding({ ...input, worktrees: [...worktrees].reverse(), threads: [...threads].reverse() }));
      expect(result).toEqual(expected ? {
        role: expected.remote ? "remote" : owners.length ? "layer" : "holder", thread: expected,
      } : { role: canAssign ? "unbound" : "ambiguous" });
    }));
  });

  it("agrees with catalog order for matching PR chains and reports base drift without reordering catalog layers", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 20 }),
      fc.boolean(),
      (numbers, drift) => {
        const ordered = numbers.map((number, index) => ({
          number,
          headRefName: `layer-${index}`,
          baseRefName: index === 0 ? "main" : `layer-${index - 1}`,
          lifecycleState: "open" as const,
        }));
        const input = ordered.map((pr, index) => drift && index === 1 ? { ...pr, baseRefName: "different-base" } : pr);
        const scrambled = [...input].sort((a, b) => a.number - b.number);
        if (!drift) expect(inferPullRequestStacks(scrambled, new Set())).toEqual([ordered]);
        expect(inferPullRequestStacks(scrambled, new Set(ordered.map((pr) => pr.headRefName)))).toEqual([]);
        for (const [i, pr] of input.entries()) {
          const branch = { branch: pr.headRefName };
          const parent = { branch: ordered[i]!.baseRefName };
          expect(stackLayerHealth({ branch, parent, pr })).toBe(drift && i === 1 ? "drift" : "unknown");
        }
      },
    ));
  });

  it("keeps independent chains sharing trunk separate and declines branching chains", () => {
    const pr = (number: number, headRefName: string, baseRefName: string) =>
      ({ number, headRefName, baseRefName, lifecycleState: "open" as const });
    const a = pr(1, "a", "main");
    const b = pr(2, "b", "main");
    const a2 = pr(3, "a2", "a");
    const b2 = pr(4, "b2", "b");
    expect(inferPullRequestStacks([b2, a, a2, b], new Set())).toEqual([[a, a2], [b, b2]]);
    expect(inferPullRequestStacks([b2, a, a2, b, pr(5, "a3", "a")], new Set())).toEqual([[b, b2]]);
  });
});
