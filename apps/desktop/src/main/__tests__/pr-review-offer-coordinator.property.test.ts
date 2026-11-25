import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import type { PrChangeIdentitySource } from "../pr-status/pr-change-identity";
import { PrReviewOfferCoordinator, type PrReviewOfferThread } from "../pr-status/pr-review-offer-coordinator";
import { selectPrReviewOfferOwner, type PrReviewOfferCandidate } from "../pr-status/pr-review-offer-owner";
import { computePrStatusTransition, type PrStatusTransitionChanges } from "../pr-status/pr-transitions";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { SqliteThreadReviewStorage } from "../storage/thread-review-storage-sqlite";
import { ThreadTodoStore } from "../storage/thread-todo-store";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";
import { ThreadTodoService } from "../thread-todos/thread-todo-service";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

/*
 * The workflow docs/pr-review-readiness.md promises:
 *
 * - Never a merge offer for a head whose change no review covers, or whose
 *   newest covering review still has open findings. (Merge before review was
 *   the operator's complaint.)
 * - When CI is green on a change no review covers, and the latest review has
 *   no open findings, a review offer is open, unless the operator dismissed
 *   or ran the offer for that change. While the latest review's findings are
 *   open, new commits are its fixes, so nothing is offered.
 * - When CI is green on a reviewed, settled head, a merge offer is open,
 *   unless the operator dismissed or ran the offer for that head.
 * - A rebase onto the target or a merge of the target keeps the change, so
 *   it never makes a reviewed PR need review again. Commits made while a
 *   review's findings were open are review fixes and do not either.
 * - A review offer is withdrawn once a review covers the head.
 * - One offer card per PR at a time.
 *
 * Model: commits carry a change id. A rebase or target merge makes a new
 * commit with the same change id; a pushed change makes a new one. Reviews
 * cover the change they saw and the change their findings were fixed
 * through. The oracle is that bookkeeping, done by hand below. The real
 * coordinator and to-do service run against a real state database; Git is
 * replaced by the model's change ids (pr-change-identity.property.test.ts
 * checks those against real Git).
 */

afterEach(() => vi.unstubAllEnvs());

const THREAD = { backend: "codex" as const, threadId: "thread-1" };
const prKeyFor = (number: number) => buildPullRequestStatusKey({ provider: "github.com", org: "example", repo: "project", number });
const PR_KEY = prKeyFor(7);
const PR_URL = "https://github.com/example/project/pull/7";

type Ci = "pending" | "passing" | "failing";

type ModelReview = {
  review: ThreadReview;
};

class World {
  shaSeq = 0;
  changeSeq = 0;
  clock = 1_000;
  readonly changeOf = new Map<string, string>();
  head: string;
  ci: Ci = "pending";
  lifecycle: "open" | "merged" = "open";
  base = "main";
  stackUnavailable = false;
  heldBy?: string;
  lowerPolled = true;
  readonly lowers = new Map<number, "open" | "merged">();
  readonly evaluatedOwners: string[] = [];
  readonly reviews: ModelReview[] = [];
  /**
   * The oracle's own record of each review's fixed-through head: the head
   * when its findings last settled. Kept apart from what the coordinator
   * records, so a coordinator that moves it at the wrong time disagrees.
   */
  readonly settledThrough = new Map<string, string>();
  /** Offers the operator dismissed or ran: `review:<change>` or `merge:<sha>`. */
  readonly operatorClosed = new Set<string>();
  gitProcesses = 0;

  constructor() {
    this.head = this.commit(this.newChange());
  }

  newChange(): string {
    this.changeSeq += 1;
    return `change-${this.changeSeq}`;
  }

  commit(change: string): string {
    this.shaSeq += 1;
    const sha = this.shaSeq.toString(16).padStart(40, "0");
    this.changeOf.set(sha, change);
    return sha;
  }

  pr(): PrSummary {
    return {
      provider: "github.com",
      org: "example",
      repo: "project",
      number: 7,
      url: PR_URL,
      title: "Add the thing",
      headRefName: "feature",
      baseRefName: this.base,
      headSha: this.head,
      state: this.ci,
      checkState: this.ci,
      lifecycleState: this.lifecycle,
    };
  }

  /** The oracle: which reviews cover the head's change. */
  coveringReviews(): ThreadReview[] {
    const change = this.changeOf.get(this.head);
    return this.reviews
      .map((entry) => entry.review)
      .filter((review) =>
        [review.context!.headCommit, this.settledThrough.get(review.id)]
          .some((sha) => sha !== undefined && this.changeOf.get(sha) === change)
      );
  }

  newestCovering(): ThreadReview | undefined {
    return this.coveringReviews().sort((a, b) => b.createdAt - a.createdAt)[0];
  }
}

function settled(review: ThreadReview): boolean {
  return review.status !== "open";
}

const identity = (world: World): PrChangeIdentitySource => ({
  get gitProcessCount() {
    return world.gitProcesses;
  },
  resolveTargetTip: async () => {
    world.gitProcesses += 1;
    return "f".repeat(40);
  },
  // A reviewed working tree is modeled as one more id with a change.
  changeIdentity: async ({ sha, tree }) => {
    world.gitProcesses += 3;
    return world.changeOf.get(tree ?? sha);
  },
  // The reviewed checkout is on the PR branch and at the PR head.
  readReviewedBranchHead: async () => {
    world.gitProcesses += 1;
    return world.head;
  },
});

