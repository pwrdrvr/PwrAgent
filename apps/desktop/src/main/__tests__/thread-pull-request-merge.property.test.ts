import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
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

function harness(attached: string[], held: Set<string>) {
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
  it("merges exactly when the PR is attached to the thread and not held", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(prRef, { selector: identity, maxLength: 4 }),
      prRef,
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom<ThreadTodoMergeMethod>("squash", "rebase", "merge"),
      async (attachedRefs, requested, upper, hold, method) => {
        const attached = attachedRefs.map((ref) => githubUrl(ref));
        const stored = attachedRefs.find((ref) => identity(ref) === identity(requested));
        const held = new Set(hold && stored ? [githubUrl(stored)] : []);
        const { deps, merge } = harness(attached, held);
        const result = mergeThreadPullRequest(deps, { ...THREAD, url: githubUrl(requested, upper), method });
        if (stored && !hold) {
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

  it("reads the remembered pick and the Settings default", async () => {
    const { deps } = harness([], new Set());
    await expect(readThreadPullRequestMerge(deps, THREAD)).resolves.toEqual({ remembered: "rebase", fallback: "squash" });
  });
});
