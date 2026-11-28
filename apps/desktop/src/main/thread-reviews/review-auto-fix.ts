import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { ReviewAfterAction } from "@pwragent/shared/contracts/agent";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ReviewAutoFixRun,
  ReviewAutoFixStatus,
  ThreadReview,
} from "@pwragent/shared/contracts/thread-reviews";
import { threadReviewDisplayTitle } from "@pwragent/shared/contracts/thread-reviews";
import { autoFixReviewFindingsPrompt, orderReviewItems } from "../../shared/review-fix-prompts";

export type ReviewAutoFixThread = { backend: AppServerBackendKind; threadId: string };

/** One review start on a thread, armed or not. */
type Start = { autoFix: boolean; turnId?: string; landed?: boolean };

/** One review start: accepted with the backend's turn id, or refused. */
export type ReviewAutoFixStart = {
  accepted(turnId: string): void;
  refused(): void;
};

function threadKey(thread: ReviewAutoFixThread): string {
  return `${thread.backend}\0${thread.threadId}`;
}

/**
 * Which running reviews send their findings to the thread's agent when they
 * land. A review runs as a turn of its own thread, and its artifact lands on
 * that thread, in that turn, whether the reviewer ran inline or in a
 * sub-agent. So a landed review is matched to its start by turn id.
 *
 * Every start is recorded, armed or not, so a review that will not fix is
 * known as such. Only a review that lands before its start returns, while
 * the start has no turn id yet, is matched to the thread's oldest pending
 * start instead.
 *
 * Held in memory only. A review is a turn of this owner's app server, and an
 * app restart ends it, so a start has nothing to outlive.
 */
export class ReviewAutoFixArming {
  private readonly starts = new Map<string, Start[]>();
  /** Turns that ended while a start on the same thread had no turn id yet. */
  private readonly endedWhilePending = new Map<string, Set<string>>();

  /** Called when a thread's armed reviews change, so viewers can refresh. */
  constructor(private readonly onArmedChange: (thread: ReviewAutoFixThread) => void = () => {}) {}

  /**
   * Running reviews on the thread that will auto-fix when they land. A start
   * the backend has not accepted yet has no turn to name, so it is left out.
   */
  armedTurnIds(thread: ReviewAutoFixThread): string[] {
    return (this.starts.get(threadKey(thread)) ?? [])
      .filter((start) => start.autoFix && !start.landed && start.turnId !== undefined)
      .map((start) => start.turnId!);
  }

  /** Turns Auto-fix off for one running review. False when it is not armed. */
  disarm(thread: ReviewAutoFixThread, turnId: string): boolean {
    const start = (this.starts.get(threadKey(thread)) ?? [])
      .find((entry) => entry.turnId === turnId && entry.autoFix && !entry.landed);
    if (!start) return false;
    start.autoFix = false;
    this.onArmedChange(thread);
    return true;
  }

  /** Runs a change and reports it when the thread's armed reviews moved. */
  private tracking<T>(thread: ReviewAutoFixThread, change: () => T): T {
    const before = this.armedTurnIds(thread).join("\0");
    const result = change();
    if (this.armedTurnIds(thread).join("\0") !== before) this.onArmedChange(thread);
    return result;
  }

  /**
   * A review is starting. Recorded before the backend is asked, so a review
   * that lands at once still fixes. A refused start removes only itself: the
   * refusal usually means another review is running, and that review's start
   * must stay. An accepted start ends every earlier accepted start on the
   * thread, because a thread runs one review at a time.
   */
  starting(thread: ReviewAutoFixThread, afterReview: ReviewAfterAction | undefined): ReviewAutoFixStart {
    const key = threadKey(thread);
    const start: Start = { autoFix: afterReview === "auto-fix" };
    this.replace(key, [...(this.starts.get(key) ?? []), start]);
    return {
      accepted: (turnId) => this.tracking(thread, () => {
        const current = this.starts.get(key) ?? [];
        const ended = this.endedWhilePending.get(key);
        if (ended?.delete(turnId)) {
          // The turn already ended before the start response arrived; drop it
          // instead of arming a dead turn.
          const remaining = current.filter((entry) => entry !== start);
          this.replace(key, remaining);
          return;
        }
        // This review is now the thread's one running review, so earlier
        // accepted starts are over. Starts still in flight stay: each is
        // accepted or refused on its own.
        const inFlight = current
          .filter((entry) => entry !== start && entry.turnId === undefined);
        start.turnId = turnId;
        this.replace(key, [...inFlight, start]);
      }),
      refused: () => this.tracking(thread, () => {
        this.replace(key, (this.starts.get(key) ?? []).filter((entry) => entry !== start));
      }),
    };
  }

