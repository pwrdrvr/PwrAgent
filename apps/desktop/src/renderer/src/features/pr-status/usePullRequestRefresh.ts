import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { resolveFetchableDirectoryPaths } from "./resolveFetchableDirectoryPaths";
import type { DesktopApi } from "../../lib/desktop-api";

const SELECTED_REFRESH_INTERVAL_MS = 60_000;

/**
 * Drives focused-trigger PR refreshes:
 *
 *   - **Selection**: refresh the selected thread immediately when it
 *     changes (fires `--state all` so terminal-state PRs are caught
 *     before the persisted overlay locks the chip in).
 *   - **60s tick**: while a thread is selected, re-poll every 60s. Main
 *     short-circuits if the persisted PR is already terminal, so this
 *     is cheap once a PR merges.
 *   - **Hover prefetch**: exposed via `prefetch(thread)` for thread
 *     rows to call after a 750ms hover delay.
 *
 * Does not store PR data in renderer state — the navigation snapshot
 * already surfaces persisted overlay PRs through `thread.prs`. This
 * hook only owns *when* to ask main for a refresh.
 */
export function usePullRequestRefresh(params: {
  desktopApi?: DesktopApi;
  onRefreshNavigation?: () => Promise<void>;
  selectedThread?: NavigationThreadSummary;
}): { prefetch: (thread: NavigationThreadSummary) => void } {
  const desktopApi = params.desktopApi;
  const onRefreshNavigation = params.onRefreshNavigation;
  const refresh = useCallback(
    (thread: NavigationThreadSummary): void => {
      if (!desktopApi?.refreshThreadPullRequests) return;
      const branch = resolvePullRequestLookupBranch(thread);
      if (!branch) return;
      const directoryPaths = resolveFetchableDirectoryPaths(thread.linkedDirectories);
      if (directoryPaths.length === 0) return;
      void desktopApi
        .refreshThreadPullRequests({
          backend: thread.source,
          threadId: thread.id,
          branch,
          directoryPaths,
        })
        .then((response) => {
          if (prSummariesEqual(thread.prs, response.prs)) {
            return;
          }
          void onRefreshNavigation?.();
        })
        .catch(() => {
          // Logged in main — keep the renderer silent.
        });
    },
    [desktopApi, onRefreshNavigation],
  );

  const selected = params.selectedThread;
  const selectedRef = useRef<NavigationThreadSummary | undefined>(selected);
  const selectedRefreshKey = useMemo(
    () => selected ? buildRefreshRequestKey(selected) : undefined,
    [selected],
  );

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Selection trigger + 60s ticker: collapse into a single effect keyed on
  // the selected thread's fetchable PR request. Re-running on every
  // snapshot would burn fetches needlessly — the snapshot mutates during
  // live agent activity even when the selected thread's branch and
  // directories are unchanged.
  useEffect(() => {
    if (!selectedRefreshKey) return;
    const refreshSelected = (): void => {
      const currentSelected = selectedRef.current;
      if (!currentSelected) return;
      if (buildRefreshRequestKey(currentSelected) !== selectedRefreshKey) return;
      refresh(currentSelected);
    };

    refreshSelected();
    const intervalId = window.setInterval(() => {
      refreshSelected();
    }, SELECTED_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedRefreshKey, refresh]);

  // Hover prefetch: dedupe so a flood of mouseenter events for the same
  // thread doesn't trigger a flood of gh subprocesses.
  const inflightKeysRef = useRef<Set<string>>(new Set());
  const prefetch = useCallback(
    (thread: NavigationThreadSummary): void => {
      const key = buildThreadIdentityKey(thread.source, thread.id);
      if (inflightKeysRef.current.has(key)) return;
      inflightKeysRef.current.add(key);
      try {
        refresh(thread);
      } finally {
        // Allow another prefetch attempt after the typical 60s tick window.
        // We don't wait for the IPC to resolve — main absorbs the duplicate
        // call cost via the cached gh-version probe + terminal short-circuit.
        window.setTimeout(() => {
          inflightKeysRef.current.delete(key);
        }, SELECTED_REFRESH_INTERVAL_MS);
      }
    },
    [refresh],
  );

  return { prefetch };
}

function buildRefreshRequestKey(thread: NavigationThreadSummary): string | undefined {
  const branch = resolvePullRequestLookupBranch(thread);
  if (!branch) return undefined;

  const directoryPaths = resolveFetchableDirectoryPaths(thread.linkedDirectories);
  if (directoryPaths.length === 0) return undefined;

  return JSON.stringify({
    threadKey: buildThreadIdentityKey(thread.source, thread.id),
    branch,
    directoryPaths,
  });
}

function resolvePullRequestLookupBranch(
  thread: NavigationThreadSummary,
): string | undefined {
  return thread.observedGitBranch?.trim() || thread.gitBranch?.trim() || undefined;
}

function prSummariesEqual(
  left: NavigationThreadSummary["prs"],
  right: PrSummary[],
): boolean {
  const leftPrs = left ?? [];
  if (leftPrs.length !== right.length) {
    return false;
  }

  return leftPrs.every((pr, index) => {
    const candidate = right[index];
    return (
      candidate?.number === pr.number &&
      candidate.org === pr.org &&
      candidate.repo === pr.repo &&
      candidate.state === pr.state &&
      candidate.url === pr.url
    );
  });
}
