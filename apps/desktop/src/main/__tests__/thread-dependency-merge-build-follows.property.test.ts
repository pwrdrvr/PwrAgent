import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ThreadDependency,
  ThreadDependencyCondition,
  ThreadDependencyEvidence,
  ThreadDependencyMergeBuildObservation,
} from "@pwragent/shared/contracts/thread-dependencies";
import { buildDependencyPrompt } from "../app-server/thread-dependency-coordinator";
import { THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS } from "@pwragent/shared/contracts/thread-dependencies";
import {
  MERGE_BUILD_SETTLE_MS,
  evaluateMergeBuildCondition,
  mergeMergeBuildCheck,
  readMergeBuild,
  type MergeBuildTarget,
} from "../app-server/thread-dependency-merge-builds";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";

const PR_URL = "https://github.com/example/app/pull/41";
const MERGED_AT = 1_000_000;
const POLL_MS = 2 * 60_000;
const GITHUB: ForgeRepository = { provider: "github", host: "github.com", owner: "example", repo: "app" };
const GITLAB: ForgeRepository = { provider: "gitlab", host: "gitlab.com", owner: "example", repo: "app" };
const condition: ThreadDependencyCondition = { backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL };
const mergedPr: ThreadDependencyEvidence = { condition, state: "satisfied", reason: "PR merged", observedAt: 0, prUrl: PR_URL };

/** Commit `index` on the target branch: 0 is the merge commit, later ones were pushed after it. */
const sha = (index: number): string => (index + 1).toString(16).padStart(40, "a");

type Build = { conclusion: "success" | "failure" | "cancelled"; finishesAtPoll: number };
type History = {
  /** Index 0 is the merge commit's build. */
  builds: Build[];
  /** The poll at which commit `index` became the branch head; 0 for the merge commit. */
  pushedAt: number[];
  /** Commits pushed on top of something else: they do not contain the merge. */
  diverged: boolean[];
};

const historyArb: fc.Arbitrary<History> = fc.integer({ min: 1, max: 6 }).chain((length) => fc.record({
  builds: fc.array(fc.record({
    conclusion: fc.constantFrom("success" as const, "failure" as const, "cancelled" as const, "cancelled" as const),
    finishesAtPoll: fc.integer({ min: 0, max: 3 }),
  }), { minLength: length, maxLength: length }),
  pushGaps: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: length, maxLength: length }),
  diverged: fc.array(fc.boolean(), { minLength: length, maxLength: length }),
})).map(({ builds, pushGaps, diverged }) => {
  let at = 0;
  return {
    builds,
    pushedAt: pushGaps.map((gap, index) => index === 0 ? 0 : (at += gap)),
    diverged: diverged.map((value, index) => index > 0 && value),
  };
});

/** The newest commit on the branch at `poll`. */
function headAt(history: History, poll: number): number {
  let head = 0;
  history.pushedAt.forEach((at, index) => { if (at <= poll) head = index; });
  return head;
}

/**
 * The rule, stated as the operator would: the merge build decides, unless a
 * newer push cancelled it. Then the branch's newest build that contains the
 * merge decides, the same way, up to the follow limit. A build that is still
 * cancelled when nothing newer contains the merge, or at the limit, passes.
 * A build followed at one check decides no sooner than the next: its result
 * is believed only a minute after it was followed, as the merge build's is
 * after the merge.
 */
function oracle(history: History, polls: number): "success" | "failure" | "cancelled" | "waiting" {
  let current = 0;
  let follows = 0;
  let followedAtPoll = -1;
  for (let poll = 0; poll < polls; poll++) {
    for (;;) {
      const build = history.builds[current]!;
      if (build.finishesAtPoll > poll) break;
      const settled = followedAtPoll < poll;
      if (build.conclusion !== "cancelled") {
        if (settled) return build.conclusion;
        break;
      }
      const head = headAt(history, poll);
      if (follows >= THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS || head === current || history.diverged[head]) {
        if (settled) return "cancelled";
        break;
      }
      current = head;
      follows += 1;
      followedAtPoll = poll;
    }
  }
  return "waiting";
}

