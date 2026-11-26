import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ManageThreadDependenciesRequest,
  ThreadDependencyCondition,
  ThreadDependencyEvidence,
  ThreadDependencyMergeBuildObservation,
} from "@pwragent/shared/contracts/thread-dependencies";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadDependencyCoordinator, buildDependencyPrompt, validateDependencyCreate } from "../app-server/thread-dependency-coordinator";
import { readFederationThreadDependenciesRequest } from "../app-server/thread-dependencies-federation";
import {
  cancelMergeBuildWatches,
  createMergeBuildWatch,
  describeMergeBuildWatch,
  mergeBuildPullRequestUrl,
  mergeBuildWaitForPr,
  ownMergeBuildWaits,
} from "../../renderer/src/features/pr-watches/merge-build-watches";
import {
  MERGE_BUILD_NO_CHECKS_MS,
  MERGE_BUILD_SETTLE_MS,
  MERGE_BUILD_WAITING_FOR_MERGE_REASON,
  MERGE_BUILD_WAITING_REASON,
  evaluateMergeBuildCondition,
  mergeCommitOf,
  mergeMergeBuildCheck,
  readMergeBuild,
  type MergeBuildTarget,
} from "../app-server/thread-dependency-merge-builds";
import { ThreadDependencyCiRunPoller } from "../app-server/thread-dependency-ci-runs";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const PR_URL = "https://github.com/example/app/pull/41";
const MERGE_SHA = "9c1e3a7f0b2d4c6e8a0b1c2d3e4f5a6b7c8d9e0f";
const MERGED_AT = 1_000_000;
const GITHUB: ForgeRepository = { provider: "github", host: "github.com", owner: "example", repo: "app" };
const TARGET: MergeBuildTarget = { repository: GITHUB, mergeCommitSha: MERGE_SHA, baseBranch: "main", mergedAt: MERGED_AT };

const condition: ThreadDependencyCondition = { backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL };

/** One check as GitHub reports it: a check run or a commit status. */
type RawCheck =
  | { kind: "run"; status: "queued" | "in_progress" | "completed"; conclusion: string }
  | { kind: "status"; state: "pending" | "success" | "failure" | "error" };

/**
 * The rule, stated independently: what a set of checks on the merge commit
 * means, `elapsed` after the merge.
 */
function oracle(checks: readonly RawCheck[], elapsed: number): "waiting" | "satisfied" | "failed" {
  if (checks.length === 0) return elapsed >= MERGE_BUILD_NO_CHECKS_MS ? "failed" : "waiting";
  const unfinished = checks.some((check) => check.kind === "run" ? check.status !== "completed" : check.state === "pending");
  if (unfinished || elapsed < MERGE_BUILD_SETTLE_MS) return "waiting";
  const failed = checks.some((check) => check.kind === "run"
    ? !["success", "neutral", "skipped", "cancelled", "stale"].includes(check.conclusion)
    : check.state !== "success");
  return failed ? "failed" : "satisfied";
}

const rawCheckArb: fc.Arbitrary<RawCheck> = fc.oneof(
  fc.record({
    kind: fc.constant("run" as const),
    status: fc.constantFrom("queued" as const, "in_progress" as const, "completed" as const, "completed" as const),
    conclusion: fc.constantFrom("success", "success", "neutral", "skipped", "cancelled", "stale", "failure", "timed_out", "action_required", "startup_failure", "mystery"),
  }),
  fc.record({ kind: fc.constant("status" as const), state: fc.constantFrom("pending" as const, "success" as const, "success" as const, "failure" as const, "error" as const) }),
);

/** A fake GitHub that serves `checks` across pages of 100. */
function githubServing(checks: readonly RawCheck[]) {
  const runs = checks.flatMap((check, index) => check.kind === "run"
    ? [{ id: index + 1, name: `job ${index}`, status: check.status, conclusion: check.status === "completed" ? check.conclusion : null,
      html_url: `https://github.com/example/app/runs/${index + 1}` }] : []);
  const statuses = checks.flatMap((check, index) => check.kind === "status"
    ? [{ context: `ci/${index}`, state: check.state, target_url: `https://ci.example.com/${index}` }] : []);
  return vi.fn(async (_repository: ForgeRepository, path: string) => {
    if (path.includes("/check-runs?")) {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
      return { total_count: runs.length, check_runs: runs.slice((page - 1) * 100, page * 100) };
    }
    if (path.includes("/status?")) return { state: "pending", statuses };
    // Nothing newer was pushed: a cancelled build has no later build to follow.
    if (path.endsWith("/branches/main")) return { commit: { sha: MERGE_SHA } };
    throw new Error(`unexpected ${path}`);
  });
}

