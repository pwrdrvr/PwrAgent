import type {
  AppServerBackendKind,
  HandoffThreadWorkspaceRequest,
  MessagingBindingRecord,
  MessagingConfirmationIntent,
  MessagingJsonValue,
  MessagingToolUpdateMode,
  MessagingSingleSelectIntent,
  MessagingSurfaceAction,
  MessagingStatusIntent,
  ThreadIdentifier,
} from "@pwragnt/shared";
import { shortenDerivedThreadTitle } from "@pwragnt/shared";
import type { MessagingResolvedThreadState } from "./messaging-thread-state.js";

export type MessagingWorkspaceHandoffContext = {
  backend: AppServerBackendKind;
  branch?: string;
  leaveLocalBranches: string[];
  projectLabel?: string;
  repositoryPath: string;
  threadId: ThreadIdentifier;
  threadTitle?: string;
  workingDirectoryPath: string;
  workspaceKind: "local" | "worktree";
};

export const HANDOFF_BRANCH_PAGE_SIZE = 8;

export function buildBindingStatusIntent(params: {
  binding: MessagingBindingRecord;
  createdAt: number;
  handoff?: MessagingWorkspaceHandoffContext;
  id: string;
  threadState: MessagingResolvedThreadState;
  toolUpdateMode?: MessagingToolUpdateMode;
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
  const bindingTitle = formatStatusBindingTitle(params.threadState, params.binding.threadId);
  const toolUpdateMode = resolveMessagingToolUpdateMode(
    params.binding,
    params.toolUpdateMode,
  );

  return {
    id: params.id,
    kind: "status",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.binding.statusSurface ? "update" : "present",
      fallback: "present_new",
      pin: params.binding.pinnedStatusSurface ? undefined : true,
    },
    targetSurface: params.binding.statusSurface,
    status: statusForThreadState(params.threadState),
    text: [
      `Binding: ${bindingTitle} (${params.binding.backend})`,
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
      `Tool updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
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
      ...(params.handoff
        ? [
            {
              id: "status:handoff",
              label: "Handoff",
              style: "secondary" as const,
              fallbackText: "handoff",
              value: handoffValue(params.handoff),
            },
          ]
        : []),
      {
        id: "status:tool-updates",
        label: `Tools: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
        style: "secondary",
        fallbackText: "tools",
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

function formatStatusBindingTitle(
  threadState: MessagingResolvedThreadState,
  fallbackThreadId: ThreadIdentifier,
): string {
  if (!threadState.title) {
    return fallbackThreadId;
  }
  if (threadState.titleSource === "derived") {
    return truncateStatusTitle(
      shortenDerivedThreadTitle(threadState.title) ?? threadState.title,
    );
  }
  return threadState.title;
}

function truncateStatusTitle(title: string, limit = 32): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  const breakpointWindow = normalized.slice(0, limit + 1);
  const wordBreak = breakpointWindow.lastIndexOf(" ");
  if (wordBreak >= Math.floor(limit * 0.6)) {
    return `${normalized.slice(0, wordBreak).trim()}...`;
  }
  return `${normalized.slice(0, limit).trim()}...`;
}

const TOOL_UPDATE_MODE_ORDER: MessagingToolUpdateMode[] = [
  "show_none",
  "show_less",
  "show_some",
  "show_more",
  "show_all",
];

export function resolveMessagingToolUpdateMode(
  binding: MessagingBindingRecord,
  defaultMode: MessagingToolUpdateMode | undefined,
): MessagingToolUpdateMode {
  return binding.preferences?.toolUpdateMode ?? defaultMode ?? "show_some";
}

export function nextMessagingToolUpdateMode(
  mode: MessagingToolUpdateMode,
): MessagingToolUpdateMode {
  const index = TOOL_UPDATE_MODE_ORDER.indexOf(mode);
  return TOOL_UPDATE_MODE_ORDER[(index + 1) % TOOL_UPDATE_MODE_ORDER.length]!;
}

export function formatMessagingToolUpdateModeLabel(
  mode: MessagingToolUpdateMode,
): string {
  switch (mode) {
    case "show_none":
      return "Show None";
    case "show_less":
      return "Show Less";
    case "show_some":
      return "Show Some";
    case "show_more":
      return "Show More";
    case "show_all":
      return "Show All";
  }
}

export function buildHandoffOverviewIntent(params: {
  binding: MessagingBindingRecord;
  context: MessagingWorkspaceHandoffContext;
  createdAt: number;
  id: string;
}): MessagingSingleSelectIntent {
  const action =
    params.context.workspaceKind === "local"
      ? {
          id: "handoff:local-to-worktree",
          label: "Handoff to New Worktree",
          fallbackText: "1",
          style: "primary" as const,
          value: handoffValue(params.context),
        }
      : {
          id: "handoff:worktree-to-local",
          label: "Handoff to Local",
          fallbackText: "1",
          style: "primary" as const,
          value: handoffValue(params.context),
        };

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
    fallbackText: [
      handoffOverviewText(params.context),
      `1. ${action.label}`,
      "Reply with 1, Back, Refresh, or Cancel.",
    ].join("\n"),
    prompt: handoffOverviewText(params.context),
    choices: [
      action,
      {
        id: "status:refresh",
        label: "Back",
        fallbackText: "back",
        style: "secondary",
      },
      {
        id: "status:refresh",
        label: "Refresh",
        fallbackText: "refresh",
        style: "secondary",
      },
      {
        id: "handoff:cancel",
        label: "Cancel",
        fallbackText: "cancel",
        style: "secondary",
      },
    ],
  };
}

export function buildHandoffBranchPickerIntent(params: {
  binding: MessagingBindingRecord;
  context: MessagingWorkspaceHandoffContext;
  createdAt: number;
  id: string;
  pageIndex?: number;
  pageSize?: number;
}): MessagingSingleSelectIntent {
  const pageSize = Math.max(1, params.pageSize ?? HANDOFF_BRANCH_PAGE_SIZE);
  const totalBranches = params.context.leaveLocalBranches.length;
  const totalPages = Math.max(1, Math.ceil(totalBranches / pageSize));
  const pageIndex = clampPageIndex(params.pageIndex ?? 0, totalPages);
  const pageStart = pageIndex * pageSize;
  const pageBranches = params.context.leaveLocalBranches.slice(
    pageStart,
    pageStart + pageSize,
  );
  const branchChoices = pageBranches.map((branch, index) => {
    const branchNumber = pageStart + index + 1;
    return {
      id: "handoff:select-leave-branch",
      label: `${branchNumber}. ${branch}`,
      fallbackText: String(branchNumber),
      style: "secondary" as const,
      value: {
        ...handoffValue(params.context),
        leaveLocalBranch: branch,
      },
    };
  });
  const pageActions: MessagingSurfaceAction[] = [
    ...(pageIndex > 0
      ? [
          {
            id: "handoff:branches:previous",
            label: "Previous",
            fallbackText: "previous",
            style: "secondary" as const,
            value: {
              ...handoffValue(params.context),
              pageIndex: pageIndex - 1,
            },
          },
        ]
      : []),
    ...(pageIndex < totalPages - 1
      ? [
          {
            id: "handoff:branches:next",
            label: "Next",
            fallbackText: "next",
            style: "secondary" as const,
            value: {
              ...handoffValue(params.context),
              pageIndex: pageIndex + 1,
            },
          },
        ]
      : []),
  ];

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
    fallbackText: [
      "Choose the branch that should remain checked out in Local.",
      totalPages > 1 ? `Page ${pageIndex + 1}/${totalPages}.` : undefined,
      ...branchChoices.map((choice) => choice.label),
      "Reply with a number, Back, Refresh, or Cancel.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    prompt: [
      "Choose the branch that should remain checked out in Local.",
      totalPages > 1 ? `Page ${pageIndex + 1}/${totalPages}.` : undefined,
      `Moving branch: ${params.context.branch ?? unavailable()}`,
      `Local: ${params.context.repositoryPath}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    choices: [
      ...branchChoices,
      ...pageActions,
      {
        id: "status:handoff",
        label: "Back",
        fallbackText: "back",
        style: "secondary" as const,
        value: handoffValue(params.context),
      },
      {
        id: "status:refresh",
        label: "Refresh",
        fallbackText: "refresh",
        style: "secondary" as const,
      },
      {
        id: "handoff:cancel",
        label: "Cancel",
        fallbackText: "cancel",
        style: "secondary" as const,
      },
    ],
  };
}

function clampPageIndex(pageIndex: number, totalPages: number): number {
  if (!Number.isFinite(pageIndex)) {
    return 0;
  }
  return Math.min(Math.max(0, Math.trunc(pageIndex)), totalPages - 1);
}

export function buildHandoffConfirmationIntent(params: {
  binding: MessagingBindingRecord;
  context: MessagingWorkspaceHandoffContext;
  createdAt: number;
  id: string;
  leaveLocalBranch?: string;
}): MessagingConfirmationIntent {
  const direction =
    params.context.workspaceKind === "local" ? "local-to-worktree" : "worktree-to-local";
  const body = [
    direction === "local-to-worktree"
      ? "Confirm handoff to a new worktree."
      : "Confirm handoff to Local.",
    `Thread: ${params.context.threadTitle ?? params.context.threadId} (${params.context.backend})`,
    `Project: ${params.context.projectLabel ?? unavailable()}`,
    `Repository: ${params.context.repositoryPath}`,
    `Working directory: ${params.context.workingDirectoryPath}`,
    `Branch: ${params.context.branch ?? unavailable()}`,
    params.leaveLocalBranch
      ? `Leave Local on: ${params.leaveLocalBranch}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  return {
    id: params.id,
    kind: "confirmation",
    bindingId: params.binding.id,
    createdAt: params.createdAt,
    delivery: {
      mode: params.binding.statusSurface ? "update" : "present",
      fallback: "present_new",
    },
    targetSurface: params.binding.statusSurface,
    title: "Confirm Handoff",
    body,
    fallbackText: "Reply Confirm, Back, or Cancel.",
    actions: [
      {
        id: "handoff:confirm",
        label: "Confirm",
        fallbackText: "confirm",
        style: "primary",
        value: {
          ...handoffValue(params.context),
          ...(params.leaveLocalBranch
            ? { leaveLocalBranch: params.leaveLocalBranch }
            : {}),
        },
      },
      {
        id: params.context.workspaceKind === "local"
          ? "handoff:local-to-worktree"
          : "status:handoff",
        label: "Back",
        fallbackText: "back",
        style: "secondary",
        value: handoffValue(params.context),
      },
      {
        id: "handoff:cancel",
        label: "Cancel",
        fallbackText: "cancel",
        style: "secondary",
      },
    ],
  };
}

export function handoffRequestFromValue(
  value: unknown,
): HandoffThreadWorkspaceRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.direction !== "local-to-worktree" &&
    value.direction !== "worktree-to-local"
  ) {
    return undefined;
  }
  if (
    (value.backend !== "codex" && value.backend !== "grok") ||
    typeof value.threadId !== "string" ||
    typeof value.repositoryPath !== "string" ||
    typeof value.sourcePath !== "string"
  ) {
    return undefined;
  }

  return {
    backend: value.backend,
    threadId: value.threadId,
    direction: value.direction,
    repositoryPath: value.repositoryPath,
    sourcePath: value.sourcePath,
    sourceBranch: typeof value.sourceBranch === "string" ? value.sourceBranch : undefined,
    leaveLocalBranch:
      typeof value.leaveLocalBranch === "string" ? value.leaveLocalBranch : undefined,
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

function handoffValue(
  context: MessagingWorkspaceHandoffContext,
): Record<string, MessagingJsonValue> {
  return {
    backend: context.backend,
    threadId: context.threadId,
    direction:
      context.workspaceKind === "local" ? "local-to-worktree" : "worktree-to-local",
    repositoryPath: context.repositoryPath,
    sourcePath: context.workingDirectoryPath,
    ...(context.branch ? { sourceBranch: context.branch } : {}),
  };
}

function handoffOverviewText(context: MessagingWorkspaceHandoffContext): string {
  return [
    "Workspace Handoff",
    `Project: ${context.projectLabel ?? unavailable()}`,
    `Repository: ${context.repositoryPath}`,
    `Working directory: ${context.workingDirectoryPath}`,
    `Workspace: ${context.workspaceKind === "local" ? "Local" : "Worktree"}`,
    `Branch: ${context.branch ?? unavailable()}`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unavailable(): string {
  return "unavailable";
}
