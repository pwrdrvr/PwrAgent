import os from "node:os";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  buildPullRequestStatusKey,
  type AppServerTurnInputItem,
  type PrMergeQueueRemovalReason,
  type PrMergeQueueState,
  type PrMergeQueueStatus,
  type PrSummary,
} from "@pwragent/shared";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import type { ForgePrToolContext } from "../pr-status/forge-pr-tool-shared";
import { GithubPrToolClient } from "../pr-status/github-pr-tool-client";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { mapGraphqlPrNode, type GraphqlPrNode } from "../pr-status/github-graphql-client";
import { githubMergeQueueStatus, gitlabMergeTrainStatus, type GithubMergeQueueObservation } from "../pr-status/pr-merge-queue";
import { PrStatusWatchCoordinator, terminalWakeOutcomeOf } from "../pr-status/pr-status-watch";
import { computePrStatusTransition } from "../pr-status/pr-transitions";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

/*
 * The merge queue rules, stated as a model and as properties:
 *
 * 1. A PR's queue reading follows what the queue did to it, from one forge
 *    observation, through any sequence of enqueue, merge group checks,
 *    removal for any reason, landing, bypass merge, close and reopen.
 * 2. A merge on a branch that requires the queue never merges directly. It
 *    leaves a queued PR alone, turns on auto-merge while checks run, and
 *    otherwise enqueues. A branch with no queue merges directly as before.
 * 3. A removal from the queue wakes each merge watch armed before it,
 *    exactly once, and no watch armed after it, and leaves CI watches be.
 */

// ---------------------------------------------------------------------------
// 1. The queue reading, against a model of the queue's lifecycle
// ---------------------------------------------------------------------------

type EntryState = "QUEUED" | "AWAITING_CHECKS" | "MERGEABLE" | "LOCKED" | "UNMERGEABLE";
type RemovalCause = "failed_checks" | "checks_timed_out" | "merge_conflict" | "dequeued_by_operator";

type Action =
  | { type: "enqueue"; position: number }
  | { type: "checks" }
  | { type: "group_passes" }
  | { type: "lock" }
  | { type: "group_fails" }
  | { type: "removed"; cause: RemovalCause }
  | { type: "land" }
  | { type: "merge_directly" }
  | { type: "close" }
  | { type: "reopen" };

/** The truth the forge holds: what happened, not how GitHub reports it. */
type Model = {
  enabled: boolean;
  lifecycle: "open" | "merged" | "closed";
  entry?: { state: EntryState; position: number; enqueuedAt: number };
  lastRemoval?: { cause: RemovalCause; at: number };
  landedByQueue: boolean;
  /** GitHub's timeline, as the poll reads it: newest queue event last. */
  events: Array<{ type: "added" | "removed"; at: number; reason?: string }>;
  clock: number;
};

function step(model: Model, action: Action): Model {
  const next: Model = { ...model, events: [...model.events], clock: model.clock + 60_000 };
  const at = next.clock;
  const leave = (reason: string) => {
    next.entry = undefined;
    next.events.push({ type: "removed", at, reason });
  };
  switch (action.type) {
    case "enqueue":
      if (model.lifecycle !== "open" || !model.enabled || model.entry) return model;
      next.entry = { state: "QUEUED", position: action.position, enqueuedAt: at };
      next.lastRemoval = undefined;
      next.events.push({ type: "added", at });
      return next;
    case "checks":
      if (!model.entry) return model;
      next.entry = { ...model.entry, state: "AWAITING_CHECKS", position: 1 };
      return next;
    case "group_passes":
      if (model.entry?.state !== "AWAITING_CHECKS") return model;
      next.entry = { ...model.entry, state: "MERGEABLE" };
      return next;
    case "lock":
      if (model.entry?.state !== "MERGEABLE") return model;
      next.entry = { ...model.entry, state: "LOCKED" };
      return next;
    case "group_fails":
      if (model.entry?.state !== "AWAITING_CHECKS") return model;
      next.entry = { ...model.entry, state: "UNMERGEABLE" };
      return next;
    case "removed":
      if (!model.entry) return model;
      next.lastRemoval = { cause: action.cause, at };
      leave(action.cause);
      return next;
    case "land":
      if (model.entry?.state !== "MERGEABLE" && model.entry?.state !== "LOCKED") return model;
      next.lifecycle = "merged";
      next.landedByQueue = true;
      leave("merged");
      return next;
    case "merge_directly":
      if (model.lifecycle !== "open" || model.entry) return model;
      next.lifecycle = "merged";
      return next;
    case "close":
      if (model.lifecycle !== "open") return model;
      next.lifecycle = "closed";
      next.entry = undefined;
      return next;
    case "reopen":
      if (model.lifecycle !== "closed") return model;
      next.lifecycle = "open";
      return next;
  }
}

