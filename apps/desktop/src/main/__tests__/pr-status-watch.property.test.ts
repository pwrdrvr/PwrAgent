import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrStatusWatchStorage } from "@pwragent/owner-core/pr-status-storage";
import {
  buildPullRequestStatusKey,
  type AppServerTurnInputItem,
  type ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { mapGraphqlPrNode, type GraphqlPrNode } from "../pr-status/github-graphql-client";
import { parseGitLabMr } from "../pr-status/gitlab-pr-fetcher";
import type { GhCheckRunPayload } from "../pr-status/pr-derivations";
import {
  getPrStatusWatchOutcome,
  PrStatusWatchCoordinator,
  type PrStatusWatchOutcome,
} from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/*
 * The rule a PR watch promises (pwrdrvr/PwrAgent#3346):
 *
 *   A head resolves only once every check and every GitHub Actions workflow
 *   run on it has finished. It fails if any check failed. It succeeds if a
 *   check reported a result. If every check was skipped or neutral, it waits
 *   SETTLE_MS after the last one, in case the workflow that tests has not
 *   registered, then succeeds and says nothing was tested.
 *
 * The oracle below is that rule, written against the GitHub state the
 * generators build, not against PwrAgent's mapping. SETTLE_MS is the window
 * the PR promised; it is deliberately not imported.
 */
const SETTLE_MS = 2 * 60_000;
const BASE_TIME = Date.parse("2026-11-04T12:44:00Z");
const HEAD_SHA = "a".repeat(40);

const FAILING_CONCLUSIONS = ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"] as const;
const RESULT_CONCLUSIONS = ["SUCCESS", ...FAILING_CONCLUSIONS] as const;
const NO_RESULT_CONCLUSIONS = ["SKIPPED", "NEUTRAL"] as const;
const PENDING_STATUSES = ["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"] as const;
const COMMIT_STATUS_STATES = ["SUCCESS", "FAILURE", "ERROR", "PENDING"] as const;

type Job =
  | { done: false; status: (typeof PENDING_STATUSES)[number] }
  | { done: true; conclusion: string; completedAt: number };
type WorkflowRun = { done: boolean; status: string; jobs: Job[] };
/** One head commit as GitHub reports it. */
type HeadState = {
  runs: WorkflowRun[];
  /** Installed apps that never report leave a QUEUED suite on every push. */
  phantomAppSuites: number;
  commitStatuses: (typeof COMMIT_STATUS_STATES)[number][];
};

// ---------------------------------------------------------------------------
// The oracle: the promised rule, read straight off GitHub's state.
// ---------------------------------------------------------------------------

function expectedOutcome(
  head: HeadState,
  now: number,
): { outcome?: PrStatusWatchOutcome; allSkipped?: true } {
  const jobs = head.runs.flatMap((run) => run.jobs);
  const runPending = head.runs.some((run) => !run.done);
  const jobPending = jobs.some((job) => !job.done);
  const statusPending = head.commitStatuses.includes("PENDING");
  if (runPending || jobPending || statusPending) return {};
  const finished = jobs.filter((job): job is Extract<Job, { done: true }> => job.done);
  if (finished.length === 0 && head.commitStatuses.length === 0) return {};
  const failed = finished.some((job) =>
    (FAILING_CONCLUSIONS as readonly string[]).includes(job.conclusion)
  ) || head.commitStatuses.some((state) => state === "FAILURE" || state === "ERROR");
  if (failed) return { outcome: "failure" };
  const tested = head.commitStatuses.length > 0
    || finished.some((job) =>
      !(NO_RESULT_CONCLUSIONS as readonly string[]).includes(job.conclusion)
    );
  if (tested) return { outcome: "success" };
  const lastSkip = Math.max(...finished.map((job) => job.completedAt));
  return now - lastSkip >= SETTLE_MS ? { outcome: "success", allSkipped: true } : {};
}

// ---------------------------------------------------------------------------
// GitHub's side: the GraphQL node, with the rollup GitHub itself computes.
// ---------------------------------------------------------------------------

function toGraphqlNode(head: HeadState): GraphqlPrNode {
  const contexts: GhCheckRunPayload[] = [
    ...head.runs.flatMap((run) => run.jobs.map((job) => job.done
      ? {
          __typename: "CheckRun",
          conclusion: job.conclusion,
          status: "COMPLETED",
          completedAt: new Date(job.completedAt).toISOString(),
        }
      : { __typename: "CheckRun", conclusion: null, status: job.status })),
    ...head.commitStatuses.map((state) => ({ __typename: "StatusContext", state })),
  ];
  // GitHub's rollup counts only contexts that exist: any failure wins, then
  // anything unfinished, else SUCCESS. No contexts at all is no rollup.
  const rollup = contexts.length === 0 ? null : {
    state: contexts.some((context) =>
      (FAILING_CONCLUSIONS as readonly string[]).includes(context.conclusion ?? "")
      || context.state === "FAILURE"
      || context.state === "ERROR"
    ) ? "FAILURE"
      : contexts.some((context) =>
        context.state === "PENDING"
        || (context.__typename === "CheckRun" && context.status !== "COMPLETED")
      ) ? "PENDING"
        : "SUCCESS",
    contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: contexts },
  };
  return {
    number: 3346,
    title: "Resolve the to-do thread's target instance",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/3346",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: HEAD_SHA,
    headRepository: { name: "PwrAgent" },
    headRepositoryOwner: { login: "pwrdrvr" },
    commits: {
      nodes: [{
        commit: {
          id: "commit-head",
          oid: HEAD_SHA,
          statusCheckRollup: rollup,
          checkSuites: {
            nodes: [
              ...Array.from({ length: head.phantomAppSuites }, () => ({
                status: "QUEUED",
                workflowRun: null,
              })),
              ...head.runs.map((run, index) => ({
                status: run.status,
                workflowRun: { id: `run-${index}` },
              })),
            ],
          },
        },
      }],
    },
  };
}