  /**
   * A review artifact landed on the thread in `turnId`. True once, for a
   * review started with auto-fix. A landed start stays recorded until its
   * turn ends, so its turn id never falls through to another start.
   */
  takeOnCompletion(
    thread: ReviewAutoFixThread,
    turnId: string | undefined,
    relatedTurnId?: string,
  ): boolean {
    return this.tracking(thread, () => {
      const key = threadKey(thread);
      const ended = this.endedWhilePending.get(key);
      if ((turnId !== undefined && ended?.has(turnId))
        || (relatedTurnId !== undefined && ended?.has(relatedTurnId))) {
        return false;
      }
      const starts = this.starts.get(key) ?? [];
      const start = (turnId === undefined ? undefined : starts.find((entry) => entry.turnId === turnId))
        ?? (relatedTurnId === undefined ? undefined : starts.find((entry) => entry.turnId === relatedTurnId))
        ?? starts.find((entry) => entry.turnId === undefined && !entry.landed);
      if (!start || start.landed) return false;
      start.landed = true;
      return start.autoFix;
    });
  }

  /**
   * A turn ended on the thread. A review's start is no longer needed once
   * its turn ends: it landed, failed, or was interrupted. Matching by turn id
   * already keeps an ended review from fixing, so this only frees it.
   */
  turnEnded(thread: ReviewAutoFixThread, turnId: string): void {
    const key = threadKey(thread);
    this.tracking(thread, () => {
      const remaining = (this.starts.get(key) ?? []).filter((start) => start.turnId !== turnId);
      if (remaining.some((start) => start.turnId === undefined)) {
        const ended = this.endedWhilePending.get(key) ?? new Set<string>();
        ended.add(turnId);
        this.endedWhilePending.set(key, ended);
      }
      this.replace(key, remaining);
    });
  }

  private replace(key: string, starts: Start[]): void {
    if (starts.length > 0) this.starts.set(key, starts);
    else this.starts.delete(key);
    if (!starts.some((start) => start.turnId === undefined)) {
      this.endedWhilePending.delete(key);
    }
  }
}

/** What moved a landed review's Auto-fix run. */
export type ReviewAutoFixRunEvent =
  /** The send was refused before it reached the thread's queue. */
  | { kind: "sendFailed"; reason: string; at: number }
  /** The Auto-fix turn's queue entry moved, as `thread/turnQueue/updated` says. */
  | { kind: "queue"; status: string; errorMessage?: string; at: number }
  /** An agent or the operator settled a finding or resolved the review. */
  | { kind: "reviewUpdated"; at: number }
  /**
   * The owner checked the send's stack gate: `reason` while it holds the
   * send, none once admission may proceed.
   */
  | { kind: "stackHold"; reason?: string; at: number };

/**
 * A run's next state. The queue entry carries the review's id in its message
 * origin, so every step of the turn is the owner's own observation: queued or
 * held behind a running turn, started, refused or blocked at the head,
 * cancelled by the operator (no run left), and ended. Once someone settles a
 * finding or resolves the review, a failed send is old news: someone took
 * the findings on, so the failure is dropped. A run that is still going
 * settles findings itself, so it stays.
 *
 * A queued run keeps its first time. A stack hold marks the queued run with
 * its reason until the owner reports the gate open; a queue update that
 * keeps the run queued leaves the hold as it was, and leaving the queued
 * phase drops it.
 */