type Harness = {
  world: World;
  todos: ThreadTodoService;
  coordinator: PrReviewOfferCoordinator;
  restart: () => void;
  close: () => void;
};

function createHarness(
  db: StateDb = openInMemoryStateDb(),
  ownerThread: (world: World) => Promise<PrReviewOfferThread | undefined> = async () => THREAD,
  neverMerge: () => boolean = () => false,
): Harness {
  const world = new World();
  let ids = 0;
  const todos = new ThreadTodoService({
    store: new ThreadTodoStore(db),
    now: () => world.clock,
    newId: () => `todo-${++ids}`,
  });
  const buildCoordinator = () => new PrReviewOfferCoordinator({
    ownerThread: async (key) => {
      world.evaluatedOwners.push(key);
      return key === PR_KEY ? await ownerThread(world) : undefined;
    },
    threadPrKeys: () => [PR_KEY],
    neverMergeRefusal: () => neverMerge() ? "canvas never merges its pull requests." : undefined,
    getPr: () => world.pr(),
    stackHold: async () => world.heldBy ? { reason: world.heldBy, lowerKey: prKeyFor(1) } : undefined,
    stackMergeEvidence: async () => ({
      blocked: world.stackUnavailable || world.base !== "main" || [...world.lowers.values()].includes("open"),
      lowerKeys: [...world.lowers.keys()].map(prKeyFor),
      retryOnObservation: world.stackUnavailable,
    }),
    isLowerPolled: () => world.lowerPolled,
    now: () => world.clock,
    directories: () => ["/work/project"],
    listReviews: () => world.reviews.map((entry) => entry.review),
    recordFixedThrough: (reviewId, commit, settledAt) => {
      const entry = world.reviews.find((candidate) => candidate.review.id === reviewId);
      if (entry) entry.review = { ...entry.review, fixedThroughCommit: commit, fixedThroughAt: settledAt };
    },
    cards: todos,
    identity: identity(world),
  });
  const harness = { world, todos, coordinator: buildCoordinator(), restart() {
    this.coordinator.close();
    this.coordinator = buildCoordinator();
  }, close: () => db.close() };
  return harness;
}

async function retarget(harness: Harness): Promise<void> {
  const before = harness.world.pr();
  harness.world.base = "main";
  const event = computePrStatusTransition(before, harness.world.pr());
  if (event) harness.coordinator.handleTransition(event);
  await harness.coordinator.idle();
}

async function mergeLower(harness: Harness, number: number): Promise<void> {
  if (harness.world.lowers.has(number)) harness.world.lowers.set(number, "merged");
  const parent = { ...harness.world.pr(), number, url: `https://github.com/example/project/pull/${number}`, lifecycleState: "open" as const };
  const event = computePrStatusTransition(parent, { ...parent, lifecycleState: "merged" });
  harness.coordinator.handleTransition(event!);
  await harness.coordinator.idle();
}

function openOfferCards(todos: ThreadTodoService, thread: PrReviewOfferThread = THREAD): ThreadTodo[] {
  return todos.list({ ...thread, status: "open" })
    .filter((todo) => todo.dependencyId?.startsWith("pr-offer:"));
}

type Command = { name: string; run: (harness: Harness) => Promise<void> };

async function transition(harness: Harness, changed: PrStatusTransitionChanges): Promise<void> {
  harness.coordinator.handleTransition({
    prKey: PR_KEY,
    url: PR_URL,
    pr: harness.world.pr(),
    headSha: harness.world.head,
    changed,
    threadKeys: [],
  });
  await harness.coordinator.idle();
}

it("retracts a stale review offer, holds merge offers, and rechecks once the lower layer settles", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-held-review-offer-");
  const harness = createHarness(StateDb.open(temp.dbPath));
  const { world, coordinator, todos } = harness;
  try {
    world.ci = "passing";
    await coordinator.evaluate(THREAD, PR_KEY);
    expect(todos.list({ ...THREAD, status: "open" })).toHaveLength(1);
    world.heldBy = "Held by #6: CI running";
    const retired = await measureSqliteWrites(async () => await coordinator.evaluate(THREAD, PR_KEY));
    expect(retired.result).toMatchObject({ readiness: "stack_parent_open", retired: true });
    expectSqliteWriteBudget({ scenario: "stack-held-withdraw-review-offer", writes: retired.writes,
      note: "Withdraw an existing offer once when a lower layer becomes unsettled. At 100 withdrawals/day and 12,360 bytes each, about 1.24 MB/day." });
    expect(todos.list({ ...THREAD, status: "open" })).toHaveLength(0);
    recordReview(world, 0);
    await expect(coordinator.mergeOfferRefusal(THREAD, PR_KEY)).resolves.toBe(world.heldBy);
    await coordinator.evaluate(THREAD, PR_KEY);
    expect(todos.list({ ...THREAD, status: "open" })).toHaveLength(0);
    world.heldBy = undefined;
    await expect(coordinator.evaluate(THREAD, PR_KEY)).resolves.toMatchObject({ raised: "merge" });
  } finally {
    harness.close();
    removeTempStateDbDir(temp.tempDir);
  }
});

async function push(harness: Harness, change: string): Promise<void> {
  const { world } = harness;
  const from = world.head;
  const ci = world.ci;
  world.head = world.commit(change);
  world.ci = "pending";
  world.clock += 1;
  await transition(harness, {
    headSha: { from, to: world.head },
    ...(ci !== "pending" ? { checkState: { from: ci, to: "pending" } } : {}),
  });
}

