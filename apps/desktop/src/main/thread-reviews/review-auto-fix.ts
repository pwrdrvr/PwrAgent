import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  ReviewAfterAction,
  ThreadReview,
} from "@pwragent/shared";
import { threadReviewDisplayTitle } from "@pwragent/shared";
import { autoFixReviewFindingsPrompt } from "../../shared/review-fix-prompts";

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
      accepted: (turnId) => {
        // This review is now the thread's one running review, so earlier
        // accepted starts are over. Starts still in flight stay: each is
        // accepted or refused on its own.
        const inFlight = (this.starts.get(key) ?? [])
          .filter((entry) => entry !== start && entry.turnId === undefined);
        start.turnId = turnId;
        this.replace(key, [...inFlight, start]);
      },
      refused: () => {
        this.replace(key, (this.starts.get(key) ?? []).filter((entry) => entry !== start));
      },
    };
  }

  /**
   * A review artifact landed on the thread in `turnId`. True once, for a
   * review started with auto-fix. A landed start stays recorded until its
   * turn ends, so its turn id never falls through to another start.
   */
  takeOnCompletion(thread: ReviewAutoFixThread, turnId: string | undefined): boolean {
    const starts = this.starts.get(threadKey(thread)) ?? [];
    const start = (turnId === undefined ? undefined : starts.find((entry) => entry.turnId === turnId))
      ?? starts.find((entry) => entry.turnId === undefined && !entry.landed);
    if (!start || start.landed) return false;
    start.landed = true;
    return start.autoFix;
  }

  /**
   * A turn ended on the thread. A review's start is no longer needed once
   * its turn ends: it landed, failed, or was interrupted. Matching by turn id
   * already keeps an ended review from fixing, so this only frees it.
   */
  turnEnded(thread: ReviewAutoFixThread, turnId: string): void {
    const key = threadKey(thread);
    this.replace(key, (this.starts.get(key) ?? []).filter((start) => start.turnId !== turnId));
  }

  private replace(key: string, starts: Start[]): void {
    if (starts.length > 0) this.starts.set(key, starts);
    else this.starts.delete(key);
  }
}

let arming: ReviewAutoFixArming | undefined;

export function getReviewAutoFixArming(): ReviewAutoFixArming {
  return arming ??= new ReviewAutoFixArming();
}

export function resetReviewAutoFixArmingForTests(): void {
  arming = undefined;
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
  const open = review.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === "open")
    .sort((a, b) => (a.item.priority ?? 9) - (b.item.priority ?? 9) || a.index - b.index)
    .map(({ item }) => item);
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
