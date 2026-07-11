import { useEffect, useRef } from "react";
import type {
  AgentEvent,
  AppServerTurnInputItem,
  BackendSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  getNextReleasableQueuedTurn,
  type ComposerDraftStore,
  type ComposerQueuedTurnSnapshot,
} from "../features/composer/useComposerDraftStore";
import type { DesktopApi } from "./desktop-api";

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

function getThreadScopeKey(thread: Pick<NavigationThreadSummary, "id" | "source">): string {
  return `thread:${thread.source}:${thread.id}`;
}

function isThreadSelected(
  current: { selectedThread?: NavigationThreadSummary },
  thread: Pick<NavigationThreadSummary, "id" | "source">,
): boolean {
  return (
    current.selectedThread?.source === thread.source &&
    current.selectedThread.id === thread.id
  );
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
  threads: NavigationThreadSummary[];
}): void {
  const paramsRef = useRef(params);
  const inFlightScopeKeysRef = useRef(new Set<string>());
  paramsRef.current = params;

  const releaseQueuedTurnForThread = async (
    thread: NavigationThreadSummary,
    options: { verifyIdle: boolean },
  ): Promise<void> => {
    const current = paramsRef.current;
    const scopeKey = getThreadScopeKey(thread);
    if (
      inFlightScopeKeysRef.current.has(scopeKey) ||
      globalInFlightScopeKeys.has(scopeKey)
    ) {
      return;
    }

    const queuedTurn = getNextReleasableQueuedTurn(
      current.composerDraftStore.getQueuedTurns(scopeKey),
    );
    if (!queuedTurn || isThreadSelected(current, thread)) {
      return;
    }
    const queuedTurnId = queuedTurn.id;

    const readReleaseCandidate = (candidateThread: NavigationThreadSummary) => {
      const releaseState = paramsRef.current;
      if (isThreadSelected(releaseState, candidateThread)) {
        return undefined;
      }

      const releaseQueuedSnapshot = getNextReleasableQueuedTurn(
        releaseState.composerDraftStore.getQueuedTurns(scopeKey),
      );
      if (!releaseQueuedSnapshot || releaseQueuedSnapshot.id !== queuedTurnId) {
        return undefined;
      }

      const releaseThread = releaseState.threads.find(
        (candidate) =>
          candidate.source === candidateThread.source &&
          candidate.id === candidateThread.id,
      );
      if (!releaseThread) {
        return undefined;
      }

      const backend = releaseState.backends.find(
        (candidate) => candidate.kind === releaseThread.source,
      );
      if (!backend?.available) {
        return undefined;
      }

      return {
        backend,
        desktopApi: releaseState.desktopApi,
        releaseQueuedSnapshot,
        releaseState,
        releaseThread,
      };
    };

    let releaseCandidate = readReleaseCandidate(thread);
    if (!releaseCandidate) {
      return;
    }

    inFlightScopeKeysRef.current.add(scopeKey);
    globalInFlightScopeKeys.add(scopeKey);
    try {
      if (options.verifyIdle) {
        const readThread = paramsRef.current.desktopApi?.readThread;
        if (!readThread) {
          return;
        }

        const response = await readThread({
          backend: thread.source,
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
            threadId: releaseThread.id,
            target: reviewCommand.target,
            delivery: "inline",
            ...(reviewCommand.cwd ? { cwd: reviewCommand.cwd } : {}),
            ...(releaseThread.model ? { model: releaseThread.model } : {}),
            ...(releaseThread.reasoningEffort
              ? { reasoningEffort: releaseThread.reasoningEffort }
              : {}),
            ...(releaseThread.serviceTier ? { serviceTier: releaseThread.serviceTier } : {}),
            ...(reviewFastMode !== undefined ? { fastMode: reviewFastMode } : {}),
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
      inFlightScopeKeysRef.current.delete(scopeKey);
      globalInFlightScopeKeys.delete(scopeKey);
    }
  };

  useEffect(() => {
    const desktopApi = params.desktopApi;
    if (!desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      const current = paramsRef.current;
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

      if (
        current.selectedThread?.source === event.backend &&
        current.selectedThread.id === threadId
      ) {
        return;
      }

      const thread = current.threads.find(
        (candidate) =>
          candidate.source === event.backend && candidate.id === threadId,
      );
      if (!thread) {
        return;
      }

      void releaseQueuedTurnForThread(thread, { verifyIdle: false });
    });
  }, [params.desktopApi]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = paramsRef.current;
      for (const thread of current.threads) {
        if (
          current.selectedThread?.source === thread.source &&
          current.selectedThread.id === thread.id
        ) {
          continue;
        }

        void releaseQueuedTurnForThread(thread, { verifyIdle: true });
      }
    }, BACKGROUND_QUEUE_RELEASE_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const current = paramsRef.current;
    let nextReleaseAt: number | undefined;
    for (const thread of current.threads) {
      if (
        current.selectedThread?.source === thread.source &&
        current.selectedThread.id === thread.id
      ) {
        continue;
      }

      for (const queuedTurn of current.composerDraftStore.getQueuedTurns(
        getThreadScopeKey(thread),
      )) {
        const scheduledSendAt = queuedTurn.scheduledSendAt;
        if (
          typeof scheduledSendAt !== "number" ||
          !Number.isFinite(scheduledSendAt) ||
          scheduledSendAt <= Date.now()
        ) {
          continue;
        }

        nextReleaseAt =
          nextReleaseAt === undefined
            ? scheduledSendAt
            : Math.min(nextReleaseAt, scheduledSendAt);
      }
    }

    if (nextReleaseAt === undefined) {
      return;
    }

    const timer = window.setTimeout(() => {
      const releaseState = paramsRef.current;
      for (const thread of releaseState.threads) {
        if (
          releaseState.selectedThread?.source === thread.source &&
          releaseState.selectedThread.id === thread.id
        ) {
          continue;
        }

        void releaseQueuedTurnForThread(thread, { verifyIdle: true });
      }
    }, Math.max(0, nextReleaseAt - Date.now()));

    return () => {
      window.clearTimeout(timer);
    };
  }, [params.threads, params.selectedThread, params.composerDraftStore]);
}
