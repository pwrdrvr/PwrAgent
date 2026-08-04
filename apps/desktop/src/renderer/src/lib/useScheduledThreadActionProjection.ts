import { useEffect, useRef } from "react";
import type { FederationTarget, ScheduledThreadAction } from "@pwragent/shared";
import type { ComposerDraftStore } from "../features/composer/useComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";

export function useScheduledThreadActionProjection(params: {
  composerDraftStore: ComposerDraftStore;
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
}): void {
  const refreshSequenceRef = useRef(0);
  const projectedScopeKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const desktopApi = params.desktopApi;
    if (!desktopApi?.listScheduledThreadActions) return;
    let cancelled = false;

    const refresh = async (): Promise<void> => {
      const sequence = refreshSequenceRef.current + 1;
      refreshSequenceRef.current = sequence;
      try {
        const response = await desktopApi.listScheduledThreadActions!({
          federationTarget: params.federationTarget,
        });
        if (cancelled || sequence !== refreshSequenceRef.current) return;
        projectedScopeKeysRef.current = syncScheduledActionProjections(
          params.composerDraftStore,
          response.actions,
          projectedScopeKeysRef.current,
        );
      } catch (error) {
        console.warn("Failed to load scheduled thread actions", error);
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
        void refresh();
      }
    });
    return () => {
      cancelled = true;
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
      (entry) => !entry.scheduledActionId,
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
    (entry) => entry.scheduledActionId !== action.id,
  );
  if (["scheduled", "dispatching", "queued"].includes(action.status)) {
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
    scheduledActionId: action.id,
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
