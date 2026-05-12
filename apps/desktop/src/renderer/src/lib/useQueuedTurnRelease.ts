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
    if (!desktopApi?.onAgentEvent || !startTurn) {
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

        const input = buildQueuedTurnInput(queuedTurn);
        if (input.length === 0) {
          current.composerDraftStore.removeQueuedTurnById(scopeKey, queuedTurn.id);
          return;
        }

        const backend = current.backends.find(
          (candidate) => candidate.kind === thread.source,
        );
        if (!backend?.available || !backend.capabilities.startTurn) {
          return;
        }

        const selectedModelOption =
          backend.launchpadOptions?.models?.find((option) => option.id === thread.model) ??
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
          backend: thread.source,
          threadId: thread.id,
          input,
          executionMode: thread.executionMode,
          model: selectedModelOption?.id,
          reasoningEffort: supportsReasoning
            ? getReasoningEffortValue(backend, thread.reasoningEffort)
            : undefined,
          serviceTier:
            thread.serviceTier ?? backend.launchpadOptions?.serviceTiers?.[0],
          fastMode:
            thread.source === "codex" && supportsFast
              ? Boolean(thread.fastMode)
              : undefined,
        });
        current.composerDraftStore.removeQueuedTurnById(scopeKey, queuedTurn.id);
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