function recordReview(world: World, findings: number): ThreadReview {
  world.clock += 1;
  const review: ThreadReview = {
    ...THREAD,
    id: `review-${world.reviews.length + 1}`,
    origin: "automatic",
    sourceKey: `managed-review:${world.reviews.length + 1}`,
    title: "Code review",
    context: {
      workspacePath: "/work/project",
      gitBranch: "feature",
      baseBranch: "main",
      headCommit: world.head,
      pullRequest: { provider: "github.com", org: "example", repo: "project", number: 7, url: PR_URL },
    },
    status: findings === 0 ? "handled" : "open",
    // As the service does: a clean review is settled when it lands.
    ...(findings === 0 ? { resolution: { note: "Review completed with no findings.", actor: "system" as const, at: world.clock } } : {}),
    items: Array.from({ length: findings }, (_, index) => ({
      id: `finding-${index}`,
      title: `Finding ${index}`,
      status: "open" as const,
      createdAt: world.clock,
      updatedAt: world.clock,
    })),
    createdAt: world.clock,
    updatedAt: world.clock,
  };
  world.reviews.push({ review });
  if (findings === 0) world.settledThrough.set(review.id, world.head);
  return review;
}

async function reviewChanged(harness: Harness, review: ThreadReview): Promise<void> {
  harness.coordinator.handleReviewChanged(review);
  await harness.coordinator.idle();
}

function settleLatestOpen(world: World): ThreadReview | undefined {
  const entry = [...world.reviews].reverse().find((candidate) => candidate.review.status === "open");
  if (!entry) return undefined;
  world.clock += 1;
  entry.review = {
    ...entry.review,
    status: "handled",
    items: entry.review.items.map((item) => ({ ...item, status: "addressed" as const, updatedAt: world.clock })),
    // As the service does when the last finding settles.
    resolution: { note: "Every finding is settled.", actor: "system", at: world.clock },
    updatedAt: world.clock,
  };
  world.settledThrough.set(entry.review.id, world.head);
  return entry.review;
}

const commands: fc.Arbitrary<Command>[] = [
  fc.constant<Command>({ name: "pushChange", run: async (h) => await push(h, h.world.newChange()) }),
  fc.constant<Command>({ name: "rebaseOntoTarget", run: async (h) => await push(h, h.world.changeOf.get(h.world.head)!) }),
  fc.constant<Command>({ name: "mergeTargetIn", run: async (h) => await push(h, h.world.changeOf.get(h.world.head)!) }),
  fc.constantFrom<Ci>("passing", "failing").map<Command>((ci) => ({
    name: `ci:${ci}`,
    run: async (h) => {
      const from = h.world.ci;
      if (from === ci) return;
      h.world.ci = ci;
      await transition(h, { checkState: { from, to: ci } });
    },
  })),
  fc.nat({ max: 2 }).map<Command>((findings) => ({
    name: `review:${findings}`,
    run: async (h) => await reviewChanged(h, recordReview(h.world, findings)),
  })),
  fc.constant<Command>({
    name: "fixAndSettle",
    run: async (h) => {
      if (!h.world.reviews.some((entry) => entry.review.status === "open")) return;
      await push(h, h.world.newChange());
      const review = settleLatestOpen(h.world);
      if (review) await reviewChanged(h, review);
    },
  }),
  fc.constant<Command>({
    name: "settleWithoutCommit",
    run: async (h) => {
      const review = settleLatestOpen(h.world);
      if (review) await reviewChanged(h, review);
    },
  }),
  fc.constant<Command>({
    // The operator reopens a settled finding; settling it again without a
    // commit must bring the same head's merge offer back.
    name: "reopenFinding",
    run: async (h) => {
      const entry = [...h.world.reviews].reverse()
        .find((candidate) => candidate.review.status === "handled" && candidate.review.items.length > 0);
      if (!entry) return;
      h.world.clock += 1;
      entry.review = {
        ...entry.review,
        status: "open",
        items: entry.review.items.map((item, index) => index === 0
          ? { ...item, status: "open" as const, updatedAt: h.world.clock }
          : item),
        resolution: undefined,
        updatedAt: h.world.clock,
      };
      await reviewChanged(h, entry.review);
    },
  }),
  fc.constant<Command>({
    // Someone edits a settled finding's note. It is not a settlement, so the
    // commits pushed since must not become review fixes.
    name: "editSettledFinding",
    run: async (h) => {
      const entry = [...h.world.reviews].reverse()
        .find((candidate) => candidate.review.status === "handled" && candidate.review.items.length > 0);
      if (!entry) return;
      h.world.clock += 1;
      entry.review = {
        ...entry.review,
        items: entry.review.items.map((item, index) => index === 0
          ? { ...item, resolution: { note: `Edited at ${h.world.clock}`, actor: "user" as const, at: h.world.clock }, updatedAt: h.world.clock }
          : item),
        updatedAt: h.world.clock,
      };
      await reviewChanged(h, entry.review);
    },
  }),
  fc.constantFrom("dismissed" as const, "done" as const).map<Command>((status) => ({
    name: `operator:${status}`,
    run: async (h) => {
      const card = openOfferCards(h.todos)[0];
      if (!card) return;
      const kind = card.action?.type === "merge_pull_request" ? "merge" : "review";
      const head = card.dependencyId!.split(":sha:")[1];
      const change = card.dependencyId!.split(":patch:")[1];
      h.world.operatorClosed.add(kind === "merge" ? `merge:${head}` : `review:${change ?? h.world.changeOf.get(head!)}`);
      h.todos.resolve({ id: card.id, status, allowOpenItems: true });
    },
  })),
];

