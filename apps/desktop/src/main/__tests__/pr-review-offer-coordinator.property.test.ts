import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import type { PrChangeIdentitySource } from "../pr-status/pr-change-identity";
import { PrReviewOfferCoordinator } from "../pr-status/pr-review-offer-coordinator";
import type { PrStatusTransitionChanges } from "../pr-status/pr-transitions";
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
const PR_KEY = "github.com:example/project#7";
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
      baseRefName: "main",
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
  close: () => void;
};

function createHarness(db: StateDb = openInMemoryStateDb()): Harness {
  const world = new World();
  let ids = 0;
  const todos = new ThreadTodoService({
    store: new ThreadTodoStore(db),
    now: () => world.clock,
    newId: () => `todo-${++ids}`,
  });
  const coordinator = new PrReviewOfferCoordinator({
    ownerThread: async () => THREAD,
    threadPrKeys: () => [PR_KEY],
    getPr: () => world.pr(),
    directories: () => ["/work/project"],
    listReviews: () => world.reviews.map((entry) => entry.review),
    recordFixedThrough: (reviewId, commit, settledAt) => {
      const entry = world.reviews.find((candidate) => candidate.review.id === reviewId);
      if (entry) entry.review = { ...entry.review, fixedThroughCommit: commit, fixedThroughAt: settledAt };
    },
    cards: todos,
    identity: identity(world),
  });
  return { world, todos, coordinator, close: () => db.close() };
}

function openOfferCards(todos: ThreadTodoService): ThreadTodo[] {
  return todos.list({ ...THREAD, status: "open" })
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
    }), { numRuns: 30 });
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
      expect(card?.action).toEqual({ type: "start_review" });
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