const mergedPr: ThreadDependencyEvidence = { condition, state: "satisfied", reason: "PR merged", observedAt: 0, prUrl: PR_URL, headSha: "head" };

describe("merge build evaluation", () => {
  it("matches the oracle for every set of checks, at any time after the merge", async () => {
    await fc.assert(fc.asyncProperty(fc.array(rawCheckArb, { maxLength: 8 }), fc.nat({ max: 40 * 60_000 }), async (checks, elapsed) => {
      const seen = await readMergeBuild(githubServing(checks), TARGET, MERGED_AT + elapsed);
      const evidence = evaluateMergeBuildCondition(condition, mergedPr, seen, undefined, MERGED_AT + elapsed);
      expect(evidence.state).toBe(oracle(checks, elapsed));
      // A fired wait carries what fired it, for the wake.
      if (evidence.state !== "waiting") expect(evidence.mergeBuild).toBe(seen);
      else expect(evidence.reason).toBe(MERGE_BUILD_WAITING_REASON);
    }));
  });

  it("fires once and never changes after, whatever later checks see", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.array(rawCheckArb, { maxLength: 4 }), { minLength: 1, maxLength: 8 }), async (sequence) => {
      let previous: ThreadDependencyEvidence | undefined;
      let fired: ThreadDependencyEvidence | undefined;
      for (const [index, checks] of sequence.entries()) {
        const at = MERGED_AT + MERGE_BUILD_SETTLE_MS + index * 120_000;
        const evidence = evaluateMergeBuildCondition(condition, mergedPr, await readMergeBuild(githubServing(checks), TARGET, at), previous, at);
        if (fired) expect(evidence).toBe(fired);
        else if (evidence.state !== "waiting") fired = evidence;
        previous = evidence;
      }
    }));
  });

  it("reads exactly as a merge wait until the PR merges, and a closed PR fails it", () => {
    const open: ThreadDependencyEvidence = { condition, state: "waiting", reason: MERGE_BUILD_WAITING_FOR_MERGE_REASON, observedAt: 5, prUrl: PR_URL };
    expect(evaluateMergeBuildCondition(condition, open, undefined, undefined, 5)).toEqual(open);
    const closed: ThreadDependencyEvidence = { condition, state: "failed", reason: "PR closed without merging", observedAt: 5, prUrl: PR_URL };
    expect(evaluateMergeBuildCondition(condition, closed, undefined, undefined, 5)).toMatchObject({ state: "failed", reason: "PR closed without merging" });
  });

  it("gives every waiting check the same evidence, so checks write nothing", async () => {
    await fc.assert(fc.asyncProperty(fc.array(rawCheckArb, { maxLength: 6 }), fc.nat({ max: MERGE_BUILD_NO_CHECKS_MS - 1 }), async (checks, elapsed) => {
      const seen = await readMergeBuild(githubServing(checks), TARGET, MERGED_AT + elapsed);
      const evidence = evaluateMergeBuildCondition(condition, mergedPr, seen, undefined, 0);
      if (evidence.state !== "waiting") return;
      expect(evidence).toEqual({ condition, state: "waiting", reason: MERGE_BUILD_WAITING_REASON, observedAt: 0, prUrl: PR_URL, headSha: "head" });
    }));
  });

  it("keeps a merge it saw when a later read loses the PR", () => {
    const merged = evaluateMergeBuildCondition(condition, mergedPr, undefined, undefined, 1);
    const lost: ThreadDependencyEvidence = { condition, state: "waiting", reason: "Waiting for a primary-workspace PR", observedAt: 2 };
    expect(evaluateMergeBuildCondition(condition, lost, undefined, merged, 2)).toMatchObject({ reason: MERGE_BUILD_WAITING_REASON, prUrl: PR_URL });
  });

  it("reports a build that cannot be read three times as gone", () => {
    const failing = (errorChecks: number): ThreadDependencyMergeBuildObservation =>
      ({ status: "unknown", error: "not found", errorCode: "not_found", errorChecks, checkedAt: MERGED_AT });
    expect(evaluateMergeBuildCondition(condition, mergedPr, failing(2), undefined, 0).state).toBe("waiting");
    expect(evaluateMergeBuildCondition(condition, mergedPr, failing(3), undefined, 0).state).toBe("failed");
  });
});

