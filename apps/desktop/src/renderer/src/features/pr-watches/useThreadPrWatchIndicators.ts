import { createContext, useContext, useEffect, useState } from "react";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadPrAutoFixState,
  ThreadPullRequestWatchEvent,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  pullRequestMatchesRepositoryKey,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { resolveLifecycleState } from "../pr-status/pr-chip-state";

/**
 * What one PR chip says about the watches that wake its thread. Only a CI
 * watch draws the eye: a merge/close watch is near-permanent, and Auto-fix is
 * a thread setting the composer already shows. The hover card lists all three.
 */
export type PrChipWatch = {
  ci?: {
    /** The re-run's attempt this watch waits for, when PwrAgent requested it. */
    runAttempt?: number;
    createdAt: number;
    notifyOn: readonly ThreadPullRequestWatchEvent[];
  };
  terminal?: { createdAt: number };
  /** Auto-fix starts a repair turn on this thread when the PR fails CI. */
  autoFix?: boolean;
  /**
   * Auto-fix is on for the thread, but main will not wake it for this PR:
   * the repair budget is paused, or another thread owns this PR's repairs.
   */
  autoFixBlocked?: PrAutoFixBlock;
};

export type PrAutoFixBlock =
  | { reason: "paused" }
  | { reason: "handled_by_other_thread"; threadTitle?: string };

/** One local thread's active PR watches. */
export type ThreadPrWatches = {
  /** Oldest first. */
  watches: readonly ThreadPullRequestWatchSummary[];
  /** Keyed by `buildPullRequestStatusKey`, the key every watch carries. */
  byPrKey: ReadonlyMap<string, PrChipWatch>;
  /**
   * What Auto-fix does for each of the thread's PRs, by PR key, as main
   * projects it. Absent when main sent no projection.
   */
  autoFixByPrKey?: ReadonlyMap<string, ThreadPrAutoFixState>;
};

export type ThreadPrWatchIndicatorsValue = {
  byThreadKey: ReadonlyMap<string, ThreadPrWatches>;
  /**
   * False when this instance's Git settings stop Auto-fix: background PR
   * polling or Auto-fix PR is off. Absent where this window cannot tell.
   */
  autoFixAvailable?: boolean;
  /** Stops one watch. Absent where this window cannot stop watches. */
  stop?: (watch: ThreadPullRequestWatchSummary) => Promise<void>;
  /**
   * Drafts a request for the agent to watch CI on a PR into that thread's
   * composer. It never sends. Absent where no composer can take it.
   */
  askAgentToWatchCi?: (thread: NavigationThreadSummary, pr: PrSummary) => void;
};

export const ThreadPrWatchIndicatorsContext = createContext<ThreadPrWatchIndicatorsValue | undefined>(undefined);

const EMPTY: ReadonlyMap<string, ThreadPrWatches> = new Map();
// A poll can end, move or clear several watches at once; a burst becomes one
// list request.
const REFRESH_DEBOUNCE_MS = 150;

export function useThreadPrWatchIndicatorsContext(): ThreadPrWatchIndicatorsValue | undefined {
  return useContext(ThreadPrWatchIndicatorsContext);
}

/**
 * The thread's primary repository key when Auto-fix can repair its PRs, else
 * undefined. Main repairs only PRs on that repository, and only while the
 * thread opted in and Git settings let Auto-fix run. A peer's thread runs
 * under the peer's settings, which this window cannot read.
 */
export function resolveThreadAutoFixRepository(
  thread: Pick<NavigationThreadSummary, "prAutoDispatchEnabled" | "primaryGitRepository" | "federation">,
  autoFixAvailable: boolean | undefined,
): string | undefined {
  if (thread.prAutoDispatchEnabled !== true) return undefined;
  if (!thread.federation && autoFixAvailable === false) return undefined;
  return thread.primaryGitRepository;
}

export function useThreadAutoFixRepository(
  thread: Pick<NavigationThreadSummary, "prAutoDispatchEnabled" | "primaryGitRepository" | "federation">,
): string | undefined {
  const context = useContext(ThreadPrWatchIndicatorsContext);
  return resolveThreadAutoFixRepository(thread, context?.autoFixAvailable);
}

/** A local thread's watches. Watches run on the owning machine, so a peer's row has none. */
export function useThreadPrWatches(
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation"> | undefined,
): ThreadPrWatches | undefined {
  const context = useContext(ThreadPrWatchIndicatorsContext);
  if (!context || !thread || thread.federation) return undefined;
  return context.byThreadKey.get(buildThreadIdentityKey(thread.source, thread.id));
}

