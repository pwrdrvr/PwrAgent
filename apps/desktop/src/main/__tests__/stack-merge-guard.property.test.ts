import fc from "fast-check";
import { expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { assertGithubStackMergeAllowed, isObservedStackParent } from "../stacks/stack-merge-guard";

it("holds a merge offer while the child targets a parent that merged during the child's lifetime", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.integer({ min: -500, max: 500 }), (sameProject, retargeted, mergedAfterChild) => {
    const parent: PrSummary = {
      number: 1, headRefName: "parent", provider: "github.com", org: "fixture", repo: "project", state: "merged",
      lifecycleState: "merged", mergedAt: 1000 + mergedAfterChild, url: "https://github.com/fixture/project/pull/1",
      ...(sameProject ? {} : { sourceRepository: { provider: "github.com", org: "fork", repo: "project" } }),
    };
    const child: PrSummary = {
      number: 2, baseRefName: retargeted ? "main" : "parent", provider: "github.com", org: "fixture", repo: "project",
      state: "passing", lifecycleState: "open", createdAt: 1000, url: "https://github.com/fixture/project/pull/2",
    };
    expect(isObservedStackParent(parent, child)).toBe(sameProject && !retargeted && mergedAfterChild >= 0);
  }), { examples: [[true, false, 0]] });
});

it("uses the catalog trunk and resolves unnumbered lower layers from the same repository", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("release", "maintenance"), fc.boolean(), fc.boolean(),
    async (trunk, hasLower, merged) => {
      const requests: string[] = [];
      const repository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "project" };
      const result = assertGithubStackMergeAllowed(repository, 3, [{
        schemaVersion: 1, repository: "github.com:fixture/project",
        stacks: [{ trunk: { branch: trunk }, branches: [
          ...(hasLower ? [{ branch: "lower" }] : []), { branch: "upper", pullRequest: { number: 3 } },
        ] }],
      }], async (route) => {
        const head = (ref: string) => ({ ref, repo: { full_name: "fixture/project" } });
        const base = { ref: trunk, repo: { default_branch: "main" } };
        requests.push(route);
        if (route === "/pulls/3") return { head: head("upper"), base };
        if (route === "/pulls/2") return { merged };
        if (new URLSearchParams(route.split("?")[1]).get("head") === "fixture:lower") {
          return [{ number: 2, head: head("lower"), base, state: merged ? "closed" : "open", merged_at: merged ? "2026-01-01" : null }];
        }
        return [{ number: 1, head: head(trunk), state: "open" }];
      });
      if (!hasLower || merged) await expect(result).resolves.toBe(trunk);
      else await expect(result).rejects.toMatchObject({ code: "stack_parent_open" });
      expect(requests.some((route) => new URLSearchParams(route.split("?")[1]).get("head") === `fixture:${trunk}`)).toBe(false);
    },
  ), { examples: [["release", false, false], ["release", true, true]] });
});