describe("merge build checks", () => {
  it("never ends the wait on its first check when the forge gave no merge time", () => {
    // Without a merge time, the settle and no-checks windows run from the
    // first check: neither an empty build nor one fast finished check ends it.
    fc.assert(fc.property(
      fc.constantFrom("no_checks" as const, "completed" as const),
      fc.constantFrom("success" as const, "failure" as const, "cancelled" as const),
      fc.integer({ min: 0, max: 10 ** 12 }),
      (status, conclusion, checkedAt) => {
        const first = mergeMergeBuildCheck(undefined, {
          mergeCommitSha: MERGE_SHA, status, ...status === "completed" ? { conclusion } : {}, checkedAt,
          checks: { total: status === "completed" ? 1 : 0, passed: 0, failed: 0, cancelled: 0, running: 0, queued: 0, skipped: 0 },
        });
        expect(evaluateMergeBuildCondition(condition, mergedPr, first, undefined, checkedAt).state).toBe("waiting");
        // Later checks keep the first check's time.
        const later = mergeMergeBuildCheck(first, { status: "no_checks", checkedAt: checkedAt + MERGE_BUILD_NO_CHECKS_MS });
        expect(later.mergedAt).toBe(checkedAt);
        expect(evaluateMergeBuildCondition(condition, mergedPr, later, undefined, later.checkedAt).state).toBe("failed");
      },
    ));
  });

  it("treats a failed merge details lookup as a read to retry, not a missing commit", () => {
    expect(mergeCommitOf({ mergeCommitSha: MERGE_SHA })).toBe(MERGE_SHA);
    const thrown = (details: Parameters<typeof mergeCommitOf>[0]) => {
      try { mergeCommitOf(details); } catch (error) { return error as Error & { code?: string }; }
      throw new Error("mergeCommitOf returned");
    };
    // Rate limits and network failures leave no cached details; three of them
    // in a row must not end the wait as gone.
    expect(thrown({ detailsUnavailableReason: "The forge lookup for merge details failed: rate limited" }).code).toBeUndefined();
    expect(thrown({}).code).toBe("not_found");
    expect(thrown(undefined).code).toBe("not_found");
  });
});