/**
 * Lists this instance's active PR watches and refreshes on every
 * `thread/prWatches/updated` event. A failed refresh keeps the last list: a
 * chip losing its eye would read as the watch having ended.
 */
export function useThreadPrWatchIndicators(desktopApi?: DesktopApi): ReadonlyMap<string, ThreadPrWatches> {
  const [indicators, setIndicators] = useState(EMPTY);
  useEffect(() => {
    if (!desktopApi?.manageThreadPrWatches || readRendererFederationTarget()?.scope === "remote") {
      setIndicators(EMPTY);
      return;
    }
    let disposed = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const sequence = ++latest;
      try {
        const response = await desktopApi.manageThreadPrWatches!({ action: "active" });
        if (disposed || sequence !== latest || !response.ok) return;
        const next = summarizeThreadPrWatches(response.active ?? [], response.autoFix);
        // Rows read this through context; an unchanged thread keeps its entry,
        // and an unchanged list keeps its identity, so no chip re-renders.
        setIndicators((current) => reuseUnchanged(current, next));
      } catch {
        // Keep the last list; the next update event retries.
      }
    };
    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (event.federationTarget?.scope === "remote" || event.notification.method !== "thread/prWatches/updated") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [desktopApi]);
  return indicators;
}

export function isCiWatch(watch: ThreadPullRequestWatchSummary): boolean {
  return (watch.kind ?? "checks") === "checks";
}

/** The attempt a CI watch waits for. Rows from before `runAttempt` carry it on the baseline. */
export function readWatchRunAttempt(watch: ThreadPullRequestWatchSummary): number | undefined {
  return watch.runAttempt ?? watch.baseline?.runAttempt;
}

/**
 * `autoFix` is main's Auto-fix projection, absent from an owner that predates
 * it. A thread with Auto-fix states and no watch still gets an entry.
 */
export function summarizeThreadPrWatches(
  watches: readonly ThreadPullRequestWatchSummary[],
  autoFix?: readonly ThreadPrAutoFixState[],
): ReadonlyMap<string, ThreadPrWatches> {
  const byThread = new Map<string, ThreadPullRequestWatchSummary[]>();
  for (const watch of watches) {
    const key = buildThreadIdentityKey(watch.backend, watch.threadId);
    const items = byThread.get(key);
    if (items) items.push(watch);
    else byThread.set(key, [watch]);
  }
  const autoFixByThread = new Map<string, Map<string, ThreadPrAutoFixState>>();
  for (const state of autoFix ?? []) {
    const key = buildThreadIdentityKey(state.backend, state.threadId);
    if (!byThread.has(key)) byThread.set(key, []);
    const states = autoFixByThread.get(key) ?? new Map<string, ThreadPrAutoFixState>();
    states.set(state.prKey, state);
    autoFixByThread.set(key, states);
  }
  const summaries = new Map<string, ThreadPrWatches>();
  for (const [key, items] of byThread) {
    items.sort((left, right) => left.createdAt - right.createdAt);
    const byPrKey = new Map<string, PrChipWatch>();
    for (const watch of items) {
      const current = byPrKey.get(watch.prKey) ?? {};
      const runAttempt = readWatchRunAttempt(watch);
      byPrKey.set(watch.prKey, isCiWatch(watch)
        ? {
            ...current,
            ci: {
              ...(runAttempt !== undefined ? { runAttempt } : {}),
              createdAt: watch.createdAt,
              notifyOn: watch.notifyOn,
            },
          }
        : { ...current, terminal: { createdAt: watch.createdAt } });
    }
    summaries.set(key, {
      watches: items,
      byPrKey,
      ...(autoFix ? { autoFixByPrKey: autoFixByThread.get(key) ?? NO_AUTO_FIX_STATES } : {}),
    });
  }
  return summaries;
}

const NO_AUTO_FIX_STATES: ReadonlyMap<string, ThreadPrAutoFixState> = new Map();

const AUTO_FIX_ONLY: PrChipWatch = { autoFix: true };
const NO_CHIP_WATCH: PrChipWatch = {};
// One object per watch entry, so a chip keeps its props across row renders.
const withAutoFixCache = new WeakMap<PrChipWatch, PrChipWatch>();
// Keyed by main's Auto-fix state object, which keeps its identity while the
// thread's entry is unchanged, then by the watch entry.
const withBlockedAutoFixCache = new WeakMap<ThreadPrAutoFixState, WeakMap<PrChipWatch, PrChipWatch>>();

