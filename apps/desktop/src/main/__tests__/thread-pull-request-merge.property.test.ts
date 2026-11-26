import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import {
  resolveProjectForgeAutomation,
  resolveProjectNeverMergePolicy,
} from "@pwragent/shared/project-forge-automation";
import {
  mergeThreadPullRequest,
  readThreadPullRequestMerge,
  type ThreadPullRequestMergeDeps,
} from "../pr-status/thread-pull-request-merge";

/**
 * The renderer names a thread and a PR URL. Main must merge only a GitHub PR
 * attached to that thread, never one a Continue After wait holds, and with
 * one of the three methods. A pick from the card's method list becomes the
 * project's before the merge runs, as a to-do card's pick does.
 */
const THREAD = { backend: "codex", threadId: "thread-1" } as const;
const REPOS = [["pwrdrvr", "PwrAgent"], ["acme", "widgets"]] as const;

const prRef = fc.record({
  repo: fc.constantFrom(...REPOS),
  number: fc.integer({ min: 1, max: 4 }),
});
const githubUrl = (ref: { repo: readonly [string, string]; number: number }, upper = false) => {
  const [org, repo] = ref.repo;
  return `https://github.com/${upper ? org.toUpperCase() : org}/${upper ? repo.toUpperCase() : repo}/pull/${ref.number}`;
};
const identity = (ref: { repo: readonly [string, string]; number: number }) => `${ref.repo.join("/")}#${ref.number}`;

/** The thread's project as its owner stored it, and the base it read for each PR. */
type Project = { neverMerge?: true; mergeBranches?: string[] };
const BASES = ["main", "pwrdrvr"] as const;

function harness(attached: string[], held: Set<string>, project: Project = {}, bases = new Map<string, string>()) {
  const calls: string[] = [];
  const remember = vi.fn((method: ThreadTodoMergeMethod) => calls.push(`remember:${method}`));
  const merge = vi.fn(async (params: { pullRequest: string; method: ThreadTodoMergeMethod; assertCanMerge: (url: string) => void }) => {
    params.assertCanMerge(params.pullRequest);
    calls.push(`merge:${params.pullRequest}:${params.method}`);
    return { summary: "Squash-merged", mergedUrl: params.pullRequest };
  });
  const deps: ThreadPullRequestMergeDeps = {
    readThreadPullRequestUrls: () => attached,
    readPreference: async () => ({ remembered: "rebase", remember }),
    defaultMethod: () => "squash",
    neverMergePolicy: () => resolveProjectNeverMergePolicy({
      label: "canvas",
      automation: resolveProjectForgeAutomation(project),
    }),
    readPullRequestBase: (_thread, url) => bases.get(url),
    resolveCwd: async () => "/work/PwrAgent",
    assertNotHeld: (_thread, url) => {
      if (held.has(url)) throw new Error("Merge held: waiting for #9 to merge.");
    },
    merge,
    refresh: async () => undefined,
  };
  return { deps, merge, remember, calls };
}

