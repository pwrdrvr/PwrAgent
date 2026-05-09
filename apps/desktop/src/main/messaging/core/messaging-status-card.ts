import type {
  AppServerBackendKind,
  HandoffThreadWorkspaceRequest,
  MessagingToolUpdateMode,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingConfirmationIntent,
  MessagingJsonValue,
  MessagingStreamingResponseMode,
  MessagingSingleSelectIntent,
  MessagingSurfaceAction,
  MessagingStatusIntent,
} from "@pwragent/messaging-interface";
import { shortenDerivedThreadTitle } from "@pwragent/shared";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  capabilityProfilePageSize,
  capabilityProfileSupportsActionCount,
  truncateActionsByPriority,
} from "@pwragent/messaging-interface";
import type { MessagingResolvedThreadState } from "./messaging-thread-state.js";

/**
 * Minimum action count for a usable status card. Below this, drop all
 * actions and rely on text rendering (Stop/Refresh/Detach via text reply).
 */
const STATUS_CARD_MIN_ACTIONS = 3;

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
  capabilityProfile?: MessagingCapabilityProfile;
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
  const queuedExecutionMode =
    params.threadState.queuedExecutionMode &&
    params.threadState.queuedExecutionMode !== permissionsMode
      ? params.threadState.queuedExecutionMode
      : undefined;
  const activeTurn = params.threadState.activeTurn;
  const branch = formatBranch(params.threadState);
  const bindingTitle = formatStatusBindingTitle(params.threadState, params.binding.threadId);
  const toolUpdateMode = resolveMessagingToolUpdateMode(
    params.binding,
    params.toolUpdateMode,
  );
  const streamingMode = resolveMessagingStreamingResponseMode(params.binding);

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
      `Permissions: ${formatPermissionsLineLabel(permissionsMode, queuedExecutionMode)}`,
      `Tool updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
      `Streaming: ${formatMessagingStreamingResponseModeLabel(streamingMode)}`,
      "Context usage: unavailable",
      "Account: unavailable",
      "Rate limits: unavailable",
      `Thread: ${params.binding.threadId}`,
      activeTurn ? `Turn: ${activeTurn.status} (${activeTurn.turnId})` : "Turn: idle",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    actions: buildStatusActions({
      capabilityProfile: params.capabilityProfile,
      fastMode,
      handoff: params.handoff,
      permissionsMode,
      queuedExecutionMode,
      reasoning,
      streamingMode,
      toolUpdateMode,
    }),
  };
}

function buildStatusActions(params: {
  capabilityProfile?: MessagingCapabilityProfile;
  fastMode: boolean | undefined;
  handoff?: MessagingWorkspaceHandoffContext;
  permissionsMode: string;
  queuedExecutionMode?: ThreadExecutionMode;
  reasoning: string;
  streamingMode: MessagingStreamingResponseMode;
  toolUpdateMode: MessagingToolUpdateMode;
}): MessagingSurfaceAction[] {
  const profile = params.capabilityProfile;
  if (profile && !capabilityProfileSupportsActionCount(profile, STATUS_CARD_MIN_ACTIONS)) {
    return [];
  }

  const allActions: MessagingSurfaceAction[] = [
    {
      id: "status:model",
      label: "Model",
      style: "secondary",
      fallbackText: "model",
      priority: 4,
    },
    {
      id: "status:reasoning",
      label: `Reasoning: ${params.reasoning}`,
      style: "secondary",
      fallbackText: "reasoning",
      priority: 5,
    },
    {
      id: "status:fast",
      label: params.fastMode ? "Fast: on" : "Fast: off",
      style: "secondary",
      fallbackText: "fast",
      priority: 6,
    },
    {
      id: "status:permissions",
      label: formatPermissionsActionLabel(
        params.permissionsMode,
        params.queuedExecutionMode,
      ),
      style: "secondary",
      fallbackText: "permissions",
      priority: 7,
    },
    ...(params.handoff
      ? [
          {
            id: "status:handoff",
            label: "Handoff",
            style: "secondary" as const,
            fallbackText: "handoff",
            value: handoffValue(params.handoff),
            priority: 8,
          },
        ]
      : []),
    {
      id: "status:tool-updates",
      label: `Tools: ${formatMessagingToolUpdateModeLabel(params.toolUpdateMode)}`,
      style: "secondary",
      fallbackText: "tools",
      priority: 9,
    },
    {
      id: "status:streaming",
      label: `Stream: ${formatMessagingStreamingResponseModeLabel(params.streamingMode)}`,
      style: "secondary",
      fallbackText: "stream",
      priority: 10,
    },
    {
      id: "status:compact",
      label: "Compact",
      style: "secondary",
      fallbackText: "compact",
      priority: 11,
    },
    {
      id: "status:sync-name",
      label: "Sync name",
      style: "secondary",
      fallbackText: "sync name",
      priority: 12,
    },
    {
      id: "status:stop",
      label: "Stop",
      style: "danger",
      fallbackText: "stop",
      priority: 1,
      layout: { rowBreakBefore: true },
    },
    {
      id: "status:refresh",
      label: "Refresh",
      style: "secondary",
      fallbackText: "refresh",
      priority: 2,
    },
    {
      id: "status:detach",
      label: "Detach",
      style: "danger",
      fallbackText: "detach",
      priority: 3,
    },
  ];

  if (profile?.actions) {
    return truncateActionsByPriority(allActions, profile.actions.maxActions);
  }
  return allActions;
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

export function resolveMessagingStreamingResponseMode(
  binding: MessagingBindingRecord,
): MessagingStreamingResponseMode {
  return binding.preferences?.streamingResponses ?? "inherit";
}

export function nextMessagingStreamingResponseMode(
  mode: MessagingStreamingResponseMode,
): MessagingStreamingResponseMode {
  switch (mode) {
    case "inherit":
      return "disabled";
    case "disabled":
      return "enabled";
    case "enabled":
      return "inherit";
  }
}

export function formatMessagingStreamingResponseModeLabel(
  mode: MessagingStreamingResponseMode,
): string {
  switch (mode) {
    case "inherit":
      return "Inherit";
    case "disabled":
      return "Off";
    case "enabled":
      return "Advanced";
  }
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
  capabilityProfile?: MessagingCapabilityProfile;
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
    choices: applyActionCapabilityLimits(
      [
        action,
        {
          // Back from the handoff overview returns to the status card.
          // Distinct id from the sibling "Refresh" button so callback
          // handles don't collide on Telegram (same intent, two actions
          // with identical ids would map to a single handle record).
          // Both ids resolve to renderBindingStatus on the controller.
          id: "handoff:back-to-status",
          label: "Back",
          fallbackText: "back",
          style: "secondary",
          priority: 1,
        },
        {
          id: "status:refresh",
          label: "Refresh",
          fallbackText: "refresh",
          style: "secondary",
          priority: 3,
        },
        {
          id: "handoff:cancel",
          label: "Cancel",
          fallbackText: "cancel",
          style: "secondary",
          priority: 2,
        },
      ],
      params.capabilityProfile,
    ),
  };
}

export function buildHandoffBranchPickerIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  context: MessagingWorkspaceHandoffContext;
  createdAt: number;
  id: string;
  pageIndex?: number;
  pageSize?: number;
}): MessagingSingleSelectIntent {
  // Three nav buttons always render (Back/Refresh/Cancel). Previous/Next
  // appear conditionally based on pagination — but pageSize must be a
  // single value across all pages, so we plan for the worst case (a
  // middle page with both Previous AND Next visible) when the picker
  // actually paginates. For a single-page result we only need to reserve
  // 3 nav slots, freeing 2 more for branches.
  const NAV_ACTIONS_BASE = 3; // back, refresh, cancel
  const NAV_ACTIONS_MULTIPAGE = 5; // + previous + next
  const totalBranches = params.context.leaveLocalBranches.length;
  const profilePageSize = (navActionCount: number): number =>
    params.capabilityProfile
      ? capabilityProfilePageSize(
          params.capabilityProfile,
          navActionCount,
          HANDOFF_BRANCH_PAGE_SIZE,
        )
      : HANDOFF_BRANCH_PAGE_SIZE;
  // First-pass page size assumes single-page (no Previous/Next). If the
  // branches don't all fit on one page, recompute with the multi-page
  // budget so middle pages still leave room for both nav buttons.
  const singlePagePageSize = profilePageSize(NAV_ACTIONS_BASE);
  const pageSize = Math.max(
    1,
    params.pageSize
      ?? (totalBranches <= singlePagePageSize
        ? singlePagePageSize
        : profilePageSize(NAV_ACTIONS_MULTIPAGE)),
  );
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
      // Branch entries are the lowest priority — under tight action
      // budgets, drop branches before nav buttons. The page-size math
      // should already prevent this from triggering, but the priority
      // pass is the safety net.
      priority: 100 + index,
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
            priority: 4,
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
            priority: 5,
            value: {
              ...handoffValue(params.context),
              pageIndex: pageIndex + 1,
            },
          },
        ]
      : []),
  ];

  const choices = applyActionCapabilityLimits(
    [
      ...branchChoices,
      ...pageActions,
      {
        id: "status:handoff",
        label: "Back",
        fallbackText: "back",
        style: "secondary" as const,
        priority: 1,
        value: handoffValue(params.context),
      },
      {
        id: "status:refresh",
        label: "Refresh",
        fallbackText: "refresh",
        style: "secondary" as const,
        priority: 3,
      },
      {
        id: "handoff:cancel",
        label: "Cancel",
        fallbackText: "cancel",
        style: "secondary" as const,
        priority: 2,
      },
    ],
    params.capabilityProfile,
  );

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
    choices,
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
  capabilityProfile?: MessagingCapabilityProfile;
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
    actions: applyActionCapabilityLimits(
      [
        {
          id: "handoff:confirm",
          label: "Confirm",
          fallbackText: "confirm",
          style: "primary",
          priority: 1,
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
          priority: 2,
          value: handoffValue(params.context),
        },
        {
          id: "handoff:cancel",
          label: "Cancel",
          fallbackText: "cancel",
          style: "secondary",
          priority: 3,
        },
      ],
      params.capabilityProfile,
    ),
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
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  models: Array<{ id: string; label?: string; current?: boolean }>;
}): MessagingSingleSelectIntent {
  // Build the full list and let applyActionCapabilityLimits drop the
  // lowest-priority entries (trailing models) on platforms with tighter
  // action budgets. Back stays as priority 1 (always kept); models are
  // priority 10+i so they degrade in display order.
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
    choices: applyActionCapabilityLimits(
      [
        ...params.models.map((model, index) => ({
          id: "status:set-model",
          label: `${model.label ?? model.id}${model.current ? " (current)" : ""}`,
          fallbackText: String(index + 1),
          style: "secondary" as const,
          priority: 10 + index,
          value: {
            model: model.id,
          },
        })),
        {
          id: "status:refresh",
          label: "Back",
          fallbackText: "back",
          style: "secondary" as const,
          priority: 1,
        },
      ],
      params.capabilityProfile,
    ),
  };
}

export function buildStatusReasoningPickerIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
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
    choices: applyActionCapabilityLimits(
      [
        ...params.efforts.map((effort, index) => ({
          id: "status:set-reasoning",
          label: effort,
          fallbackText: String(index + 1),
          style: "secondary" as const,
          priority: 10 + index,
          value: {
            reasoningEffort: effort,
          },
        })),
        {
          id: "status:refresh",
          label: "Back",
          fallbackText: "back",
          style: "secondary" as const,
          priority: 1,
        },
      ],
      params.capabilityProfile,
    ),
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

/**
 * Human-readable label for an execution mode in messaging surfaces.
 * Mirrors the desktop transcript copy: "Default Access" / "Full Access".
 */
export function formatExecutionModeLabel(mode: ThreadExecutionMode): string {
  return mode === "full-access" ? "Full Access" : "Default Access";
}

/**
 * Short label for the permissions action button. When a queued mode
 * change is pending this becomes
 *   "Permissions: <current> → <queued> (queued)"
 * so the user sees the pending target without needing to open the card.
 */
export function formatPermissionsActionLabel(
  current: string,
  queued?: ThreadExecutionMode,
): string {
  const currentLabel = current === "full-access" ? "Full Access" : "Default";
  if (!queued) {
    return `Permissions: ${currentLabel}`;
  }
  const queuedLabel = queued === "full-access" ? "Full Access" : "Default";
  return `Permissions: ${currentLabel} → ${queuedLabel} (queued)`;
}

/**
 * Long label used in the multi-line status card body. Same shape as the
 * action button but always uses the "Default Access" / "Full Access"
 * spellings for the current mode (action button uses "Default" alone for
 * width).
 */
function formatPermissionsLineLabel(
  current: string,
  queued?: ThreadExecutionMode,
): string {
  const currentLabel = current === "full-access" ? "Full Access" : "Default Access";
  if (!queued) {
    return currentLabel;
  }
  const queuedLabel = formatExecutionModeLabel(queued);
  return `${currentLabel} → ${queuedLabel} (queued)`;
}