const REMOVAL_REASONS: Record<RemovalCause, PrMergeQueueRemovalReason> = {
  failed_checks: "checks_failed",
  checks_timed_out: "checks_timed_out",
  merge_conflict: "merge_conflict",
  dequeued_by_operator: "other",
};

const ENTRY_STATES: Record<EntryState, PrMergeQueueState> = {
  QUEUED: "queued",
  AWAITING_CHECKS: "group_checks_running",
  MERGEABLE: "merging",
  LOCKED: "merging",
  UNMERGEABLE: "unmergeable",
};

/** What the reading must say, from the model's own facts. */
function expected(model: Model): PrMergeQueueStatus | undefined {
  if (model.lifecycle === "open" && model.entry) {
    return {
      kind: "merge_queue",
      state: ENTRY_STATES[model.entry.state],
      position: model.entry.position,
      enqueuedAt: model.entry.enqueuedAt,
    };
  }
  if (!model.enabled) return undefined;
  if (model.lifecycle === "merged") return { kind: "merge_queue", state: model.landedByQueue ? "merged_by_queue" : "not_queued" };
  if (model.lifecycle === "closed") return { kind: "merge_queue", state: "not_queued" };
  if (model.lastRemoval) {
    return {
      kind: "merge_queue",
      state: "removed",
      removedAt: model.lastRemoval.at,
      removedReason: REMOVAL_REASONS[model.lastRemoval.cause],
      ...(model.lastRemoval.cause === "dequeued_by_operator" ? { removedReasonText: "dequeued_by_operator" } : {}),
    };
  }
  return { kind: "merge_queue", state: "not_queued" };
}

/** What a poll reads from GitHub for the model's PR. */
function observe(model: Model): GithubMergeQueueObservation {
  const last = model.events.at(-1);
  return {
    lifecycle: model.lifecycle,
    enabled: model.enabled,
    entry: model.entry
      ? { state: model.entry.state, position: model.entry.position, enqueuedAt: new Date(model.entry.enqueuedAt).toISOString() }
      : null,
    lastEvent: last ? { type: last.type, createdAt: new Date(last.at).toISOString(), reason: last.reason ?? null } : null,
  };
}

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.integer({ min: 1, max: 9 }).map((position) => ({ type: "enqueue" as const, position })),
  fc.constant({ type: "checks" as const }),
  fc.constant({ type: "group_passes" as const }),
  fc.constant({ type: "lock" as const }),
  fc.constant({ type: "group_fails" as const }),
  fc.constantFrom<RemovalCause>("failed_checks", "checks_timed_out", "merge_conflict", "dequeued_by_operator")
    .map((cause) => ({ type: "removed" as const, cause })),
  fc.constant({ type: "land" as const }),
  fc.constant({ type: "merge_directly" as const }),
  fc.constant({ type: "close" as const }),
  fc.constant({ type: "reopen" as const }),
);