describe("mergeThreadPullRequest (property)", () => {
  it("merges exactly when the PR is attached, not held, and its project merges or merges into the PR's base", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(prRef, { selector: identity, maxLength: 4 }),
      prRef,
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom<ThreadTodoMergeMethod>("squash", "rebase", "merge"),
      fc.boolean(),
      fc.subarray([...BASES]),
      // The base the owner read for each attached PR; undefined: not read yet.
      fc.array(fc.option(fc.constantFrom(...BASES), { nil: undefined }), { minLength: 4, maxLength: 4 }),
      async (attachedRefs, requested, upper, hold, method, neverMerge, mergeBranches, readBases) => {
        const attached = attachedRefs.map((ref) => githubUrl(ref));
        const bases = new Map(attached.flatMap((url, index) => readBases[index] ? [[url, readBases[index]!] as const] : []));
        const stored = attachedRefs.find((ref) => identity(ref) === identity(requested));
        const held = new Set(hold && stored ? [githubUrl(stored)] : []);
        const project: Project = neverMerge ? { neverMerge: true, mergeBranches } : {};
        const { deps, merge } = harness(attached, held, project, bases);
        const result = mergeThreadPullRequest(deps, { ...THREAD, url: githubUrl(requested, upper), method });
        // The rule, stated independently: a never-merge project merges only
        // a PR whose base, as the owner read it, it lists.
        const base = stored ? bases.get(githubUrl(stored)) : undefined;
        const projectMerges = !neverMerge || (base !== undefined && mergeBranches.includes(base));
        if (stored && !projectMerges) {
          await expect(result).rejects.toThrow(mergeBranches.length ? /canvas merges only pull requests into/ : /canvas never merges/);
          expect(merge).not.toHaveBeenCalled();
        } else if (stored && !hold) {
          await expect(result).resolves.toEqual({ summary: `Squash-merged #${requested.number}` });
          // The stored URL, not the renderer's spelling of it, goes to gh.
          expect(merge).toHaveBeenCalledTimes(1);
          expect(merge.mock.calls[0]![0]).toMatchObject({ pullRequest: githubUrl(stored), method, cwd: "/work/PwrAgent" });
        } else {
          await expect(result).rejects.toThrow(stored ? /Merge held/ : /not attached/);
          expect(merge).not.toHaveBeenCalled();
        }
      },
    ));
  });

  // Shrunk counterexamples: the pre-change gate refused every PR in a
  // never-merge project, including one into a listed branch.
  it("merges a never-merge project's PR into a listed branch, and refuses one whose base was not read", async () => {
    const url = githubUrl({ repo: REPOS[0], number: 4 });
    const project: Project = { neverMerge: true, mergeBranches: ["pwrdrvr"] };
    const read = harness([url], new Set(), project, new Map([[url, "pwrdrvr"]]));
    await expect(mergeThreadPullRequest(read.deps, { ...THREAD, url, method: "squash" }))
      .resolves.toEqual({ summary: "Squash-merged #4" });
    const unread = harness([url], new Set(), project);
    await expect(mergeThreadPullRequest(unread.deps, { ...THREAD, url, method: "squash" }))
      .rejects.toThrow("canvas merges only pull requests into pwrdrvr. Change it from the project menu: Forge Automation.");
    expect(unread.merge).not.toHaveBeenCalled();
  });

  it("refuses GitLab, non-PR URLs, unknown methods and malformed threads without merging", async () => {
    const attached = ["https://gitlab.com/group/app/-/merge_requests/7", githubUrl({ repo: REPOS[0], number: 1 })];
    const cases: [unknown, RegExp][] = [
      [{ ...THREAD, url: attached[0], method: "squash" }, /GitHub pull requests only/],
      [{ ...THREAD, url: "https://github.com/pwrdrvr/PwrAgent/issues/1", method: "squash" }, /not a pull request/],
      [{ ...THREAD, url: attached[1], method: "fast-forward" }, /squash, rebase or merge/],
      [{ backend: "nope", threadId: "thread-1", url: attached[1], method: "squash" }, /Choose a thread/],
      [{ ...THREAD, threadId: " ", url: attached[1], method: "squash" }, /Choose a thread/],
    ];
    for (const [request, error] of cases) {
      const { deps, merge } = harness(attached, new Set());
      await expect(mergeThreadPullRequest(deps, request)).rejects.toThrow(error);
      expect(merge).not.toHaveBeenCalled();
    }
  });

  it("remembers a method-list pick before merging, and a button click not at all", async () => {
    const url = githubUrl({ repo: REPOS[0], number: 2 });
    const picked = harness([url], new Set());
    await mergeThreadPullRequest(picked.deps, { ...THREAD, url, method: "merge", rememberMethod: true });
    expect(picked.calls).toEqual(["remember:merge", `merge:${url}:merge`]);
    const clicked = harness([url], new Set());
    await mergeThreadPullRequest(clicked.deps, { ...THREAD, url, method: "rebase" });
    expect(clicked.remember).not.toHaveBeenCalled();
  });

  it("keeps a queue's own summary and reports it queued", async () => {
    const url = githubUrl({ repo: REPOS[0], number: 3 });
    const { deps } = harness([url], new Set());
    const refresh = vi.spyOn(deps, "refresh");
    deps.merge = async () => ({ summary: "Added #3 to the merge queue · queued #2", queued: true });
    await expect(mergeThreadPullRequest(deps, { ...THREAD, url, method: "squash" }))
      .resolves.toEqual({ summary: "Added #3 to the merge queue · queued #2", queued: true });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(THREAD);
  });

  it("passes the stack layers the card chose to merge too, and refuses a list it cannot trust", async () => {
    const url = githubUrl({ repo: REPOS[0], number: 4 });
    await fc.assert(fc.asyncProperty(
      fc.oneof(
        fc.uniqueArray(fc.integer({ min: 1, max: 99_999 }), { maxLength: 64 }),
        fc.anything(),
        fc.array(fc.oneof(fc.integer(), fc.double(), fc.string()), { minLength: 1, maxLength: 70 }),
      ),
      async (layers) => {
        const { deps, merge } = harness([url], new Set());
        const valid = Array.isArray(layers) && layers.length <= 64
          && layers.every((number) => typeof number === "number" && Number.isSafeInteger(number) && number > 0)
          && new Set(layers).size === layers.length;
        const request = { ...THREAD, url, method: "squash", mergeOpenLayersBelow: layers };
        if (!valid && layers !== undefined) {
          await expect(mergeThreadPullRequest(deps, request)).rejects.toThrow("Choose the stack layers to merge again.");
          expect(merge).not.toHaveBeenCalled();
          return;
        }
        await mergeThreadPullRequest(deps, request);
        const sent = (merge.mock.calls[0]![0] as { mergeOpenLayersBelow?: number[] }).mergeOpenLayersBelow;
        expect(sent).toEqual(Array.isArray(layers) && layers.length ? layers : undefined);
      },
    ));
  });

  it("holds a stack merge while a wait holds any layer below it that GitHub would land too", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 3 }),
      fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
      async (below, heldLayer) => {
        const url = githubUrl({ repo: REPOS[0], number: 4 });
        const held = new Set(heldLayer === undefined ? [] : [githubUrl({ repo: REPOS[0], number: heldLayer })]);
        const { deps, merge } = harness([url], held);
        const request = { ...THREAD, url, method: "squash", mergeOpenLayersBelow: below };
        if (heldLayer !== undefined && below.includes(heldLayer)) {
          await expect(mergeThreadPullRequest(deps, request)).rejects.toThrow("Merge held");
          expect(merge).not.toHaveBeenCalled();
        } else {
          await mergeThreadPullRequest(deps, request);
          expect(merge).toHaveBeenCalledOnce();
        }
      },
    ));
  });

  it("reads the remembered pick and the Settings default", async () => {
    const { deps } = harness([], new Set());
    await expect(readThreadPullRequestMerge(deps, THREAD)).resolves.toEqual({ remembered: "rebase", fallback: "squash" });
  });

  it("tells the card when the thread's project never merges, and the branches it still merges into", async () => {
    const { deps } = harness([], new Set(), { neverMerge: true });
    await expect(readThreadPullRequestMerge(deps, THREAD))
      .resolves.toEqual({ remembered: "rebase", fallback: "squash", neverMergeProject: "canvas" });
    const listed = harness([], new Set(), { neverMerge: true, mergeBranches: ["pwrdrvr"] });
    await expect(readThreadPullRequestMerge(listed.deps, THREAD))
      .resolves.toEqual({ remembered: "rebase", fallback: "squash", neverMergeProject: "canvas", mergeBranches: ["pwrdrvr"] });
  });
});
