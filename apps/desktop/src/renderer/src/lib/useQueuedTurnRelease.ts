import { useEffect, useRef } from "react";
import type {
  AgentEvent,
  AppServerTurnInputItem,
  BackendSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type {
  ComposerDraftStore,
  ComposerQueuedTurnSnapshot,
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

function getDefaultModelOption(backend?: BackendSummary): ModelOption | undefined {
  const models = backend?.launchpadOptions?.models ?? [];
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

function getDefaultReasoningEffort(backend?: BackendSummary): string | undefined {
  const reasoningEfforts = backend?.launchpadOptions?.reasoningEfforts ?? [];
  return reasoningEfforts.includes("medium") ? "medium" : reasoningEfforts[0];
}

function getReasoningEffortValue(
  backend: BackendSummary | undefined,
  currentValue: string | undefined,
): string | undefined {
  const reasoningEfforts = backend?.launchpadOptions?.reasoningEfforts ?? [];
  return reasoningEfforts.includes(currentValue ?? "")
    ? currentValue
    : getDefaultReasoningEffort(backend);
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

function readNotificationThreadId(event: AgentEvent): string | undefined {
  const params = event.notification.params;
  return "threadId" in params && typeof params.threadId === "string"
    ? params.threadId
    : undefined;
}

function getThreadScopeKey(thread: Pick<NavigationThreadSummary, "id" | "source">): string {
  return `thread:${thread.source}:${thread.id}`;
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

  useEffect(() => {
    const desktopApi = params.desktopApi;
    const startTurn = desktopApi?.startTurn;
    const startReview = desktopApi?.startReview;
    if (!desktopApi?.onAgentEvent || (!startTurn && !startReview)) {
      return;
    }

    const releaseQueuedTurn = async (
      current: typeof params,
      thread: NavigationThreadSummary,
      queuedTurn: ComposerQueuedTurnSnapshot,
      scopeKey: string,
    ): Promise<void> => {
      inFlightScopeKeysRef.current.add(scopeKey);
      try {
        let releaseState = current;
        let releaseThread = thread;
        let releaseQueuedSnapshot = queuedTurn;

        if (thread.gitBranch && current.desktopApi?.checkThreadBranchDrift) {
          const drift = await current.desktopApi.checkThreadBranchDrift({
            backend: thread.source,
            expectedBranch: thread.gitBranch,
            threadId: thread.id,
          });
          if (drift.drifted) {
            return;
          }
        }

        releaseState = paramsRef.current;
        if (
          releaseState.selectedThread?.source === thread.source &&
          releaseState.selectedThread.id === thread.id
        ) {
          return;
        }

        const latestQueuedTurn = releaseState.composerDraftStore.getQueuedTurn(scopeKey);
        if (!latestQueuedTurn || latestQueuedTurn.id !== queuedTurn.id) {
          return;
        }
        releaseQueuedSnapshot = latestQueuedTurn;

        const latestThread = releaseState.threads.find(
          (candidate) =>
            candidate.source === thread.source && candidate.id === thread.id,
        );
        if (!latestThread) {
          return;
        }
        releaseThread = latestThread;

        const backend = releaseState.backends.find(
          (candidate) => candidate.kind === releaseThread.source,
        );
        if (!backend?.available) {
          return;
        }

        if (releaseQueuedSnapshot.reviewCommand) {
          const startReview = releaseState.desktopApi?.startReview;
          if (!startReview || !backend.capabilities.startReview) {
            return;
          }

          await startReview({
            backend: releaseThread.source,
            threadId: releaseThread.id,
            target: releaseQueuedSnapshot.reviewCommand.target,
            delivery: "inline",
          });
          releaseState.composerDraftStore.removeQueuedTurnById(
            scopeKey,
            releaseQueuedSnapshot.id,
          );
          return;
        }

        const input = buildQueuedTurnInput(releaseQueuedSnapshot);
        if (input.length === 0) {
          releaseState.composerDraftStore.removeQueuedTurnById(
            scopeKey,
            releaseQueuedSnapshot.id,
          );
          return;
        }

        if (!startTurn || !backend.capabilities.startTurn) {
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

        await startTurn({
          backend: releaseThread.source,
          threadId: releaseThread.id,
          input,
          executionMode: releaseThread.executionMode,
          model: selectedModelOption?.id,
          reasoningEffort: supportsReasoning
            ? getReasoningEffortValue(backend, releaseThread.reasoningEffort)
            : undefined,
          serviceTier:
            releaseThread.serviceTier ?? backend.launchpadOptions?.serviceTiers?.[0],
          fastMode:
            releaseThread.source === "codex" && supportsFast
              ? Boolean(releaseThread.fastMode)
              : undefined,
        });
        releaseState.composerDraftStore.removeQueuedTurnById(
          scopeKey,
          releaseQueuedSnapshot.id,
        );
      } finally {
        inFlightScopeKeysRef.current.delete(scopeKey);
      }
    };

    return desktopApi.onAgentEvent((event) => {
      const current = paramsRef.current;
      if (!TERMINAL_TURN_METHODS.has(event.notification.method)) {
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

      const scopeKey = getThreadScopeKey(thread);
      if (inFlightScopeKeysRef.current.has(scopeKey)) {
        return;
      }

      const queuedTurn = current.composerDraftStore.getQueuedTurn(scopeKey);
      if (!queuedTurn) {
        return;
      }

      void releaseQueuedTurn(current, thread, queuedTurn, scopeKey).catch(() => {
        inFlightScopeKeysRef.current.delete(scopeKey);
      });
    });
  }, [params.desktopApi]);
}