describe("merge queue reading follows the queue's lifecycle", () => {
  it("matches the model after every step of any lifecycle", () => {
    fc.assert(fc.property(fc.boolean(), fc.array(actionArb, { maxLength: 30 }), (enabled, actions) => {
      let model: Model = { enabled, lifecycle: "open", landedByQueue: false, events: [], clock: Date.UTC(2026, 10, 1) };
      expect(githubMergeQueueStatus(observe(model))).toEqual(expected(model));
      for (const action of actions) {
        model = step(model, action);
        const reading = githubMergeQueueStatus(observe(model));
        expect(reading).toEqual(expected(model));
        // A queued or removed PR is never read as merged, and a merged one
        // is never read as still in the queue.
        if (model.lifecycle !== "merged") expect(reading?.state).not.toBe("merged_by_queue");
        if (model.lifecycle !== "open") expect(["queued", "group_checks_running", "merging", "unmergeable", "removed"]).not.toContain(reading?.state);
      }
    }), { numRuns: 400 });
  });

  it("carries the reading through the status poll's node mapping and its transitions", () => {
    const node = (extra: Partial<GraphqlPrNode>): GraphqlPrNode => ({
      number: 3631, url: "https://github.com/fixture/project/pull/3631", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
      baseRefName: "main", headRefOid: "a".repeat(40), headRepository: { name: "project" }, headRepositoryOwner: { login: "fixture" },
      commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [], pageInfo: { hasNextPage: false } } } } }] },
      isMergeQueueEnabled: true, ...extra,
    });
    const queued = mapGraphqlPrNode(node({ mergeQueueEntry: { state: "QUEUED", position: 2, enqueuedAt: "2026-11-11T18:00:00Z" } }));
    expect(queued.mergeQueue).toEqual({ kind: "merge_queue", state: "queued", position: 2, enqueuedAt: Date.parse("2026-11-11T18:00:00Z") });
    const removed = mapGraphqlPrNode(node({ queueEvents: { nodes: [{ __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-11-11T18:04:12Z", reason: "failed_checks" }] } }));
    expect(removed.mergeQueue).toMatchObject({ state: "removed", removedReason: "checks_failed" });
    // Checks stay green through all of it: only the queue field moves.
    expect(computePrStatusTransition(queued, removed)?.changed).toEqual({ mergeQueueState: { from: "queued", to: "removed" } });
    expect(mapGraphqlPrNode(node({ isMergeQueueEnabled: false })).mergeQueue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. A merge never goes around a required queue
// ---------------------------------------------------------------------------

const repo: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
const head = "a".repeat(40);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ctx = (): ForgePrToolContext => ({
  repository: repo, branch: "topic", directories: [], attached: [], privateRoots: [], defaultMergeMethod: () => "squash",
});

type Gate = {
  required: boolean;
  entry: EntryState | null;
  checks: "SUCCESS" | "PENDING" | "EXPECTED" | "FAILURE" | null;
  lastRemoved: boolean;
};

const gateArb: fc.Arbitrary<Gate> = fc.record({
  required: fc.boolean(),
  entry: fc.constantFrom<EntryState | null>(null, null, "QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED", "UNMERGEABLE"),
  checks: fc.constantFrom<Gate["checks"]>("SUCCESS", "PENDING", "EXPECTED", "FAILURE", null),
  lastRemoved: fc.boolean(),
});

function gateData(gate: Gate) {
  return {
    repository: { pullRequest: {
      id: "PR_node", state: "OPEN", headRefOid: head, baseRefName: "main", isMergeQueueEnabled: gate.required,
      mergeQueueEntry: gate.entry ? { state: gate.entry, position: 3, enqueuedAt: "2026-11-11T18:00:00Z" } : null,
      queueEvents: { nodes: gate.lastRemoved ? [{ __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-11-11T17:00:00Z", reason: "failed_checks" }] : [] },
      commits: { nodes: [{ commit: { statusCheckRollup: gate.checks ? { state: gate.checks } : null } }] },
    } },
  };
}

/** What the merge must do, from the rule rather than from the code. */
function expectedAction(gate: Gate): "direct" | "none" | "auto_merge" | "enqueue" {
  if (!gate.required) return "direct";
  if (gate.entry) return "none";
  if (gate.checks === "PENDING" || gate.checks === "EXPECTED") return "auto_merge";
  return "enqueue";
}

describe("merge_pull_request on a branch that requires a merge queue", () => {
  it("enqueues, waits on auto-merge, or leaves a queued PR alone, and never merges directly", async () => {
    await fc.assert(fc.asyncProperty(gateArb, async (gate) => {
      const calls: Array<{ method: string; url: string; query?: string }> = [];
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) as { query?: string } : undefined;
        calls.push({ method: init?.method ?? "GET", url: String(input), ...(body?.query ? { query: body.query } : {}) });
        const query = body?.query ?? "";
        if (query.includes("enqueuePullRequest")) return json({ data: { enqueuePullRequest: { mergeQueueEntry: { state: "QUEUED", position: 4, enqueuedAt: "2026-11-11T18:10:00Z" } } } });
        if (query.includes("enablePullRequestAutoMerge")) return json({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "2026-11-11T18:10:00Z" } } } } });
        if (query.includes("isMergeQueueEnabled")) return json({ data: gateData(gate) });
        if (init?.method === "PUT") return json({ merged: true, sha: "c".repeat(40), message: "Pull Request successfully merged" });
        return json({ message: "unexpected" }, 500);
      }) as unknown as typeof fetch;
      const ci = new ForgeCiClient({ fetch: fetcher, githubToken: async () => "fixture-secret", gitlab: { readApi: vi.fn() }, enabled: () => true, takeToken: () => true });
      const client = new GithubPrToolClient({ ci, tempRoots: [os.tmpdir()] });
      const result = await client.execute("merge_pull_request", { number: 3631, expectedHeadSha: head, method: "rebase" }, ctx()) as Record<string, unknown>;

      const direct = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/pulls/3631/merge"));
      const enqueued = calls.filter((call) => call.query?.includes("enqueuePullRequest"));
      const autoMerge = calls.filter((call) => call.query?.includes("enablePullRequestAutoMerge"));
      const action = expectedAction(gate);
      expect(direct).toHaveLength(action === "direct" ? 1 : 0);
      expect(enqueued).toHaveLength(action === "enqueue" ? 1 : 0);
      expect(autoMerge).toHaveLength(action === "auto_merge" ? 1 : 0);
      if (action === "direct") {
        expect(result).toMatchObject({ merged: true, method: "rebase" });
      } else {
        expect(result.merged).toBe(false);
        expect(result.method).toBeUndefined();
        expect(result.queued).toBe(action !== "auto_merge");
        if (action === "auto_merge") expect(result.autoMergeEnabled).toBe(true);
        if (action === "none") expect(result.alreadyQueued).toBe(true);
        if (action === "enqueue") expect(result.mergeQueue).toMatchObject({ state: "queued", position: 4, baseRef: "main" });
      }
    }), { numRuns: 120 });
  });

  // A repository without a queue must merge exactly as it did before the
  // queue existed, whatever happens to the queue read: an Enterprise Server
  // without the schema, a GraphQL refusal or outage, an unreadable answer.
  it("merges directly, as before, whenever the queue read fails", async () => {
    const failure = fc.constantFrom(
      () => json({ errors: [{ message: "Field 'isMergeQueueEnabled' doesn't exist on type 'PullRequest'" }] }),
      () => json({ errors: [{ message: "Something went wrong" }] }),
      () => json({ message: "Server Error" }, 502),
      () => json({ data: { repository: null } }),
    );
    await fc.assert(fc.asyncProperty(failure, fc.constantFrom("github.com", "ghe.example.com"), async (gateResponse, host) => {
      const calls: string[] = [];
      const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init?.method ?? "GET");
        if (init?.method === "PUT") return json({ merged: true, sha: "c".repeat(40) });
        return gateResponse();
      }) as unknown as typeof fetch;
      const client = new GithubPrToolClient({ ci: new ForgeCiClient({
        fetch: fetcher, githubToken: async () => "fixture-secret", gitlab: { readApi: vi.fn() }, enabled: () => true, takeToken: () => true,
      }), tempRoots: [os.tmpdir()] });
      const context = { ...ctx(), repository: { ...repo, host } };
      await expect(client.execute("merge_pull_request", { number: 3631, expectedHeadSha: head, method: "squash" }, context))
        .resolves.toMatchObject({ merged: true, method: "squash" });
      expect(calls.filter((method) => method === "PUT")).toHaveLength(1);
    }), { numRuns: 16 });
  });

  it("merges with gh, as before, when a to-do card's queue read fails", async () => {
    const ran: string[][] = [];
    const fetcher = new GithubPrFetcher({
      graphqlClient: { fetchPullRequests: vi.fn(), fetchPullRequestsForBranches: vi.fn() },
      discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
      runGhCommand: async (_command, args) => {
        ran.push(args);
        if (args[0] === "pr" && args[1] === "view") return { stdout: "https://github.com/fixture/project/pull/3631\n" };
        if (args[0] === "api") throw Object.assign(new Error("exit 1"), { stderr: "HTTP 502: Bad Gateway" });
        return { stdout: "" };
      },
    });
    await expect(fetcher.mergePullRequest({ pullRequest: "3631", method: "squash" })).resolves.toMatchObject({ summary: "Squash-merged #3631" });
    expect(ran.at(-1)).toEqual(["pr", "merge", "3631", "--squash"]);
  });

  it("fails rather than reports auto-merge on when GitHub did not turn it on", async () => {
    const pending: Gate = { required: true, entry: null, checks: "PENDING", lastRemoved: false };
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const query = (init?.body ? JSON.parse(String(init.body)) as { query?: string } : {}).query ?? "";
      if (query.includes("enablePullRequestAutoMerge")) return json({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } } });
      return json({ data: gateData(pending) });
    }) as unknown as typeof fetch;
    const client = new GithubPrToolClient({ ci: new ForgeCiClient({
      fetch: fetcher, githubToken: async () => "fixture-secret", gitlab: { readApi: vi.fn() }, enabled: () => true, takeToken: () => true,
    }), tempRoots: [os.tmpdir()] });
    await expect(client.execute("merge_pull_request", { number: 3631, expectedHeadSha: head }, ctx())).rejects.toMatchObject({ code: "rejected" });
  });

  it("does the same through a to-do card's gh merge, and says it queued rather than merged", async () => {
    await fc.assert(fc.asyncProperty(gateArb, async (gate) => {
      const ran: string[][] = [];
      const fetcher = new GithubPrFetcher({
        graphqlClient: { fetchPullRequests: vi.fn(), fetchPullRequestsForBranches: vi.fn() },
        discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
        runGhCommand: async (_command, args) => {
          ran.push(args);
          const query = args.find((arg) => arg.startsWith("query=")) ?? "";
          if (args[0] === "pr" && args[1] === "view") return { stdout: "https://github.com/fixture/project/pull/3631\n" };
          if (query.includes("enqueuePullRequest")) return { stdout: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { state: "QUEUED", position: 2, enqueuedAt: "2026-11-11T18:10:00Z" } } } }) };
          if (query.includes("enablePullRequestAutoMerge")) return { stdout: JSON.stringify({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "x" } } } } }) };
          if (query.includes("isMergeQueueEnabled")) return { stdout: JSON.stringify({ data: gateData(gate) }) };
          if (args[0] === "pr" && args[1] === "merge") return { stdout: "" };
          throw new Error(`unexpected gh ${args.join(" ")}`);
        },
      });
      const merged = await fetcher.mergePullRequest({ pullRequest: "3631", method: "squash" });
      const direct = ran.filter((args) => args[0] === "pr" && args[1] === "merge");
      const action = expectedAction(gate);
      expect(direct).toEqual(action === "direct" ? [["pr", "merge", "3631", "--squash"]] : []);
      if (action === "direct") {
        expect(merged.summary).toBe("Squash-merged #3631");
      } else {
        expect(merged.queued).toBe(true);
        expect(merged.summary).not.toMatch(/merged #/i);
        expect(merged.summary).toMatch(action === "auto_merge" ? /Auto-merge on for #3631/ : action === "enqueue" ? /^Added #3631 to the merge queue · queued #2$/ : /^#3631 is already in the merge queue · queued/);
      }
    }), { numRuns: 80 });
  });
});

