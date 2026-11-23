import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import type { ThreadTodo, ThreadTodoAction } from "@pwragent/shared/contracts/thread-todos";
import type { PrChangeIdentitySource } from "./pr-change-identity";
import {
  deriveReviewStanding,
  describePrReviewReadiness,
  type ReviewStanding,
  PR_OFFER_WITHDRAWN_RESULTS,
  desiredPrOffer,
  parsePrOfferId,
  planPrOffer,
  prGateReadiness,
  prOfferCardKey,
  PR_OFFER_RETIRE_RESULTS,
  type OpenPrOffer,
  type PrOffer,
  type PrReviewCoverage,
  type PrReviewReadiness,
} from "./pr-review-readiness";
import type { PrStatusTransition } from "./pr-transitions";

export type PrReviewOfferThread = { backend: AppServerBackendKind; threadId: string };

/** The to-do service surface the coordinator writes through. */
export type PrOfferCardPort = {
  findOpenByKey(params: PrReviewOfferThread & { key: string }): ThreadTodo | undefined;
  reconcileOffer(params: PrReviewOfferThread & {
    retire?: { id: string; result: string };
    raise?: {
      offerId: string;
      key: string;
      title: string;
      detail?: string;
      action: Extract<ThreadTodoAction, { type: "start_review" | "merge_pull_request" }>;
      cwd?: string;
      /** Results this coordinator gives a card it withdraws; such a card can reopen. */
      withdrawnResults?: readonly string[];
    };
  }): { retired?: ThreadTodo; raised?: ThreadTodo };
};