function checkInvariants(harness: Harness): void {
  const { world, todos } = harness;
  const cards = openOfferCards(todos);
  expect(cards.length).toBeLessThanOrEqual(1);
  const card = cards[0];
  const newest = world.newestCovering();
  const change = world.changeOf.get(world.head)!;
  const reviewedAndSettled = newest !== undefined && settled(newest);
  if (card?.action?.type === "merge_pull_request") {
    expect(world.lifecycle).toBe("open");
    expect(card.dependencyId).toContain(`:sha:${world.head}`);
    expect(reviewedAndSettled).toBe(true);
  }
  if (card?.action?.type === "start_review") {
    expect(newest).toBeUndefined();
    // The card names its PR, so the composer reviews that PR, not the checkout.
    expect(card.action.pullRequest).toBe(PR_URL);
  }
  if (world.lifecycle !== "open" || world.ci !== "passing") return;
  const latest = [...world.reviews].map((entry) => entry.review).sort((a, b) => b.createdAt - a.createdAt)[0];
  const latestHasOpenFindings = latest !== undefined && latest.status === "open";
  if (!newest && !latestHasOpenFindings && !world.operatorClosed.has(`review:${change}`)) {
    expect(card?.action?.type).toBe("start_review");
    expect(card?.dependencyId).toContain(`:patch:${change}`);
  }
  if (reviewedAndSettled && !world.operatorClosed.has(`merge:${world.head}`)) {
    expect(card?.action?.type).toBe("merge_pull_request");
  }
}