// ---------------------------------------------------------------------------
// 3. A removal wakes each merge watch armed before it, once
// ---------------------------------------------------------------------------

const prBase: PrSummary = {
  provider: "github.com", org: "fixture", repo: "project", number: 3619, title: "Retry flaky lane",
  url: "https://github.com/fixture/project/pull/3619", baseRefName: "main",
  // Checks still run at the head, so the CI watch below has nothing to say.
  state: "pending", checkState: "pending", checksStillRunning: true, lifecycleState: "open", headSha: head,
};

function removedAt(at: number, reason: PrMergeQueueRemovalReason = "checks_failed"): PrSummary {
  return { ...prBase, mergeQueue: { kind: "merge_queue", state: "removed", removedAt: at, removedReason: reason } };
}

async function registerMergeWatch(store: SqliteOverlayStore, threadId: string, createdAt: number) {
  await store.registerThreadPrStatusWatch({ now: createdAt, watch: {
    backend: "codex", threadId, watchId: `merge-${threadId}`, prKey: buildPullRequestStatusKey(prBase), prUrl: prBase.url,
    prNumber: prBase.number, kind: "terminal", headSha: "", notifyOn: ["merged"], createdAt, failureHandledByAutoFix: false,
  } });
}

describe("a GitLab merge train car that merged", () => {
  // The car and the MR are separate reads. A car that already merged while
  // the MR still reads open is the train landing it, never a removal: a
  // removal would end the merge watch with "It has not merged".
  it("reads as merging, and wakes no merge watch, until the MR reads merged", () => {
    fc.assert(fc.property(
      fc.constantFrom("merged", "skip_merged", "MERGED"),
      fc.option(fc.constantFrom("success", "failed", "canceled"), { nil: null }),
      (status, pipelineStatus) => {
        const open = gitlabMergeTrainStatus({
          lifecycle: "open", enabled: true,
          car: { status, createdAt: "2026-11-11T18:00:00Z", updatedAt: "2026-11-11T18:20:00Z", pipelineStatus },
        });
        expect(open?.state).toBe("merging");
        const pr = { provider: "gitlab.com", org: "fixture", repo: "project", number: 17, url: "https://gitlab.com/fixture/project/-/merge_requests/17", lifecycleState: "open", mergeQueue: open } as PrSummary;
        expect(terminalWakeOutcomeOf(pr)).toBeUndefined();
        expect(gitlabMergeTrainStatus({ lifecycle: "merged", enabled: true, car: { status } })?.state).toBe("merged_by_queue");
      },
    ));
  });
});

