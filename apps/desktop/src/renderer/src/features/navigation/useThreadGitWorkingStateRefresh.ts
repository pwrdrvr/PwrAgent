import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  FederationRemoteTarget,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { resolveThreadWorkingStatePath } from "../../lib/thread-working-state-path";

const SELECTED_REFRESH_INTERVAL_MS = 60_000;
const USER_REFRESH_COOLDOWN_MS = 10_000;

/**
 * Keeps the selected thread's Git chips on a focused refresh tier and exposes
 * a user-triggered hover prefetch. The broad navigation refresh remains a
 * bounded slow lane; these requests target only the worktree being inspected.
 *
 * A remote thread's worktree lives on its owner, so the request goes there.
 * The owner's Git info store decides whether anything probes, and its update
 * event comes back only when the state changed.
 */
export function useThreadGitWorkingStateRefresh(params: {
  desktopApi?: DesktopApi;
  selectedThread?: NavigationThreadSummary;
}): { prefetch: (thread: NavigationThreadSummary) => void } {
  const desktopApi = params.desktopApi;
  const federationWindowInstanceId =
    readRendererFederationTarget()?.instanceId;
  const refresh = useCallback(
    (
      thread: NavigationThreadSummary,
      trigger: "scheduled" | "user",
    ): void => {
      if (!desktopApi?.refreshThreadGitWorkingState) return;
      if (!resolveThreadWorkingStatePath(thread)) return;
      const federationTarget = resolveWorkingStateFederationTarget(
        thread,
        federationWindowInstanceId,
      );
      void desktopApi.refreshThreadGitWorkingState({
        backend: thread.source,
        threadId: thread.id,
        trigger,
        ...(federationTarget ? { federationTarget } : {}),
      }).catch(() => {
        // Logged in main — keep the renderer silent.
      });
    },
    [desktopApi, federationWindowInstanceId],
  );

  const selected = params.selectedThread;
  const selectedRef = useRef<NavigationThreadSummary | undefined>(selected);
  const selectedRefreshKey = useMemo(
    () => selected
      ? buildRefreshRequestKey(selected, federationWindowInstanceId)
      : undefined,
    [federationWindowInstanceId, selected],
  );
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    if (!selectedRefreshKey) return;
    const refreshSelected = (): void => {
      const currentSelected = selectedRef.current;
      if (!currentSelected) return;
      if (
        buildRefreshRequestKey(currentSelected, federationWindowInstanceId)
        !== selectedRefreshKey
      ) return;
      refresh(currentSelected, "scheduled");
    };

    refreshSelected();
    const intervalId = window.setInterval(
      refreshSelected,
      SELECTED_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [federationWindowInstanceId, refresh, selectedRefreshKey]);

  const lastUserRefreshAtByThreadKey = useRef(new Map<string, number>());
  const prefetch = useCallback(
    (thread: NavigationThreadSummary): void => {
      const key = buildWorkingStateThreadKey(thread, federationWindowInstanceId);
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
    [federationWindowInstanceId, refresh],
  );

  return { prefetch };
}

function buildRefreshRequestKey(
  thread: NavigationThreadSummary,
  federationWindowInstanceId?: string,
): string | undefined {
  const worktreePath = resolveThreadWorkingStatePath(thread);
  if (!worktreePath) return undefined;
  return JSON.stringify({
    threadKey: buildWorkingStateThreadKey(thread, federationWindowInstanceId),
    worktreePath,
  });
}

function buildWorkingStateThreadKey(
  thread: NavigationThreadSummary,
  federationWindowInstanceId?: string,
): string {
  const federationTarget = resolveWorkingStateFederationTarget(
    thread,
    federationWindowInstanceId,
  );
  return `${federationTarget?.instanceId ?? "local"}:${buildThreadIdentityKey(
    thread.source,
    thread.id,
  )}`;
}

function resolveWorkingStateFederationTarget(
  thread: NavigationThreadSummary,
  federationWindowInstanceId?: string,
): FederationRemoteTarget | undefined {
  const threadTarget = thread.federation?.ref.target;
  if (threadTarget && isRemoteFederationTarget(threadTarget)) {
    return threadTarget;
  }
  return federationWindowInstanceId
    ? { scope: "remote", instanceId: federationWindowInstanceId }
    : undefined;
}
