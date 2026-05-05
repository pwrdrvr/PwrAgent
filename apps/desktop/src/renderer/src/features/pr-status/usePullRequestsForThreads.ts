import { useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

const FETCH_DEBOUNCE_MS = 250;

/**
 * Lazy PR fetcher for visible thread rows. Walks the snapshot's threads,
 * issues `getThreadPullRequests` IPC for each thread that has a branch
 * but no cached PR data, and stashes the results in a per-thread map.
 *
 * Main-process side already enforces a 60s subprocess cache and gracefully
 * degrades when `gh` isn't installed, so this hook can fire as broadly as
 * needed — repeated calls are cheap.
 */
export function usePullRequestsForThreads(params: {
  desktopApi?: DesktopApi;
  threads: NavigationThreadSummary[];
}): { prsByThreadKey: Record<string, PrSummary[]> } {
  const [prsByThreadKey, setPrsByThreadKey] = useState<Record<string, PrSummary[]>>({});
  const fetchedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    const desktopApi = params.desktopApi;
    if (!desktopApi?.getThreadPullRequests) {
      return;
    }

    // Debounce: snapshots can re-render rapidly during inbox refresh — wait
    // a beat so we don't fire a flurry of identical IPC calls.
    const timeout = window.setTimeout(() => {
      void runFetch();
    }, FETCH_DEBOUNCE_MS);

    let cancelled = false;
    async function runFetch(): Promise<void> {
      const fetcher = desktopApi?.getThreadPullRequests;
      if (!fetcher) return;
      const targets = params.threads.filter((thread) => {
        if (!thread.gitBranch?.trim()) return false;
        if (thread.linkedDirectories.length === 0) return false;
        const key = buildThreadIdentityKey(thread.source, thread.id);
        return !fetchedKeysRef.current.has(key);
      });
      // Sequential to avoid spawning many gh processes simultaneously.
      for (const thread of targets) {
        if (cancelled) return;
        const key = buildThreadIdentityKey(thread.source, thread.id);
        fetchedKeysRef.current.add(key);
        try {
          const result = await fetcher({
            backend: thread.source,
            threadId: thread.id,
          });
          if (cancelled) return;
          setPrsByThreadKey((current) => ({
            ...current,
            [key]: result.prs,
          }));
        } catch {
          // Logged on the main side; fall back to silent on the renderer.
        }
      }
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [params.desktopApi, params.threads]);

  return { prsByThreadKey };
}
