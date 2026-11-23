import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrMergeQueueState, PrSummary } from "../contracts/navigation";
import { THREAD_TODO_MERGE_METHODS, type ThreadTodoMergeMethod } from "../contracts/thread-todos";
import {
  pullRequestMergeMethods,
  pullRequestUrlForge,
  resolvePullRequestMergeOffer,
} from "../pull-request-merge-offer";

/**
 * Rules from the PR card's merge design (PR Card Merge Actions UX Review):
 * only an open, ready, conflict-free GitHub PR offers a direct merge; a base
 * branch with a queue offers the queue instead unless the PR is in it; the
 * chevron lists only methods the repository allows, in the to-do card's
 * order; the button runs the remembered pick, then the Settings default, and
 * never a method the repository refuses.
 */
const URLS = {
  github: "https://github.com/pwrdrvr/PwrAgent/pull/4186",
  enterprise: "https://git.example.com/team/app/pull/12",
  gitlab: "https://gitlab.com/group/sub/app/-/merge_requests/7",
} as const;
const QUEUE_STATES: (PrMergeQueueState | undefined)[] = [
  undefined, "not_queued", "queued", "group_checks_running", "merging", "unmergeable", "removed", "merged_by_queue",
];
const ACTIVE_QUEUE = new Set<PrMergeQueueState>(["queued", "group_checks_running", "merging", "unmergeable"]);
const method = fc.constantFrom<ThreadTodoMergeMethod>(...THREAD_TODO_MERGE_METHODS);

const arbitraryInput = fc.record({
  url: fc.constantFrom(...Object.values(URLS)),
  lifecycleState: fc.constantFrom<PrSummary["lifecycleState"]>(undefined, "open", "merged", "closed"),
  reviewState: fc.constantFrom<PrSummary["reviewState"]>(undefined, "draft", "ready_for_review"),
  mergeState: fc.constantFrom<PrSummary["mergeState"]>(undefined, "mergeable", "conflicting", "unknown"),
  queueState: fc.constantFrom(...QUEUE_STATES),
  allowed: fc.option(fc.subarray([...THREAD_TODO_MERGE_METHODS]), { nil: undefined }),
  remembered: fc.option(method, { nil: undefined }),
  fallback: fc.option(method, { nil: undefined }),
}).map((input) => ({
  ...input,
  pr: {
    provider: "github.com",
    number: 4186,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "passing",
    url: input.url,
    ...(input.lifecycleState ? { lifecycleState: input.lifecycleState } : {}),
    ...(input.reviewState ? { reviewState: input.reviewState } : {}),
    ...(input.mergeState ? { mergeState: input.mergeState } : {}),
    ...(input.queueState ? { mergeQueue: { kind: "merge_queue", state: input.queueState } } : {}),
    ...(input.allowed ? { allowedMergeMethods: input.allowed } : {}),
  } satisfies PrSummary,
}));

describe("resolvePullRequestMergeOffer (property)", () => {
  it("offers a direct merge only for an open, ready, conflict-free GitHub PR outside a queue", () => {
    fc.assert(fc.property(arbitraryInput, (input) => {
      const offer = resolvePullRequestMergeOffer(input);
      const landable = input.url !== URLS.gitlab
        && (input.lifecycleState ?? "open") === "open"
        && input.reviewState !== "draft"
        && input.mergeState !== "conflicting";
      const queued = input.queueState !== undefined && input.queueState !== "merged_by_queue";
      expect(offer.kind === "merge").toBe(landable && !queued);
      expect(offer.kind === "queue").toBe(landable && queued && !ACTIVE_QUEUE.has(input.queueState!));
      if (offer.kind === "queue") expect(offer.again).toBe(input.queueState === "removed");
    }));
  });

  it("lists only allowed methods, in the to-do card's order, and runs one of them", () => {
    fc.assert(fc.property(arbitraryInput, (input) => {
      const offer = resolvePullRequestMergeOffer(input);
      if (offer.kind !== "merge") return;
      expect(offer.methods.length).toBeGreaterThan(0);
      expect(offer.methods).toEqual(THREAD_TODO_MERGE_METHODS.filter((m) => offer.methods.includes(m)));
      if (input.allowed && input.allowed.length > 0) {
        expect(offer.methods).toEqual(THREAD_TODO_MERGE_METHODS.filter((m) => input.allowed!.includes(m)));
      }
      expect(offer.methods).toContain(offer.method);
    }));
  });

  it("runs the remembered pick, then the default, when the repository allows it", () => {
    fc.assert(fc.property(arbitraryInput, (input) => {
      const offer = resolvePullRequestMergeOffer(input);
      if (offer.kind !== "merge") return;
      const expected = [input.remembered, input.fallback].find((m) => m && offer.methods.includes(m))
        ?? offer.methods[0];
      expect(offer.method).toBe(expected);
    }));
  });

  it("never offers GitLab's missing rebase, nor a method outside the forge's list", () => {
    fc.assert(fc.property(arbitraryInput, (input) => {
      const methods = pullRequestMergeMethods(input.pr);
      if (input.url === URLS.gitlab) expect(methods).not.toContain("rebase");
      expect(methods.length).toBeGreaterThan(0);
    }));
  });
});

describe("pullRequestUrlForge", () => {
  it("reads the forge from the change-request path, including Enterprise hosts", () => {
    expect(pullRequestUrlForge(URLS.github)).toBe("github");
    expect(pullRequestUrlForge(URLS.enterprise)).toBe("github");
    expect(pullRequestUrlForge(URLS.gitlab)).toBe("gitlab");
    expect(pullRequestUrlForge("https://github.com/pwrdrvr/PwrAgent/issues/12")).toBeUndefined();
    expect(pullRequestUrlForge("not a url")).toBeUndefined();
  });
});
