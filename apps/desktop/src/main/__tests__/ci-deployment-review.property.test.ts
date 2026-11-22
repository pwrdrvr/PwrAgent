import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDependencyCiRunObservation } from "@pwragent/shared/contracts/thread-dependencies";
import type {
  ReviewThreadTodoCiDeploymentRequest,
  ThreadTodoCiApproval,
} from "@pwragent/shared/contracts/thread-todos";
import { threadTodoCiDeploymentReviewRequest } from "@pwragent/shared/contracts/thread-todos";
import { ciApprovalSettled } from "../app-server/thread-dependency-ci-runs";
import {
  approveGithubCiDeployment,
  CI_DEPLOYMENT_APPROVAL_COMMENT,
  type CiDeploymentGithubRequest,
} from "../thread-todos/ci-deployment-review";
import { ThreadTodoService } from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../storage/thread-todo-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

/*
 * The rule: PwrAgent writes a deployment approval only when the reads made
 * immediately before the write still show exactly the gate the operator
 * reviewed (repository, attempt, head commit, every environment id and name)
 * and GitHub says this account may approve each one. It approves only those
 * environments. Every run, repository and environment here is invented; no
 * real release gate is read or written.
 */

const URL = "https://github.com/example/app/actions/runs/88";
const SHA = "a".repeat(40);
const ENVIRONMENTS = [
  { name: "windows-signing", id: 301 },
  { name: "apple-signing", id: 302 },
  { name: "staging", id: 303 },
];

type Env = { name: string; id: number; canApprove: boolean };
type GithubState = { fullName: string; attempt: number; headSha: string; status: string; pending: Env[] };

const reviewedArb = fc.subarray(ENVIRONMENTS, { minLength: 1 }).map((picked): ReviewThreadTodoCiDeploymentRequest => ({
  id: "card", url: URL, repository: "example/app", runId: 88, attempt: 2, headSha: SHA,
  environments: picked.map((entry) => entry.name), environmentIds: picked.map((entry) => entry.id),
}));

/** GitHub as it might be when re-read: mostly as reviewed, sometimes moved on. */
const stateArb: fc.Arbitrary<GithubState> = fc.record({
  fullName: fc.constantFrom("example/app", "Example/App", "example/fork"),
  attempt: fc.constantFrom(2, 2, 3),
  headSha: fc.constantFrom(SHA, SHA.toUpperCase(), "b".repeat(40)),
  status: fc.constantFrom("waiting", "waiting", "in_progress", "completed"),
  pending: fc.subarray(ENVIRONMENTS).chain((present) => fc.tuple(...present.map((entry) => fc.record({
    name: fc.constantFrom(entry.name, entry.name, `${entry.name}-renamed`),
    id: fc.constantFrom(entry.id, entry.id, entry.id + 1000),
    canApprove: fc.boolean(),
  })))).map((entries) => entries as Env[]),
});

/** The oracle, written from the rule rather than from the code. */
function mayApprove(reviewed: ReviewThreadTodoCiDeploymentRequest, state: GithubState): boolean {
  return state.fullName.toLowerCase() === reviewed.repository
    && state.attempt === reviewed.attempt
    && state.headSha.toLowerCase() === reviewed.headSha
    && state.status === "waiting"
    && reviewed.environments.every((name, index) => state.pending.some((entry) =>
      entry.id === reviewed.environmentIds[index] && entry.name === name && entry.canApprove));
}

function fakeGithub(read: () => GithubState, onPost?: (ids: number[]) => void): { request: CiDeploymentGithubRequest; posts: unknown[] } {
  const posts: unknown[] = [];
  const request: CiDeploymentGithubRequest = async (_repository, call) => {
    const state = read();
    if (call.method === "POST") {
      posts.push(call.body);
      onPost?.((call.body as { environment_ids: number[] }).environment_ids);
      return [];
    }
    if (call.path.endsWith("/pending_deployments")) {
      return state.pending.map((entry) => ({
        environment: { id: entry.id, name: entry.name }, current_user_can_approve: entry.canApprove,
        wait_timer: 0, reviewers: [],
      }));
    }
    return { id: 88, status: state.status, run_attempt: state.attempt, head_sha: state.headSha,
      repository: { full_name: state.fullName } };
  };
  return { request, posts };
}