export function nextReviewAutoFixRun(
  current: ReviewAutoFixRun | undefined,
  event: ReviewAutoFixRunEvent,
): ReviewAutoFixRun | undefined {
  const queuedSince = current?.phase === "queued" ? current.at : event.at;
  if (event.kind === "sendFailed") return { phase: "failed", at: event.at, reason: event.reason };
  if (event.kind === "reviewUpdated") return current?.phase === "failed" ? undefined : current;
  if (event.kind === "stackHold") {
    if (event.reason) return { phase: "queued", at: queuedSince, hold: event.reason };
    return current?.phase === "queued" ? { phase: "queued", at: current.at } : current;
  }
  switch (event.status) {
    case "queued":
    case "held":
      return current?.phase === "queued" ? current : { phase: "queued", at: event.at };
    case "started":
      return { phase: "running", at: event.at };
    case "failed":
    case "blocked":
      return { phase: "failed", at: event.at, reason: event.errorMessage ?? "The turn could not start." };
    case "cancelled":
      return undefined;
    case "terminal":
      return { phase: "finished", at: event.at };
    default:
      return current;
  }
}

/** Whether two runs show viewers the same step. */
function sameReviewAutoFixRunStep(
  a: ReviewAutoFixRun | undefined,
  b: ReviewAutoFixRun | undefined,
): boolean {
  if (a?.phase !== b?.phase) return false;
  if (a?.phase === "failed" && b?.phase === "failed") return a.reason === b.reason;
  if (a?.phase === "queued" && b?.phase === "queued") return a.hold === b.hold;
  return true;
}

/** Runs kept per thread; older ones belong to reviews long since settled. */
const RUNS_PER_THREAD = 20;

/** Each landed review's Auto-fix run, in this owner's memory. */
export class ReviewAutoFixRuns {
  private readonly runs = new Map<string, Map<string, ReviewAutoFixRun>>();

  constructor(private readonly onRunChange: (thread: ReviewAutoFixThread) => void = () => {}) {}

  record(thread: ReviewAutoFixThread, reviewId: string, event: ReviewAutoFixRunEvent): void {
    const key = threadKey(thread);
    const runs = this.runs.get(key) ?? new Map<string, ReviewAutoFixRun>();
    const current = runs.get(reviewId);
    const next = nextReviewAutoFixRun(current, event);
    // A queue position update repeats the phase; the run keeps its first time.
    if (sameReviewAutoFixRunStep(current, next)) return;
    runs.delete(reviewId);
    if (next) runs.set(reviewId, next);
    while (runs.size > RUNS_PER_THREAD) runs.delete(runs.keys().next().value!);
    if (runs.size > 0) this.runs.set(key, runs);
    else this.runs.delete(key);
    this.onRunChange(thread);
  }

  of(thread: ReviewAutoFixThread): Record<string, ReviewAutoFixRun> {
    return Object.fromEntries(this.runs.get(threadKey(thread)) ?? []);
  }
}

let listener: (thread: ReviewAutoFixThread) => void = () => {};
const notify = (thread: ReviewAutoFixThread) => listener(thread);
let arming: ReviewAutoFixArming | undefined;
let runs: ReviewAutoFixRuns | undefined;

export function getReviewAutoFixArming(): ReviewAutoFixArming {
  return arming ??= new ReviewAutoFixArming(notify);
}

export function getReviewAutoFixRuns(): ReviewAutoFixRuns {
  return runs ??= new ReviewAutoFixRuns(notify);
}

/** Where a change to a thread's Auto-fix state is announced. */
export function setReviewAutoFixListener(next: (thread: ReviewAutoFixThread) => void): void {
  listener = next;
}

/** A thread's Auto-fix state for its viewers. */
export function readReviewAutoFixStatus(thread: ReviewAutoFixThread): ReviewAutoFixStatus {
  return { armedTurnIds: getReviewAutoFixArming().armedTurnIds(thread), runs: getReviewAutoFixRuns().of(thread) };
}