/** A forge that serves `history` as it stands at the current poll, and records every read. */
function forge(history: History, repository: ForgeRepository) {
  let poll = 0;
  const checksRead = new Set<number>();
  const reads: string[] = [];
  const commitIndex = (value: string): number => {
    const index = history.builds.findIndex((_, candidate) => sha(candidate) === value);
    if (index < 0) throw new Error(`unknown commit ${value}`);
    return index;
  };
  const get = async (_repository: ForgeRepository, path: string): Promise<unknown> => {
    reads.push(path);
    const runs = /commits\/([0-9a-f]{40})\/check-runs/.exec(path);
    if (runs) {
      const index = commitIndex(runs[1]!);
      checksRead.add(index);
      const build = history.builds[index]!;
      const done = build.finishesAtPoll <= poll;
      return { total_count: 1, check_runs: [{ name: "unit", status: done ? "completed" : "in_progress", conclusion: done ? build.conclusion : null }] };
    }
    if (/commits\/[0-9a-f]{40}\/status/.test(path)) return { statuses: [] };
    const pipelines = /pipelines\?sha=([0-9a-f]{40})/.exec(path);
    if (pipelines) {
      const index = commitIndex(pipelines[1]!);
      checksRead.add(index);
      const build = history.builds[index]!;
      const done = build.finishesAtPoll <= poll;
      return [{ id: index + 1, status: done ? (build.conclusion === "cancelled" ? "canceled" : build.conclusion === "failure" ? "failed" : "success") : "running" }];
    }
    if (/branches\/main$/.test(path)) {
      const head = sha(headAt(history, poll));
      return repository.provider === "gitlab" ? { commit: { id: head } } : { commit: { sha: head } };
    }
    const compare = /compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})/.exec(path);
    if (compare) return { status: history.diverged[commitIndex(compare[2]!)] ? "diverged" : "ahead" };
    const mergeBase = /merge_base\?refs%5B%5D=([0-9a-f]{40})&refs%5B%5D=([0-9a-f]{40})/.exec(path);
    if (mergeBase) return { id: history.diverged[commitIndex(mergeBase[2]!)] ? sha(99) : mergeBase[1] };
    throw new Error(`unexpected read ${path}`);
  };
  return { get, checksRead, reads, setPoll: (next: number) => { poll = next; } };
}

/** Polls as the owner does: each check continues from the last, and the wait fires at most once. */
async function run(history: History, repository: ForgeRepository, polls: number) {
  const served = forge(history, repository);
  const target: MergeBuildTarget = { repository, mergeCommitSha: sha(0), baseBranch: "main", mergedAt: MERGED_AT };
  let observation: ThreadDependencyMergeBuildObservation | undefined;
  let evidence: ThreadDependencyEvidence | undefined;
  for (let poll = 0; poll < polls && (!evidence || evidence.state === "waiting"); poll++) {
    served.setPoll(poll);
    const now = MERGED_AT + MERGE_BUILD_SETTLE_MS + poll * POLL_MS;
    observation = mergeMergeBuildCheck(observation, await readMergeBuild(served.get, target, now, observation));
    evidence = evaluateMergeBuildCondition(condition, mergedPr, observation, evidence, now);
  }
  return { evidence, observation, served };
}

