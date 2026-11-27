import fc from "fast-check";
import { expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { assertGithubStackMergeAllowed, isObservedStackParent } from "../stacks/stack-merge-guard";

it("keeps a retargeted top layer held until its merged intermediate has a path to trunk", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (bottomMerged) => {
    const repository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "project" };
    const sha = (c: string) => c.repeat(40);
    const head = (ref: string, c: string) => ({ ref, sha: sha(c), repo: { full_name: "fixture/project" } });
    const base = (ref: string) => ({ ref, repo: { default_branch: "main" } });
    const opened = "2026-01-01T00:00:00Z";
    const result = assertGithubStackMergeAllowed(repository, 3, [], async (route) => {
      if (route === "/pulls/3") return { head: head("top", "c"), base: base("main"), created_at: opened };
      if (route.startsWith("/compare/")) {
        const from = route.slice("/compare/".length).split("...")[0];
        return { merge_base_commit: { sha: from } };
      }
      if (new URLSearchParams(route.split("?")[1]).get("head") === "fixture:middle") {
        return [{ number: 2, head: head("middle", "b"), base: base("bottom"), created_at: opened,
          state: "closed", merged_at: "2026-01-03T00:00:00Z", merge_commit_sha: sha("d") }];
      }
      return [{ number: 1, head: head("bottom", "a"), base: base("main"), created_at: opened,
        state: bottomMerged ? "closed" : "open", merged_at: bottomMerged ? "2026-01-04T00:00:00Z" : null }];
    }, async () => ({ repository: { pullRequest: { baseRefName: "main", headRefOid: sha("c"),
      timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [
        { previousRefName: "middle", currentRefName: "main", createdAt: "2026-01-02T00:00:00Z" },
      ] },
    } } }));
    if (bottomMerged) await expect(result).resolves.toBe("main");
    else await expect(result).rejects.toMatchObject({ code: "stack_parent_open", message: expect.stringContaining("#1") });
  }), { examples: [[false], [true]] });
});

it("reconstructs a retargeted child's lower layer after starting with no local history", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("same", "recycled", "fork", "unproven"), fc.boolean(), async (parentKind, merged) => {
    const repository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "project" };
    const parentSha = "a".repeat(40);
    const childSha = "b".repeat(40);
    const get = async (route: string) => {
      if (route === "/pulls/3") return {
        created_at: "2026-01-02T00:00:00Z", head: { ref: "upper", sha: childSha },
        base: { ref: "main", repo: { default_branch: "main" } },
      };
      if (route.startsWith("/pulls?")) return [{
        number: 2, state: merged ? "closed" : "open",
        created_at: parentKind === "recycled" ? "2026-01-04T00:00:00Z" : "2026-01-01T00:00:00Z",
        merged_at: merged ? "2026-01-05T00:00:00Z" : null,
        base: { ref: "main" },
        head: { ref: "lower", sha: parentSha, repo: { full_name: parentKind === "fork" ? "fork/project" : "fixture/project" } },
      }];
      if (route.startsWith("/compare/")) return { merge_base_commit: { sha: parentKind === "unproven" ? "c".repeat(40) : parentSha } };
      throw new Error(route);
    };
    const graphql = async () => ({ repository: { pullRequest: {
      baseRefName: "main", headRefOid: childSha,
      timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [{
        previousRefName: "lower", currentRefName: "main", createdAt: "2026-01-03T00:00:00Z",
      }] },
    } } });
    // A fresh resolver and no catalog reproduce the checkout-less restart.
    const lower: number[] = [];
    const guard = assertGithubStackMergeAllowed(repository, 3, [], get, graphql, (number) => lower.push(number));
    if (parentKind === "recycled" || parentKind === "fork" || merged) await expect(guard).resolves.toBe("main");
    else await expect(guard).rejects.toMatchObject({ code: "stack_parent_open" });
    expect(lower).toEqual(parentKind === "same" && !merged ? [2] : []);
  }), { examples: [["same", false], ["recycled", false], ["unproven", false]] });
});

it("uses bounded REST history only for an older GitHub Enterprise schema, and holds when it cannot establish the old refs", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (wasRetargeted, truncated) => {
    const repository = { provider: "github" as const, host: "ghe.example.com", owner: "fixture", repo: "project" };
    const routes: string[] = [];
    const check = assertGithubStackMergeAllowed(repository, 3, [], async (route) => {
      routes.push(route);
      if (route === "/pulls/3") return {
        created_at: "2026-01-02T00:00:00Z", head: { ref: "upper", sha: "a".repeat(40) },
        base: { ref: "main", repo: { default_branch: "main" } },
      };
      return Array.from({ length: truncated ? 100 : 1 }, () => ({
        event: wasRetargeted ? "base_ref_changed" : "labeled",
      }));
    }, async () => { throw new Error("Field 'timelineItems' doesn't exist on type 'PullRequest'"); });
    if (wasRetargeted || truncated) await expect(check).rejects.toMatchObject({ code: "stack_parent_open" });
    else await expect(check).resolves.toBe("main");
    expect(routes).toEqual(["/pulls/3", "/issues/3/timeline?per_page=100"]);
  }));
});

