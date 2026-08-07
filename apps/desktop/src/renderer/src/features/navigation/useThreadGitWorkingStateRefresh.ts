import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

const SELECTED_REFRESH_INTERVAL_MS = 60_000;
const USER_REFRESH_COOLDOWN_MS = 10_000;

/**
 * Keeps the selected thread's Git chips on a focused refresh tier and exposes
 * a user-triggered hover prefetch. The broad navigation refresh remains a
 * bounded slow lane; these requests target only the worktree being inspected.
 */
export function useThreadGitWorkingStateRefresh(params: {
  desktopApi?: DesktopApi;
  selectedThread?: NavigationThreadSummary;
}): { prefetch: (thread: NavigationThreadSummary) => void } {
  const desktopApi = params.desktopApi;
  const isFederationWindow = Boolean(readRendererFederationTarget());
  const refresh = useCallback(
    (
      thread: NavigationThreadSummary,
      trigger: "scheduled" | "user",
    ): void => {
      if (!desktopApi?.refreshThreadGitWorkingState) return;
      if (isFederationWindow || isRemoteFederatedThread(thread)) return;
      if (!resolveWorkingStatePath(thread)) return;
      void desktopApi.refreshThreadGitWorkingState({
        backend: thread.source,
        threadId: thread.id,
        trigger,
      }).catch(() => {
        // Logged in main — keep the renderer silent.
      });
    },
    [desktopApi, isFederationWindow],
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
  useEffect(() => {
    if (!selectedRefreshKey) return;
    const refreshSelected = (): void => {
      const currentSelected = selectedRef.current;
      if (!currentSelected) return;
      if (buildRefreshRequestKey(currentSelected) !== selectedRefreshKey) return;
      refresh(currentSelected, "scheduled");
    };

    refreshSelected();
    const intervalId = window.setInterval(
      refreshSelected,
      SELECTED_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [refresh, selectedRefreshKey]);

  const lastUserRefreshAtByThreadKey = useRef(new Map<string, number>());
  const prefetch = useCallback(
    (thread: NavigationThreadSummary): void => {
      const key = buildThreadIdentityKey(thread.source, thread.id);
      const now = Date.now();
      const lastRefreshAt = lastUserRefreshAtByThreadKey.current.get(key);
      if (
        lastRefreshAt !== undefined
        && now - lastRefreshAt < USER_REFRESH_COOLDOWN_MS
      ) {
        return;
      }
      lastUserRefreshAtByThreadKey.current.set(key, now);
      refresh(thread, "user");
    },
    [refresh],
  );

  return { prefetch };
}

function buildRefreshRequestKey(
  thread: NavigationThreadSummary,
): string | undefined {
  const worktreePath = resolveWorkingStatePath(thread);
  if (!worktreePath) return undefined;
  return JSON.stringify({
    threadKey: buildThreadIdentityKey(thread.source, thread.id),
    worktreePath,
  });
}

function resolveWorkingStatePath(
  thread: NavigationThreadSummary,
): string | undefined {
  const projectKey = thread.projectKey?.trim();
  if (projectKey) return projectKey;
  return thread.linkedDirectories.find((directory) =>
    Boolean(directory.worktreePath?.trim())
  )?.worktreePath?.trim();
}

function isRemoteFederatedThread(thread: NavigationThreadSummary): boolean {
  const target = thread.federation?.ref.target;
  return Boolean(target && isRemoteFederationTarget(target));
}