/**
 * The chip's `watch` prop. Identity is stable for unchanged data, so the
 * memoized chip bails out when only its row re-rendered.
 * `autoFixRepository` comes from `resolveThreadAutoFixRepository`.
 */
export function resolvePrChipWatch(
  watches: ThreadPrWatches | undefined,
  pr: PrSummary,
  autoFixRepository: string | undefined,
): PrChipWatch | undefined {
  const prKey = buildPullRequestStatusKey(pr);
  const base = watches?.byPrKey.get(prKey);
  // Auto-fix repairs open PRs on the primary workspace's repository only; it
  // means nothing on a merged card or a linked directory's PR.
  if (
    resolveLifecycleState(pr) !== "open"
    || !pullRequestMatchesRepositoryKey(pr, autoFixRepository)
  ) return base;
  // Main says when it will not repair here. No entry yet reads as active:
  // the candidate list catches up on main's next refresh.
  const autoFixState = watches?.autoFixByPrKey?.get(prKey);
  if (autoFixState && autoFixState.state !== "active") {
    return withBlockedAutoFix(base, autoFixState);
  }
  if (!base) return AUTO_FIX_ONLY;
  let combined = withAutoFixCache.get(base);
  if (!combined) {
    combined = { ...base, autoFix: true };
    withAutoFixCache.set(base, combined);
  }
  return combined;
}

function withBlockedAutoFix(
  base: PrChipWatch | undefined,
  state: ThreadPrAutoFixState,
): PrChipWatch {
  let byBase = withBlockedAutoFixCache.get(state);
  if (!byBase) {
    byBase = new WeakMap();
    withBlockedAutoFixCache.set(state, byBase);
  }
  const key = base ?? NO_CHIP_WATCH;
  let combined = byBase.get(key);
  if (!combined) {
    const title = state.handledBy?.title?.trim();
    combined = {
      ...base,
      autoFixBlocked: state.state === "paused"
        ? { reason: "paused" }
        : { reason: "handled_by_other_thread", ...(title ? { threadTitle: title } : {}) },
    };
    byBase.set(key, combined);
  }
  return combined;
}

/** The composer text both "Ask Agent to Watch CI" entry points draft. */
export function buildWatchCiRequestText(pr: Pick<PrSummary, "number">): string {
  return `Watch CI on #${pr.number} and wake this thread when it finishes, pass or fail.`;
}

function reuseUnchanged(
  current: ReadonlyMap<string, ThreadPrWatches>,
  next: ReadonlyMap<string, ThreadPrWatches>,
): ReadonlyMap<string, ThreadPrWatches> {
  let changed = current.size !== next.size;
  const merged = new Map<string, ThreadPrWatches>();
  for (const [key, entry] of next) {
    const previous = current.get(key);
    if (
      previous
      && sameWatches(previous.watches, entry.watches)
      && sameAutoFixStates(previous.autoFixByPrKey, entry.autoFixByPrKey)
    ) {
      merged.set(key, previous);
    } else {
      merged.set(key, entry);
      changed = true;
    }
  }
  return changed ? merged : current;
}

function sameWatches(
  left: readonly ThreadPullRequestWatchSummary[],
  right: readonly ThreadPullRequestWatchSummary[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((watch, index) => {
    const other = right[index]!;
    return watch.watchId === other.watchId
      && watch.headSha === other.headSha
      && watch.createdAt === other.createdAt
      && watch.notifyOn.join(",") === other.notifyOn.join(",")
      && watch.baseline?.outcome === other.baseline?.outcome
      && watch.baseline?.runAttempt === other.baseline?.runAttempt
      && watch.runAttempt === other.runAttempt
      && watch.baseline?.failedCheckUrl === other.baseline?.failedCheckUrl
      && watch.prTitle === other.prTitle;
  });
}

function sameAutoFixStates(
  left: ReadonlyMap<string, ThreadPrAutoFixState> | undefined,
  right: ReadonlyMap<string, ThreadPrAutoFixState> | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const [prKey, state] of left) {
    const other = right.get(prKey);
    if (
      !other
      || state.state !== other.state
      || state.handledBy?.backend !== other.handledBy?.backend
      || state.handledBy?.threadId !== other.handledBy?.threadId
      || state.handledBy?.title !== other.handledBy?.title
    ) return false;
  }
  return true;
}
