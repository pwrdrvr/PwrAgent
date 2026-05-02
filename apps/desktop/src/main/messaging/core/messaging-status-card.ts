import type {
  MessagingBindingRecord,
  MessagingSingleSelectIntent,
  MessagingStatusIntent,
} from "@pwragnt/shared";
import type { MessagingResolvedThreadState } from "./messaging-thread-state.js";

export function buildBindingStatusIntent(params: {
  binding: MessagingBindingRecord;
  createdAt: number;
  id: string;
  threadState: MessagingResolvedThreadState;
}): MessagingStatusIntent {
  const preferences = params.binding.preferences;
  const projectLabel = params.threadState.projectLabel ?? unavailable();
  const directoryPath = params.threadState.directoryPath ?? unavailable();
  const defaults = params.threadState.launchpadDefaults;
  const model =
    params.threadState.model ??
    preferences?.model ??
    defaults?.model ??
    unavailable();
  const reasoning =
    params.threadState.reasoningEffort ??
    preferences?.reasoningEffort ??
    defaults?.reasoningEffort ??
    unavailable();
  const fastMode =
    params.threadState.fastMode ?? preferences?.fastMode ?? defaults?.fastMode;
  const permissionsMode =
    params.threadState.executionMode ??
    preferences?.permissionsMode ??
    (preferences?.executionMode === "full-access" ? "full-access" : undefined) ??
    defaults?.executionMode ??
    "default";
  const activeTurn = params.threadState.activeTurn;
  const branch = formatBranch(params.threadState);

  return {
    id: params.id,
    kind: "status",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.binding.statusSurface ? "update" : "present",
      fallback: "present_new",
      pin: true,
    },
    targetSurface: params.binding.statusSurface,
    status: statusForThreadState(params.threadState),
    text: [
      `Binding: ${params.threadState.title ?? params.binding.threadId} (${params.binding.backend})`,
      `Project: ${projectLabel}`,
      `Directory: ${directoryPath}`,
      params.threadState.worktreePath ? `Worktree: ${params.threadState.worktreePath}` : undefined,
      `Branch: ${branch ?? unavailable()}`,
      params.threadState.missing ? "Thread state: unavailable" : undefined,
      `Model: ${model}`,
      `Reasoning: ${reasoning}`,
      `Fast mode: ${fastMode === undefined ? unavailable() : fastMode ? "on" : "off"}`,
      "Plan mode: unavailable",
      `Permissions: ${permissionsMode === "full-access" ? "Full Access" : "Default Access"}`,
      "Context usage: unavailable",
      "Account: unavailable",
      "Rate limits: unavailable",
      `Thread: ${params.binding.threadId}`,
      activeTurn ? `Turn: ${activeTurn.status} (${activeTurn.turnId})` : "Turn: idle",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    actions: [
      {
        id: "status:model",
        label: "Model",
        style: "secondary",
        fallbackText: "model",
      },
      {
        id: "status:reasoning",
        label: `Reasoning: ${reasoning}`,
        style: "secondary",
        fallbackText: "reasoning",
      },
      {
        id: "status:fast",
        label: fastMode ? "Fast: on" : "Fast: off",
        style: "secondary",
        fallbackText: "fast",
      },
      {
        id: "status:permissions",
        label:
          permissionsMode === "full-access"
            ? "Permissions: Full Access"
            : "Permissions: Default",
        style: "secondary",
        fallbackText: "permissions",
      },
      {
        id: "status:compact",
        label: "Compact",
        style: "secondary",
        fallbackText: "compact",
      },
      {
        id: "status:sync-name",
        label: "Sync name",
        style: "secondary",
        fallbackText: "sync name",
      },
      {
        id: "status:stop",
        label: "Stop",
        style: "danger",
        fallbackText: "stop",
      },
      {
        id: "status:refresh",
        label: "Refresh",
        style: "secondary",
        fallbackText: "refresh",
      },
      {
        id: "status:detach",
        label: "Detach",
        style: "danger",
        fallbackText: "detach",
      },
    ],
  };
}

export function buildStatusModelPickerIntent(params: {
  binding: MessagingBindingRecord;
  createdAt: number;
  id: string;
  models: Array<{ id: string; label?: string; current?: boolean }>;
}): MessagingSingleSelectIntent {
  return {
    id: params.id,
    kind: "single_select",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.binding.statusSurface ? "update" : "present",
      fallback: "present_new",
    },
    targetSurface: params.binding.statusSurface,
    fallbackText: "Reply with a model number, Refresh, or Detach.",
    prompt: "Select Model",
    choices: [
      ...params.models.map((model, index) => ({
        id: "status:set-model",
        label: `${model.label ?? model.id}${model.current ? " (current)" : ""}`,
        fallbackText: String(index + 1),
        style: "secondary" as const,
        value: {
          model: model.id,
        },
      })),
      {
        id: "status:refresh",
        label: "Back",
        fallbackText: "back",
        style: "secondary" as const,
      },
    ],
  };
}

export function buildStatusReasoningPickerIntent(params: {
  binding: MessagingBindingRecord;
  createdAt: number;
  id: string;
  efforts: string[];
}): MessagingSingleSelectIntent {
  return {
    id: params.id,
    kind: "single_select",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.binding.statusSurface ? "update" : "present",
      fallback: "present_new",
    },
    targetSurface: params.binding.statusSurface,
    fallbackText: "Reply with a reasoning option number, Refresh, or Detach.",
    prompt: "Select Reasoning",
    choices: [
      ...params.efforts.map((effort, index) => ({
        id: "status:set-reasoning",
        label: effort,
        fallbackText: String(index + 1),
        style: "secondary" as const,
        value: {
          reasoningEffort: effort,
        },
      })),
      {
        id: "status:refresh",
        label: "Back",
        fallbackText: "back",
        style: "secondary" as const,
      },
    ],
  };
}

function statusForThreadState(
  threadState: MessagingResolvedThreadState,
): MessagingStatusIntent["status"] {
  switch (threadState.activeTurn?.status) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
    case "interrupted":
      return "failed";
    case "completed":
    case undefined:
      return "idle";
  }
}

function formatBranch(threadState: MessagingResolvedThreadState): string | undefined {
  if (!threadState.gitBranch && !threadState.observedGitBranch) {
    return undefined;
  }
  if (
    threadState.gitBranch &&
    threadState.observedGitBranch &&
    threadState.gitBranch !== threadState.observedGitBranch
  ) {
    return `${threadState.gitBranch} (now ${threadState.observedGitBranch})`;
  }
  return threadState.gitBranch ?? threadState.observedGitBranch;
}

function unavailable(): string {
  return "unavailable";
}