// ---------------------------------------------------------------------------
// Generators: heads GitHub can produce.
// ---------------------------------------------------------------------------

const finishedJob = fc.record({
  done: fc.constant(true as const),
  conclusion: fc.constantFrom(...RESULT_CONCLUSIONS, ...NO_RESULT_CONCLUSIONS, ...NO_RESULT_CONCLUSIONS),
  completedAt: fc.integer({ min: 0, max: 10 * 60_000 }).map((offset) => BASE_TIME + offset),
});
const unfinishedJob = fc.record({
  done: fc.constant(false as const),
  status: fc.constantFrom(...PENDING_STATUSES),
});

/** A finished run's jobs all finished. An unfinished run may have no jobs yet. */
const workflowRun: fc.Arbitrary<WorkflowRun> = fc.oneof(
  fc.array(finishedJob, { minLength: 1, maxLength: 3 })
    .map((jobs) => ({ done: true, status: "COMPLETED", jobs })),
  fc.record({
    status: fc.constantFrom(...PENDING_STATUSES),
    jobs: fc.array(fc.oneof(finishedJob, unfinishedJob), { maxLength: 3 }),
  }).map(({ status, jobs }) => ({ done: false, status, jobs })),
);

const headState: fc.Arbitrary<HeadState> = fc.record({
  runs: fc.array(workflowRun, { maxLength: 4 }),
  phantomAppSuites: fc.integer({ min: 0, max: 2 }),
  commitStatuses: fc.array(fc.constantFrom(...COMMIT_STATUS_STATES), { maxLength: 2 }),
});

describe("PR watch outcome (property, oracle: the promised rule)", () => {
  it("resolves a GitHub head only as the rule allows", () => {
    fc.assert(fc.property(
      headState,
      fc.integer({ min: 0, max: 15 * 60_000 }),
      (head, elapsed) => {
        const now = BASE_TIME + elapsed;
        const summary = mapGraphqlPrNode(toGraphqlNode(head), undefined, now);
        const expected = expectedOutcome(head, now);
        expect(getPrStatusWatchOutcome(summary)).toBe(expected.outcome);
        expect(summary.checksAllSkipped).toBe(expected.allSkipped);
      },
    ));
  });

  it("never reports success while a workflow run on the head is unfinished", () => {
    // The #3346 shape: a run queued behind its concurrency group has no jobs,
    // so GitHub's rollup cannot see it.
    fc.assert(fc.property(
      headState.filter((head) => head.runs.some((run) => !run.done)),
      fc.integer({ min: 0, max: 15 * 60_000 }),
      (head, elapsed) => {
        const summary = mapGraphqlPrNode(toGraphqlNode(head), undefined, BASE_TIME + elapsed);
        expect(getPrStatusWatchOutcome(summary)).not.toBe("success");
      },
    ));
  });
});

// ---------------------------------------------------------------------------
// Model: a head evolving the way GitHub runs it, polled by the real
// coordinator over a real SQLite store after every step. Model state is the
// HeadState plus the clock; the real system is the watch.
// ---------------------------------------------------------------------------

type ModelState = { head: HeadState; now: number; delivered?: PrStatusWatchOutcome };
type RealSystem = {
  coordinator: PrStatusWatchCoordinator;
  wakes: string[];
};
type HeadCommand = fc.AsyncCommand<ModelState, RealSystem>;