describe("PR review and merge offers", () => {
  it("offers review before merge, and survives rebases, target merges, and review fixes", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.oneof(...commands), { minLength: 4, maxLength: 24 }), async (sequence) => {
      const harness = createHarness();
      try {
        for (const command of sequence) {
          await command.run(harness);
          checkInvariants(harness);
        }
      } finally {
        harness.close();
      }
    }), { numRuns: 8 });
  });

  it("does no Git work while CI is pending or failing", async () => {
    const harness = createHarness();
    try {
      await push(harness, harness.world.newChange());
      harness.world.ci = "failing";
      await transition(harness, { checkState: { from: "pending", to: "failing" } });
      expect(harness.world.gitProcesses).toBe(0);
      expect(openOfferCards(harness.todos)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("asks once per change: a rebase of an unreviewed PR does not re-raise a dismissed review offer", async () => {
    const harness = createHarness();
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      const [card] = openOfferCards(harness.todos);
      expect(card?.action).toEqual({ type: "start_review", pullRequest: PR_URL });
      harness.todos.resolve({ id: card!.id, status: "dismissed" });
      await push(harness, harness.world.changeOf.get(harness.world.head)!);
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("brings a withdrawn merge offer back when a reopened finding is settled again", async () => {
    const harness = createHarness();
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      await reviewChanged(harness, recordReview(harness.world, 1));
      expect(openOfferCards(harness.todos)).toEqual([]);
      await reviewChanged(harness, settleLatestOpen(harness.world)!);
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);
      const entry = harness.world.reviews[0]!;
      entry.review = { ...entry.review, status: "open", items: entry.review.items.map((item) => ({ ...item, status: "open" as const })) };
      await reviewChanged(harness, entry.review);
      expect(openOfferCards(harness.todos)).toEqual([]);
      await reviewChanged(harness, settleLatestOpen(harness.world)!);
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);
    } finally {
      harness.close();
    }
  });

  it("does not count commits pushed after a settlement as fixes when a settled finding is edited", async () => {
    const harness = createHarness();
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      await reviewChanged(harness, recordReview(harness.world, 1));
      const fixedHead = harness.world.head;
      await reviewChanged(harness, settleLatestOpen(harness.world)!);
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);

      await push(harness, harness.world.newChange());
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["start_review"]);

      const entry = harness.world.reviews[0]!;
      harness.world.clock += 1;
      entry.review = {
        ...entry.review,
        items: entry.review.items.map((item) => ({
          ...item,
          resolution: { note: "Reworded.", actor: "user" as const, at: harness.world.clock },
          updatedAt: harness.world.clock,
        })),
        updatedAt: harness.world.clock,
      };
      await reviewChanged(harness, entry.review);
      expect(harness.world.reviews[0]!.review.fixedThroughCommit).toBe(fixedHead);
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["start_review"]);
    } finally {
      harness.close();
    }
  });

  it("reports a covering review's open findings while CI is still running", async () => {
    const harness = createHarness();
    try {
      await reviewChanged(harness, recordReview(harness.world, 2));
      const assessment = await harness.coordinator.assess(THREAD, PR_KEY, { coverage: true });
      expect(assessment).toMatchObject({ readiness: "ci_pending", headCovered: true, openFindings: 2 });
    } finally {
      harness.close();
    }
  });

  it("offers the merge on the PR's owner when the review ran on another thread", async () => {
    const harness = createHarness();
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      const review = { ...recordReview(harness.world, 0), threadId: "thread-child" };
      harness.world.reviews[0]!.review = review;
      await reviewChanged(harness, review);
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);
    } finally {
      harness.close();
    }
  });

  it("leaves a running merge card as the only offer until its run ends", async () => {
    const harness = createHarness();
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      await reviewChanged(harness, recordReview(harness.world, 0));
      const [merge] = openOfferCards(harness.todos);
      expect(merge?.action?.type).toBe("merge_pull_request");
      // The service marks a card running while its action runs.
      const running = (harness.todos as unknown as { running: Set<string> }).running;
      running.add(merge!.id);

      await push(harness, harness.world.newChange());
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.id)).toEqual([merge!.id]);

      running.delete(merge!.id);
      await transition(harness, { checkState: { from: "passing", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["start_review"]);
    } finally {
      harness.close();
    }
  });

  it("refuses an agent's merge card until a review covers the head and its findings settle", async () => {
    const harness = createHarness();
    const refusal = async () => await harness.coordinator.mergeOfferRefusal(THREAD, PR_KEY);
    try {
      expect(await refusal()).toContain("has no review covering its head");
      await reviewChanged(harness, recordReview(harness.world, 1));
      // CI still running does not hide the open finding.
      expect(await refusal()).toContain("1 unsettled finding");
      await reviewChanged(harness, settleLatestOpen(harness.world)!);
      expect(await refusal()).toBeUndefined();
      await push(harness, harness.world.newChange());
      expect(await refusal()).toContain("has no review covering its head");
      await push(harness, harness.world.changeOf.get(harness.world.head)!);
      expect(await refusal()).toContain("has no review covering its head");
      harness.world.lifecycle = "merged";
      expect(await refusal()).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("withdraws a merge card when a newer review opens findings while CI is failing", async () => {
    const harness = createHarness();
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      await reviewChanged(harness, recordReview(harness.world, 0));
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);
      harness.world.ci = "failing";
      await transition(harness, { checkState: { from: "passing", to: "failing" } });
      await reviewChanged(harness, recordReview(harness.world, 1));
      expect(openOfferCards(harness.todos)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("counts the commit recording a reviewed working tree as reviewed, and nothing after it", async () => {
    const harness = createHarness();
    try {
      // A clean review of uncommitted changes on top of the current head.
      const work = harness.world.newChange();
      const tree = "7".repeat(40);
      harness.world.changeOf.set(tree, work);
      const review = recordReview(harness.world, 0);
      review.context = { ...review.context!, reviewedTree: tree };
      harness.world.reviews[0]!.review = review;
      await reviewChanged(harness, review);

      // The reviewed work is committed and pushed as it was.
      await push(harness, work);
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);

      await push(harness, harness.world.newChange());
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["start_review"]);
    } finally {
      harness.close();
    }
  });

  it("reconciles a green reviewed child on its retarget and the last tracked lower merge in either order", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer({ min: 2, max: 6 }), async (retargetFirst, restart, lowerCount) => {
      const harness = createHarness();
      try {
        harness.world.ci = "passing";
        harness.world.base = "parent";
        for (let lower = 1; lower <= lowerCount; lower++) harness.world.lowers.set(lower, "open");
        await reviewChanged(harness, recordReview(harness.world, 0));
        if (restart) {
          harness.restart();
          harness.coordinator.handleObservations([harness.world.pr()]);
          await harness.coordinator.idle();
        }
        if (retargetFirst) await retarget(harness);
        harness.world.evaluatedOwners.length = 0;
        await mergeLower(harness, 123);
        expect(harness.world.evaluatedOwners).toEqual([prKeyFor(123)]);
        for (let lower = 1; lower < lowerCount; lower++) {
          await mergeLower(harness, lower);
          expect(openOfferCards(harness.todos)).toEqual([]);
        }
        await mergeLower(harness, lowerCount);
        if (!retargetFirst) {
          expect(openOfferCards(harness.todos)).toEqual([]);
          await retarget(harness);
        }
        expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);
      } finally {
        harness.close();
      }
    }), { numRuns: 8, examples: [[true, false, 2], [false, true, 2]] });
  });

  it.each([false, true] as const)("preserves a merge card during a failed stack read only for the card's exact head [%#]", async (headMoved) => {
    const harness = createHarness();
    try {
      const { world } = harness;
      world.ci = "passing";
      await reviewChanged(harness, recordReview(world, 0));
      expect(openOfferCards(harness.todos)).toHaveLength(1);
      const previous = world.head;
      world.stackUnavailable = true;
      if (headMoved) world.head = world.commit(world.changeOf.get(previous)!);
      await transition(harness, { headSha: { from: previous, to: world.head } });
      expect(openOfferCards(harness.todos)).toHaveLength(headMoved ? 0 : 1);
    } finally { harness.close(); }
  });

  it.each([
    [false, 1],
    [false, 2],
    [false, 3],
    [false, 4],
    [false, 5],
    [false, 6],
    [true, 1],
    [true, 2],
    [true, 3],
    [true, 4],
    [true, 5],
    [true, 6],
  ] as const)("rechecks an uncovered hold on unchanged child polls within a bounded cadence [%#]", async (polled, duplicatePolls) => {
    const harness = createHarness();
    try {
      const { world } = harness;
      world.ci = "passing";
      world.lowerPolled = polled;
      world.lowers.set(1, "open");
      await reviewChanged(harness, recordReview(world, 0));
      world.lowers.set(1, "merged");
      for (let i = 0; i < duplicatePolls; i++) {
        harness.coordinator.handleObservations([world.pr()]);
        await harness.coordinator.idle();
        expect(openOfferCards(harness.todos)).toHaveLength(0);
      }
      world.clock += 10 * 60_000;
      harness.coordinator.handleObservations([world.pr()]);
      await harness.coordinator.idle();
      expect(openOfferCards(harness.todos)).toHaveLength(polled ? 0 : 1);
    } finally { harness.close(); }
  });

  it.each(["status transition", "local settlement"] as const)("offers a review on %s without a child PR change", async (trigger) => {
    const harness = createHarness();
    try {
      const { world, coordinator, todos } = harness;
      world.ci = "passing";
      world.heldBy = "Held by #1: CI running";
      world.lowerPolled = true;
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(todos)).toEqual([]);
      world.heldBy = undefined;
      if (trigger === "status transition") {
        const lower = { ...world.pr(), number: 1, url: "https://github.com/example/project/pull/1" };
        coordinator.handleTransition(computePrStatusTransition(
          { ...lower, checkState: "failing", state: "failing" }, lower,
        )!);
      } else {
        world.clock += 6 * 60_000;
        coordinator.handleObservations([world.pr()]);
      }
      await coordinator.idle();
      expect(openOfferCards(todos).map((card) => card.action?.type)).toEqual(["start_review"]);
    } finally { harness.close(); }
  });

  it("budgets card writes from stack transitions and duplicate deliveries", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    for (const trigger of ["base", "lower"] as const) {
      const temp = createTempStateDb(`pwragent-stack-offer-${trigger}-`);
      const harness = createHarness(StateDb.open(temp.dbPath));
      try {
        harness.world.ci = "passing";
        harness.world.base = trigger === "base" ? "parent" : "main";
        harness.world.lowers.set(1, trigger === "lower" ? "open" : "merged");
        await reviewChanged(harness, recordReview(harness.world, 0));
        const previous = harness.world.pr();
        const baseChange = computePrStatusTransition(previous, { ...previous, baseRefName: "main" });
        const event = async () => {
          if (trigger === "lower") {
            await mergeLower(harness, 1);
          } else {
            harness.world.base = "main";
            harness.coordinator.handleTransition(baseChange!);
            await harness.coordinator.idle();
          }
        };
        const { writes } = await measureSqliteWrites(event);
        expect(openOfferCards(harness.todos)).toHaveLength(1);
        expectSqliteWriteBudget({ scenario: `pr-review-stack-${trigger}-offer`, writes,
          note: "One eligible child becomes ready: one card commit. At 100 child offers/day and ~29 KB WAL/offer, ~2.9 MB/day." });
        const repeat = await measureSqliteWrites(event);
        expectSqliteWriteBudget({ scenario: `pr-review-stack-${trigger}-repeat`, writes: repeat.writes,
          note: "A repeated observation after the offer is open costs 0 MB/day." });
      } finally {
        harness.close();
        removeTempStateDbDir(temp.tempDir);
      }
    }
  });

  it("budgets writes for uncovered holds and stale offers during transport failure", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-stack-review-recheck-");
    const harness = createHarness(StateDb.open(temp.dbPath));
    try {
      const { world } = harness;
      world.ci = "passing";
      world.lowerPolled = false;
      world.lowers.set(1, "open");
      await reviewChanged(harness, recordReview(world, 0));
      const observe = async () => {
        harness.coordinator.handleObservations([world.pr()]);
        await harness.coordinator.idle();
      };
      world.clock += 10 * 60_000;
      const unchanged = await measureSqliteWrites(observe);
      expectSqliteWriteBudget({ scenario: "pr-review-stack-uncovered-still-blocked", writes: unchanged.writes,
        note: "An unchanged child recheck while its unpolled lower remains open writes nothing." });
      world.lowers.set(1, "merged");
      world.clock += 10 * 60_000;
      const offered = await measureSqliteWrites(observe);
      expect(openOfferCards(harness.todos)).toHaveLength(1);
      expectSqliteWriteBudget({ scenario: "pr-review-stack-uncovered-offer", writes: offered.writes,
        note: "One newly eligible child writes one offer commit on a recheck. At 100 offers/day and ~29 KB WAL each, ~2.9 MB/day." });
      const before = world.head;
      world.head = world.commit(world.changeOf.get(before)!);
      world.stackUnavailable = true;
      const retired = await measureSqliteWrites(async () => {
        await transition(harness, { headSha: { from: before, to: world.head } });
      });
      expect(openOfferCards(harness.todos)).toHaveLength(0);
      expectSqliteWriteBudget({ scenario: "pr-review-stack-stale-offer-unavailable", writes: retired.writes,
        note: "One commit withdraws an old-head offer during a failed verification. At 100 withdrawals/day and ~12 KB WAL each, ~1.2 MB/day." });
    } finally {
      harness.close();
      removeTempStateDbDir(temp.tempDir);
    }
  });

  it("stays within its write budget", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-pr-review-offers-");
    const db = StateDb.open(temp.dbPath);
    const harness = createHarness(db);
    try {
      harness.world.ci = "passing";
      // A PR sees about one CI completion per push; a busy day is ~20 pushes
      // across a handful of live PRs. An offer write measured ~29 KB of WAL
      // (the card row and its indexes), so 100 offers/day is ~2.9 MB/day.
      const reviewOffer = await measureSqliteWrites(async () => {
        await transition(harness, { checkState: { from: "pending", to: "passing" } });
      });
      expectSqliteWriteBudget({
        scenario: "pr-review-offer-raise",
        writes: reviewOffer.writes,
        note: "CI turns green on an unreviewed PR head: one commit raises the review offer card. Once per CI completion on a live thread's PR, never per poll; ~29 KB WAL each, ~2.9 MB/day at 100/day.",
      });
      const unchanged = await measureSqliteWrites(async () => {
        await transition(harness, { checkState: { from: "passing", to: "passing" } });
      });
      expectSqliteWriteBudget({
        scenario: "pr-review-offer-unchanged",
        writes: unchanged.writes,
        note: "A repeat transition whose offer is already open writes nothing: 0 MB/day.",
      });
      const swap = await measureSqliteWrites(async () => {
        await reviewChanged(harness, recordReview(harness.world, 0));
      });
      expectSqliteWriteBudget({
        scenario: "pr-review-offer-swap-to-merge",
        writes: swap.writes,
        note: "A clean review lands on a green head: one commit withdraws the review offer and raises the merge offer. Once per review; ~29 KB WAL each, ~2.9 MB/day at 100/day.",
      });
    } finally {
      harness.close();
      removeTempStateDbDir(temp.tempDir);
    }
  });

  it("records the fixed-through commit in one commit per settlement", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-pr-review-fixed-through-");
    const db = StateDb.open(temp.dbPath);
    try {
      const reviews = new ThreadReviewService(new SqliteThreadReviewStorage(db), () => {}, () => 5_000);
      const review = reviews.record(THREAD, {
        sourceKey: "managed-review:1",
        title: "Code review",
        context: { workspacePath: "/work/project", gitBranch: "feature", headCommit: "a".repeat(40) },
        items: [{ title: "Finding" }],
      });
      const fixed = await measureSqliteWrites(async () => {
        reviews.recordFixedThrough(review.id, "b".repeat(40), 5_000);
        reviews.recordFixedThrough(review.id, "c".repeat(40), 5_000);
      });
      expectSqliteWriteBudget({
        scenario: "pr-review-fixed-through",
        writes: fixed.writes,
        note: "A review's findings settle: one commit records the commit they were fixed through; repeating it writes nothing. Once per settlement; ~8 KB WAL each, ~0.8 MB/day at 100/day.",
      });
      expect(reviews.get(review.id)?.fixedThroughCommit).toBe("b".repeat(40));
    } finally {
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
  });
});