describe("reading a merge build", () => {
  it("reads every page of check runs and the commit statuses, and links failed checks", async () => {
    const checks: RawCheck[] = [
      ...Array.from({ length: 150 }, () => ({ kind: "run" as const, status: "completed" as const, conclusion: "success" })),
      { kind: "run", status: "completed", conclusion: "failure" },
      { kind: "status", state: "success" },
    ];
    const get = githubServing(checks);
    const seen = await readMergeBuild(get, TARGET, MERGED_AT + 90_000);
    expect(get.mock.calls.map(([, path]) => path)).toEqual([
      `repos/example/app/commits/${MERGE_SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `repos/example/app/commits/${MERGE_SHA}/check-runs?filter=latest&per_page=100&page=2`,
      `repos/example/app/commits/${MERGE_SHA}/status?per_page=100`,
    ]);
    expect(seen).toMatchObject({
      mergeCommitSha: MERGE_SHA, baseBranch: "main", status: "completed", conclusion: "failure",
      checks: { total: 152, passed: 151, failed: 1 },
      failedChecks: [{ name: "job 150", url: "https://github.com/example/app/runs/151" }],
    });
  });

  it("treats each GitLab pipeline for the merge commit on the target branch as one check", async () => {
    const gitlab: ForgeRepository = { provider: "gitlab", host: "gitlab.com", owner: "group/sub", repo: "app" };
    const get = vi.fn(async (_repository: ForgeRepository, _path: string): Promise<unknown> => [
      { id: 7, status: "success", web_url: "https://gitlab.com/group/sub/app/-/pipelines/7" },
      { id: 8, status: "running", web_url: "https://gitlab.com/group/sub/app/-/pipelines/8" },
    ]);
    const seen = await readMergeBuild(get, { ...TARGET, repository: gitlab }, MERGED_AT);
    expect(get.mock.calls[0]![1]).toBe(`projects/${encodeURIComponent("group/sub/app")}/pipelines?sha=${MERGE_SHA}&per_page=20&ref=main`);
    expect(seen).toMatchObject({ status: "running", checks: { total: 2, passed: 1, running: 1 } });
  });

  it("refuses a response that is not a check list", async () => {
    await expect(readMergeBuild(async () => ({ check_runs: "nope" }), TARGET, 0)).rejects.toThrow(/invalid list/);
  });
});

describe("merge build poller", () => {
  it("reports a failed read through its own observation shape", async () => {
    const observe = vi.fn(async () => undefined);
    let fire: (() => void) | undefined;
    const poller = new ThreadDependencyCiRunPoller<ThreadDependencyMergeBuildObservation>({
      urls: () => [PR_URL],
      read: async () => { throw Object.assign(new Error("no merge commit"), { code: "not_found" }); },
      failed: (_url, error, code, now) => ({ status: "unknown", error, ...code ? { errorCode: code } : {}, checkedAt: now }),
      observe, now: () => 7, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => undefined,
    });
    poller.sync();
    fire!();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith(PR_URL, { status: "unknown", error: "no merge commit", errorCode: "not_found", checkedAt: 7 }));
    poller.dispose();
  });
});

describe("Continue After a merge build", () => {
  let db: StateDb;
  let store: ThreadDependencyStore;
  let tempDir: string;
  let now: number;
  let pr: PrSummary;
  const submit = vi.fn(async (_params: { input: { text: string }[] }) => ({ status: "started" as const, turnId: "continuation" }));
  const openPr = (): PrSummary => ({
    provider: "github.com", org: "example", repo: "app", number: 41, url: PR_URL, title: "feat: widgets",
    state: "passing", checkState: "passing", lifecycleState: "open", reviewState: "ready_for_review", headSha: "head",
  });
  const merge = () => { pr = { ...pr, state: "merged", lifecycleState: "merged", mergedAt: now }; };
  const build = (patch: Partial<ThreadDependencyMergeBuildObservation>): ThreadDependencyMergeBuildObservation => ({
    mergeCommitSha: MERGE_SHA, baseBranch: "main", mergedAt: pr.mergedAt, status: "running",
    checks: { total: 3, passed: 1, failed: 0, cancelled: 0, running: 2, queued: 0, skipped: 0 }, checkedAt: now, ...patch,
  });

  const coordinator = () => new ThreadDependencyCoordinator({
    store,
    readThread: async (target) => {
      if (target.threadId === "feature") return { turns: [], prs: [{ pr, fetchedAt: now }] };
      if (target.threadId === "other" || target.threadId === "review") return { turns: [], prs: [] };
      throw new Error("Thread not found");
    },
    submit, changed: async () => undefined, now: () => now,
    hasDeliveryReceipt: (item) => store.hasDeliveryReceipt(item),
  });
  // The thread waits on its own PR: no other thread is involved.
  const watch = (agent: ThreadDependencyCoordinator, extra: { wakeOn?: "failure" } = {}) => agent.manage({
    action: "create", backend: "codex", threadId: "feature", conditions: [{ backend: "codex", threadId: "feature", when: "merge_build" }],
    continuation: "Report the merge build.", ...extra,
  });

  beforeEach(() => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const temp = createTempStateDb("pwragent-merge-build-dependencies-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new ThreadDependencyStore(db.raw);
    now = 2_000_000;
    pr = openPr();
    submit.mockClear();
  });
  afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

  it("waits on its own thread's PR, checks the build only after the merge, and wakes once when it fails", async () => {
    const agent = coordinator();
    const [registered] = (await watch(agent)).dependencies;
    expect(registered).toMatchObject({ status: "waiting", evidence: [{ state: "waiting", reason: MERGE_BUILD_WAITING_FOR_MERGE_REASON }] });
    expect(agent.mergeBuildUrls()).toEqual([]);

    now += 60_000;
    merge();
    await agent.handlePrEvent(PR_URL);
    expect(store.active()[0]!.evidence[0]).toMatchObject({ state: "waiting", reason: MERGE_BUILD_WAITING_REASON, prUrl: PR_URL });
    expect(agent.mergeBuildUrls()).toEqual([PR_URL]);
    expect(agent.mergeBuildPullRequest(PR_URL)).toMatchObject({ lifecycleState: "merged" });

    now += 30_000;
    await agent.handleMergeBuildObservation(PR_URL, build({}));
    // The list shows the latest check, which is never stored. The windows'
    // active list carries it too, for PR chips and the rail.
    expect(agent.withCiRunObservations(store.active())[0]!.evidence[0]!.mergeBuild).toMatchObject({ status: "running" });
    expect(agent.active()[0]!.evidence[0]!.mergeBuild).toMatchObject({ status: "running" });
    expect(store.active()[0]!.evidence[0]!.mergeBuild).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();

    now += 120_000;
    await agent.handleMergeBuildObservation(PR_URL, build({
      status: "completed", conclusion: "failure",
      checks: { total: 3, passed: 2, failed: 1, cancelled: 0, running: 0, queued: 0, skipped: 0 },
      failedChecks: [{ name: "unit (ubuntu)", url: "https://github.com/example/app/actions/runs/5/job/9" }],
    }));
    expect(submit).toHaveBeenCalledTimes(1);
    const prompt = submit.mock.calls[0]![0].input[0]!.text;
    expect(prompt).toContain("Merge build failed on main: 1 of 3 checks failed (unit (ubuntu))");
    expect(prompt).toContain(`Merge commit ${MERGE_SHA} on main`);
    expect(prompt).toContain("Failed check: unit (ubuntu); https://github.com/example/app/actions/runs/5/job/9");
    expect(prompt).toContain("combined with others merged before it");
    expect(prompt).not.toContain("A newer push cancelled");
    expect(agent.mergeBuildUrls()).toEqual([]);
    expect(store.list("codex", "feature")[0]).toMatchObject({ status: "delivered", outcome: "failure" });
  });

  it("ends a failure-only watch quietly when the build passes", async () => {
    const agent = coordinator();
    await watch(agent, { wakeOn: "failure" });
    now += 60_000;
    merge();
    await agent.handlePrEvent(PR_URL);
    now += MERGE_BUILD_SETTLE_MS;
    await agent.handleMergeBuildObservation(PR_URL, build({
      status: "completed", conclusion: "success", checks: { total: 3, passed: 3, failed: 0, cancelled: 0, running: 0, queued: 0, skipped: 0 },
    }));
    expect(submit).not.toHaveBeenCalled();
    expect(store.list("codex", "feature")[0]).toMatchObject({ status: "delivered", outcome: "success", wakeOn: "failure" });
    expect(buildDependencyPrompt(store.list("codex", "feature")[0]!)).toContain("Merge build passed on main");
  });

  it("arms one automatic failure-only watch per merged PR, and never one the operator stopped", async () => {
    const agent = coordinator();
    merge();
    expect(await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: PR_URL, title: "feat: widgets" })).toBe("armed");
    expect(store.active()).toHaveLength(1);
    expect(store.active()[0]).toMatchObject({ automatic: true, wakeOn: "failure", conditions: [{ when: "merge_build", prUrl: PR_URL }] });
    expect(await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: PR_URL })).toBe("covered");
    await agent.manage({ action: "cancel", backend: "codex", threadId: "feature", dependencyId: store.active()[0]!.id });
    expect(await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: PR_URL })).toBe("covered");
    expect(store.active()).toHaveLength(0);
  });

  it("remembers an operator's stopped watch behind any amount of later history", async () => {
    const agent = coordinator();
    merge();
    await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: PR_URL });
    await agent.manage({ action: "cancel", backend: "codex", threadId: "feature", dependencyId: store.active()[0]!.id });
    // More ended registrations than a thread's list shows.
    for (let index = 0; index < 140; index++) {
      now += 1;
      const [created] = (await agent.manage({
        action: "create", backend: "codex", threadId: "feature",
        conditions: [{ backend: "codex", threadId: "other", when: "marked_done" }], continuation: `step ${index}`,
      })).dependencies;
      await agent.manage({ action: "cancel", backend: "codex", threadId: "feature", dependencyId: created!.id });
    }
    expect(store.list("codex", "feature").some((item) => item.conditions[0]!.when === "merge_build")).toBe(false);
    expect(await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: PR_URL })).toBe("covered");
  });

  it("lists another thread's merge build wait as a dependent and refuses a cycle through it", async () => {
    const agent = coordinator();
    // Waiting on its own merge build is no cycle.
    await watch(agent);
    expect(store.dependents("codex", "feature")).toEqual([]);
    await agent.manage({
      action: "create", backend: "codex", threadId: "review",
      conditions: [{ backend: "codex", threadId: "feature", when: "merge_build" }], continuation: "Check main.",
    });
    expect(store.dependents("codex", "feature").map((item) => item.threadId)).toEqual(["review"]);
    await expect(agent.manage({
      action: "create", backend: "codex", threadId: "feature",
      conditions: [{ backend: "codex", threadId: "review", when: "marked_done" }], continuation: "x",
    })).rejects.toThrow(/cycle/);
  });

  it("refuses a merge build that would hold its own merge", async () => {
    await expect(coordinator().manage({
      action: "create", backend: "codex", threadId: "feature", holdMerge: true,
      conditions: [{ backend: "codex", threadId: "feature", when: "merge_build" }], continuation: "x",
    })).rejects.toThrow(/cannot hold the merge/);
  });

  it("writes nothing for unchanged checks of a running build", async () => {
    const agent = coordinator();
    await watch(agent);
    merge();
    await agent.handlePrEvent(PR_URL);
    const { writes } = await measureSqliteWrites(async () => {
      for (let check = 0; check < 100; check++) {
        now += 30_000;
        await agent.handleMergeBuildObservation(PR_URL, build({
          checkedAt: now, checks: { total: 5, passed: check % 5, failed: 0, cancelled: 0, running: 5 - (check % 5), queued: 0, skipped: 0 },
        }));
        if (check % 10 === 0) await agent.handleMergeBuildObservation(PR_URL, { status: "unknown", error: "rate limited", checkedAt: now });
      }
    });
    expectSqliteWriteBudget({ scenario: "thread-dependency-merge-build-unchanged-checks", note: "100 checks of a running merge build, with changing counts and failed reads: zero commits and 0 MB/day while it waits.", writes });
  });

  it("budgets one automatic merge build watch from the merge to a quiet pass", async () => {
    const agent = coordinator();
    merge();
    const { writes } = await measureSqliteWrites(async () => {
      await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: PR_URL });
      for (let check = 0; check < 20; check++) {
        now += 30_000;
        await agent.handleMergeBuildObservation(PR_URL, build({ checkedAt: now }));
      }
      await agent.handleMergeBuildObservation(PR_URL, build({
        status: "completed", conclusion: "success", checkedAt: now, checks: { total: 3, passed: 3, failed: 0, cancelled: 0, running: 0, queued: 0, skipped: 0 },
      }));
    });
    expectSqliteWriteBudget({ scenario: "thread-dependency-merge-build-lifecycle", note: "One automatic merge build watch: registration, the merged evaluation and the quiet pass; checks in between write nothing. About 33 KB WAL per merge, so twenty merges a day is ~0.7 MB/day.", writes });
  });

  it("preserves wakeOn across federation dependency requests", () => {
    const forwarded = readFederationThreadDependenciesRequest({
      action: "create",
      backend: "codex",
      threadId: "feature",
      conditions: [{ backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL }],
      continuation: "Report the merge build result.",
      wakeOn: "failure",
    });
    expect(forwarded?.wakeOn).toBe("failure");
  });

  it("lets createMergeBuildWatch register through strict continuation validation, with or without a PR", async () => {
    const agent = coordinator();
    const sent: ManageThreadDependenciesRequest[] = [];
    const api = {
      manageThreadDependencies: async (request: ManageThreadDependenciesRequest) => {
        sent.push(request);
        if (request.action === "create") {
          validateDependencyCreate(request);
          if (typeof request.continuation !== "string" || !request.continuation.trim()) {
            throw new Error("Write what this thread should do when the prerequisites are met.");
          }
        }
        return await agent.manage({ ...request, backend: "codex", threadId: "feature" });
      },
    };
    const thread: Pick<NavigationThreadSummary, "id" | "source" | "federation" | "title"> = {
      id: "feature", source: "codex", title: "Widgets",
    };
    await createMergeBuildWatch(api, thread, undefined);
    expect(sent[0]?.continuation?.trim()).toBeTruthy();
    expect(store.active()).toHaveLength(1);
  });

  it("ignores old closed and already-merged PRs for an unnamed self merge_build wait until a new PR opens", async () => {
    const closed: PrSummary = { ...openPr(), number: 40, url: "https://github.com/example/app/pull/40", state: "closed", lifecycleState: "closed" };
    const earlierMerged: PrSummary = { ...openPr(), number: 39, url: "https://github.com/example/app/pull/39", state: "merged", lifecycleState: "merged", mergedAt: now - 300_000 };
    let prs: PrSummary[] = [earlierMerged, closed];
    const agent = new ThreadDependencyCoordinator({
      store,
      readThread: async () => ({ turns: [], prs: prs.map((item) => ({ pr: item, fetchedAt: now })) }),
      submit, changed: async () => undefined, now: () => now,
      hasDeliveryReceipt: (item) => store.hasDeliveryReceipt(item),
    });

    const [created] = (await watch(agent)).dependencies;
    expect(created).toMatchObject({ status: "waiting", evidence: [{ state: "waiting", reason: "Waiting for a primary-workspace PR" }] });
    expect(submit).not.toHaveBeenCalled();

    // Opening a new PR attaches it to the thread (`thread/pullRequests/updated`),
    // binding the unnamed wait cleanly instead of failing on "multiple PRs".
    const fresh = openPr();
    prs = [earlierMerged, closed, fresh];
    await agent.handleThreadEvent({ backend: "codex", threadId: "feature" });
    expect(store.active()[0]!.evidence[0]).toMatchObject({ state: "waiting", reason: MERGE_BUILD_WAITING_FOR_MERGE_REASON, prUrl: fresh.url });
  });

  it("keeps describeMergeBuildWatch opt-out in agreement with armMergeBuild", async () => {
    let prs: PrSummary[] = [];
    const agent = new ThreadDependencyCoordinator({
      store,
      readThread: async () => ({ turns: [], prs: prs.map((item) => ({ pr: item, fetchedAt: now })) }),
      submit, changed: async () => undefined, now: () => now,
      hasDeliveryReceipt: (item) => store.hasDeliveryReceipt(item),
    });

    // Toggle on then cancel before any PR exists: future PRs are NOT opted out.
    const [created] = (await watch(agent)).dependencies;
    await agent.manage({ action: "cancel", backend: "codex", threadId: "feature", dependencyId: created!.id });
    const nextPr: PrSummary = { ...openPr(), state: "merged", lifecycleState: "merged", mergedAt: now };
    prs = [nextPr];
    const waits = ownMergeBuildWaits(store.list("codex", "feature"), { backend: "codex", threadId: "feature" });
    expect(describeMergeBuildWatch({ waits, defaultOn: true, prUrl: nextPr.url }).detail).not.toBe("Off for this PR");
    expect(await agent.armMergeBuild({ backend: "codex", threadId: "feature" }, { url: nextPr.url })).toBe("armed");
  });

  it("holds renderer-vs-owner merge build watch invariants across random PR and click sequences", async () => {
    type Op =
      | { kind: "openPr" }
      | { kind: "mergePr"; index: number }
      | { kind: "closePr"; index: number }
      | { kind: "composerClick" }
      | { kind: "chipStop"; index: number }
      | { kind: "buildFinish"; index: number; conclusion: "success" | "failure" }
      | { kind: "toggleDefault" };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.constant({ kind: "openPr" as const }),
      fc.record({ kind: fc.constant("mergePr" as const), index: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant("closePr" as const), index: fc.integer({ min: 0, max: 2 }) }),
      fc.constant({ kind: "composerClick" as const }),
      fc.record({ kind: fc.constant("chipStop" as const), index: fc.integer({ min: 0, max: 2 }) }),
      fc.record({
        kind: fc.constant("buildFinish" as const),
        index: fc.integer({ min: 0, max: 2 }),
        conclusion: fc.constantFrom("success" as const, "failure" as const),
      }),
      fc.constant({ kind: "toggleDefault" as const }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.array(opArb, { minLength: 2, maxLength: 14 }),
        async (initialDefaultOn, remote, ops) => {
          db.raw.exec("DELETE FROM thread_dependencies; DELETE FROM thread_message_origins;");
          let clock = 2_000_000;
          let defaultOn = initialDefaultOn;
          let nextNum = 100;
          const prs: PrSummary[] = [];
          const wakes: string[] = [];
          const target = { backend: "codex" as const, threadId: "feature" };
          const thread: NavigationThreadSummary = {
            id: "feature", source: "codex", title: "Widgets", titleSource: "explicit",
            inbox: { inInbox: false }, linkedDirectories: [], primaryGitRepository: "github.com/example/app",
            ...(remote ? { federation: { ref: { target: { scope: "remote", instanceId: "peer-m5" }, threadId: "feature" } } as NavigationThreadSummary["federation"] } : {}),
          };
          const agent = new ThreadDependencyCoordinator({
            store,
            readThread: async () => ({ turns: [], prs: prs.map((item) => ({ pr: item, fetchedAt: clock })) }),
            submit: async (params) => { wakes.push(params.input[0]?.text ?? ""); return { status: "started", turnId: `t-${wakes.length}` }; },
            changed: async () => undefined,
            now: () => clock,
            hasDeliveryReceipt: (item) => store.hasDeliveryReceipt(item),
          });
          const api = {
            manageThreadDependencies: async (request: ManageThreadDependenciesRequest) => {
              const { federationTarget, ...rest } = request;
              const owned = federationTarget?.scope === "remote" ? readFederationThreadDependenciesRequest(rest) : rest;
              expect(owned).toBeDefined();
              if (owned!.action === "create") {
                validateDependencyCreate(owned!);
                expect(typeof owned!.continuation === "string" && owned!.continuation.trim().length > 0).toBe(true);
              }
              return await agent.manage({ ...owned!, backend: "codex", threadId: "feature" });
            },
          };
          const listWaits = () => ownMergeBuildWaits(agent.withCiRunObservations(store.list("codex", "feature")), target);

          for (const op of ops) {
            if (op.kind === "openPr") {
              clock += 10_000;
              const number = nextNum++;
              const item: PrSummary = {
                provider: "github.com", org: "example", repo: "app", number,
                url: `https://github.com/example/app/pull/${number}`, title: `PR #${number}`,
                state: "passing", checkState: "passing", lifecycleState: "open", createdAt: clock, headSha: `sha-${number}`,
              };
              prs.push(item);
              await agent.handleThreadEvent(target);
              await agent.handlePrEvent(item.url);
            } else if (op.kind === "closePr") {
              const open = prs.filter((item) => item.lifecycleState === "open");
              if (!open.length) continue;
              const chosen = open[op.index % open.length]!;
              clock += 10_000;
              chosen.lifecycleState = "closed";
              chosen.state = "closed";
              await agent.handlePrEvent(chosen.url);
            } else if (op.kind === "mergePr") {
              const open = prs.filter((item) => item.lifecycleState === "open");
              if (!open.length) continue;
              const chosen = open[op.index % open.length]!;
              const before = describeMergeBuildWatch({ waits: listWaits(), defaultOn, prUrl: chosen.url });
              clock += 10_000;
              chosen.lifecycleState = "merged";
              chosen.state = "merged";
              chosen.mergedAt = clock;
              await agent.handlePrEvent(chosen.url);
              if (defaultOn) {
                const armed = await agent.armMergeBuild(target, { url: chosen.url, title: chosen.title });
                if (before.detail === "Off for this PR") expect(armed).toBe("covered");
                if (!before.checked && before.detail !== "Off for this PR") expect(armed).toBe("armed");
              }
            } else if (op.kind === "composerClick") {
              const waitsBefore = listWaits();
              const prUrl = mergeBuildPullRequestUrl(prs, waitsBefore);
              const stateBefore = describeMergeBuildWatch({ waits: waitsBefore, defaultOn, prUrl });
              const wakesBefore = wakes.length;
              if (stateBefore.checked) {
                await cancelMergeBuildWatches(api, thread, waitsBefore);
                const waitsAfter = listWaits();
                expect(describeMergeBuildWatch({ waits: waitsAfter, defaultOn, prUrl: mergeBuildPullRequestUrl(prs, waitsAfter) }).checked).toBe(false);
              } else {
                await createMergeBuildWatch(api, thread, prUrl);
                expect(wakes.slice(wakesBefore).some((text) => text.includes("PR closed without merging"))).toBe(false);
                const waitsAfter = listWaits();
                expect(describeMergeBuildWatch({ waits: waitsAfter, defaultOn, prUrl: mergeBuildPullRequestUrl(prs, waitsAfter) }).checked).toBe(true);
              }
            } else if (op.kind === "chipStop") {
              const watched = prs.filter((item) => mergeBuildWaitForPr(listWaits(), item));
              if (!watched.length) continue;
              const chosen = watched[op.index % watched.length]!;
              await cancelMergeBuildWatches(api, thread, [mergeBuildWaitForPr(listWaits(), chosen)!]);
              expect(mergeBuildWaitForPr(listWaits(), chosen)).toBeUndefined();
            } else if (op.kind === "buildFinish") {
              const mergedList = prs.filter((item) => item.lifecycleState === "merged");
              if (!mergedList.length) continue;
              const chosen = mergedList[op.index % mergedList.length]!;
              clock += MERGE_BUILD_SETTLE_MS + 10_000;
              await agent.handleMergeBuildObservation(chosen.url, {
                mergeCommitSha: `merge-${chosen.number}`.padEnd(40, "0"),
                baseBranch: "main",
                mergedAt: chosen.mergedAt,
                status: "completed",
                conclusion: op.conclusion,
                checks: op.conclusion === "success"
                  ? { total: 2, passed: 2, failed: 0, cancelled: 0, running: 0, queued: 0, skipped: 0 }
                  : { total: 2, passed: 1, failed: 1, cancelled: 0, running: 0, queued: 0, skipped: 0 },
                checkedAt: clock,
              });
              agent.mergeBuildUrls();
            } else if (op.kind === "toggleDefault") {
              defaultOn = !defaultOn;
            }
          }
        },
      ),
      { numRuns: 5 },
    );
  });
});
