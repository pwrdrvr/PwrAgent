import { useCallback, useEffect, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
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
  selectedThread?: NavigationThreadSummary;
}): { prefetch: (thread: NavigationThreadSummary) => void } {
  const desktopApi = params.desktopApi;
  const refresh = useCallback(
    (thread: NavigationThreadSummary): void => {
      if (!desktopApi?.refreshThreadPullRequests) return;
      const branch = thread.gitBranch?.trim();
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
        .catch(() => {
          // Logged in main — keep the renderer silent.
        });
    },
    [desktopApi],
  );

  const selected = params.selectedThread;
  const selectedKey = selected
    ? buildThreadIdentityKey(selected.source, selected.id)
    : undefined;

  // Selection trigger + 60s ticker: collapse into a single effect keyed on
  // the selected thread's identity. Re-running on every snapshot would
  // burn fetches needlessly — the snapshot mutates on inbox refresh even
  // when the selected thread is unchanged.
  useEffect(() => {
    if (!selected) return;
    refresh(selected);
    const intervalId = window.setInterval(() => {
      refresh(selected);
    }, SELECTED_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [selected, selectedKey, refresh]);

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