/*
 * Forge Automation's PR offers switch (docs/pr-review-readiness.md, Scope):
 * a project with offers off, or paused, never receives a new review or merge
 * offer card, and the PR's offers go to the thread the oracle elects instead.
 *
 * Model: two threads in two projects show the same PR. Each project's
 * Forge Automation is switched at random, each thread may be archived, and
 * the stored Auto-fix election names one of them. The oracle decides
 * eligibility from the raw fields, not from the shared helper. The real
 * coordinator and to-do service run with `selectPrReviewOfferOwner`, the
 * function the desktop service asks for every offer.
 */
const THREAD_B = { backend: "codex" as const, threadId: "thread-2" };

type ProjectsModel = {
  automation: Map<string, ProjectForgeAutomation>;
  archived: Set<string>;
  winner: PrReviewOfferThread;
};

const offerThreads = [THREAD, THREAD_B];

function oracleAllowsOffers(model: ProjectsModel, thread: PrReviewOfferThread): boolean {
  const automation = model.automation.get(thread.threadId)!;
  return !model.archived.has(thread.threadId) && !automation.paused && automation.prOffers;
}

function oracleOwner(model: ProjectsModel): PrReviewOfferThread | undefined {
  const eligible = offerThreads.filter((thread) => oracleAllowsOffers(model, thread));
  return eligible.find((thread) => thread.threadId === model.winner.threadId) ?? eligible[0];
}