describe("following a merge build that a newer push cancelled", () => {
  it("ends as the oracle says for any branch history, on GitHub and GitLab", async () => {
    await fc.assert(fc.asyncProperty(historyArb, fc.constantFrom(GITHUB, GITLAB), async (history, repository) => {
      // Enough polls for every build to finish and every push to land, plus
      // one to let a followed build settle.
      const polls = Math.max(...history.pushedAt, ...history.builds.map((build) => build.finishesAtPoll)) + 3;
      const expected = oracle(history, polls);
      const { evidence } = await run(history, repository, polls);
      if (expected === "waiting") {
        expect(evidence?.state).toBe("waiting");
        return;
      }
      expect(evidence?.state).toBe(expected === "failure" ? "failed" : "satisfied");
      expect(evidence?.reason).toMatch(expected === "success" ? /passed/ : expected === "failure" ? /failed/ : /cancelled/);
    }));
  });

  it("reads at most the merge build and the follow limit's builds, and never a commit without the merge", async () => {
    await fc.assert(fc.asyncProperty(historyArb, async (history) => {
      const { served, observation } = await run(history, GITHUB, 12);
      expect(served.checksRead.size).toBeLessThanOrEqual(THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS + 1);
      for (const index of served.checksRead) expect(history.diverged[index]).toBe(false);
      expect(observation?.follows ?? 0).toBeLessThanOrEqual(THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS);
      // Only a cancelled build asks about the branch: no build was cancelled, no branch read.
      if (!history.builds.some((build) => build.conclusion === "cancelled")) {
        expect(served.reads.some((path) => path.includes("/branches/"))).toBe(false);
      }
    }));
  });

  it("stops following at the limit when every newer build is cancelled too", async () => {
    // Six builds, each cancelled by the next push: the first newer push
    // cancelled the merge build, then one more landed at every check.
    const history: History = {
      builds: Array.from({ length: 6 }, () => ({ conclusion: "cancelled" as const, finishesAtPoll: 0 })),
      pushedAt: [0, 0, 1, 2, 3, 4],
      diverged: Array.from({ length: 6 }, () => false),
    };
    const { evidence, observation, served } = await run(history, GITHUB, 12);
    expect(observation?.follows).toBe(THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS);
    expect(served.checksRead.size).toBe(THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS + 1);
    expect(evidence).toMatchObject({ state: "satisfied" });
    expect(evidence?.reason).toContain(`stopped following after ${THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS} newer builds`);
  });

  it("says no newer build held the merge when a followed build is cancelled below the limit", async () => {
    // The merge build was cancelled by one push, whose own build was then
    // cancelled with nothing newer on the branch.
    const history: History = {
      builds: [{ conclusion: "cancelled", finishesAtPoll: 0 }, { conclusion: "cancelled", finishesAtPoll: 0 }],
      pushedAt: [0, 0],
      diverged: [false, false],
    };
    for (const repository of [GITHUB, GITLAB]) {
      const { evidence, observation } = await run(history, repository, 4);
      expect(observation?.follows).toBe(1);
      expect(evidence).toMatchObject({ state: "satisfied" });
      expect(evidence?.reason).toContain("no newer build on the branch contains the merge");
      expect(evidence?.reason).not.toContain("stopped following");
    }
  });

  it("keeps a cancelled build's pass when the branch is gone, and retries any other read error", async () => {
    const target = (repository: ForgeRepository): MergeBuildTarget => ({ repository, mergeCommitSha: sha(0), baseBranch: "feat/parent", mergedAt: MERGED_AT });
    const cancelled = (path: string): unknown => /check-runs/.test(path)
      ? { total_count: 1, check_runs: [{ name: "unit", status: "completed", conclusion: "cancelled" }] }
      : /\/status\?/.test(path) ? { statuses: [] }
        : /pipelines\?/.test(path) ? [{ id: 1, status: "canceled" }]
          : undefined;
    const now = MERGED_AT + MERGE_BUILD_SETTLE_MS;
    for (const repository of [GITHUB, GITLAB]) {
      // A stacked PR's base branch, deleted after its parent merged: 404.
      for (const code of ["not_found", "rejected"]) {
        const gone = async (_repository: ForgeRepository, path: string): Promise<unknown> =>
          cancelled(path) ?? Promise.reject(Object.assign(new Error("Not Found"), { code }));
        const observation = await readMergeBuild(gone, target(repository), now);
        expect(observation).toMatchObject({ status: "completed", conclusion: "cancelled" });
        expect(observation.followedSha).toBeUndefined();
        const evidence = evaluateMergeBuildCondition(condition, mergedPr, observation, undefined, now);
        expect(evidence).toMatchObject({ state: "satisfied" });
        expect(evidence.reason).toContain("no newer build on the branch contains the merge");
      }
      // A transient error is the poller's to retry, not a verdict.
      const flaky = async (_repository: ForgeRepository, path: string): Promise<unknown> =>
        cancelled(path) ?? Promise.reject(Object.assign(new Error("Bad gateway"), { code: "provider_error" }));
      await expect(readMergeBuild(flaky, target(repository), now)).rejects.toThrow("Bad gateway");
    }
  });

  it("counts a followed build's windows from when it was followed", async () => {
    // The merge build was cancelled at once; the newer build finished as it was followed.
    const history: History = {
      builds: [{ conclusion: "cancelled", finishesAtPoll: 0 }, { conclusion: "failure", finishesAtPoll: 0 }],
      pushedAt: [0, 0],
      diverged: [false, false],
    };
    const served = forge(history, GITHUB);
    const target: MergeBuildTarget = { repository: GITHUB, mergeCommitSha: sha(0), baseBranch: "main", mergedAt: MERGED_AT };
    const now = MERGED_AT + 10 * 60_000;
    const first = await readMergeBuild(served.get, target, now);
    expect(first).toMatchObject({ followedSha: sha(1), followedAt: now, follows: 1, status: "completed", conclusion: "failure" });
    expect(evaluateMergeBuildCondition(condition, mergedPr, first, undefined, now).state).toBe("waiting");
    const later = await readMergeBuild(served.get, target, now + MERGE_BUILD_SETTLE_MS, first);
    const fired = evaluateMergeBuildCondition(condition, mergedPr, later, undefined, now + MERGE_BUILD_SETTLE_MS);
    expect(fired).toMatchObject({ state: "failed" });
    expect(fired.reason).toContain(`followed to ${sha(1).slice(0, 12)}`);
    // The next check read the followed commit directly, not the merge commit again.
    expect(served.reads.filter((path) => path.includes(`commits/${sha(0)}/check-runs`))).toHaveLength(1);
    // The wake says the checks are a later commit's, which may carry the break.
    const dependency: ThreadDependency = {
      id: "wait-1", backend: "codex", threadId: "feature", mode: "all", onFailure: "notify", status: "ready", outcome: "failure",
      conditions: [condition], evidence: [fired], createdAt: 1, updatedAt: 1,
    };
    const prompt = buildDependencyPrompt(dependency);
    expect(prompt).toContain(`Followed build ${sha(1)}, which contains the merge: completed, failure`);
    expect(prompt).toContain("A failure may come from a change pushed after this merge.");
  });
});