export type PrReviewOfferPorts = {
  /**
   * The live thread that owns this PR's automation, when one does: the PR is
   * its primary attached PR, the thread is not archived, and its project's
   * forge activity is not paused. One thread per PR, so a PR shown by a
   * parent and its sub-thread is offered once.
   */
  ownerThread(prKey: string): Promise<PrReviewOfferThread | undefined>;
  /** The primary attached PR keys of one thread, for review events. */
  threadPrKeys(thread: PrReviewOfferThread): string[];
  /** The status registry's current PR. No forge request is made. */
  getPr(prKey: string): PrSummary | undefined;
  stackMergeEvidence?(thread: PrReviewOfferThread, pr: PrSummary): Promise<{ blocked: boolean; lowerKeys: string[]; retryOnObservation?: boolean }>;
  isLowerPolled?(prKey: string): boolean;
  now?: () => number;
  /** Checkouts where Git can read this PR's commits; the first one is used. */
  directories(thread: PrReviewOfferThread, pr: PrSummary): string[];
  /**
   * Every review, any status, recorded by a thread that shows this PR: the
   * owner, and any sibling or sub-thread on the same PR. A review counts
   * wherever it ran.
   */
  listReviews(thread: PrReviewOfferThread, pr: PrSummary): ThreadReview[];
  recordFixedThrough(reviewId: string, commit: string, settledAt: number): void;
  cards: PrOfferCardPort;
  identity: PrChangeIdentitySource;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/** A review count past this is history; the newest decide. */
const MAX_REVIEWS_CONSIDERED = 8;
const MAX_TRACKED_CHILDREN = 128;
const MAX_TRACKED_LOWERS = 32;
const UNCOVERED_STACK_RECHECK_MS = 5 * 60_000;

/** The fields that can move a PR's readiness. Title and others cannot. */
const READINESS_FIELDS = [
  "baseRefName",
  "checkState",
  "headSha",
  "lifecycleState",
  "mergeState",
  "mergeQueueState",
  "reviewState",
] as const;

/** Where one PR stands for one thread. */
export type PrReviewAssessment = {
  readiness: PrReviewReadiness;
  headSha?: string;
  /** A review covers the head, whatever CI says. */
  headCovered: boolean;
  /** Where the reviews leave the head, when they were read. */
  standing?: ReviewStanding;
  /**
   * The newest review covering the head, or the latest review with open
   * findings when none covers it. Absent while CI holds readiness back.
   */
  reviewId?: string;
  openFindings?: number;
  headContentId?: string;
};

export type PrReviewOfferEvaluation = {
  readiness: PrReviewReadiness;
  reviewId?: string;
  raised?: PrOffer["kind"];
  retired?: boolean;
  /** Git processes this evaluation started; zero unless CI was green. */
  gitProcesses: number;
};

/**
 * Raises "review this PR" and "merge this PR" offers as to-do cards, in that
 * order, from events PwrAgent already receives: a PR status transition from
 * polling or a refresh, and a change to one of the thread's reviews. Only a
 * green, reviewed head asks for stack evidence. Git runs only
 * when CI is green, in the thread's own checkout, and caches by commit.
 */
export class PrReviewOfferCoordinator {
  private readonly inFlight = new Map<string, { again: boolean; recoveryOnly: boolean; done: Promise<void> }>();
  private readonly pending = new Set<Promise<void>>();
  private readonly lowerKeysByChild = new Map<string, string[]>();
  private readonly childKeysByLower = new Map<string, Set<string>>();
  private readonly lowerChanges = new Map<string, number>();
  private lowerChangeSequence = 0;
  private readonly evaluated = new Map<string, { checkedAt: number; blocked: boolean }>();
  private observationReconciliationPending = false;
  private lastObservedCandidate: string | undefined;
  private closed = false;

  constructor(private readonly ports: PrReviewOfferPorts) {}

  /** A PR field moved. Only fields that can change readiness count. */
  handleTransition(transition: PrStatusTransition): void {
    if (this.closed) return;
    if (!READINESS_FIELDS.some((field) => transition.changed[field] !== undefined)) return;
    const keys = new Set([transition.prKey]);
    const lifecycle = transition.changed.lifecycleState;
    if (lifecycle && lifecycle.from !== lifecycle.to) {
      this.lowerChanges.delete(transition.prKey);
      this.lowerChanges.set(transition.prKey, ++this.lowerChangeSequence);
      if (this.lowerChanges.size > MAX_TRACKED_CHILDREN) {
        this.lowerChanges.delete(this.lowerChanges.keys().next().value!);
      }
      for (const child of this.childKeysByLower.get(transition.prKey) ?? []) {
        const pr = this.ports.getPr(child);
        if (pr && !prGateReadiness(pr)) keys.add(child);
      }
    }
    this.track(this.reconcile(keys));
  }

  /** Recover the index on fresh child observations, one per existing poll
   * result. No startup query, dedicated timer, or repository-wide fan-out. */
  handleObservations(prs: readonly PrSummary[]): void {
    if (this.closed || this.observationReconciliationPending) return;
    const keys = prs.filter((pr) => !prGateReadiness(pr)).map(buildPullRequestStatusKey);
    const offset = keys.indexOf(this.lastObservedCandidate ?? "") + 1;
    const now = this.ports.now?.() ?? Date.now();
    const candidate = [...keys.slice(offset), ...keys.slice(0, offset)].find((key) => {
      const previous = this.evaluated.get(key);
      if (!previous) return true;
      if (!previous.blocked || now - previous.checkedAt < UNCOVERED_STACK_RECHECK_MS) return false;
      const lowers = this.lowerKeysByChild.get(key);
      return !lowers?.length || lowers.some((lower) => !this.ports.isLowerPolled?.(lower));
    });
    if (!candidate) return;
    this.lastObservedCandidate = candidate;
    this.observationReconciliationPending = true;
    this.track(this.reconcile([candidate], true).finally(() => {
      this.observationReconciliationPending = false;
    }));
  }

  private async reconcile(keys: Iterable<string>, recoveryOnly = false): Promise<void> {
    for (const key of keys) {
      if (this.closed) return;
      const thread = await this.ports.ownerThread(key);
      if (thread) await this.schedule(thread, key, recoveryOnly);
      else this.trackLowers(key, []);
    }
  }

  private trackLowers(child: string, lowerKeys: readonly string[]): void {
    const forget = (key: string) => {
      for (const lower of this.lowerKeysByChild.get(key) ?? []) {
        const children = this.childKeysByLower.get(lower)!;
        children.delete(key);
        if (!children.size) this.childKeysByLower.delete(lower);
      }
      this.lowerKeysByChild.delete(key);
    };
    forget(child);
    const lowers = [...new Set(lowerKeys)].filter((key) => key !== child).slice(0, MAX_TRACKED_LOWERS);
    if (!lowers.length) return;
    if (this.lowerKeysByChild.size >= MAX_TRACKED_CHILDREN) forget(this.lowerKeysByChild.keys().next().value!);
    this.lowerKeysByChild.set(child, lowers);
    for (const lower of lowers) {
      const children = this.childKeysByLower.get(lower) ?? new Set<string>();
      children.add(child);
      this.childKeysByLower.set(lower, children);
    }
  }

  /** A review on a thread was recorded, settled, or reopened. */
  handleReviewChanged(review: ThreadReview): void {
    if (this.closed) return;
    const thread = { backend: review.backend, threadId: review.threadId };
    const prKeys = this.ports.threadPrKeys(thread).filter((prKey) => {
      const pr = this.ports.getPr(prKey);
      return pr !== undefined && reviewMatchesPr(review, pr);
    });
    if (prKeys.length === 0) return;
    this.track((async () => {
      // The PR's owner may be another thread on the same PR, such as the
      // parent of the sub-thread the review ran in.
      const owners: Array<{ owner: PrReviewOfferThread; prKey: string }> = [];
      for (const prKey of prKeys) {
        const owner = await this.ports.ownerThread(prKey);
        if (owner) owners.push({ owner, prKey });
      }
      if (owners.length === 0) return;
      await this.captureFixedThrough(review);
      for (const { owner, prKey } of owners) this.schedule(owner, prKey);
    })());
  }

  /** Settles when every event and scheduled evaluation has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0 || this.inFlight.size > 0) {
      await Promise.all([
        ...this.pending,
        ...[...this.inFlight.values()].map((entry) => entry.done),
      ]);
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.ports.log?.("pr review offer event failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
  }

  close(): void {
    this.closed = true;
  }

  /**
   * One evaluation per thread and PR at a time. Events that arrive while one
   * runs fold into a single rerun, so a burst of transitions costs at most
   * two evaluations.
   */
  private schedule(thread: PrReviewOfferThread, prKey: string, recoveryOnly = false): Promise<void> | undefined {
    if (this.closed) return;
    const key = JSON.stringify([thread.backend, thread.threadId, prKey]);
    const running = this.inFlight.get(key);
    if (running) {
      if (!recoveryOnly) {
        running.recoveryOnly = false;
        running.again = true;
      }
      return running.done;
    }
    const entry = { again: false, recoveryOnly, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          try {
            await this.evaluate(thread, prKey, entry.recoveryOnly);
          } catch (error) {
            this.ports.log?.("pr review offer evaluation failed", {
              prKey,
              threadId: thread.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } while (entry.again && !this.closed);
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, entry);
    return entry.done;
  }

  async evaluate(thread: PrReviewOfferThread, prKey: string, recoveryOnly = false): Promise<PrReviewOfferEvaluation | undefined> {
    const pr = this.ports.getPr(prKey);
    if (!pr) return undefined;
    const gitBefore = this.ports.identity.gitProcessCount;
    const cardKey = prOfferCardKey(prKey);
    const card = this.ports.cards.findOpenByKey({ ...thread, key: cardKey });
    const parsed = parsePrOfferId(card?.dependencyId);
    const open: OpenPrOffer | undefined = card && parsed?.prKey === prKey
      ? {
          cardId: card.id,
          kind: parsed.kind,
          offerId: card.dependencyId!,
          ...(parsed.headSha ? { headSha: parsed.headSha } : {}),
        }
      : undefined;

    // Git runs only when CI is green, or to withdraw an open offer: a review
    // offer that a review started some other way has answered, or a merge
    // offer for this head that a newer review has findings against.
    const withdrawable = open?.kind === "review"
      || (open?.kind === "merge" && open.headSha === pr.headSha);
    const lowerSequence = this.lowerChangeSequence;
    const assessment = await this.assessPr(thread, pr, withdrawable, !recoveryOnly);
    const latest = this.ports.getPr(prKey);
    if (this.closed || !latest || latest.headSha !== pr.headSha || latest.baseRefName !== pr.baseRefName
      || prGateReadiness(latest) !== prGateReadiness(pr)) return undefined;
    if (!assessment.retryOnObservation) {
      this.evaluated.delete(prKey);
      this.evaluated.set(prKey, { checkedAt: this.ports.now?.() ?? Date.now(), blocked: assessment.readiness === "stack_parent_open" });
      if (this.evaluated.size > MAX_TRACKED_CHILDREN) this.evaluated.delete(this.evaluated.keys().next().value!);
    } else {
      this.evaluated.delete(prKey);
    }
    if (assessment.lowerKeys) {
      const lowers = assessment.retryOnObservation
        ? [...(this.lowerKeysByChild.get(prKey) ?? []), ...assessment.lowerKeys] : assessment.lowerKeys;
      this.trackLowers(prKey, lowers);
      if (assessment.lowerKeys.some((key) => (this.lowerChanges.get(key) ?? 0) > lowerSequence)) {
        this.schedule(thread, prKey);
        return undefined;
      }
    } else if (assessment.readiness === "closed") {
      this.trackLowers(prKey, []);
    }
    if (recoveryOnly && assessment.standing !== "ready_to_merge") return undefined;
    // A transient transport failure defers a new offer. A previously
    // verified card stays put; executing it always rechecks live evidence.
    if (assessment.retryOnObservation && open?.kind === "merge" && open.headSha === pr.headSha) return undefined;
    const { readiness, reviewId, headContentId, headCovered, standing } = assessment;
    const desired = desiredPrOffer({
      prKey,
      readiness,
      ...(pr.headSha ? { headSha: pr.headSha } : {}),
      ...(headContentId ? { headContentId } : {}),
    });
    const plan = planPrOffer({
      open,
      desired,
      readiness,
      headCovered,
      ...(standing ? { standing } : {}),
      ...(pr.headSha ? { headSha: pr.headSha } : {}),
    });
    let raised: PrOffer["kind"] | undefined;
    let retired = false;
    if (plan.raise || plan.retire) {
      const directory = this.ports.directories(thread, pr)[0];
      const result = this.ports.cards.reconcileOffer({
        ...thread,
        ...(plan.retire
          ? { retire: { id: plan.retire.cardId, result: PR_OFFER_RETIRE_RESULTS[plan.retire.reason] } }
          : {}),
        ...(plan.raise ? { raise: offerCard(plan.raise, pr, cardKey, directory) } : {}),
      });
      raised = result.raised ? plan.raise?.kind : undefined;
      retired = Boolean(result.retired);
    }
    const evaluation: PrReviewOfferEvaluation = {
      readiness,
      ...(reviewId ? { reviewId } : {}),
      ...(raised ? { raised } : {}),
      ...(retired ? { retired } : {}),
      gitProcesses: this.ports.identity.gitProcessCount - gitBefore,
    };
    this.ports.log?.("pr review offer evaluated", {
      prKey,
      threadId: thread.threadId,
      ...evaluation,
    });
    return evaluation;
  }

  /**
   * Where a PR stands for this thread, without touching cards. With
   * `coverage`, reviews are read even while CI is not green (never for a
   * closed PR or one without a head), which can start Git processes.
   */
  async assess(
    thread: PrReviewOfferThread,
    prKey: string,
    options: { coverage?: boolean } = {},
  ): Promise<PrReviewAssessment | undefined> {
    const pr = this.ports.getPr(prKey);
    return pr ? await this.assessPr(thread, pr, options.coverage === true, false) : undefined;
  }

  /**
   * Why this thread may not raise its own merge card for the PR, or nothing
   * when it may: a review must cover the head and have no open findings,
   * whatever CI says. Unknown and closed PRs are not refused.
   */
  async mergeOfferRefusal(thread: PrReviewOfferThread, prKey: string): Promise<string | undefined> {
    const pr = this.ports.getPr(prKey);
    if (!pr) return undefined;
    const assessment = await this.assessPr(thread, pr, true, false);
    if (assessment.readiness === "stack_parent_open") return `#${pr.number} is waiting for its lower stack layers to merge and its base to be trunk.`;
    if (!assessment.headSha || assessment.readiness === "closed") return undefined;
    if (assessment.headCovered && (assessment.openFindings ?? 0) === 0) {
      if (prGateReadiness(pr) && (await this.ports.stackMergeEvidence?.(thread, pr))?.blocked) {
        return `#${pr.number} is waiting for its lower stack layers to merge and its base to be trunk.`;
      }
      return undefined;
    }
    return `${describePrReviewReadiness({
      prNumber: pr.number,
      readiness: assessment.readiness,
      headSha: assessment.headSha,
      reviewed: assessment.headCovered,
      ...(assessment.openFindings !== undefined ? { openFindings: assessment.openFindings } : {}),
    })} This card was not raised. If the operator asks to merge now, use the merge_pull_request tool, which asks for their approval.`;
  }

  /**
   * `forOffer` also reads the head's change identity when no review covers
   * it, because a review offer is keyed by change. A read-only assessment
   * skips that Git work.
   */
  private async assessPr(
    thread: PrReviewOfferThread,
    pr: PrSummary,
    coverageWhileWaiting: boolean,
    forOffer: boolean,
  ): Promise<PrReviewAssessment & { lowerKeys?: string[]; retryOnObservation?: boolean }> {
    const gate = prGateReadiness(pr);
    const head = pr.headSha;
    if (gate && (!coverageWhileWaiting || !head || gate === "closed" || gate === "no_head")) {
      return { readiness: gate, ...(head ? { headSha: head } : {}), headCovered: false };
    }
    const coverage = await this.reviewCoverage(thread, pr, forOffer && !gate);
    // The review side holds while CI runs, so the merge-card gate still sees
    // open findings then.
    const standing = deriveReviewStanding(coverage.reviews);
    const stack = !gate && standing.readiness === "ready_to_merge"
      ? await this.ports.stackMergeEvidence?.(thread, pr) : undefined;
    return {
      readiness: stack?.blocked ? "stack_parent_open" : gate ?? standing.readiness,
      ...(stack ? { lowerKeys: stack.lowerKeys } : {}),
      ...(stack?.retryOnObservation ? { retryOnObservation: true } : {}),
      standing: standing.readiness,
      headSha: head!,
      headCovered: coverage.reviews.some((review) => review.coversHead),
      ...(standing.reviewId ? { reviewId: standing.reviewId } : {}),
      ...(standing.openFindings !== undefined ? { openFindings: standing.openFindings } : {}),
      ...(coverage.headContentId ? { headContentId: coverage.headContentId } : {}),
    };
  }

  /**
   * Which of this PR's reviews cover its head. An exact commit match needs no
   * Git. Otherwise the head's change identity is compared with each review's
   * reviewed working tree, reviewed commit, and fixed-through commit.
   */
  private async reviewCoverage(
    thread: PrReviewOfferThread,
    pr: PrSummary,
    keyUncoveredHead: boolean,
  ): Promise<{ reviews: PrReviewCoverage[]; headContentId?: string }> {
    const head = pr.headSha!.toLowerCase();
    const reviews = this.ports.listReviews(thread, pr)
      .filter((review) => reviewMatchesPr(review, pr) && review.context?.headCommit)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_REVIEWS_CONSIDERED);
    const cwd = this.ports.directories(thread, pr)[0];
    const identity = this.ports.identity;
    let targetTip: string | undefined | null = null;
    const tip = async (): Promise<string | undefined> => {
      if (targetTip === null) {
        targetTip = cwd
          ? await identity.resolveTargetTip({
              cwd,
              ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
              ...(pr.baseRefName ? { baseRefName: pr.baseRefName } : {}),
            })
          : undefined;
      }
      return targetTip;
    };
    const changeOf = async (sha: string, tree?: string): Promise<string | undefined> => {
      const target = await tip();
      if (!cwd || !target) return undefined;
      return await identity.changeIdentity({
        cwd,
        sha,
        ...(tree ? { tree } : {}),
        targetTip: target,
      });
    };
    let headContentId: string | undefined;
    let headContentRead = false;
    const headChange = async (): Promise<string | undefined> => {
      if (!headContentRead) {
        headContentRead = true;
        headContentId = await changeOf(head);
      }
      return headContentId;
    };
    const coverage: PrReviewCoverage[] = [];
    for (const review of reviews) {
      const reviewed = review.context!.headCommit!;
      const covered = [reviewed, review.fixedThroughCommit]
        .filter((sha): sha is string => Boolean(sha))
        .map((sha) => sha.toLowerCase());
      // A review of uncommitted changes also covers the working tree it read.
      const subjects: Array<{ sha: string; tree?: string }> = [
        ...(review.context?.reviewedTree ? [{ sha: reviewed, tree: review.context.reviewedTree }] : []),
        ...covered.map((sha) => ({ sha })),
      ];
      let coversHead = covered.includes(head);
      if (!coversHead) {
        const current = await headChange();
        if (current) {
          for (const subject of subjects) {
            if (await changeOf(subject.sha, subject.tree) === current) {
              coversHead = true;
              break;
            }
          }
        }
      }
      coverage.push({
        reviewId: review.id,
        createdAt: review.createdAt,
        coversHead,
        openFindings: openFindingCount(review),
      });
      // Newest first: the first covering review decides, and the latest
      // review is already in. Older reviews cannot change readiness.
      if (coversHead) break;
    }
    // A review offer is keyed by change, so a rebase does not ask again.
    const anyCovers = coverage.some((entry) => entry.coversHead);
    if (!anyCovers && keyUncoveredHead) await headChange();
    return { reviews: coverage, ...(headContentId ? { headContentId } : {}) };
  }

  /**
   * When a review's findings are settled, the reviewed checkout's HEAD is the
   * commit they were fixed through: commits made while findings were open
   * are review fixes. At most two Git processes and one commit, once per
   * settlement.
   */
  private async captureFixedThrough(review: ThreadReview): Promise<void> {
    const reviewed = review.context?.headCommit;
    const workspace = review.context?.workspacePath;
    // Only a settlement counts: an edit to an already settled finding keeps
    // the same resolution time, so it never reads a newer HEAD.
    const settledAt = review.resolution?.at;
    if (review.status === "open" || !reviewed || !workspace || settledAt === undefined) return;
    if (review.fixedThroughAt !== undefined && review.fixedThroughAt >= settledAt) return;
    const head = await this.ports.identity.readReviewedBranchHead(workspace, {
      sha: reviewed,
      ...(review.context?.gitBranch ? { branch: review.context.gitBranch } : {}),
    });
    if (!head) return;
    this.ports.recordFixedThrough(review.id, head, settledAt);
  }
}

/** Findings still waiting. An open review with no structured findings counts as one. */
export function openFindingCount(review: Pick<ThreadReview, "status" | "items">): number {
  if (review.status !== "open") return 0;
  const open = review.items.filter((item) => item.status === "open").length;
  return Math.max(open, 1);
}

/**
 * A review is of this PR when it names the PR, or when it ran on the PR's
 * branch before any PR existed for it.
 */
export function reviewMatchesPr(review: Pick<ThreadReview, "context">, pr: PrSummary): boolean {
  const context = review.context;
  if (!context) return false;
  const named = context.pullRequests?.length
    ? context.pullRequests
    : context.pullRequest ? [context.pullRequest] : [];
  if (named.length > 0) {
    return named.some((candidate) =>
      candidate.provider === pr.provider
      && candidate.org.toLowerCase() === pr.org.toLowerCase()
      && candidate.repo.toLowerCase() === pr.repo.toLowerCase()
      && candidate.number === pr.number
    );
  }
  return Boolean(pr.headRefName && context.gitBranch === pr.headRefName);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function offerCard(
  offer: PrOffer,
  pr: PrSummary,
  key: string,
  cwd: string | undefined,
): NonNullable<Parameters<PrOfferCardPort["reconcileOffer"]>[0]["raise"]> {
  const name = `#${pr.number}`;
  const title = pr.title ? `${name} ${pr.title}` : name;
  return offer.kind === "review"
    ? {
        offerId: offer.offerId,
        key,
        withdrawnResults: PR_OFFER_WITHDRAWN_RESULTS,
        title: `Review ${title}`.slice(0, 120),
        detail: `CI is green at ${shortSha(offer.headSha)}, and no review covers this change yet.`,
        action: { type: "start_review" },
        ...(cwd ? { cwd } : {}),
      }
    : {
        offerId: offer.offerId,
        key,
        withdrawnResults: PR_OFFER_WITHDRAWN_RESULTS,
        title: `Merge ${title}`.slice(0, 120),
        detail: `Reviewed, every finding settled, and CI green at ${shortSha(offer.headSha)}.`,
        action: { type: "merge_pull_request", pullRequest: pr.url },
        ...(cwd ? { cwd } : {}),
      };
}
