import type { FederationTarget, NavigationThreadSummary, ScheduledThreadAction } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  buildThreadComposerScopeKey,
  type ComposerDraftStore,
  type ComposerQueuedTurnSnapshot,
} from "./useComposerDraftStore";

type ComposerDestination = { scopeKey: string };
const handoffTargets = new WeakMap<ComposerDraftStore, Map<string, ComposerDestination>>();
const attachmentListeners = new WeakMap<ComposerDraftStore, Set<(scopeKey: string) => void>>();

export function subscribeLaunchpadAttachmentHandoffs(
  store: ComposerDraftStore,
  listener: (scopeKey: string) => void,
): () => void {
  let listeners = attachmentListeners.get(store);
  if (!listeners) {
    listeners = new Set();
    attachmentListeners.set(store, listeners);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyLaunchpadAttachmentHandoff(store: ComposerDraftStore, scopeKey: string): void {
  for (const listener of attachmentListeners.get(store) ?? []) listener(scopeKey);
}

type ScheduledFirstActionEvidence = Pick<
  ScheduledThreadAction, "status" | "turnId" | "errorMessage" | "updatedAt"
>;
type ScheduledFirstActionState = {
  observed: Map<string, ScheduledFirstActionEvidence>;
  waiting: Map<string, (action: ScheduledFirstActionEvidence) => void>;
};
const scheduledFirstActions = new WeakMap<ComposerDraftStore, ScheduledFirstActionState>();

function scheduledFirstActionState(store: ComposerDraftStore): ScheduledFirstActionState {
  let state = scheduledFirstActions.get(store);
  if (!state) {
    state = { observed: new Map(), waiting: new Map() };
    scheduledFirstActions.set(store, state);
  }
  return state;
}

/** Retain positive admission evidence even if it arrives before materialization returns. */
export function observeLaunchpadScheduledAction(store: ComposerDraftStore, action: ScheduledThreadAction, target: FederationTarget = { scope: "local" }): void {
  if (!["started", "failed", "cancelled", "held"].includes(action.status)) return;
  const state = scheduledFirstActionState(store);
  const key = `${buildThreadComposerScopeKey(action.backend, action.threadId, target)}:${action.id}`;
  const previous = state.observed.get(key);
  if (previous && previous.updatedAt > action.updatedAt) return;
  state.observed.set(key, {
    status: action.status,
    turnId: action.turnId,
    errorMessage: action.errorMessage,
    updatedAt: action.updatedAt,
  });
  state.waiting.get(key)?.(action);
}

export function getLaunchpadComposerDestination(
  store: ComposerDraftStore,
  scopeKey: string,
): ComposerDestination {
  let targets = handoffTargets.get(store);
  if (!targets) {
    targets = new Map();
    handoffTargets.set(store, targets);
  }
  let destination = targets.get(scopeKey);
  if (!destination) {
    destination = { scopeKey };
    targets.set(scopeKey, destination);
  }
  return destination;
}

export function beginLaunchpadComposition(store: ComposerDraftStore, scopeKey: string): void {
  handoffTargets.get(store)?.delete(scopeKey);
  getLaunchpadComposerDestination(store, scopeKey);
}

export function resolveLaunchpadComposerScope(store: ComposerDraftStore, scopeKey: string): string {
  return handoffTargets.get(store)?.get(scopeKey)?.scopeKey ?? scopeKey;
}

/** Move local composition before navigation exposes the new thread. */
export function handoffLaunchpadComposer(
  store: ComposerDraftStore,
  directoryKey: string,
  thread: NavigationThreadSummary,
  desktopApi?: DesktopApi,
): void {
  const source = `launchpad:${directoryKey}`;
  const target = buildThreadComposerScopeKey(thread.source, thread.id, thread.federation?.ref.target ?? readRendererFederationTarget() ?? { scope: "local" });
  getLaunchpadComposerDestination(store, source).scopeKey = target;
  const draft = store.get(source);
  if (draft) {
    store.set(target, draft);
    store.delete(source);
  }
  const parked = [];
  for (let snapshot = store.popDraft(source); snapshot; snapshot = store.popDraft(source)) {
    parked.push(snapshot);
  }
  for (const snapshot of parked.reverse()) store.pushDraft(target, snapshot);

  const turnId = thread.optimisticActiveTurn?.id;
  const queued = store.getQueuedTurns(source).map((entry) => ({
    ...entry,
    // A failed first turn must be resolved before follow-ups can run.
    ...(!turnId && !thread.scheduledStart ? {
      manualReleaseRequired: true,
      holdReason: "Start the first message before releasing this follow-up.",
    } : {}),
    ...(!turnId && thread.scheduledStart ? {
      waitingForScheduledActionId: thread.scheduledStart.actionId,
    } : {}),
    ...(entry.steerWhenReady && turnId ? { backendQueuePending: true } : {}),
  }));
  store.setQueuedTurns(target, [...store.getQueuedTurns(target), ...queued]);
  store.deleteQueuedTurn(source);

  // Capture the owning thread, never the current selection. The operator may
  // have navigated away while setup ran. Failed/ambiguous submissions stay
  // held for explicit recovery rather than being sent a second time.
  const steer = async (entry: ComposerQueuedTurnSnapshot, expectedTurnId = turnId): Promise<void> => {
    const update = (patch: Partial<ComposerQueuedTurnSnapshot>): void => {
      store.setQueuedTurns(target, store.getQueuedTurns(target).map((current) =>
        current.id === entry.id ? { ...current, ...patch } : current,
      ));
    };
    try {
      if (!desktopApi?.steerTurn || !expectedTurnId || !entry.input?.length) {
        throw new Error("Steering is unavailable. Edit this message to send it again.");
      }
      const response = await desktopApi.steerTurn({
        backend: thread.source,
        federationTarget: thread.federation?.ref.target ?? readRendererFederationTarget(),
        threadId: thread.id,
        expectedTurnId,
        requestId: entry.id,
        input: entry.input,
        fallback: {
          displayText: entry.text,
          imageAttachments: entry.imageAttachments,
          fileAttachments: entry.fileAttachments,
          turn: {
            input: entry.input,
            executionMode: thread.executionMode,
            model: thread.model,
            reasoningEffort: thread.reasoningEffort,
            serviceTier: thread.serviceTier,
            fastMode: thread.fastMode,
          },
        },
      });
      if (response.scheduledAction?.status === "failed") {
        throw new Error(response.scheduledAction.errorMessage ?? "The follow-up could not be dispatched.");
      }
      if (response.disposition === "held" || response.disposition === "scheduled") {
        update({
          backendQueuePending: false,
          steerWhenReady: false,
          queueEntryId: response.queueEntryId,
          scheduledActionId: response.scheduledAction?.id,
          manualReleaseRequired: response.disposition === "held",
          holdReason: response.holdReason,
        });
      } else {
        store.removeQueuedTurnById(target, entry.id);
      }
    } catch (error) {
      update({
        backendQueuePending: false,
        steerWhenReady: false,
        manualReleaseRequired: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (!turnId && thread.scheduledStart && queued.length > 0) {
    const state = scheduledFirstActionState(store);
    const actionId = thread.scheduledStart.actionId;
    const key = `${target}:${actionId}`;
    const settle = (action: ScheduledFirstActionEvidence): void => {
      const steers: ComposerQueuedTurnSnapshot[] = [];
      store.setQueuedTurns(target, store.getQueuedTurns(target).map((entry) => {
        if (entry.waitingForScheduledActionId !== actionId) return entry;
        const admitted = action.status === "started";
        const steerReady = admitted && entry.steerWhenReady && action.turnId;
        const next = {
          ...entry,
          waitingForScheduledActionId: undefined,
          ...(steerReady ? { backendQueuePending: true } : {}),
          ...(!admitted ? {
            manualReleaseRequired: true,
            holdReason: action.errorMessage ?? "The scheduled first message did not start. Edit this follow-up to send it.",
          } : {}),
        };
        if (steerReady) steers.push(next);
        return next;
      }));
      state.waiting.delete(key);
      void (async () => {
        for (const entry of steers) await steer(entry, action.turnId);
      })();
    };
    state.waiting.set(key, settle);
    const observed = state.observed.get(key);
    if (observed) settle(observed);
  }
  void (async () => {
    for (const entry of queued) {
      if (entry.steerWhenReady && turnId) await steer(entry);
    }
  })();
}