const projectSwitch = fc.record({
  thread: fc.constantFrom(THREAD, THREAD_B),
  change: fc.constantFrom("offers-off", "offers-on", "pause", "resume", "archive", "unarchive"),
});

type ProjectsCommand =
  | { kind: "workflow"; command: Command }
  | { kind: "project"; thread: PrReviewOfferThread; change: string };

function applyProjectChange(model: ProjectsModel, thread: PrReviewOfferThread, change: string): void {
  const automation = model.automation.get(thread.threadId)!;
  switch (change) {
    case "offers-off": model.automation.set(thread.threadId, { ...automation, prOffers: false }); break;
    case "offers-on": model.automation.set(thread.threadId, { ...automation, prOffers: true }); break;
    case "pause": model.automation.set(thread.threadId, { ...automation, paused: true }); break;
    case "resume": model.automation.set(thread.threadId, { ...automation, paused: false }); break;
    case "archive": model.archived.add(thread.threadId); break;
    default: model.archived.delete(thread.threadId);
  }
}

function createProjectsHarness(model: ProjectsModel): Harness {
  return createHarness(openInMemoryStateDb(), async () => await selectPrReviewOfferOwner({
    candidates: offerThreads.map((thread): PrReviewOfferCandidate => ({
      ...thread,
      archived: model.archived.has(thread.threadId),
      automation: model.automation.get(thread.threadId),
    })),
    readWinner: async () => model.winner,
  }));
}

const startingAutomation = fc.record({
  paused: fc.boolean(),
  prOffers: fc.boolean(),
}).map(({ paused, prOffers }): ProjectForgeAutomation => ({
  ...DEFAULT_PROJECT_FORGE_AUTOMATION,
  paused,
  prOffers,
}));

