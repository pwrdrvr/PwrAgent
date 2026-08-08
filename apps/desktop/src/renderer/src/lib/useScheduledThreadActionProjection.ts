import { useEffect } from "react";
import type { FederationTarget, ScheduledThreadAction } from "@pwragent/shared";
import type { ComposerDraftStore } from "../features/composer/useComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";

const SCHEDULED_ACTION_RECONCILIATION_INTERVAL_MS = 5_000;

export type ScheduledThreadActionProjectionSource = {
  federationTarget?: FederationTarget;
  suspended?: boolean;
};

export function useScheduledThreadActionProjection(params: {
  composerDraftStore: ComposerDraftStore;
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
  onThreadLifecycleChanged?: () => void;
  sources?: readonly ScheduledThreadActionProjectionSource[];
  /**
   * True while the federation peer behind `federationTarget` is
   * unreachable. Suspends the reconciliation poll so a disconnected
   * remote window doesn't hammer the dead peer with a failing RPC (and
   * a console warning) every five seconds; resuming re-runs the effect
   * and refreshes immediately.
   */
  suspended?: boolean;
}): void {
  const sourcesJson = JSON.stringify(
    params.sources ?? [{
      federationTarget: params.federationTarget,
      suspended: params.suspended,
    }],
  );

  useEffect(() => {
    const desktopApi = params.desktopApi;
    const listScheduledThreadActions = desktopApi?.listScheduledThreadActions;
    if (!desktopApi || !listScheduledThreadActions) return;
    const sources = JSON.parse(
      sourcesJson,
    ) as ScheduledThreadActionProjectionSource[];
    const cleanups = sources
      .filter((source) => !source.suspended)
      .map((source) => startScheduledThreadActionProjection({
        composerDraftStore: params.composerDraftStore,
        desktopApi,
        federationTarget: source.federationTarget,
        listScheduledThreadActions,
        onThreadLifecycleChanged: params.onThreadLifecycleChanged,
      }));
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    params.composerDraftStore,
    params.desktopApi,
    params.onThreadLifecycleChanged,
    sourcesJson,
  ]);
}

function startScheduledThreadActionProjection(params: {
  composerDraftStore: ComposerDraftStore;
  desktopApi: DesktopApi;
  federationTarget?: FederationTarget;
  listScheduledThreadActions: NonNullable<DesktopApi["listScheduledThreadActions"]>;
  onThreadLifecycleChanged?: () => void;
}): () => void {
  let refreshSequence = 0;
  let projectedScopeKeys = new Set<string>();
  const projectedFailures = new Map<string, ScheduledThreadAction>();
  const dismissedFailures = new Set<string>();
  let terminalUpdatedAfter: number | undefined;
  let lastWarnedFailure: string | undefined;
  let cancelled = false;

  const refresh = async (): Promise<void> => {
    const sequence = refreshSequence + 1;
    refreshSequence = sequence;
    try {
      const response = await params.listScheduledThreadActions({
        federationTarget: params.federationTarget,
        ...(terminalUpdatedAfter === undefined
          ? { includeFailed: true }
          : { terminalUpdatedAfter }),
      });
      if (cancelled || sequence !== refreshSequence) return;
      terminalUpdatedAfter = response.observedAt ?? Date.now();
      for (const [actionId, action] of projectedFailures) {
        const stillProjected = params.composerDraftStore
          .getQueuedTurns(scopeKeyForAction(action))
          .some((entry) => entry.failedScheduledActionId === actionId);
        if (!stillProjected) {
          dismissedFailures.add(actionId);
          projectedFailures.delete(actionId);
        }
      }
      for (const action of response.actions) {
        if (
          action.status === "failed"
          && !dismissedFailures.has(action.id)
        ) {
          projectedFailures.set(action.id, action);
        }
      }
      const visibleActions = [
        ...response.actions.filter((action) => action.status !== "failed"),
        ...projectedFailures.values(),
      ];
      projectedScopeKeys = syncScheduledActionProjections(
        params.composerDraftStore,
        visibleActions,
        projectedScopeKeys,
      );
      lastWarnedFailure = undefined;
    } catch (error) {
      // A persistent failure (peer offline, backend down) repeats on
      // every 5s reconciliation tick — warn once per distinct failure
      // instead of spamming the console/log for the same condition.
      const message = error instanceof Error ? error.message : String(error);
      if (lastWarnedFailure !== message) {
        lastWarnedFailure = message;
        console.warn("Failed to load scheduled thread actions", error);
      }
    }
  };

  void refresh();
  const unsubscribe = params.desktopApi.onAgentEvent?.((event) => {
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
        projectedFailures.set(action.id, action);
      } else {
        projectedFailures.delete(action.id);
      }
      if (
        action.status === "started"
        || action.status === "cancelled"
        || action.status === "failed"
      ) {
        params.onThreadLifecycleChanged?.();
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
    const scheduled = (byScope.get(scopeKey) ?? [])
      .sort((left, right) => left.scheduledFor - right.scheduledFor)
      .map(projectionFromAction);
    const scheduledQueueEntryIds = new Set(
      scheduled
        .map((entry) => entry.queueEntryId)
        .filter((queueEntryId): queueEntryId is string => Boolean(queueEntryId)),
    );
    const local = store.getQueuedTurns(scopeKey).filter(
      (entry) =>
        !entry.scheduledActionId
        && !entry.failedScheduledActionId
        && (
          !entry.queueEntryId
          || !scheduledQueueEntryIds.has(entry.queueEntryId)
        ),
    );
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
      && entry.failedScheduledActionId !== action.id
      && (
        !action.queueEntryId
        || entry.queueEntryId !== action.queueEntryId
      ),
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
            // A scheduled review can also be released client-side, so the
            // picked reviewer has to survive the round trip through this
            // projection or that release runs on the thread's own provider.
            ...(action.review.reviewBackend
              ? {
                  reviewer: {
                    backend: action.review.reviewBackend,
                    ...(action.review.model
                      ? { model: action.review.model }
                      : {}),
                    ...(action.review.reasoningEffort
                      ? { reasoningEffort: action.review.reasoningEffort }
                      : {}),
                  },
                }
              : {}),
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
