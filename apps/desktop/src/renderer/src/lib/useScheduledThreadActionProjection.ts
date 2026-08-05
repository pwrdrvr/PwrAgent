import { useEffect, useRef } from "react";
import type { FederationTarget, ScheduledThreadAction } from "@pwragent/shared";
import type { ComposerDraftStore } from "../features/composer/useComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";

const SCHEDULED_ACTION_RECONCILIATION_INTERVAL_MS = 5_000;

export function useScheduledThreadActionProjection(params: {
  composerDraftStore: ComposerDraftStore;
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
  /**
   * True while the federation peer behind `federationTarget` is
   * unreachable. Suspends the reconciliation poll so a disconnected
   * remote window doesn't hammer the dead peer with a failing RPC (and
   * a console warning) every five seconds; resuming re-runs the effect
   * and refreshes immediately.
   */
  suspended?: boolean;
}): void {
  const refreshSequenceRef = useRef(0);
  const projectedScopeKeysRef = useRef<Set<string>>(new Set());
  const projectedFailuresRef = useRef<Map<string, ScheduledThreadAction>>(new Map());
  const dismissedFailuresRef = useRef<Set<string>>(new Set());
  const terminalUpdatedAfterRef = useRef<number | undefined>(undefined);
  const lastWarnedFailureRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const desktopApi = params.desktopApi;
    if (!desktopApi?.listScheduledThreadActions) return;
    if (params.suspended) return;
    let cancelled = false;

    const refresh = async (): Promise<void> => {
      const sequence = refreshSequenceRef.current + 1;
      refreshSequenceRef.current = sequence;
      try {
        const terminalUpdatedAfter = terminalUpdatedAfterRef.current;
        const response = await desktopApi.listScheduledThreadActions!({
          federationTarget: params.federationTarget,
          ...(terminalUpdatedAfter === undefined
            ? { includeFailed: true }
            : { terminalUpdatedAfter }),
        });
        if (cancelled || sequence !== refreshSequenceRef.current) return;
        terminalUpdatedAfterRef.current = response.observedAt ?? Date.now();
        for (const [actionId, action] of projectedFailuresRef.current) {
          const stillProjected = params.composerDraftStore
            .getQueuedTurns(scopeKeyForAction(action))
            .some((entry) => entry.failedScheduledActionId === actionId);
          if (!stillProjected) {
            dismissedFailuresRef.current.add(actionId);
            projectedFailuresRef.current.delete(actionId);
          }
        }
        for (const action of response.actions) {
          if (
            action.status === "failed"
            && !dismissedFailuresRef.current.has(action.id)
          ) {
            projectedFailuresRef.current.set(action.id, action);
          }
        }
        const visibleActions = [
          ...response.actions.filter((action) => action.status !== "failed"),
          ...projectedFailuresRef.current.values(),
        ];
        projectedScopeKeysRef.current = syncScheduledActionProjections(
          params.composerDraftStore,
          visibleActions,
          projectedScopeKeysRef.current,
        );
        lastWarnedFailureRef.current = undefined;
      } catch (error) {
        // A persistent failure (peer offline, backend down) repeats on
        // every 5s reconciliation tick — warn once per distinct failure
        // instead of spamming the console/log for the same condition.
        const message = error instanceof Error ? error.message : String(error);
        if (lastWarnedFailureRef.current !== message) {
          lastWarnedFailureRef.current = message;
          console.warn("Failed to load scheduled thread actions", error);
        }
      }
    };

    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (event.notification.method === "thread/scheduledAction/updated") {
        if (!federationTargetsEqual(
          event.federationTarget,
          params.federationTarget,
        )) {
          return;
        }
        const action = (event.notification.params as { action?: unknown }).action;
        if (!isScheduledThreadAction(action)) return;
        applyScheduledActionProjection(
          params.composerDraftStore,
          action,
        );
        if (action.status === "failed") {
          projectedFailuresRef.current.set(action.id, action);
        } else {
          projectedFailuresRef.current.delete(action.id);
        }
        void refresh();
      }
    });
    const reconciliationTimer = setInterval(
      () => void refresh(),
      SCHEDULED_ACTION_RECONCILIATION_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(reconciliationTimer);
      unsubscribe?.();
    };
  }, [
    params.composerDraftStore,
    params.desktopApi,
    params.federationTarget,
  ]);
}

