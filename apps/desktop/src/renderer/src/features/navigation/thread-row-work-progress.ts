import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { isThreadTurnRunning } from "./ThreadRowStatus";

export type ThreadWorkProgress = Pick<
  NavigationThreadSummary,
  "gitBranch" | "gitWorkingState" | "observedGitBranch"
>;

/**
 * Whether a sidebar row holds its git and to-do progress chips.
 *
 * Holds only while the thread's turn or an owned worker is running and the
 * thread is not the open thread. Background tasks left running after a turn
 * keep the row's working mark, not the hold.
 */
export function shouldHoldThreadRowWorkProgress(
  thread: NavigationThreadSummary,
  selectedThreadKey?: string,
  thinkingThreadKeys?: Record<string, boolean>,
): boolean {
  const threadKey = threadSummaryIdentityKey(thread);
  return (
    threadKey !== selectedThreadKey
    && isThreadTurnRunning(thread, thinkingThreadKeys)
  );
}

/**
 * Returns `live`, or `committed` while `hold` is true. On a row's initial
 * mount `committed` starts at `live`, so mounting mid-turn shows the first
 * value.
 */
export function resolveHeldValue<T>(
  committed: T,
  live: T,
  hold: boolean,
): T {
  return hold ? committed : live;
}

export function extractThreadWorkProgress(
  thread: NavigationThreadSummary,
): ThreadWorkProgress {
  return {
    gitBranch: thread.gitBranch,
    gitWorkingState: thread.gitWorkingState,
    observedGitBranch: thread.observedGitBranch,
  };
}

/**
 * Applies held git work-progress fields onto `thread` while keeping every
 * other field (identity, PRs, federation, agent, approvals) live.
 */
export function applyHeldThreadWorkProgress(
  thread: NavigationThreadSummary,
  held: ThreadWorkProgress,
  hold: boolean,
): NavigationThreadSummary {
  return hold ? { ...thread, ...held } : thread;
}

export type ThreadRowWorkProgressStep = {
  thread: NavigationThreadSummary;
  openTodos: readonly ThreadTodo[];
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  remount?: boolean;
};

export type ThreadRowWorkProgressState = {
  git: ThreadWorkProgress;
  openTodos: readonly ThreadTodo[];
};

export type ThreadRowWorkProgressShown = {
  hold: boolean;
  thread: NavigationThreadSummary;
  openTodos: readonly ThreadTodo[];
};

/**
 * Pure step transition matching one render + commit of `ThreadRow` and
 * `ThreadMetaChips`. `state` is `undefined` on initial mount or after a
 * remount, when there is no prior committed value to hold.
 */
export function stepThreadRowWorkProgress(
  state: ThreadRowWorkProgressState | undefined,
  step: ThreadRowWorkProgressStep,
): {
  state: ThreadRowWorkProgressState;
  shown: ThreadRowWorkProgressShown;
} {
  const prior = step.remount ? undefined : state;
  const hold = shouldHoldThreadRowWorkProgress(
    step.thread,
    step.selectedThreadKey,
    step.thinkingThreadKeys,
  );
  const liveGit = extractThreadWorkProgress(step.thread);
  const shownGit = resolveHeldValue(prior ? prior.git : liveGit, liveGit, hold);
  const shownTodos = resolveHeldValue(
    prior ? prior.openTodos : step.openTodos,
    step.openTodos,
    hold,
  );
  return {
    state: {
      git: shownGit,
      openTodos: shownTodos,
    },
    shown: {
      hold,
      thread: applyHeldThreadWorkProgress(step.thread, shownGit, hold),
      openTodos: shownTodos,
    },
  };
}