describe("approving a reviewed deployment gate", () => {
  it("writes only when the fresh reads match what the operator reviewed, and approves only those environments", async () => {
    await fc.assert(fc.asyncProperty(reviewedArb, stateArb, async (reviewed, state) => {
      const github = fakeGithub(() => state);
      const outcome = await approveGithubCiDeployment({ request: github.request, reviewed, urls: {} })
        .then(() => "approved", (error: Error) => error.message);
      if (mayApprove(reviewed, state)) {
        expect(outcome).toBe("approved");
        expect(github.posts).toEqual([{ environment_ids: reviewed.environmentIds, state: "approved",
          comment: CI_DEPLOYMENT_APPROVAL_COMMENT }]);
      } else {
        expect(outcome).not.toBe("approved");
        expect(github.posts).toEqual([]);
      }
    }), { numRuns: 400 });
  });

  it("judges the reads made just before the write, whatever changed between the operator's view and the click", async () => {
    // Each GitHub call may first apply a change someone else made: another
    // reviewer approves, the run is rerun, or a push replaces the commit.
    const eventArb = fc.constantFrom("none", "none", "approved_elsewhere", "rerun", "pushed");
    await fc.assert(fc.asyncProperty(reviewedArb, fc.array(eventArb, { minLength: 3, maxLength: 3 }), async (reviewed, events) => {
      let state: GithubState = {
        fullName: "example/app", attempt: 2, headSha: SHA, status: "waiting",
        pending: ENVIRONMENTS.map((entry) => ({ ...entry, canApprove: true })),
      };
      const seen: GithubState[] = [];
      let call = 0;
      const github = fakeGithub(() => {
        const event = events[call++] ?? "none";
        if (event === "approved_elsewhere") state = { ...state, pending: [], status: "in_progress" };
        if (event === "rerun") state = { ...state, attempt: state.attempt + 1 };
        if (event === "pushed") state = { ...state, headSha: "c".repeat(40) };
        seen.push(state);
        return state;
      });
      const approved = await approveGithubCiDeployment({ request: github.request, reviewed, urls: {} })
        .then(() => true, () => false);
      // The run and its gates were read in calls 1 and 2; both must have matched.
      const readsMatched = seen.length >= 2 && mayApprove(reviewed, seen[0]!) && mayApprove(reviewed, seen[1]!);
      expect(approved).toBe(readsMatched);
      expect(github.posts.length).toBe(readsMatched ? 1 : 0);
    }), { numRuns: 300 });
  });

  it("refuses a URL the owner may not write to before any request", async () => {
    const github = fakeGithub(() => { throw new Error("must not read"); });
    for (const url of ["https://github.example.com/example/app/actions/runs/88", "https://github.com/example/other/actions/runs/88",
      "https://github.com/example/app/actions/runs/89", "http://github.com/example/app/actions/runs/88"]) {
      await expect(approveGithubCiDeployment({ request: github.request, urls: {},
        reviewed: { id: "card", url, repository: "example/app", runId: 88, attempt: 2, headSha: SHA,
          environments: ["staging"], environmentIds: [303] } })).rejects.toThrow("may review");
    }
    expect(github.posts).toEqual([]);
  });
});

describe("settling an approval card from what the owner observes", () => {
  const observationArb = fc.record({
    status: fc.constantFrom("waiting", "in_progress", "queued", "completed"),
    conclusion: fc.constantFrom(undefined, "success", "failure"),
    attempt: fc.constantFrom(2, 3),
    pending: fc.subarray(ENVIRONMENTS.map((entry) => entry.name)),
    error: fc.constantFrom(undefined, undefined, "GitHub returned HTTP 502."),
  });

  it("settles exactly when GitHub no longer holds any of the card's gates on the reviewed attempt", () => {
    fc.assert(fc.property(fc.subarray(ENVIRONMENTS.map((entry) => entry.name), { minLength: 1 }), observationArb, (environments, seen) => {
      const observation: ThreadDependencyCiRunObservation = {
        runId: 88, status: seen.status, attempt: seen.attempt, checkedAt: 1,
        ...(seen.conclusion ? { conclusion: seen.conclusion } : {}),
        ...(seen.error ? { error: seen.error } : {}),
        gates: seen.pending.map((environment) => ({ environment, reviewers: ["release-team"] })),
      };
      const stillHeld = seen.status === "waiting" && environments.some((name) => seen.pending.includes(name));
      const expected = !seen.error && (seen.status === "completed" || seen.attempt !== 2 || !stillHeld);
      expect(ciApprovalSettled({ environments, attempt: 2 }, observation) !== undefined).toBe(expected);
    }));
  });
});