export function syncScheduledActionProjections(
  store: ComposerDraftStore,
  actions: readonly ScheduledThreadAction[],
  previousScopeKeys: ReadonlySet<string> = new Set(),
): Set<string> {
  const byScope = new Map<string, ScheduledThreadAction[]>();
  for (const action of actions) {
    if (!isProjectableAction(action)) continue;
    const scopeKey = scopeKeyForAction(action);
    const current = byScope.get(scopeKey) ?? [];
    current.push(action);
    byScope.set(scopeKey, current);
  }

  const projectedScopes = new Set(previousScopeKeys);
  for (const action of actions) {
    projectedScopes.add(scopeKeyForAction(action));
  }
  for (const scopeKey of projectedScopes) {
    const local = store.getQueuedTurns(scopeKey).filter(
      (entry) => !entry.scheduledActionId && !entry.failedScheduledActionId,
    );
    const scheduled = (byScope.get(scopeKey) ?? [])
      .sort((left, right) => left.scheduledFor - right.scheduledFor)
      .map(projectionFromAction);
    store.setQueuedTurns(scopeKey, [...local, ...scheduled]);
  }
  return new Set(byScope.keys());
}

export function applyScheduledActionProjection(
  store: ComposerDraftStore,
  action: ScheduledThreadAction,
): void {
  const scopeKey = scopeKeyForAction(action);
  const current = store.getQueuedTurns(scopeKey);
  const withoutAction = current.filter(
    (entry) =>
      entry.scheduledActionId !== action.id
      && entry.failedScheduledActionId !== action.id,
  );
  if (isProjectableAction(action)) {
    store.setQueuedTurns(scopeKey, [
      ...withoutAction,
      projectionFromAction(action),
    ]);
  } else {
    store.setQueuedTurns(scopeKey, withoutAction);
  }
}

function projectionFromAction(action: ScheduledThreadAction) {
  return {
    id: `scheduled-projection:${action.id}`,
    ...(action.status === "failed"
      ? {
          failedScheduledActionId: action.id,
          errorMessage:
            action.errorMessage ?? "The scheduled action could not be dispatched.",
        }
      : { scheduledActionId: action.id }),
    ...(action.status === "scheduled"
      ? { scheduledSendAt: action.scheduledFor }
      : {}),
    ...(action.status === "dispatching"
      ? { backendQueuePending: true }
      : {}),
    ...(action.status === "queued" && action.queueEntryId
      ? { queueEntryId: action.queueEntryId }
      : {}),
    input: action.turn?.input,
    text: action.review?.draftText ?? action.displayText,
    imageAttachments: action.imageAttachments ?? [],
    fileAttachments: action.fileAttachments ?? [],
    ...(action.review
      ? {
          reviewCommand: {
            cwd: action.review.cwd,
            displayText: action.displayText,
            target: action.review.target,
          },
        }
      : {}),
  };
}

function isProjectableAction(action: ScheduledThreadAction): boolean {
  return ["scheduled", "dispatching", "queued", "failed"].includes(
    action.status,
  );
}

function scopeKeyForAction(action: ScheduledThreadAction): string {
  return `thread:${action.backend}:${action.threadId}`;
}

function isScheduledThreadAction(value: unknown): value is ScheduledThreadAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScheduledThreadAction>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.backend === "string"
    && typeof candidate.threadId === "string"
    && typeof candidate.status === "string"
    && typeof candidate.scheduledFor === "number"
  );
}
