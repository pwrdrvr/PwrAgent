import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  ReviewAfterAction,
  ReviewAutoFixRun,
  ReviewAutoFixStatus,
  ThreadReview,
} from "@pwragent/shared";
import { threadReviewDisplayTitle } from "@pwragent/shared";
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
        // This review is now the thread's one running review, so earlier
        // accepted starts are over. Starts still in flight stay: each is
        // accepted or refused on its own.
        const inFlight = (this.starts.get(key) ?? [])
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
  takeOnCompletion(thread: ReviewAutoFixThread, turnId: string | undefined): boolean {
    return this.tracking(thread, () => {
      const starts = this.starts.get(threadKey(thread)) ?? [];
      const start = (turnId === undefined ? undefined : starts.find((entry) => entry.turnId === turnId))
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
      this.replace(key, (this.starts.get(key) ?? []).filter((start) => start.turnId !== turnId));
    });
  }

  private replace(key: string, starts: Start[]): void {
    if (starts.length > 0) this.starts.set(key, starts);
    else this.starts.delete(key);
  }
}

/** What moved a landed review's Auto-fix run. */
export type ReviewAutoFixRunEvent =
  /** The send was refused before it reached the thread's queue. */
  | { kind: "sendFailed"; reason: string; at: number }
  /** The Auto-fix turn's queue entry moved, as `thread/turnQueue/updated` says. */
  | { kind: "queue"; status: string; errorMessage?: string; at: number }
  /** An agent or the operator settled a finding or resolved the review. */
  | { kind: "reviewUpdated"; at: number };

/**
 * A run's next state. The queue entry carries the review's id in its message
 * origin, so every step of the turn is the owner's own observation: queued or
 * held behind a running turn, started, refused or blocked at the head,
 * cancelled by the operator (no run left), and ended. Once someone settles a
 * finding or resolves the review, a failed send is old news: someone took
 * the findings on, so the failure is dropped. A run that is still going
 * settles findings itself, so it stays.
 */
export function nextReviewAutoFixRun(
  current: ReviewAutoFixRun | undefined,
  event: ReviewAutoFixRunEvent,
): ReviewAutoFixRun | undefined {
  if (event.kind === "sendFailed") return { phase: "failed", at: event.at, reason: event.reason };
  if (event.kind === "reviewUpdated") return current?.phase === "failed" ? undefined : current;
  switch (event.status) {
    case "queued":
    case "held":
      return { phase: "queued", at: event.at };
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
    if (next?.phase === current?.phase
      && (next?.phase !== "failed" || current?.phase !== "failed" || next.reason === current.reason)) return;
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
    text: autoFixReviewFindingsPrompt(title, open),
    messageOrigin: {
      kind: "pwragent",
      reviewAutoFix: { reviewId: review.id, title, findingCount: open.length },
    },
  };
}