it("makes no branch lookups when the historical branch or timeline budget is exceeded", async () => {
  const repository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "project" };
  const head = "a".repeat(40);
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5, max: 16 }), fc.boolean(), async (count, truncated) => {
    const requests: string[] = [];
    const result = assertGithubStackMergeAllowed(repository, 99, [], async (route) => {
      requests.push(route);
      return { created_at: "2026-01-01T00:00:00Z", head: { sha: head }, base: { ref: "main", repo: { default_branch: "main" } } };
    }, async () => ({
      repository: { pullRequest: {
        baseRefName: "main", headRefOid: head,
        timelineItems: { pageInfo: { hasPreviousPage: truncated }, nodes: Array.from({ length: count }, (_, index) => ({
          previousRefName: `old-${index}`, currentRefName: index === count - 1 ? "main" : `old-${index + 1}`,
          createdAt: new Date(Date.UTC(2026, 0, index + 2)).toISOString(),
        })) },
      } },
    }));
    await expect(result).rejects.toMatchObject({ code: "stack_parent_open" });
    expect(requests).toEqual(["/pulls/99"]);
  }));
});

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
      }, async () => { throw new Error("The catalog already establishes the trunk."); });
      if (!hasLower || merged) await expect(result).resolves.toBe(trunk);
      else await expect(result).rejects.toMatchObject({ code: "stack_parent_open" });
      expect(requests.some((route) => new URLSearchParams(route.split("?")[1]).get("head") === `fixture:${trunk}`)).toBe(false);
    },
  ), { examples: [["release", false, false], ["release", true, true]] });
});

const auditRepository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "project" };
const auditBase = (ref: string) => ({ ref, repo: { default_branch: "main" } });
const auditSha = (number: number) => number.toString(16).padStart(40, "0");
const auditHead = (number: number) => ({ ref: `layer-${number}`, sha: auditSha(number), repo: { full_name: "fixture/project" } });
const auditDate = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();

function catalogEvidence(numberedLayers: readonly (readonly boolean[])[], open?: number) {
  const child = Math.max(...numberedLayers.map((layers) => layers.length)) + 1;
  const catalogs = numberedLayers.map((numbered) => ({
    schemaVersion: 1 as const,
    repository: "github.com:fixture/project",
    stacks: [{ trunk: { branch: "main" }, branches: [
      ...numbered.map((hasNumber, index) => ({
        branch: `layer-${index + 1}`,
        ...(hasNumber ? { pullRequest: { number: index + 1 } } : {}),
      })),
      { branch: `layer-${child}`, pullRequest: { number: child } },
    ] }],
  }));
  const routes: string[] = [];
  const guard = assertGithubStackMergeAllowed(auditRepository, child, catalogs, async (route) => {
    routes.push(route);
    if (route === `/pulls/${child}`) return { head: auditHead(child), base: auditBase("main") };
    if (route.startsWith("/pulls/")) return { merged: Number(route.slice(7)) !== open };
    const branch = new URLSearchParams(route.split("?")[1]).get("head");
    const number = Number(branch?.split("-").at(-1));
    if (number > 0 && number < child) return [{
      number, head: auditHead(number), base: auditBase("main"),
      state: number === open ? "open" : "closed", merged_at: number === open ? null : auditDate(5),
    }];
    throw new Error(`Unexpected route ${route}`);
  }, async () => { throw new Error("Expected the catalog to supply the stack."); });
  return { guard, routes };
}

function historicalEvidence(size: number) {
  const child = size + 1;
  const history = Array.from({ length: size }, (_, index) => {
    const number = size - index;
    return {
      previousRefName: auditHead(number).ref,
      currentRefName: number === 1 ? "main" : auditHead(number - 1).ref,
      createdAt: auditDate(5 + index),
    };
  });
  const routes: string[] = [];
  const guard = assertGithubStackMergeAllowed(auditRepository, child, [], async (route) => {
    routes.push(route);
    if (route === `/pulls/${child}`) return {
      head: auditHead(child), base: auditBase("main"), created_at: auditDate(2),
    };
    if (route.startsWith("/compare/")) {
      const [ancestor, descendant] = route.slice(9).split("?")[0]!.split("...");
      const mergedChild = Number.parseInt(ancestor!, 16) - 100;
      const parent = Number.parseInt(descendant!, 16);
      if (mergedChild !== parent + 1) throw new Error(`Unexpected ancestry edge ${route}`);
      return { merge_base_commit: { sha: ancestor } };
    }
    const branch = new URLSearchParams(route.split("?")[1]).get("head");
    const number = Number(branch?.split("-").at(-1));
    if (number > 0 && number < child) return [{
      number, head: auditHead(number), base: auditBase(number === 1 ? "main" : auditHead(number - 1).ref),
      state: "closed", created_at: auditDate(1), merged_at: auditDate(5 + size - number), merge_commit_sha: auditSha(100 + number),
    }];
    throw new Error(`Unexpected route ${route}`);
  }, async () => ({ repository: { pullRequest: { baseRefName: "main", headRefOid: auditSha(child),
    timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: history },
  } } }));
  return { guard, routes };
}

it("shares lower-layer evidence across separate clones of the same repository", async () => {
  const { guard, routes } = catalogEvidence([[false, true], [false, true]]);
  await expect(guard).resolves.toBe("main");
  expect(routes.filter((route) => route.startsWith("/pulls?"))).toHaveLength(1);
  expect(routes.filter((route) => route === "/pulls/1")).toHaveLength(1);
  expect(routes.filter((route) => route === "/pulls/2")).toHaveLength(1);

  const divergent = catalogEvidence([[false], [false, true]], 2);
  await expect(divergent.guard).rejects.toMatchObject({ code: "stack_parent_open", message: expect.stringContaining("#2") });
});

it("only compares an immutable ancestry edge once when former bases share lower layers", async () => {
  const { guard, routes } = historicalEvidence(3);
  await expect(guard).resolves.toBe("main");
  expect(routes.filter((route) => route.startsWith("/compare/"))).toHaveLength(2);
});