/** Deliver this head to the real watch, and check it against the rule. */
async function poll(model: ModelState, real: RealSystem): Promise<void> {
  const summary = mapGraphqlPrNode(toGraphqlNode(model.head), undefined, model.now);
  const dispatched = await real.coordinator.handleStatusSnapshot(summary, model.now);
  const expected = model.delivered ? undefined : expectedOutcome(model.head, model.now).outcome;
  // A one-shot watch wakes exactly once, on the first poll the rule allows.
  expect(dispatched).toBe(expected ? 1 : 0);
  if (expected) {
    expect(real.wakes.at(-1)).toContain(`- Outcome: ${expected}`);
    model.delivered = expected;
  }
}

function openRuns(model: Readonly<ModelState>): WorkflowRun[] {
  return model.head.runs.filter((run) => !run.done);
}

function unfinishedJobs(model: Readonly<ModelState>): { run: WorkflowRun; index: number }[] {
  return model.head.runs.flatMap((run) =>
    run.jobs.flatMap((job, index) => job.done ? [] : [{ run, index }])
  );
}

function finishableRuns(model: Readonly<ModelState>): WorkflowRun[] {
  // A run finishes once it has jobs and every one of them finished.
  return openRuns(model).filter((run) => run.jobs.length > 0 && run.jobs.every((job) => job.done));
}

class StartRun implements HeadCommand {
  check(): boolean {
    return true;
  }
  async run(model: ModelState, real: RealSystem): Promise<void> {
    // Created queued, with no jobs: what a run waiting on concurrency looks like.
    model.head.runs.push({ done: false, status: "QUEUED", jobs: [] });
    await poll(model, real);
  }
  toString(): string {
    return "startRun";
  }
}

class AddJob implements HeadCommand {
  constructor(private readonly runIndex: number) {}
  check(model: Readonly<ModelState>): boolean {
    return openRuns(model).length > 0;
  }
  async run(model: ModelState, real: RealSystem): Promise<void> {
    const open = openRuns(model);
    const run = open[this.runIndex % open.length]!;
    run.status = "IN_PROGRESS";
    run.jobs.push({ done: false, status: "QUEUED" });
    await poll(model, real);
  }
  toString(): string {
    return `addJob(${this.runIndex})`;
  }
}

class FinishJob implements HeadCommand {
  constructor(private readonly jobIndex: number, private readonly conclusion: string) {}
  check(model: Readonly<ModelState>): boolean {
    return unfinishedJobs(model).length > 0;
  }
  async run(model: ModelState, real: RealSystem): Promise<void> {
    const open = unfinishedJobs(model);
    const { run, index } = open[this.jobIndex % open.length]!;
    run.jobs[index] = { done: true, conclusion: this.conclusion, completedAt: model.now };
    await poll(model, real);
  }
  toString(): string {
    return `finishJob(${this.jobIndex}, ${this.conclusion})`;
  }
}

class FinishRun implements HeadCommand {
  constructor(private readonly runIndex: number) {}
  check(model: Readonly<ModelState>): boolean {
    return finishableRuns(model).length > 0;
  }
  async run(model: ModelState, real: RealSystem): Promise<void> {
    const ready = finishableRuns(model);
    const run = ready[this.runIndex % ready.length]!;
    run.done = true;
    run.status = "COMPLETED";
    await poll(model, real);
  }
  toString(): string {
    return `finishRun(${this.runIndex})`;
  }
}

class PassTime implements HeadCommand {
  constructor(private readonly ms: number) {}
  check(): boolean {
    return true;
  }
  async run(model: ModelState, real: RealSystem): Promise<void> {
    model.now += this.ms;
    await poll(model, real);
  }
  toString(): string {
    return `passTime(${this.ms})`;
  }
}

const jobConclusion = fc.constantFrom(
  ...RESULT_CONCLUSIONS,
  ...NO_RESULT_CONCLUSIONS,
  ...NO_RESULT_CONCLUSIONS,
);

const headCommands = [
  fc.constant(new StartRun()),
  fc.nat(3).map((index) => new AddJob(index)),
  fc.tuple(fc.nat(5), jobConclusion).map(([index, conclusion]) => new FinishJob(index, conclusion)),
  fc.nat(3).map((index) => new FinishRun(index)),
  fc.integer({ min: 1_000, max: 3 * 60_000 }).map((ms) => new PassTime(ms)),
];

/**
 * GitHub eventually finishes every run: give a jobless run its job, finish
 * every job and run, then wait out the settle window, polling after each step.
 */
