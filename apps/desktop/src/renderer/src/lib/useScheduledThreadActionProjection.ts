import { buildThreadComposerScopeKey } from "../features/composer/useComposerDraftStore";
import { observeLaunchpadScheduledAction } from "../features/composer/launchpad-composer-handoff";
import { useEffect, useReducer } from "react";
import type { FederationTarget, ScheduledThreadAction } from "@pwragent/shared";
import type { ComposerDraftStore } from "../features/composer/useComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import { readScheduledActionProjection } from "./read-scheduled-action-projection";
import { navigationScheduledProjectionBudget } from "./navigation-metadata-budget";
import { resolveComposerScopeOwner } from "../features/composer/useOwnedComposerDraftStore";

let nextScheduledProjection = 0;

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
  const [, scopesChanged] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const owners = (): string => JSON.stringify([...new Set(params.composerDraftStore.getQueuedScopeKeys().map((scope) => {
      const resolved = resolveComposerScopeOwner(params.composerDraftStore, scope);
      return resolved.state === "known" ? JSON.stringify(resolved.owner.target) : "";
    }).filter(Boolean))].sort());
    let previous = owners();
    return params.composerDraftStore.subscribeQueuedTurns(() => {
      const next = owners();
      if (next !== previous) { previous = next; scopesChanged(); }
    });
  }, [params.composerDraftStore]);
  const sources = [...(params.sources ?? [{
    federationTarget: params.federationTarget, suspended: params.suspended,
  }])];
  for (const scope of params.composerDraftStore.getQueuedScopeKeys()) {
    const resolved = resolveComposerScopeOwner(params.composerDraftStore, scope);
    if (resolved.state !== "known") continue;
    if (!sources.some((source) => federationTargetsEqual(source.federationTarget, resolved.owner.target))) {
      sources.push({ federationTarget: resolved.owner.target });
    }
  }
  const sourcesJson = JSON.stringify(
    sources,
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
  let running = false;
  let dirty = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetKey = `scheduled:${++nextScheduledProjection}`;
  const controller = new AbortController();

  const refresh = async (): Promise<void> => {
    if (running) { dirty = true; refreshSequence += 1; return; }
    running = true;
    const sequence = refreshSequence + 1;
    refreshSequence = sequence;
    let allocation: ReturnType<typeof navigationScheduledProjectionBudget.begin> | undefined;
    try {
      allocation = navigationScheduledProjectionBudget.begin(budgetKey);
      const response = await readScheduledActionProjection({
        request: { federationTarget: params.federationTarget,
          ...(terminalUpdatedAfter === undefined ? { includeFailed: true } : { terminalUpdatedAfter }),
        },
        read: (request) => params.listScheduledThreadActions(request, budgetKey),
        signal: controller.signal,
        allocation,
        isCancelled: () => cancelled || sequence !== refreshSequence,
      });
      if (cancelled || sequence !== refreshSequence) return;
      // Retained failed actions survive subsequent terminal windows and must
      // remain charged when the new response no longer includes them.
      const responseIds = new Set(response.actions.map((action) => action.id));
      for (const action of projectedFailures.values()) if (!responseIds.has(action.id)) {
        allocation.reserve(new TextEncoder().encode(JSON.stringify(action)).byteLength);
      }
      allocation.commit();
      terminalUpdatedAfter = response.observedAt ?? Date.now();
      for (const [actionId, action] of projectedFailures) {
        const stillProjected = params.composerDraftStore
          .getQueuedTurns(scopeKeyForAction(action, params.federationTarget))
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
        params.federationTarget,
      );
      lastWarnedFailure = undefined;
    } catch (error) {
      if (cancelled || sequence !== refreshSequence) return;
      // A persistent failure (peer offline, backend down) repeats on
      // every 5s reconciliation tick — warn once per distinct failure
      // instead of spamming the console/log for the same condition.
      const message = error instanceof Error ? error.message : String(error);
      if (lastWarnedFailure !== message) {
        lastWarnedFailure = message;
        console.warn("Failed to load scheduled thread actions", error);
      }
    } finally {
      allocation?.dispose();
      running = false;
      if (dirty && !cancelled) { dirty = false; schedule(); }
    }
  };
  const schedule = (): void => {
    if (cancelled || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 100);
  };

  void refresh();
  const unsubscribe = params.desktopApi.onAgentEvent?.((event) => {
    if (event.notification.method === "federation/peerStatus/changed"
      && params.federationTarget?.scope === "remote"
      && event.notification.params.instanceId === params.federationTarget.instanceId
      && event.notification.params.status === "connected") { schedule(); return; }
    if (event.notification.method === "navigation/invalidated"
      && event.notification.params.sourceMethod === "thread/scheduledAction/updated"
      && federationTargetsEqual(event.federationTarget, params.federationTarget)) {
      refreshSequence += 1;
      schedule();
      return;
    }
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
        params.federationTarget,
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
      refreshSequence += 1;
      schedule();
    }
  });
  return () => {
    cancelled = true;
    controller.abort();
    void params.desktopApi.releaseNavigationQuery?.(budgetKey);
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    navigationScheduledProjectionBudget.release(budgetKey);
    unsubscribe?.();
  };
}

