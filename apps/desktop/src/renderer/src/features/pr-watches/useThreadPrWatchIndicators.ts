import { createContext, useContext, useEffect, useState } from "react";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadPullRequestWatchEvent,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { buildPullRequestStatusKey, buildThreadIdentityKey } from "@pwragent/shared";
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
  autoFix?: boolean;
};

/** One local thread's active PR watches. */
export type ThreadPrWatches = {
  /** Oldest first. */
  watches: readonly ThreadPullRequestWatchSummary[];
  /** Keyed by `buildPullRequestStatusKey`, the key every watch carries. */
  byPrKey: ReadonlyMap<string, PrChipWatch>;
};

export type ThreadPrWatchIndicatorsValue = {
  byThreadKey: ReadonlyMap<string, ThreadPrWatches>;
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
        const next = summarizeThreadPrWatches(response.active ?? []);
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

export function summarizeThreadPrWatches(
  watches: readonly ThreadPullRequestWatchSummary[],
): ReadonlyMap<string, ThreadPrWatches> {
  const byThread = new Map<string, ThreadPullRequestWatchSummary[]>();
  for (const watch of watches) {
    const key = buildThreadIdentityKey(watch.backend, watch.threadId);
    const items = byThread.get(key);
    if (items) items.push(watch);
    else byThread.set(key, [watch]);
  }
  const summaries = new Map<string, ThreadPrWatches>();
  for (const [key, items] of byThread) {
    items.sort((left, right) => left.createdAt - right.createdAt);
    const byPrKey = new Map<string, PrChipWatch>();
    for (const watch of items) {
      const current = byPrKey.get(watch.prKey) ?? {};
      byPrKey.set(watch.prKey, isCiWatch(watch)
        ? {
            ...current,
            ci: {
              ...(watch.baseline?.runAttempt !== undefined ? { runAttempt: watch.baseline.runAttempt } : {}),
              createdAt: watch.createdAt,
              notifyOn: watch.notifyOn,
            },
          }
        : { ...current, terminal: { createdAt: watch.createdAt } });
    }
    summaries.set(key, { watches: items, byPrKey });
  }
  return summaries;
}

const AUTO_FIX_ONLY: PrChipWatch = { autoFix: true };
// One object per watch entry, so a chip keeps its props across row renders.
const withAutoFixCache = new WeakMap<PrChipWatch, PrChipWatch>();

/**
 * The chip's `watch` prop. Identity is stable for unchanged data, so the
 * memoized chip bails out when only its row re-rendered.
 */
export function resolvePrChipWatch(
  watches: ThreadPrWatches | undefined,
  pr: PrSummary,
  autoFix: boolean,
): PrChipWatch | undefined {
  const base = watches?.byPrKey.get(buildPullRequestStatusKey(pr));
  // Auto-fix repairs open PRs only; it means nothing on a merged card.
  if (!autoFix || resolveLifecycleState(pr) !== "open") return base;
  if (!base) return AUTO_FIX_ONLY;
  let combined = withAutoFixCache.get(base);
  if (!combined) {
    combined = { ...base, autoFix: true };
    withAutoFixCache.set(base, combined);
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
    if (previous && sameWatches(previous.watches, entry.watches)) {
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
      && watch.baseline?.failedCheckUrl === other.baseline?.failedCheckUrl
      && watch.prTitle === other.prTitle;
  });
}