describe("a merge queue removal wakes merge watches", () => {
  it("wakes each watch armed before the removal exactly once, and none armed after it", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 6 }),
      fc.integer({ min: 2, max: 401 }),
      fc.integer({ min: 1, max: 4 }),
      async (armedAt, removal, polls) => {
        const db = openInMemoryStateDb();
        const store = new SqliteOverlayStore(db);
        const woken: string[] = [];
        const prompts: string[] = [];
        const submitTurnIfIdle = vi.fn(async (params: { threadId: string; input: AppServerTurnInputItem[] }) => {
          woken.push(params.threadId);
          const first = params.input[0];
          prompts.push(first?.type === "text" ? first.text : "");
          return { status: "started" as const, turnId: "wake" };
        });
        const coordinator = new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle }, now: () => 1_000 });
        try {
          for (const at of armedAt) await registerMergeWatch(store, `thread-${at}`, at);
          // A CI watch on the same PR, which a removal must not end.
          await store.registerThreadPrStatusWatch({ now: 1, watch: {
            backend: "codex", threadId: "ci-thread", watchId: "ci", prKey: buildPullRequestStatusKey(prBase), prUrl: prBase.url,
            prNumber: prBase.number, kind: "checks", headSha: head, notifyOn: ["success", "failure"], createdAt: 1, failureHandledByAutoFix: false,
          } });
          for (let index = 0; index < polls; index += 1) {
            await coordinator.handleStatusSnapshot(removedAt(removal), 900 + index);
          }
          const before = armedAt.filter((at) => at < removal).map((at) => `thread-${at}`).sort();
          expect([...woken].sort()).toEqual(before);
          for (const prompt of prompts) {
            expect(prompt).toContain("removed from the merge queue for main");
            expect(prompt).toContain("The merge group's checks failed.");
          }
          const active = (await store.listAllActivePrStatusWatches()).map((watch) => watch.watchId).sort();
          const after = armedAt.filter((at) => at >= removal).map((at) => `merge-thread-${at}`);
          expect(active).toEqual(["ci", ...after].sort());

          // A later removal reaches the watches the first one did not.
          await coordinator.handleStatusSnapshot(removedAt(500, "merge_conflict"), 950);
          expect([...woken].sort()).toEqual(armedAt.map((at) => `thread-${at}`).sort());
          expect((await store.listAllActivePrStatusWatches()).map((watch) => watch.watchId)).toEqual(["ci"]);
        } finally { db.close(); }
      },
    ), { numRuns: 40 });
  });

  it("puts a wake a busy thread refused back, and delivers it when the thread is idle", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    let busy = true;
    const submitTurnIfIdle = vi.fn(async () => busy ? { status: "busy" as const } : { status: "started" as const, turnId: "wake" });
    const coordinator = new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle }, now: () => 1_000 });
    try {
      await registerMergeWatch(store, "busy-thread", 1);
      await coordinator.handleStatusSnapshot(removedAt(100), 900);
      await coordinator.handleStatusSnapshot(removedAt(100), 901);
      expect(submitTurnIfIdle).toHaveBeenCalledTimes(1);
      const [saved] = await store.listPendingPrTerminalWatchObservations({ backend: "codex", threadId: "busy-thread" });
      busy = false;
      await coordinator.handleTerminalSnapshot(saved!.pr, saved!.observedAt, { fromSavedObservation: true, pendingOnly: true });
      expect(submitTurnIfIdle).toHaveBeenCalledTimes(2);
      expect(await store.listPendingPrTerminalWatchObservations()).toEqual([]);
      const [ended] = await store.listThreadPrStatusWatchHistory({ backend: "codex", threadId: "busy-thread", limit: 5 });
      expect(ended).toMatchObject({ status: "dispatched", endedReason: "pr_dequeued" });
    } finally { db.close(); }
  });

  it("stays within its write budget across repeated polls of a removed PR", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("merge-queue-removal-budget-");
    const db = StateDb.open(temp.dbPath);
    const store = new SqliteOverlayStore(db);
    const coordinator = new PrStatusWatchCoordinator({
      store, registry: { submitTurnIfIdle: async () => ({ status: "started" as const, turnId: "wake" }) }, now: () => 1_000,
    });
    try {
      await registerMergeWatch(store, "budget", 1);
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 10; index += 1) {
          await coordinator.handleStatusSnapshot(removedAt(100), 900 + index);
        }
      });
      expectSqliteWriteBudget({ scenario: "pr-merge-queue-removal-wake", writes,
        note: "one merge watch woken by a queue removal, then nine more polls of the removed PR: observe, claim and finish once, 0 commits per later poll; ~0.3 MB/day at 10 removals/day" });
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); }
  });
});
