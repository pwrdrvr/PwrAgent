import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { ReviewAfterAction } from "@pwragent/shared/contracts/agent";
import type {
  ReviewAutoFixRun,
  ReviewAutoFixStatus,
  ThreadReview,
} from "@pwragent/shared/contracts/thread-reviews";
import { buildPullRequestStatusKey, buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { reviewContextPullRequests, threadReviewDisplayTitle } from "@pwragent/shared/contracts/thread-reviews";
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

export type ReviewStackHoldObservation = {
  /** Subscribe before the asynchronous activity read can observe a stale repair. */
  readActivity: (threadKey: string) => void;
  /** Keep the dependency on the repair that actually blocked the review. */
  heldBy: (threadKey: string) => void;
};

export type ReviewAutoFixDispatcherDeps = {
  getReview: (id: string) => ThreadReview | undefined;
  isThreadArchived: (thread: ReviewAutoFixThread) => boolean;
  readStackHold?: (review: ThreadReview, observation: ReviewStackHoldObservation) => Promise<string | undefined>;
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
  reviewTurnId?: string;
  reviewTurnEnded: boolean;
  release: () => void;
};

type PendingAutoFix = {
  id: string;
  thread: ReviewAutoFixThread;
  forgeScopes: readonly ForgeWakeScope[];
  repairThreads: Set<string>;
  changedRepairThreads: Set<string>;
  repairBlocker?: string;
  checking: boolean;
  recheck: boolean;
  hold?: string;
  handoff?: HandoffSuspension;
};

type ForgeWakeScope = {
  repository: string | undefined;
  idle: Set<PendingAutoFix>;
  reviewCount: number;
  lastWake: number;
};

function repositoryOf(prKey: unknown): string | undefined {
  if (typeof prKey !== "string") return undefined;
  return /^([^\s/#]+(?:\/[^\s/#]+){2,})#[1-9]\d*$/.exec(prKey)?.[1]?.toLowerCase();
}

function reviewRepositories(review: ThreadReview): readonly (string | undefined)[] {
  const repositories = new Set(reviewContextPullRequests(review.context)
    .map((pr) => repositoryOf(buildPullRequestStatusKey(pr))));
  return repositories.size ? [...repositories] : [undefined];
}

function addPending<Key>(index: Map<Key, Set<PendingAutoFix>>, key: Key, pending: PendingAutoFix): void {
  const existing = index.get(key);
  if (existing) existing.add(pending);
  else index.set(key, new Set([pending]));
}

function removePending<Key>(index: Map<Key, Set<PendingAutoFix>>, key: Key, pending: PendingAutoFix): void {
  const existing = index.get(key);
  if (!existing) return;
  existing.delete(pending);
  if (!existing.size) index.delete(key);
}

/**
 * Sends Auto-fix turns for landed armed reviews, honoring stack holds without
 * dropping wakeups or losing review-to-fix precedence over queued messages.
 */
export class ReviewAutoFixDispatcher {
  private readonly pending = new Map<string, PendingAutoFix>();
  private readonly byThread = new Map<string, Set<PendingAutoFix>>();
  private readonly byRepository = new Map<string | undefined, ForgeWakeScope>();
  private readonly byRepairThread = new Map<string, Set<PendingAutoFix>>();
  private readonly now: () => number;
  private forgeWakeSequence = 0;
  private disposed = false;

  constructor(private readonly deps: ReviewAutoFixDispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  onReviewLanded(id: string, thread: ReviewAutoFixThread, reviewTurnId: string | undefined): void {
    void this.dispatch(id, { thread, reviewTurnId });
  }

  onTurnEnded(thread: ReviewAutoFixThread, endedTurnIds: ReadonlySet<string>): void {
    for (const { handoff } of this.byThread.get(threadKey(thread)) ?? []) {
      if (handoff && (!handoff.reviewTurnId || endedTurnIds.has(handoff.reviewTurnId))) {
        handoff.reviewTurnEnded = true;
      }
    }
    this.onThreadAvailable(thread);
  }

  onThreadAvailable(thread: ReviewAutoFixThread): void {
    const key = buildThreadIdentityKey(thread.backend, thread.threadId);
    const own = this.byThread.get(threadKey(thread));
    this.wakePending(own ?? []);
    for (const pending of [...this.byRepairThread.get(key) ?? []]) {
      if (own?.has(pending) || !this.isCurrent(pending)) continue;
      if (pending.checking) pending.changedRepairThreads.add(key);
      else void this.dispatch(pending.id);
    }
  }

  wake(thread?: ReviewAutoFixThread): void {
    this.wakePending(thread ? this.byThread.get(threadKey(thread)) ?? [] : this.pending.values());
  }

  wakeForPullRequest(prKey: unknown, aliases: readonly string[] = []): void {
    const repository = repositoryOf(prKey);
    if (!repository) {
      this.wake();
      return;
    }
    // A different PR in this repository may be a lower stack layer, including
    // a layer discovered by this very observation. Its thread/backend may differ.
    // Reviews without captured PR context can be affected by any observation.
    const sequence = ++this.forgeWakeSequence;
    const affected = new Set<PendingAutoFix>();
    for (const key of new Set([undefined, repository, ...aliases.map(repositoryOf)])) {
      const scope = this.byRepository.get(key);
      if (!scope) continue;
      // In-flight checks compare against this sequence when they return.
      scope.lastWake = sequence;
      for (const pending of scope.idle) affected.add(pending);
    }
    this.wakePending(affected);
  }

  private wakePending(reviews: Iterable<PendingAutoFix>): void {
    for (const pending of [...reviews]) {
      if (this.isCurrent(pending)) void this.dispatch(pending.id);
    }
  }

  onThreadArchived(thread: ReviewAutoFixThread): void {
    for (const pending of [...this.byThread.get(threadKey(thread)) ?? []]) {
      if (this.isCurrent(pending)) this.cancelReview(pending);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) this.forget(pending);
  }

  private isCurrent(pending: PendingAutoFix): boolean {
    return this.pending.get(pending.id) === pending;
  }

  private track(review: ThreadReview): PendingAutoFix {
    const { id, backend, threadId } = review;
    const thread = { backend, threadId };
    const pending: PendingAutoFix = {
      id, thread, forgeScopes: reviewRepositories(review).map((repository) => this.joinForgeScope(repository)),
      repairThreads: new Set(), changedRepairThreads: new Set(),
      checking: false, recheck: false,
    };
    this.pending.set(id, pending);
    addPending(this.byThread, threadKey(thread), pending);
    return pending;
  }

  private joinForgeScope(repository: string | undefined): ForgeWakeScope {
    let scope = this.byRepository.get(repository);
    if (!scope) {
      scope = { repository, idle: new Set(), reviewCount: 0, lastWake: 0 };
      this.byRepository.set(repository, scope);
    }
    scope.reviewCount++;
    return scope;
  }

  private forget(pending: PendingAutoFix): void {
    this.pending.delete(pending.id);
    removePending(this.byThread, threadKey(pending.thread), pending);
    for (const scope of pending.forgeScopes) {
      scope.idle.delete(pending);
      if (--scope.reviewCount === 0) this.byRepository.delete(scope.repository);
    }
    for (const thread of pending.repairThreads) removePending(this.byRepairThread, thread, pending);
    this.releaseHandoffSuspension(pending);
  }

  private cancelReview(pending: PendingAutoFix): void {
    this.forget(pending);
    this.deps.recordRun(pending.thread, pending.id, { kind: "queue", status: "cancelled", at: this.now() });
  }

  private releaseHandoffSuspension(pending: PendingAutoFix): void {
    const { handoff } = pending;
    pending.handoff = undefined;
    handoff?.release();
  }

  private claimHandoffSuspension(
    pending: PendingAutoFix,
    thread: ReviewAutoFixThread,
    reviewTurnId: string | undefined,
  ): void {
    if (!this.deps.readStackHold || !this.deps.suspendDispatch) return;
    for (const other of this.byThread.get(threadKey(thread)) ?? []) {
      this.releaseHandoffSuspension(other);
    }
    if (!this.isCurrent(pending)) return;
    const release = this.deps.suspendDispatch(thread);
    if (this.isCurrent(pending)) pending.handoff = { reviewTurnId, reviewTurnEnded: false, release };
    else release();
  }

  async dispatch(id: string, landed?: { thread: ReviewAutoFixThread; reviewTurnId?: string }): Promise<void> {
    if (this.disposed) return;
    const existing = this.pending.get(id);
    if (existing?.checking) {
      existing.recheck = true;
      return;
    }
    let pending = existing;
    try {
      let review = this.deps.getReview(id);
      if (!review) {
        if (pending) this.forget(pending);
        return;
      }
      pending ??= this.track(review);
      pending.checking = true;
      for (const scope of pending.forgeScopes) scope.idle.delete(pending);
      if (landed) this.claimHandoffSuspension(pending, landed.thread, landed.reviewTurnId);
      while (this.isCurrent(pending)) {
        pending.recheck = false;
        const forgeSnapshot = this.forgeWakeSequence;
        await this.checkReview(pending, review, forgeSnapshot);
        if (!this.isCurrent(pending) || !pending.hold || !this.needsRecheck(pending, forgeSnapshot)) return;
        review = this.deps.getReview(id);
        if (!review) {
          this.forget(pending);
          return;
        }
      }
    } catch (error) {
      if (this.disposed || (pending && !this.isCurrent(pending))) return;
      if (pending) this.forget(pending);
      const reason = error instanceof Error ? error.message : String(error);
      const review = this.deps.getReview(id);
      if (!review) return;
      this.deps.onSendFailed?.(review, reason);
      this.deps.recordRun(review, id, { kind: "sendFailed", reason, at: this.now() });
    } finally {
      if (pending && this.isCurrent(pending)) {
        pending.checking = false;
        pending.recheck = false;
        for (const scope of pending.forgeScopes) scope.idle.add(pending);
      }
    }
  }

  private needsRecheck(pending: PendingAutoFix, forgeSnapshot: number): boolean {
    return pending.recheck
      || (pending.repairBlocker !== undefined && pending.changedRepairThreads.has(pending.repairBlocker))
      || pending.forgeScopes.some((scope) => scope.lastWake > forgeSnapshot);
  }

  private observeStackHold(pending: PendingAutoFix) {
    pending.changedRepairThreads.clear();
    let blocker: string | undefined;
    const observe = (key: string) => {
      if (!this.isCurrent(pending) || pending.repairThreads.has(key)) return;
      pending.repairThreads.add(key);
      addPending(this.byRepairThread, key, pending);
    };
    return {
      readActivity: observe,
      heldBy: (key) => { blocker = key; observe(key); },
      finish: (hold: string | undefined) => {
        if (!this.isCurrent(pending)) return;
        pending.repairBlocker = hold ? blocker : undefined;
        for (const key of pending.repairThreads) {
          if (key === pending.repairBlocker) continue;
          removePending(this.byRepairThread, key, pending);
          pending.repairThreads.delete(key);
        }
      },
    } satisfies ReviewStackHoldObservation & { finish: (hold: string | undefined) => void };
  }

  private async checkReview(pending: PendingAutoFix, review: ThreadReview, forgeSnapshot: number): Promise<void> {
    const { id } = pending;
    if (!reviewAutoFixMessage(review) || this.deps.isThreadArchived(review)) {
      this.cancelReview(pending);
      return;
    }
    if (this.deps.readStackHold) {
      this.deps.recordRun(review, id, { kind: "queue", status: "held", at: this.now() });
    }
    const observation = this.observeStackHold(pending);
    const hold = await this.deps.readStackHold?.(review, observation);
    observation.finish(hold);
    if (!this.isCurrent(pending)) return;
    const current = this.deps.getReview(id);
    const latest = current && reviewAutoFixMessage(current);
    if (!current || !latest || this.deps.isThreadArchived(current)) {
      this.cancelReview(pending);
      return;
    }
    if (hold) {
      // The card names the stack hold until admission decides otherwise.
      this.deps.recordRun(current, id, { kind: "stackHold", reason: hold, at: this.now() });
      if (pending.hold !== hold) this.deps.onHeld?.(current, hold);
      pending.hold = hold;
      // Do not freeze queued user messages while a stack hold is active.
      this.releaseHandoffSuspension(pending);
      return;
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
      let admissionHold: string | undefined;
      const result = await this.deps.submitTurnIfIdle({
        ...request,
        canAdmit: async () => {
          if (!this.isCurrent(pending)) return false;
          const observation = this.observeStackHold(pending);
          admissionHold = await this.deps.readStackHold?.(current, observation);
          observation.finish(admissionHold);
          return this.isCurrent(pending) && !admissionHold;
        },
        ...(pending.handoff ? { reviewAutoFixHandoff: true } : {}),
      });
      if (!this.isCurrent(pending)) return;
      if (result.status === "busy") {
        this.recordBusy(pending, admissionHold, forgeSnapshot);
        return;
      }
      this.deps.recordRun(current, id, { kind: "stackHold", at: this.now() });
    } else {
      await this.deps.submitTurn(request);
    }
    if (this.isCurrent(pending)) this.forget(pending);
  }

  private recordBusy(pending: PendingAutoFix, admissionHold: string | undefined, forgeSnapshot: number): void {
    const { id, handoff } = pending;
    const afterBusy = this.deps.getReview(id);
    if (!afterBusy || !reviewAutoFixMessage(afterBusy) || this.deps.isThreadArchived(afterBusy)) {
      this.cancelReview(pending);
      return;
    }
    // Record the gate once admission answers, so a hold that closes
    // again at admission does not flash the current-turn wording.
    this.deps.recordRun(afterBusy, id, {
      kind: "stackHold",
      ...(admissionHold ? { reason: admissionHold } : {}),
      at: this.now(),
    });
    pending.hold = admissionHold ?? "Waiting for turn admission";
    const reviewTurnStillActive = handoff !== undefined
      && !handoff.reviewTurnEnded
      && (this.deps.threadHasActiveTurn?.(afterBusy) ?? true);
    if (handoff && !reviewTurnStillActive && !this.needsRecheck(pending, forgeSnapshot)) {
      this.releaseHandoffSuspension(pending);
    }
  }
}