export function resetReviewAutoFixArmingForTests(): void {
  arming = undefined;
  runs = undefined;
  listener = () => {};
}

/**
 * The message Auto-fix sends for a landed review, or undefined when nothing
 * in it is open. Open findings go by priority, as the card lists them.
 */
export function reviewAutoFixMessage(review: ThreadReview): {
  text: string;
  messageOrigin: AppServerThreadMessageOrigin;
} | undefined {
  if (review.status !== "open") return undefined;
  const open = orderReviewItems(review.items).filter((item) => item.status === "open");
  if (open.length === 0) return undefined;
  const title = threadReviewDisplayTitle(review);
  return {
    text: autoFixReviewFindingsPrompt(title, open, review.context),
    messageOrigin: {
      kind: "pwragent",
      reviewAutoFix: { reviewId: review.id, title, findingCount: open.length },
    },
  };
}

export type ReviewAutoFixTurnRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  input: [{ type: "text"; text: string }];
  origin: "automation";
  messageOrigin: AppServerThreadMessageOrigin;
};

export type ReviewAutoFixStackUpdate =
  | { prKeys: readonly string[]; pr?: Pick<PrSummary, "headRefName" | "baseRefName"> }
  | { threadKey: string };

export type ReviewAutoFixStackWakeFilter = (update: ReviewAutoFixStackUpdate) => boolean;

export type ReviewAutoFixDispatcherDeps = {
  getReview: (id: string) => ThreadReview | undefined;
  isThreadArchived: (thread: ReviewAutoFixThread) => boolean;
  readStackHold?: (
    review: ThreadReview, setWakeFilter: (filter: ReviewAutoFixStackWakeFilter) => void,
  ) => Promise<string | undefined>;
  threadHasActiveTurn?: (thread: ReviewAutoFixThread) => boolean;
  suspendDispatch?: (thread: ReviewAutoFixThread) => () => void;
  submitTurn: (request: ReviewAutoFixTurnRequest) => Promise<unknown>;
  submitTurnIfIdle: (
    request: ReviewAutoFixTurnRequest & {
      canAdmit: () => Promise<boolean>;
      reviewAutoFixHandoff?: boolean;
    },
  ) => Promise<{ status: string }>;
  recordRun: (thread: ReviewAutoFixThread, reviewId: string, event: ReviewAutoFixRunEvent) => void;
  onHeld?: (thread: ReviewAutoFixThread, reason: string) => void;
  onSendFailed?: (thread: ReviewAutoFixThread, reason: string) => void;
  now?: () => number;
};

type HandoffSuspension = {
  backend: AppServerBackendKind;
  threadId: string;
  reviewTurnId?: string;
  reviewTurnEnded: boolean;
  release: () => void;
};

/**
 * Sends Auto-fix turns for landed armed reviews, honoring stack holds without
 * dropping wakeups or losing review-to-fix precedence over queued messages.
 */
export class ReviewAutoFixDispatcher {
  private readonly heldReviews = new Map<string, string>();
  private readonly checkingReviews = new Set<string>();
  private readonly recheckReviews = new Set<string>();
  private readonly stackWakeFilters = new Map<string, ReviewAutoFixStackWakeFilter>();
  private readonly handoffSuspensions = new Map<string, HandoffSuspension>();
  private readonly now: () => number;