describe("PR offers and project Forge Automation", () => {
  it("never raises an offer card in a project with offers off, and offers go to the elected eligible thread", async () => {
    await fc.assert(fc.asyncProperty(
      startingAutomation,
      startingAutomation,
      fc.constantFrom(THREAD, THREAD_B),
      fc.array(fc.oneof(
        { weight: 3, arbitrary: fc.oneof(...commands).map((command): ProjectsCommand => ({ kind: "workflow", command })) },
        { weight: 1, arbitrary: projectSwitch.map(({ thread, change }): ProjectsCommand => ({ kind: "project", thread, change })) },
      ), { minLength: 4, maxLength: 24 }),
      async (automationA, automationB, winner, sequence) => {
        const model: ProjectsModel = {
          automation: new Map([[THREAD.threadId, automationA], [THREAD_B.threadId, automationB]]),
          archived: new Set(),
          winner,
        };
        const harness = createProjectsHarness(model);
        try {
          for (const step of sequence) {
            if (step.kind === "project") {
              applyProjectChange(model, step.thread, step.change);
              continue;
            }
            const before = new Map(offerThreads.map((thread) => [
              thread.threadId,
              new Set(openOfferCards(harness.todos, thread).map((card) => card.id)),
            ]));
            await step.command.run(harness);
            const owner = oracleOwner(model);
            for (const thread of offerThreads) {
              const raised = openOfferCards(harness.todos, thread)
                .filter((card) => !before.get(thread.threadId)!.has(card.id));
              if (raised.length === 0) continue;
              expect(oracleAllowsOffers(model, thread)).toBe(true);
              expect(owner?.threadId).toBe(thread.threadId);
            }
          }
        } finally {
          harness.close();
        }
      },
    ), { numRuns: 8 });
  });

  it("offers a passing PR to the thread whose project allows it, and to neither when both are off", async () => {
    const model: ProjectsModel = {
      automation: new Map([
        [THREAD.threadId, { ...DEFAULT_PROJECT_FORGE_AUTOMATION, prOffers: false }],
        [THREAD_B.threadId, { ...DEFAULT_PROJECT_FORGE_AUTOMATION }],
      ]),
      archived: new Set(),
      winner: THREAD,
    };
    const harness = createProjectsHarness(model);
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos, THREAD)).toEqual([]);
      expect(openOfferCards(harness.todos, THREAD_B).map((card) => card.action?.type)).toEqual(["start_review"]);

      applyProjectChange(model, THREAD_B, "offers-off");
      await push(harness, harness.world.newChange());
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos, THREAD)).toEqual([]);
      // The card raised before the switch stays; no new one joins it.
      expect(openOfferCards(harness.todos, THREAD_B)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });
});

/**
 * A contribution fork's project never merges its pull requests (Forge
 * Automation `neverMerge`). The rule: while it is on, PwrAgent raises no
 * merge offer, and every evaluation withdraws an open one; review offers
 * keep their normal rules.
 */
describe("PR offers in a never-merge project", () => {
  type Step = { kind: "workflow"; command: Command } | { kind: "toggle"; on: boolean };

  it("raises no merge card while the project never merges, withdraws an open one, and keeps review offers", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(),
      fc.array(fc.oneof(
        { weight: 4, arbitrary: fc.oneof(...commands).map((command): Step => ({ kind: "workflow", command })) },
        { weight: 1, arbitrary: fc.boolean().map((on): Step => ({ kind: "toggle", on })) },
      ), { minLength: 4, maxLength: 30 }),
      async (startOn, sequence) => {
        let never = startOn;
        const harness = createHarness(openInMemoryStateDb(), async () => THREAD, () => never);
        try {
          for (const step of sequence) {
            if (step.kind === "toggle") {
              never = step.on;
              continue;
            }
            const before = new Set(openOfferCards(harness.todos).map((card) => card.id));
            const evaluations = harness.world.evaluatedOwners.length;
            await step.command.run(harness);
            if (!never) continue;
            const cards = openOfferCards(harness.todos);
            // Never raised while on.
            for (const card of cards.filter((candidate) => !before.has(candidate.id))) {
              expect(card.action?.type).toBe("start_review");
            }
            // Any evaluation while on leaves no merge card behind.
            if (harness.world.evaluatedOwners.length > evaluations) {
              expect(cards.filter((card) => card.action?.type === "merge_pull_request")).toEqual([]);
            }
          }
        } finally {
          harness.close();
        }
      },
    ), { numRuns: 8 });
  });

  it("withdraws a merge card raised before the switch, refuses an agent's merge card, and still offers reviews", async () => {
    let never = false;
    const harness = createHarness(openInMemoryStateDb(), async () => THREAD, () => never);
    try {
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["start_review"]);
      await reviewChanged(harness, recordReview(harness.world, 0));
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);

      never = true;
      expect(await harness.coordinator.mergeOfferRefusal(THREAD, PR_KEY)).toContain("never merges");
      // Saving the setting re-evaluates at once; the PR sees no transition.
      harness.coordinator.reevaluate([PR_KEY]);
      await harness.coordinator.idle();
      expect(openOfferCards(harness.todos)).toEqual([]);
      const withdrawn = harness.todos.list({ ...THREAD, status: "all" })
        .find((todo) => todo.action?.type === "merge_pull_request");
      expect(withdrawn?.result).toBe("Withdrawn: this project never merges its pull requests");

      // Turning it off offers the merge again for the same reviewed head.
      never = false;
      harness.coordinator.reevaluate([PR_KEY]);
      await harness.coordinator.idle();
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["merge_pull_request"]);

      never = true;
      await push(harness, harness.world.newChange());
      harness.world.ci = "passing";
      await transition(harness, { checkState: { from: "pending", to: "passing" } });
      expect(openOfferCards(harness.todos).map((card) => card.action?.type)).toEqual(["start_review"]);
    } finally {
      harness.close();
    }
  });
});