async function finishHead(
  model: ModelState,
  real: RealSystem,
  conclusions: readonly string[],
): Promise<void> {
  let next = 0;
  for (const run of openRuns(model)) {
    if (run.jobs.length === 0) run.jobs.push({ done: false, status: "QUEUED" });
  }
  for (const { run, index } of unfinishedJobs(model)) {
    const conclusion = conclusions[next++ % conclusions.length]!;
    run.jobs[index] = { done: true, conclusion, completedAt: model.now };
    await poll(model, real);
  }
  for (const run of openRuns(model)) {
    run.done = true;
    run.status = "COMPLETED";
    await poll(model, real);
  }
  model.now += SETTLE_MS;
  await poll(model, real);
}

describe("PR watch over a head as GitHub runs it (model)", () => {
  it("wakes exactly once, on the first poll the rule allows", async () => {
    await fc.assert(fc.asyncProperty(
      // A push: 1-3 workflow runs queued with no jobs, as #3346 saw it.
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 0, max: 2 }),
      fc.commands(headCommands, { maxCommands: 25 }),
      fc.array(jobConclusion, { minLength: 1, maxLength: 4 }),
      async (queuedRuns, phantomAppSuites, commands, finalConclusions) => {
        const stateDb = openInMemoryStateDb();
        try {
          const store = new SqliteOverlayStore(stateDb);
          const storage: PrStatusWatchStorage = store;
          const wakes: string[] = [];
          const model: ModelState = {
            head: {
              runs: Array.from({ length: queuedRuns }, () => ({
                done: false,
                status: "QUEUED",
                jobs: [],
              })),
              phantomAppSuites,
              commitStatuses: [],
            },
            now: BASE_TIME,
          };
          const real: RealSystem = {
            wakes,
            coordinator: new PrStatusWatchCoordinator({
              store: storage,
              registry: {
                submitTurnIfIdle: async (request: { input: AppServerTurnInputItem[] }) => {
                  const input = request.input[0];
                  wakes.push(input?.type === "text" ? input.text : "");
                  return { status: "started" as const, turnId: `turn-${wakes.length}` };
                },
              },
              now: () => model.now,
            }),
          };
          const pr = mapGraphqlPrNode(toGraphqlNode(model.head), undefined, model.now);
          const watch: ThreadPullRequestWatchSummary = {
            watchId: "watch-model",
            backend: "codex",
            threadId: "thread-model",
            prKey: buildPullRequestStatusKey(pr),
            prUrl: pr.url,
            prNumber: pr.number,
            headSha: HEAD_SHA,
            notifyOn: ["success", "failure"],
            createdAt: model.now,
            failureHandledByAutoFix: false,
          };
          await store.registerThreadPrStatusWatch({ watch, now: model.now });
          await poll(model, real);
          await fc.asyncModelRun(() => ({ model, real }), commands);
          await finishHead(model, real, finalConclusions);
          // A finished, settled head always resolves, and wakes the thread once.
          expect(model.delivered).toBeDefined();
          expect(wakes).toHaveLength(1);
        } finally {
          stateDb.close();
        }
      },
    ), { numRuns: 40 });
  });
});

// ---------------------------------------------------------------------------
// GitLab: the head pipeline's own status is the oracle.
// ---------------------------------------------------------------------------

/** GitLab's pipeline statuses, split by whether the pipeline can still change. */
const GITLAB_FINAL = { success: "success", failed: "failure", canceled: "failure", skipped: "success" } as const;
const GITLAB_NOT_FINAL = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "manual",
  "scheduled",
] as const;

describe("GitLab MR watch outcome (property, oracle: GitLab's pipeline status)", () => {
  it("ends a watch on every final pipeline and on no other", () => {
    fc.assert(fc.property(
      fc.constantFrom(...Object.keys(GITLAB_FINAL), ...GITLAB_NOT_FINAL),
      (status) => {
        const summary = parseGitLabMr({
          iid: 17,
          web_url: "https://gitlab.com/team/project/-/merge_requests/17",
          state: "opened",
          source_branch: "feature",
          target_branch: "main",
          sha: HEAD_SHA,
          detailed_merge_status: "mergeable",
          head_pipeline: { status, sha: HEAD_SHA },
        });
        const final = GITLAB_FINAL[status as keyof typeof GITLAB_FINAL];
        expect(getPrStatusWatchOutcome(summary)).toBe(final);
        // `[skip ci]` is final but ran nothing; the wake must say so.
        expect(summary.checksAllSkipped).toBe(status === "skipped" ? true : undefined);
      },
    ));
  });
});