  constructor(private readonly deps: ReviewAutoFixDispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  onReviewLanded(id: string, thread: ReviewAutoFixThread, reviewTurnId: string | undefined): void {
    this.claimHandoffSuspension(id, thread, reviewTurnId);
    void this.dispatch(id);
  }

  onTurnEnded(thread: ReviewAutoFixThread, endedTurnIds: ReadonlySet<string>): void {
    for (const handoff of this.handoffSuspensions.values()) {
      if (
        handoff.backend === thread.backend
        && handoff.threadId === thread.threadId
        && (!handoff.reviewTurnId || endedTurnIds.has(handoff.reviewTurnId))
      ) {
        handoff.reviewTurnEnded = true;
      }
    }
    this.wake(thread);
  }

  wake(thread?: ReviewAutoFixThread): void {
    this.wakeMatching((id) => {
      if (!thread) return true;
      const review = this.deps.getReview(id);
      return !review || (review.backend === thread.backend && review.threadId === thread.threadId);
    });
  }

  wakeForStackUpdate(update: ReviewAutoFixStackUpdate): void {
    // Readers without scoped evidence still need every possible wakeup.
    this.wakeMatching((id) => this.stackWakeFilters.get(id)?.(update) ?? true);
  }

  private wakeMatching(matches: (id: string) => boolean): void {
    for (const id of this.checkingReviews) {
      if (matches(id)) this.recheckReviews.add(id);
    }
    for (const id of [...this.heldReviews.keys()]) {
      if (!this.checkingReviews.has(id) && matches(id)) void this.dispatch(id);
    }
  }

  onThreadArchived(thread: ReviewAutoFixThread): void {
    const matchesThread = (id: string): boolean => {
      const handoff = this.handoffSuspensions.get(id);
      if (handoff) {
        return handoff.backend === thread.backend && handoff.threadId === thread.threadId;
      }
      const review = this.deps.getReview(id);
      return review !== undefined && review.backend === thread.backend && review.threadId === thread.threadId;
    };
    const cancelled = new Set<string>();
    for (const id of [...this.handoffSuspensions.keys()]) {
      if (matchesThread(id)) {
        this.heldReviews.delete(id);
        this.releaseHandoffSuspension(id);
        cancelled.add(id);
      }
    }
    for (const id of [...this.heldReviews.keys()]) {
      if (matchesThread(id)) {
        this.heldReviews.delete(id);
        cancelled.add(id);
      }
    }
    for (const id of this.checkingReviews) {
      if (matchesThread(id)) {
        this.recheckReviews.add(id);
        cancelled.add(id);
      }
    }
    for (const id of cancelled) {
      this.stackWakeFilters.delete(id);
      this.deps.recordRun(thread, id, { kind: "queue", status: "cancelled", at: this.now() });
    }
  }

  dispose(): void {
    for (const id of [...this.handoffSuspensions.keys()]) {
      this.releaseHandoffSuspension(id);
    }
    this.heldReviews.clear();
    this.recheckReviews.clear();
    this.stackWakeFilters.clear();
  }

  private cancelReview(id: string, thread: ReviewAutoFixThread): void {
    this.heldReviews.delete(id);
    this.releaseHandoffSuspension(id);
    this.deps.recordRun(thread, id, { kind: "queue", status: "cancelled", at: this.now() });
  }

  private releaseHandoffSuspension(id: string): void {
    const handoff = this.handoffSuspensions.get(id);
    if (!handoff) return;
    this.handoffSuspensions.delete(id);
    handoff.release();
  }

  private claimHandoffSuspension(
    id: string,
    thread: ReviewAutoFixThread,
    reviewTurnId: string | undefined,
  ): void {
    if (!this.deps.readStackHold || !this.deps.suspendDispatch) return;
    for (const [existingId, existing] of this.handoffSuspensions.entries()) {
      if (existing.backend === thread.backend && existing.threadId === thread.threadId) {
        this.releaseHandoffSuspension(existingId);
      }
    }
    this.handoffSuspensions.set(id, {
      backend: thread.backend,
      threadId: thread.threadId,
      reviewTurnId,
      reviewTurnEnded: false,
      release: this.deps.suspendDispatch(thread),
    });
  }

  private readStackHold(review: ThreadReview): Promise<string | undefined> | undefined {
    this.stackWakeFilters.delete(review.id);
    return this.deps.readStackHold?.(review, (filter) => this.stackWakeFilters.set(review.id, filter));
  }

  async dispatch(id: string): Promise<void> {
    if (this.checkingReviews.has(id)) {
      this.recheckReviews.add(id);
      return;
    }
    this.checkingReviews.add(id);
    try {
      do {
        this.recheckReviews.delete(id);
        const review = this.deps.getReview(id);
        const message = review && reviewAutoFixMessage(review);
        if (!review || !message || this.deps.isThreadArchived(review)) {
          if (review) {
            this.cancelReview(id, review);
          } else {
            this.heldReviews.delete(id);
            this.releaseHandoffSuspension(id);
          }
          return;
        }
        if (this.deps.readStackHold) {
          this.deps.recordRun(review, id, { kind: "queue", status: "held", at: this.now() });
        }
        const hold = await this.readStackHold(review);
        const current = this.deps.getReview(id);
        const latest = current && reviewAutoFixMessage(current);
        if (!current || !latest || this.deps.isThreadArchived(current)) {
          this.cancelReview(id, current ?? review);
          return;
        }
        if (hold) {
          // The card names the stack hold until admission decides otherwise.
          this.deps.recordRun(current, id, { kind: "stackHold", reason: hold, at: this.now() });
          if (this.heldReviews.get(id) !== hold) {
            this.deps.onHeld?.(current, hold);
          }
          this.heldReviews.set(id, hold);
          // Do not freeze queued user messages while a stack hold is active.
          this.releaseHandoffSuspension(id);
          continue;
        }
        const request: ReviewAutoFixTurnRequest = {
          backend: current.backend,
          threadId: current.threadId,
          input: [{ type: "text", text: latest.text }],
          origin: "automation",
          messageOrigin: latest.messageOrigin,
        };
        if (this.deps.readStackHold) {
          // Keep ownership until admission. A queued start could otherwise
          // outlive the observation that cleared the gate.
          const hasHandoff = this.handoffSuspensions.has(id);
          let admissionHold: string | undefined;
          const result = await this.deps.submitTurnIfIdle({
            ...request,
            canAdmit: async () => {
              admissionHold = await this.readStackHold(current);
              return !admissionHold;
            },
            ...(hasHandoff ? { reviewAutoFixHandoff: true } : {}),
          });
          if (result.status === "busy") {
            const afterBusy = this.deps.getReview(id);
            if (!afterBusy || !reviewAutoFixMessage(afterBusy) || this.deps.isThreadArchived(afterBusy)) {
              this.cancelReview(id, afterBusy ?? current);
              return;
            }
            // Record the gate once admission answers, so a hold that closes
            // again at admission does not flash the current-turn wording.
            this.deps.recordRun(afterBusy, id, {
              kind: "stackHold",
              ...(admissionHold ? { reason: admissionHold } : {}),
              at: this.now(),
            });
            this.heldReviews.set(id, admissionHold ?? "Waiting for turn admission");
            const handoff = this.handoffSuspensions.get(id);
            const reviewTurnStillActive = handoff !== undefined
              && !handoff.reviewTurnEnded
              && (this.deps.threadHasActiveTurn?.(afterBusy) ?? true);
            if (handoff && !reviewTurnStillActive && !this.recheckReviews.has(id)) {
              this.releaseHandoffSuspension(id);
            }
            continue;
          }
          this.deps.recordRun(current, id, { kind: "stackHold", at: this.now() });
        } else {
          await this.deps.submitTurn(request);
        }
        this.heldReviews.delete(id);
        this.releaseHandoffSuspension(id);
        return;
      } while (this.recheckReviews.has(id) && this.heldReviews.has(id));
    } catch (error) {
      this.heldReviews.delete(id);
      this.releaseHandoffSuspension(id);
      const reason = error instanceof Error ? error.message : String(error);
      const review = this.deps.getReview(id);
      if (!review) return;
      this.deps.onSendFailed?.(review, reason);
      this.deps.recordRun(review, id, { kind: "sendFailed", reason, at: this.now() });
    } finally {
      this.checkingReviews.delete(id);
      this.recheckReviews.delete(id);
      if (!this.heldReviews.has(id)) this.stackWakeFilters.delete(id);
    }
  }
}