describe("the approval card on its owner", () => {
  let db: StateDb;
  let tempDir: string;
  let previousMetrics: string | undefined;
  let approvals: ThreadTodoCiApproval[];

  const approval = (overrides: Partial<ThreadTodoCiApproval> = {}): ThreadTodoCiApproval => ({
    url: URL, repository: "example/app", runId: 88, environments: ["windows-signing"], environmentIds: [301],
    attempt: 2, headSha: SHA, ref: "v2.4.1", ...overrides,
  });

  const createService = () => {
    let ids = 0;
    const service = new ThreadTodoService({
      store: new ThreadTodoStore(db),
      readCiApprovals: () => approvals,
      now: () => 1_000,
      newId: () => `todo-${++ids}`,
    });
    const { todo } = service.raiseForDependency({ backend: "codex", threadId: "release-thread", dependencyId: "watch",
      key: "dependency:watch", title: "Review signing" });
    return { service, todo };
  };

  beforeEach(() => {
    previousMetrics = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const temp = createTempStateDb("pwragent-ci-deployment-review-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    approvals = [approval()];
  });

  afterEach(() => {
    db.close();
    if (previousMetrics === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
    else process.env[SQLITE_WRITE_METRICS_ENV] = previousMetrics;
    removeTempStateDbDir(tempDir);
  });

  it("approves the owner's stored gate and completes the card in one commit", async () => {
    const { service, todo } = createService();
    const reviewer = vi.fn(async (reviewed: ReviewThreadTodoCiDeploymentRequest) => ({ environments: reviewed.environments }));
    service.setCiDeploymentReviewer(reviewer);
    const request = threadTodoCiDeploymentReviewRequest(todo, approval())!;
    const { writes, result } = await measureSqliteWrites(() => service.reviewCiDeployment(request));
    expect(result).toMatchObject({ status: "done", result: "Approved windows-signing on GitHub" });
    expect(reviewer).toHaveBeenCalledExactlyOnceWith(request);
    expectSqliteWriteBudget({ scenario: "thread-todo-ci-deployment-approved", writes,
      note: "One operator Approve that GitHub accepted: the card is marked done." });
  });

  it("keeps GitHub's refusal on the card, in one commit, and leaves it open", async () => {
    const { service, todo } = createService();
    service.setCiDeploymentReviewer(async () => {
      throw new Error("GitHub returned HTTP 422: Deployment protection rule not satisfied");
    });
    const { writes, result } = await measureSqliteWrites(() =>
      service.reviewCiDeployment(threadTodoCiDeploymentReviewRequest(todo, approval())!));
    expect(result).toMatchObject({ status: "open", error: "GitHub returned HTTP 422: Deployment protection rule not satisfied" });
    expectSqliteWriteBudget({ scenario: "thread-todo-ci-deployment-refused", writes,
      note: "One operator Approve that was refused: the refusal is saved on the open card." });
  });

  it("refuses a request that differs from the stored card in any reviewed field, without asking GitHub", async () => {
    const { service, todo } = createService();
    const reviewer = vi.fn(async () => ({ environments: [] }));
    service.setCiDeploymentReviewer(reviewer);
    const seen = threadTodoCiDeploymentReviewRequest(todo, approval())!;
    for (const changed of [
      { attempt: 3 }, { headSha: "b".repeat(40) }, { environmentIds: [302] }, { environments: ["apple-signing"] },
      { repository: "example/fork" }, { runId: 89 },
    ]) {
      await expect(service.reviewCiDeployment({ ...seen, ...changed })).rejects.toThrow("changed after you saw it");
    }
    // A milestone without ids, from an owner that predates in-app review, offers GitHub alone.
    approvals = [approval({ environmentIds: undefined })];
    await expect(service.reviewCiDeployment(seen)).rejects.toThrow("Review it on GitHub");
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("runs one review at a time and lets no reconciliation or resolve overwrite it", async () => {
    const { service, todo } = createService();
    let release!: () => void;
    service.setCiDeploymentReviewer(() => new Promise((resolve) => { release = () => resolve({ environments: ["windows-signing"] }); }));
    const request = threadTodoCiDeploymentReviewRequest(todo, approval())!;
    const first = service.reviewCiDeployment(request);
    await expect(service.reviewCiDeployment(request)).rejects.toThrow("already running");
    expect(() => service.resolve({ id: todo.id, status: "dismissed" })).toThrow("running now");
    expect(service.settleCiApprovals(() => "Deployment review finished on GitHub")).toEqual([]);
    release();
    expect(await first).toMatchObject({ status: "done", result: "Approved windows-signing on GitHub" });
    await expect(service.reviewCiDeployment(request)).rejects.toThrow("already resolved");
  });

  it("writes nothing while GitHub still holds the gate, and closes the card once it does not", async () => {
    const { service, todo } = createService();
    expect(service.ciApprovalUrls()).toEqual([URL]);
    const waiting = await measureSqliteWrites(() => service.settleCiApprovals(() => undefined));
    expect(waiting.result).toEqual([]);
    expectSqliteWriteBudget({ scenario: "thread-todo-ci-approval-still-waiting", writes: waiting.writes,
      note: "One reconciler check of an approval card's run that is still held at its gate." });
    const settled = await measureSqliteWrites(() => service.settleCiApprovals(() => "Deployment review finished on GitHub: windows-signing"));
    expect(settled.result).toMatchObject([{ id: todo.id, status: "done", result: "Deployment review finished on GitHub: windows-signing" }]);
    expectSqliteWriteBudget({ scenario: "thread-todo-ci-approval-settled", writes: settled.writes,
      note: "The owner saw an approval card's gate cleared (approved anywhere) or its run end: the card is marked done." });
    expect(service.ciApprovalUrls()).toEqual([]);
  });

  it("closes a card that waits on two runs only when both have settled", () => {
    const other = "https://github.com/example/app/actions/runs/99";
    approvals = [approval(), approval({ url: other, runId: 99 })];
    const { service } = createService();
    expect(service.settleCiApprovals((entry) => entry.url === URL ? "Run finished: success" : undefined)).toEqual([]);
    expect(service.settleCiApprovals(() => "Run finished: success")).toHaveLength(1);
  });
});