export function syncScheduledActionProjections(
  store: ComposerDraftStore,
  actions: readonly ScheduledThreadAction[],
  previousScopeKeys: ReadonlySet<string> = new Set(),
  target: FederationTarget = { scope: "local" },
): Set<string> {
  const byScope = new Map<string, ScheduledThreadAction[]>();
  for (const action of actions) {
    observeLaunchpadScheduledAction(store, action, target);
    if (!isProjectableAction(action)) continue;
    const scopeKey = scopeKeyForAction(action, target);
    const current = byScope.get(scopeKey) ?? [];
    current.push(action);
    byScope.set(scopeKey, current);
  }

  const projectedScopes = new Set(previousScopeKeys);
  for (const action of actions) {
    projectedScopes.add(scopeKeyForAction(action, target));
  }
  for (const scopeKey of projectedScopes) {
    const current = store.getQueuedTurns(scopeKey);
    const scopedActions = (byScope.get(scopeKey) ?? [])
      .sort((left, right) => left.scheduledFor - right.scheduledFor);
    const actionsById = new Map(
      scopedActions.map((action) => [action.id, action]),
    );
    const projectionsById = new Map(
      scopedActions.map((action) => [action.id, projectionFromAction(action)]),
    );
    const scheduledQueueEntryIds = new Set(
      scopedActions
        .map((action) => action.queueEntryId)
        .filter((queueEntryId): queueEntryId is string => Boolean(queueEntryId)),
    );
    const placedHeldActions = new Set<string>();
    const reconciledCurrent = current.flatMap((entry) => {
      const actionId = entry.scheduledActionId ?? entry.failedScheduledActionId;
      if (actionId) {
        const action = actionsById.get(actionId);
        const projection = projectionsById.get(actionId);
        if (action?.status === "held" && projection) {
          placedHeldActions.add(actionId);
          return [projection];
        }
        return [];
      }
      if (
        entry.queueEntryId
        && scheduledQueueEntryIds.has(entry.queueEntryId)
      ) {
        return [];
      }
      return [entry];
    });
    const newHeld = scopedActions
      .filter(
        (action) =>
          action.status === "held" && !placedHeldActions.has(action.id),
      )
      .sort((left, right) => {
        const leftIsUnqueued = !left.queueEntryId;
        const rightIsUnqueued = !right.queueEntryId;
        if (leftIsUnqueued !== rightIsUnqueued) {
          return leftIsUnqueued ? -1 : 1;
        }
        return leftIsUnqueued
          ? right.updatedAt - left.updatedAt
          : left.scheduledFor - right.scheduledFor;
      })
      .map(projectionFromAction);
    const scheduled = scopedActions
      .filter((action) => action.status !== "held")
      .map(projectionFromAction);
    store.setQueuedTurns(
      scopeKey,
      [...newHeld, ...reconciledCurrent, ...scheduled],
    );
  }
  return new Set(byScope.keys());
}

export function applyScheduledActionProjection(
  store: ComposerDraftStore,
  action: ScheduledThreadAction,
  target: FederationTarget = { scope: "local" },
): void {
  observeLaunchpadScheduledAction(store, action, target);
  const scopeKey = scopeKeyForAction(action, target);
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
    const currentIndex = current.findIndex(
      (entry) => entry.scheduledActionId === action.id,
    );
    const insertionIndex =
      action.status === "held" && !action.queueEntryId
        ? 0
        : currentIndex >= 0
          ? currentIndex
          : withoutAction.length;
    store.setQueuedTurns(scopeKey, [
      ...withoutAction.slice(0, insertionIndex),
      projectionFromAction(action),
      ...withoutAction.slice(insertionIndex),
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
    ...((action.status === "held" || action.status === "queued")
      && action.queueEntryId
      ? { queueEntryId: action.queueEntryId }
      : {}),
    ...(action.status === "held" || action.manualReleaseRequired
      ? {
          manualReleaseRequired: true,
          holdReason:
            action.errorMessage
            ?? "The turn ended before this steering message could be delivered.",
        }
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
  return ["held", "scheduled", "dispatching", "queued", "failed"].includes(
    action.status,
  );
}

function scopeKeyForAction(action: ScheduledThreadAction, target: FederationTarget = { scope: "local" }): string {
  return buildThreadComposerScopeKey(action.backend, action.threadId, target);
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
