import { buildOwnedComposerScopeKey } from "@pwragent/shared";
import { useEffect, useRef } from "react";
import type {
  AgentEvent,
  AppServerTurnInputItem,
  BackendSummary,
  ComposerThreadOwner,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  getNextReleasableQueuedTurn,
  type ComposerDraftStore,
  type ComposerQueuedTurnSnapshot,
} from "../features/composer/useComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";
import { resolveComposerScopeOwner } from "../features/composer/useOwnedComposerDraftStore";
import { readCompleteNavigationQueue } from "./navigation-queue-projection";
import { applyNavigationSelectedDetail, selectNavigationIdentity } from "./navigation-query-state";
import { federationTargetsEqual } from "./federated-thread-events";

type ModelOption = NonNullable<
  NonNullable<BackendSummary["launchpadOptions"]>["models"]
>[number];

const TERMINAL_TURN_METHODS = new Set([
  "turn/completed",
  "turn/failed",
  "turn/cancelled",
]);
const BACKGROUND_QUEUE_RELEASE_INTERVAL_MS = 30_000;
const globalInFlightScopeKeys = new Set<string>();

function getDefaultModelOption(backend?: BackendSummary): ModelOption | undefined {
  const models = backend?.launchpadOptions?.models ?? [];
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

function getReasoningEffortsForModel(
  backend: BackendSummary | undefined,
  model: ModelOption | undefined,
): string[] {
  return model?.reasoningEfforts ?? backend?.launchpadOptions?.reasoningEfforts ?? [];
}

function getDefaultReasoningEffort(
  backend: BackendSummary | undefined,
  model: ModelOption | undefined,
): string | undefined {
  const reasoningEfforts = getReasoningEffortsForModel(backend, model);
  if (
    model?.defaultReasoningEffort &&
    reasoningEfforts.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort;
  }
  return reasoningEfforts.includes("medium") ? "medium" : reasoningEfforts[0];
}

function getReasoningEffortValue(
  backend: BackendSummary | undefined,
  model: ModelOption | undefined,
  currentValue: string | undefined,
): string | undefined {
  const reasoningEfforts = getReasoningEffortsForModel(backend, model);
  return reasoningEfforts.includes(currentValue ?? "")
    ? currentValue
    : getDefaultReasoningEffort(backend, model);
}

function buildQueuedTurnInput(
  queuedTurn: ComposerQueuedTurnSnapshot,
): AppServerTurnInputItem[] {
  if (queuedTurn.input?.length) {
    return queuedTurn.input;
  }

  return [
    ...(queuedTurn.text.trim()
      ? [{ type: "text" as const, text: queuedTurn.text.trim() }]
      : []),
    ...queuedTurn.imageAttachments.map((attachment) => ({
      type: "image" as const,
      url: attachment.url,
    })),
  ];
}

function restoreQueuedTurn(
  composerDraftStore: ComposerDraftStore,
  scopeKey: string,
  queuedTurn: ComposerQueuedTurnSnapshot,
): void {
  const current = composerDraftStore.getQueuedTurns(scopeKey);
  if (current.some((entry) => entry.id === queuedTurn.id)) {
    return;
  }

  composerDraftStore.setQueuedTurns(scopeKey, [queuedTurn, ...current]);
}

function readNotificationThreadId(event: AgentEvent): string | undefined {
  const params = event.notification.params;
  return "threadId" in params && typeof params.threadId === "string"
    ? params.threadId
    : undefined;
}

function isIdleStatusNotification(event: AgentEvent): boolean {
  if (event.notification.method !== "thread/status/changed") {
    return false;
  }

  const status = event.notification.params.status;
  return (
    typeof status === "object" &&
    status !== null &&
    "type" in status &&
    status.type === "idle"
  );
}

function isThreadSelected(
  current: { selectedThread?: NavigationThreadSummary },
  owner: ComposerThreadOwner,
): boolean {
  return current.selectedThread?.source === owner.backend
    && current.selectedThread.id === owner.threadId
    && federationTargetsEqual(current.selectedThread.federation?.ref.target ?? readRendererFederationTarget(), owner.target);
}

function isRetainedBranchDrift(
  thread: NavigationThreadSummary,
  expectedBranch?: string,
  observedBranch?: string,
): boolean {
  // Match ThreadView / registry retention semantics: the first named
  // branch after detached HEAD is always a fresh context decision.
  if (expectedBranch === "HEAD") {
    return false;
  }

  if (!expectedBranch || !observedBranch) {
    return false;
  }

  return (thread.retainedBranchDriftPairs ?? []).some(
    (pair) =>
      pair.expectedBranch === expectedBranch &&
      pair.observedBranch === observedBranch,
  );
}

export function useQueuedTurnRelease(params: {
  backends: BackendSummary[];
  composerDraftStore: ComposerDraftStore;
  desktopApi?: DesktopApi;
  selectedThread?: NavigationThreadSummary;
  /**
   * A queued reply reaching the backend is still the operator replying — it
   * is the same composer submit, just deferred past a running turn. The
   * Attention lens clears unread on reply and nothing else, so without this
   * a thread the operator answered while it was busy would sit in the work
   * queue forever. Same contract as the composer's own prop.
   */
  onUserRepliedToThread?: (thread: NavigationThreadSummary) => void;
}): void {
  const paramsRef = useRef(params);
  const mountedRef = useRef(true);
  const lifetimeRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    lifetimeRef.current += 1;
    return () => { mountedRef.current = false; lifetimeRef.current += 1; };
  }, []);
  const inFlightScopeKeysRef = useRef(new Set<string>());
  paramsRef.current = params;

  const releaseQueuedTurnForScope = async (
    scopeKey: string,
    owner: ComposerThreadOwner,
    options: { verifyIdle: boolean },
  ): Promise<void> => {
    if (!mountedRef.current || globalInFlightScopeKeys.size >= 8) return;
    const lifetime = lifetimeRef.current;
    const current = paramsRef.current;
    const ownerKey = buildOwnedComposerScopeKey(owner);
    const leaseKey = ownerKey;
    if (
      inFlightScopeKeysRef.current.has(leaseKey) ||
      globalInFlightScopeKeys.has(leaseKey)
    ) {
      return;
    }

    const queuedTurn = getNextReleasableQueuedTurn(
      current.composerDraftStore.getQueuedTurns(scopeKey),
    );
    if (!queuedTurn || !queuedTurn.threadOwner || buildOwnedComposerScopeKey(queuedTurn.threadOwner) !== ownerKey
      || isThreadSelected(current, owner)) {
      return;
    }
    const queuedTurnId = queuedTurn.id;

    const readReleaseCandidate = (candidateThread: NavigationThreadSummary) => {
      const releaseState = paramsRef.current;
      if (!mountedRef.current || lifetime !== lifetimeRef.current) return undefined;
      if (isThreadSelected(releaseState, owner)) {
        return undefined;
      }

      const releaseQueuedSnapshot = getNextReleasableQueuedTurn(
        releaseState.composerDraftStore.getQueuedTurns(scopeKey),
      );
      if (!releaseQueuedSnapshot || releaseQueuedSnapshot.id !== queuedTurnId
        || !releaseQueuedSnapshot.threadOwner || buildOwnedComposerScopeKey(releaseQueuedSnapshot.threadOwner) !== ownerKey) {
        return undefined;
      }

      const resolved = resolveComposerScopeOwner(releaseState.composerDraftStore, scopeKey);
      if (resolved.state !== "known" || buildOwnedComposerScopeKey(resolved.owner) !== ownerKey) return undefined;
      const releaseThread = candidateThread;
      if (!ownerBackend?.available) return undefined;
      const backend = ownerBackend;

      return {
        backend,
        desktopApi: releaseState.desktopApi,
        releaseQueuedSnapshot,
        releaseState,
        releaseThread,
      };
    };

    let ownerBackend = owner.target.scope === "local"
      ? current.backends.find((backend) => backend.kind === owner.backend) : undefined;
    inFlightScopeKeysRef.current.add(leaseKey);
    globalInFlightScopeKeys.add(leaseKey);
    try {
      const api = current.desktopApi;
      if (!api?.getNavigationSelectedDetail || !api.getNavigationQueueProjection) return;
      const ref = { backend: owner.backend, threadId: owner.threadId,
        ...(owner.target.scope === "remote" ? { ownerInstanceId: owner.target.instanceId } : {}),
      };
      const selection = selectNavigationIdentity(undefined, ref);
      const detail = applyNavigationSelectedDetail({
        state: selection, sequence: selection.pendingSequence,
        detail: await api.getNavigationSelectedDetail({ protocol: 2, ref, federationTarget: owner.target }),
      });
      if (detail.readiness !== "ready" || detail.detail?.identity !== "present" || !detail.detail.thread) return;
      const thread = {
        ...detail.detail.thread,
        ...(owner.target.scope === "remote" ? { federation: {
          ...detail.detail.thread.federation, instanceLabel: detail.detail.thread.federation?.instanceLabel ?? owner.target.instanceId,
          ref: { backend: owner.backend, threadId: owner.threadId, target: owner.target },
        } } : {}),
      };
      const fifo = await readCompleteNavigationQueue({ owner, read: api.getNavigationQueueProjection, isCancelled: () => !mountedRef.current || lifetime !== lifetimeRef.current });
      if (fifo.entries.length > 0) return;
      if (owner.target.scope === "remote") {
        if (!api.listBackends) return;
        const response = await api.listBackends({ includeUnavailable: true, federationTarget: owner.target });
        ownerBackend = response.backends.find((backend) => backend.kind === owner.backend);
      }
      let releaseCandidate = readReleaseCandidate(thread);
      if (!releaseCandidate) return;
      if (options.verifyIdle) {
        const readThread = paramsRef.current.desktopApi?.readThread;
        if (!readThread) {
          return;
        }

        const response = await readThread({
          backend: thread.source,
          // Remote threads verify idleness on their owning instance;
          // an unstamped read would hit the viewer's own registry.
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          limit: 1,
        });
        if (response.threadStatus !== "idle") {
          return;
        }
      }

      releaseCandidate = readReleaseCandidate(thread);
      if (!releaseCandidate) {
        return;
      }

      if (
        releaseCandidate.releaseThread.gitBranch &&
        // Branch drift is a LOCAL git check; for a remote thread the
        // paths belong to the owning machine, so skip it here and let
        // the owner's own guards apply at start time.
        !releaseCandidate.releaseThread.federation &&
        !readRendererFederationTarget() &&
        releaseCandidate.desktopApi?.checkThreadBranchDrift
      ) {
        const drift = await releaseCandidate.desktopApi.checkThreadBranchDrift({
          backend: releaseCandidate.releaseThread.source,
          expectedBranch: releaseCandidate.releaseThread.gitBranch,
          threadId: releaseCandidate.releaseThread.id,
        });
        if (
          drift.drifted &&
          !isRetainedBranchDrift(
            releaseCandidate.releaseThread,
            drift.expectedBranch,
            drift.observedBranch,
          )
        ) {
          return;
        }
      }

      releaseCandidate = readReleaseCandidate(thread);
      if (!releaseCandidate) {
        return;
      }

      const {
        backend,
        desktopApi,
        releaseQueuedSnapshot,
        releaseState,
        releaseThread,
      } = releaseCandidate;

      if (releaseQueuedSnapshot.reviewCommand) {
        const startReview = desktopApi?.startReview;
        if (!startReview || !backend.capabilities.startReview) {
          return;
        }

        const claimedQueuedTurn =
          releaseState.composerDraftStore.removeQueuedTurnById(
            scopeKey,
            releaseQueuedSnapshot.id,
          );
        if (!claimedQueuedTurn) {
          return;
        }
        const reviewCommand = claimedQueuedTurn.reviewCommand;
        if (!reviewCommand) {
          restoreQueuedTurn(
            releaseState.composerDraftStore,
            scopeKey,
            claimedQueuedTurn,
          );
          return;
        }
        const reviewFastMode =
          releaseThread.source === "codex" && typeof releaseThread.fastMode === "boolean"
            ? releaseThread.fastMode
            : undefined;

        try {
          await startReview({
            backend: releaseThread.source,
            federationTarget: releaseThread.federation?.ref.target ??
              readRendererFederationTarget(),
            threadId: releaseThread.id,
            target: reviewCommand.target,
            delivery: "inline",
            ...(reviewCommand.cwd ? { cwd: reviewCommand.cwd } : {}),
            // A reviewer picked when the review was queued replaces the
            // thread's settings wholesale — its model names an entry in
            // another provider's catalog.
            ...(reviewCommand.reviewer
              ? {
                  reviewBackend: reviewCommand.reviewer.backend,
                  ...(reviewCommand.reviewer.model
                    ? { model: reviewCommand.reviewer.model }
                    : {}),
                  ...(reviewCommand.reviewer.reasoningEffort
                    ? { reasoningEffort: reviewCommand.reviewer.reasoningEffort }
                    : {}),
                }
              : {
                  ...(releaseThread.model ? { model: releaseThread.model } : {}),
                  ...(releaseThread.reasoningEffort
                    ? { reasoningEffort: releaseThread.reasoningEffort }
                    : {}),
                  ...(releaseThread.serviceTier
                    ? { serviceTier: releaseThread.serviceTier }
                    : {}),
                  ...(reviewFastMode !== undefined
                    ? { fastMode: reviewFastMode }
                    : {}),
                }),
          });
        } catch (error) {
          restoreQueuedTurn(
            releaseState.composerDraftStore,
            scopeKey,
            claimedQueuedTurn,
          );
          throw error;
        }
        return;
      }

      const claimedQueuedTurn =
        releaseState.composerDraftStore.removeQueuedTurnById(
          scopeKey,
          releaseQueuedSnapshot.id,
        );
      if (!claimedQueuedTurn) {
        return;
      }

      const input = buildQueuedTurnInput(claimedQueuedTurn);
      if (input.length === 0) {
        return;
      }

      const startTurn = desktopApi?.startTurn;
      if (!startTurn || !backend.capabilities.startTurn) {
        restoreQueuedTurn(
          releaseState.composerDraftStore,
          scopeKey,
          claimedQueuedTurn,
        );
        return;
      }

      const selectedModelOption =
        backend.launchpadOptions?.models?.find(
          (option) => option.id === releaseThread.model,
        ) ??
        getDefaultModelOption(backend);
      const supportsReasoning =
        selectedModelOption?.supportsReasoning ??
        Boolean(backend.launchpadOptions?.reasoningEfforts?.length);
      const supportsFast =
        backend.kind === "codex"
          ? selectedModelOption?.supportsFast ??
            backend.launchpadOptions?.supportsFastMode ??
            false
          : false;

      try {
        await startTurn({
          backend: releaseThread.source,
          // Route to the owning instance — an unstamped submit lands in
          // the viewer's own registry, which has no such thread, and the
          // failure loops silently on the 30s sweep.
          federationTarget: releaseThread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: releaseThread.id,
          input,
          executionMode: releaseThread.executionMode,
          model: selectedModelOption?.id,
          reasoningEffort: supportsReasoning
            ? getReasoningEffortValue(
                backend,
                selectedModelOption,
                releaseThread.reasoningEffort,
              )
            : undefined,
          serviceTier:
            releaseThread.serviceTier ?? backend.launchpadOptions?.serviceTiers?.[0],
          fastMode:
            releaseThread.source === "codex" && supportsFast
              ? Boolean(releaseThread.fastMode)
              : undefined,
        });
        releaseState.onUserRepliedToThread?.(releaseThread);
      } catch (error) {
        restoreQueuedTurn(
          releaseState.composerDraftStore,
          scopeKey,
          claimedQueuedTurn,
        );
        throw error;
      }
    } catch {
      // Keep the queued entry. The next terminal/idle notification or
      // periodic idle probe will retry without losing the user's request.
    } finally {
      inFlightScopeKeysRef.current.delete(leaseKey);
      globalInFlightScopeKeys.delete(leaseKey);
    }
  };

  useEffect(() => {
    const desktopApi = params.desktopApi;
    if (!desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      const current = paramsRef.current;
      if (event.notification.method === "thread/turnQueue/updated") {
        const notification = event.notification.params as {
          queueEntryId?: unknown;
          status?: unknown;
          threadId?: unknown;
        };
        if (
          typeof notification.threadId === "string" &&
          typeof notification.queueEntryId === "string" &&
          (notification.status === "started"
            || notification.status === "failed"
            || notification.status === "cancelled"
            || notification.status === "terminal")
        ) {
          for (const scopeKey of current.composerDraftStore.getQueuedScopeKeys()) {
            const resolved = resolveComposerScopeOwner(current.composerDraftStore, scopeKey);
            if (resolved.state !== "known" || resolved.owner.backend !== event.backend
              || resolved.owner.threadId !== notification.threadId
              || !federationTargetsEqual(resolved.owner.target, event.federationTarget ?? readRendererFederationTarget())) continue;
            const queued = current.composerDraftStore.getQueuedTurns(scopeKey);
            const next = queued.filter((candidate) => candidate.queueEntryId !== notification.queueEntryId);
            if (next.length !== queued.length) current.composerDraftStore.setQueuedTurns(scopeKey, next);
          }
        }
        return;
      }
      if (
        !TERMINAL_TURN_METHODS.has(event.notification.method) &&
        !isIdleStatusNotification(event)
      ) {
        return;
      }

      const threadId = readNotificationThreadId(event);
      if (!threadId) {
        return;
      }

      for (const scopeKey of current.composerDraftStore.getQueuedScopeKeys()) {
        const resolved = resolveComposerScopeOwner(current.composerDraftStore, scopeKey);
        if (resolved.state !== "known" || resolved.owner.backend !== event.backend || resolved.owner.threadId !== threadId
          || !federationTargetsEqual(resolved.owner.target, event.federationTarget ?? readRendererFederationTarget())) continue;
        void releaseQueuedTurnForScope(scopeKey, resolved.owner, { verifyIdle: false });
      }
    });
  }, [params.desktopApi]);

  useEffect(() => {
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;
      sweeping = true;
      const lifetime = lifetimeRef.current;
      try {
        const scopes = paramsRef.current.composerDraftStore.getQueuedScopeKeys();
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(8, scopes.length) }, async () => {
          while (mountedRef.current && lifetime === lifetimeRef.current && index < scopes.length) {
            const scopeKey = scopes[index++]!;
            const resolved = resolveComposerScopeOwner(paramsRef.current.composerDraftStore, scopeKey);
            if (resolved.state !== "known") continue;
            await releaseQueuedTurnForScope(scopeKey, resolved.owner, { verifyIdle: true });
          }
        }));
      } finally { sweeping = false; }
    };
    const timer = window.setInterval(() => { void sweep(); }, BACKGROUND_QUEUE_RELEASE_INTERVAL_MS);
    return () => { window.clearInterval(timer); };
  }, []);

}
