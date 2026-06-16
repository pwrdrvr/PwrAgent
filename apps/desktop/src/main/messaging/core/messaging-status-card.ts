import type {
  AppServerBackendKind,
  BackendSummary,
  CodexEnvironmentOption,
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
import { isAcpBackendId, shortenDerivedThreadTitle } from "@pwragent/shared";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  capabilityProfilePageSize,
  capabilityProfileSupportsActionCount,
  truncateActionsByPriority,
} from "@pwragent/messaging-interface";
import type { MessagingResolvedThreadState } from "./messaging-thread-state.js";
import {
  buildMessagingAcpRuntimeModeSummary,
  type MessagingAcpRuntimeModeChoice,
} from "./messaging-acp-runtime.js";

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

export const BRANCH_PICKER_PAGE_SIZE = 8;
export const HANDOFF_BRANCH_PAGE_SIZE = BRANCH_PICKER_PAGE_SIZE;

export function buildBindingStatusIntent(params: {
  allowFullAccessEscalation?: boolean;
  backendSummary?: BackendSummary;
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  contextUsageSummary?: string;
  createdAt: number;
  handoff?: MessagingWorkspaceHandoffContext;
  id: string;
  streamingResponsesDefault?: boolean;
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
  const modelOption = params.backendSummary?.launchpadOptions?.models?.find(
    (option) => option.id === model,
  );
  const supportsReasoning =
    !params.backendSummary ||
    Boolean(params.backendSummary.launchpadOptions?.reasoningEfforts?.length);
  const reasoning = supportsReasoning
    ? params.threadState.reasoningEffort ??
      preferences?.reasoningEffort ??
      defaults?.reasoningEffort ??
      unavailable()
    : undefined;
  const supportsFastMode = backendSupportsFastMode(
    params.backendSummary,
    modelOption,
  );
  const fastMode = supportsFastMode
    ? params.threadState.fastMode ?? preferences?.fastMode ?? defaults?.fastMode
    : undefined;
  const contextUsageLine = formatContextUsageLine(params.contextUsageSummary);
  const accountLine = formatBackendAccountLine(params.backendSummary, params.binding);
  const rateLimitsLine = formatBackendRateLimitsLine(params.backendSummary);
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
  const bindingKind = params.binding.targetKind === "agent_thread"
    ? "Agent binding"
    : "Binding";
  const toolUpdateMode = resolveMessagingToolUpdateMode(
    params.binding,
    params.toolUpdateMode,
  );
  const streamingMode = resolveMessagingStreamingResponseMode(params.binding);
  const streamingLabel = formatMessagingStreamingResponseModeLabel(
    streamingMode,
    params.streamingResponsesDefault,
  );
  const acpRuntimeMode = isAcpBackendId(params.binding.backend)
    ? buildMessagingAcpRuntimeModeSummary({
        backend: params.backendSummary,
        runtime: params.threadState.acpRuntime,
      })
    : undefined;
  const acpRuntimeLabel = acpRuntimeMode?.currentLabel;
  const acpRuntimeChoices = acpRuntimeMode?.choices ?? [];
  const permissionsLineLabel = formatPermissionsLineDisplayLabel({
    acpRuntimeLabel,
    current: permissionsMode,
    queued: queuedExecutionMode,
  });
  const permissionsActionLabel = formatPermissionsActionDisplayLabel({
    acpRuntimeLabel,
    current: permissionsMode,
    queued: queuedExecutionMode,
  });

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
      `${bindingKind}: ${bindingTitle} (${params.binding.backend})`,
      `Project: ${projectLabel}`,
      `Directory: ${directoryPath}`,
      params.threadState.worktreePath ? `Worktree: ${params.threadState.worktreePath}` : undefined,
      `Branch: ${branch ?? unavailable()}`,
      params.threadState.missing ? "Thread state: unavailable" : undefined,
      mentionRequiredLine(params.binding, params.capabilityProfile),
      `Model: ${model}`,
      reasoning ? `Reasoning: ${reasoning}` : undefined,
      supportsFastMode ? `Fast mode: ${fastMode ? "on" : "off"}` : undefined,
      planDeliveryLine(params.capabilityProfile),
      `Permissions: ${permissionsLineLabel}`,
      `Tool updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
      `Streaming: ${streamingLabel}`,
      params.binding.pendingSkillSelection
        ? `Pending skill: $${params.binding.pendingSkillSelection.name}`
        : undefined,
      contextUsageLine,
      accountLine,
      rateLimitsLine,
      `Thread: ${params.binding.threadId}`,
      activeTurn ? `Turn: ${activeTurn.status} (${activeTurn.turnId})` : "Turn: idle",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    actions: buildStatusActions({
      capabilityProfile: params.capabilityProfile,
      allowFullAccessEscalation: params.allowFullAccessEscalation,
      fastMode,
      handoff: params.handoff,
      permissionsMode,
      permissionsActionLabel,
      permissionsChoices: acpRuntimeChoices,
      supportsLegacyPermissionsAction:
        !isAcpBackendId(params.binding.backend) ||
        permissionsMode === "full-access",
      queuedExecutionMode,
      reasoning,
      supportsFastMode,
      supportsReasoning,
      streamingMode,
      streamingResponsesDefault: params.streamingResponsesDefault,
      toolUpdateMode,
    }),
  };
}

function backendSupportsFastMode(
  backendSummary: BackendSummary | undefined,
  modelOption: { supportsFast?: boolean } | undefined,
): boolean {
  if (!backendSummary) {
    return true;
  }
  if (backendSummary.kind !== "codex") {
    return false;
  }
  return modelOption?.supportsFast ?? backendSummary.launchpadOptions?.supportsFastMode ?? false;
}

function formatContextUsageLine(summary: string | undefined): string | undefined {
  if (!summary) {
    return undefined;
  }
  return `Context usage: ${summary}`;
}

function formatBackendAccountLine(
  backendSummary: BackendSummary | undefined,
  binding: MessagingBindingRecord,
): string | undefined {
  const account = backendSummary?.account;
  if (!account) {
    return undefined;
  }

  const kind =
    account.type === "chatgpt"
      ? "ChatGPT"
      : account.type === "apiKey"
        ? "API key"
        : undefined;
  const detail = [kind, account.planType].filter(Boolean).join(" ");
  if (binding.channel.conversation.kind !== "dm") {
    if (detail) {
      return `Account: ${detail}`;
    }
    if (kind) {
      return `Account: ${kind}`;
    }
    if (account.requiresOpenaiAuth) {
      return "Account: OpenAI auth required";
    }
    return undefined;
  }
  if (account.email && detail) {
    return `Account: ${account.email} (${detail})`;
  }
  if (account.email) {
    return `Account: ${account.email}`;
  }
  if (detail) {
    return `Account: ${detail}`;
  }
  if (account.requiresOpenaiAuth) {
    return "Account: OpenAI auth required";
  }
  return undefined;
}

function formatBackendRateLimitsLine(
  backendSummary: BackendSummary | undefined,
): string | undefined {
  const rateLimits = selectStatusRateLimits(backendSummary);
  if (!rateLimits || rateLimits.length === 0) {
    return undefined;
  }

  return `Rate limits: ${rateLimits
    .map((rateLimit) => formatBackendRateLimit(rateLimit))
    .filter((line): line is string => Boolean(line))
    .join("; ")}`;
}

function selectStatusRateLimits(
  backendSummary: BackendSummary | undefined,
): NonNullable<BackendSummary["rateLimits"]> | undefined {
  const limits = backendSummary?.rateLimits;
  if (!limits || limits.length === 0) {
    return undefined;
  }
  return [...limits].sort((left, right) => {
    const leftName = splitRateLimitName(left.name);
    const rightName = splitRateLimitName(right.name);
    const leftFamilyOrder = isSparkRateLimit(left) ? 1 : 0;
    const rightFamilyOrder = isSparkRateLimit(right) ? 1 : 0;
    if (leftFamilyOrder !== rightFamilyOrder) {
      return leftFamilyOrder - rightFamilyOrder;
    }
    if (leftName.labelOrder !== rightName.labelOrder) {
      return leftName.labelOrder - rightName.labelOrder;
    }
    return left.name.localeCompare(right.name);
  });
}

function formatBackendRateLimit(
  rateLimit: NonNullable<BackendSummary["rateLimits"]>[number],
): string | undefined {
  const { label } = splitRateLimitName(rateLimit.name);
  const displayLabel = isSparkRateLimit(rateLimit) ? `Spark ${label}` : label;
  const resetText = formatRateLimitReset(rateLimit.resetAt);
  const suffix = resetText ? `, resets ${resetText}` : "";

  if (rateLimit.usedPercent !== undefined) {
    return `${displayLabel}: ${Math.max(
      0,
      Math.round(100 - rateLimit.usedPercent),
    )}% left${suffix}`;
  }
  if (rateLimit.remaining !== undefined && rateLimit.limit !== undefined) {
    if (rateLimit.limit === 100) {
      return `${displayLabel}: ${Math.max(
        0,
        Math.round(rateLimit.remaining),
      )}% left${suffix}`;
    }
    return `${displayLabel}: ${formatWholeNumber(
      rateLimit.remaining,
    )}/${formatWholeNumber(rateLimit.limit)} left${suffix}`;
  } else if (rateLimit.remaining !== undefined) {
    return `${displayLabel}: ${Math.max(
      0,
      Math.round(rateLimit.remaining),
    )}% left${suffix}`;
  } else if (rateLimit.used !== undefined && rateLimit.limit !== undefined) {
    return `${displayLabel}: ${formatWholeNumber(rateLimit.used)}/${formatWholeNumber(
      rateLimit.limit,
    )} used${suffix}`;
  }

  return undefined;
}

function splitRateLimitName(name: string): {
  label: string;
  labelOrder: number;
} {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("5h limit")) {
    return { label: "5h limit", labelOrder: 0 };
  }
  if (lower.endsWith("weekly limit")) {
    return { label: "Weekly limit", labelOrder: 1 };
  }
  return { label: trimmed, labelOrder: 99 };
}

function isSparkRateLimit(
  rateLimit: NonNullable<BackendSummary["rateLimits"]>[number],
): boolean {
  return isSparkRateLimitName(rateLimit.limitId) ||
    isSparkRateLimitName(rateLimit.name);
}

function isSparkRateLimitName(value: string | undefined): boolean {
  return value?.toLowerCase().includes("spark") ?? false;
}

function formatRateLimitReset(resetAt: number | undefined): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (resetAt >= now && resetAt - now < oneDayMs) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function planDeliveryLine(
  capabilityProfile: MessagingCapabilityProfile | undefined,
): string {
  return capabilityProfile?.outboundAttachments?.supportsFileUpload
    ? "Plan delivery: Markdown attachment + inline preview"
    : "Plan delivery: inline preview";
}

function mentionRequiredLine(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile | undefined,
): string | undefined {
  if (
    binding.channel.conversation.kind === "dm" ||
    !capabilityProfile?.conversationInput?.sharedConversationRequiresMention
  ) {
    return undefined;
  }
  return capabilityProfile.conversationInput.sharedConversationStatusLine
    ?? capabilityProfile.conversationInput.sharedConversationMentionInstruction;
}

function buildStatusActions(params: {
  allowFullAccessEscalation?: boolean;
  capabilityProfile?: MessagingCapabilityProfile;
  fastMode: boolean | undefined;
  handoff?: MessagingWorkspaceHandoffContext;
  permissionsMode: string;
  permissionsActionLabel: string;
  permissionsChoices?: MessagingAcpRuntimeModeChoice[];
  supportsLegacyPermissionsAction?: boolean;
  queuedExecutionMode?: ThreadExecutionMode;
  reasoning?: string;
  supportsFastMode: boolean;
  supportsReasoning: boolean;
  streamingMode: MessagingStreamingResponseMode;
  streamingResponsesDefault?: boolean;
  toolUpdateMode: MessagingToolUpdateMode;
}): MessagingSurfaceAction[] {
  const profile = params.capabilityProfile;
  if (profile && !capabilityProfileSupportsActionCount(profile, STATUS_CARD_MIN_ACTIONS)) {
    return [];
  }

  const permissionsAction:
    | MessagingSurfaceAction
    | undefined =
    params.permissionsChoices?.length ||
    (params.supportsLegacyPermissionsAction !== false &&
      (params.permissionsMode === "full-access" ||
        params.allowFullAccessEscalation !== false))
      ? {
          id: "status:permissions",
          label: `Permissions: ${params.permissionsActionLabel}`,
          style: "secondary",
          fallbackText: "permissions",
          priority: 7,
        }
      : undefined;
  const allActions: MessagingSurfaceAction[] = [
    {
      id: "status:model",
      label: "Model",
      style: "secondary",
      fallbackText: "model",
      priority: 4,
    },
    ...(params.supportsReasoning && params.reasoning
      ? [
          {
            id: "status:reasoning",
            label: `Reasoning: ${params.reasoning}`,
            style: "secondary" as const,
            fallbackText: "reasoning",
            priority: 5,
          },
        ]
      : []),
    ...(params.supportsFastMode
      ? [
          {
            id: "status:fast",
            label: params.fastMode ? "Fast: on" : "Fast: off",
            style: "secondary" as const,
            fallbackText: "fast",
            priority: 6,
          },
        ]
      : []),
    ...(permissionsAction ? [permissionsAction] : []),
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
      label: `Stream: ${formatMessagingStreamingResponseModeLabel(
        params.streamingMode,
        params.streamingResponsesDefault,
      )}`,
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
      id: "status:skills",
      label: "Skills",
      style: "secondary",
      fallbackText: "skills",
      priority: 13,
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
  streamingResponsesDefault = false,
): MessagingStreamingResponseMode {
  switch (mode) {
    case "inherit":
      return streamingResponsesDefault ? "disabled" : "enabled";
    case "enabled":
      return "disabled";
    case "disabled":
      return "enabled";
  }
}

export function formatMessagingStreamingResponseModeLabel(
  mode: MessagingStreamingResponseMode,
  streamingResponsesDefault = false,
): string {
  switch (mode) {
    case "inherit":
      return streamingResponsesDefault ? "On" : "Off";
    case "disabled":
      return "Off";
    case "enabled":
      return "On";
  }
}

export function formatMessagingToolUpdateModeLabel(
  mode: MessagingToolUpdateMode,
): string {
  switch (mode) {
    case "show_none":
      return "None";
    case "show_less":
      return "Few";
    case "show_some":
      return "Some";
    case "show_more":
      return "More";
    case "show_all":
      return "All";
  }
}

export type MessagingToolUpdateModeChoice = {
  current?: boolean;
  label: string;
  mode: MessagingToolUpdateMode;
};

export function messagingToolUpdateModeChoices(
  currentMode: MessagingToolUpdateMode,
): MessagingToolUpdateModeChoice[] {
  return TOOL_UPDATE_MODE_ORDER.map((mode) => ({
    current: mode === currentMode,
    label: formatMessagingToolUpdateModeLabel(mode),
    mode,
  }));
}

export function buildHandoffOverviewIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  context: MessagingWorkspaceHandoffContext;
  createdAt: number;
  id: string;
}): MessagingSingleSelectIntent {
  const actions: MessagingSurfaceAction[] = [];
  if (params.context.workspaceKind === "local") {
    if (params.context.leaveLocalBranches.length > 0) {
      actions.push({
        id: "handoff:move-branch",
        label: "Move Existing Branch",
        fallbackText: String(actions.length + 1),
        style: "primary",
        value: {
          ...handoffValue(params.context),
          strategy: "move-branch",
        },
      });
    }
    actions.push({
      id: "handoff:create-detached",
      label: "Create Detached Head",
      fallbackText: String(actions.length + 1),
      style: actions.length === 0 ? "primary" : "secondary",
      value: {
        ...handoffValue(params.context),
        strategy: "detached-changes",
      },
    });
  } else {
    actions.push({
      id: "handoff:worktree-to-local",
      label: "Handoff to Local",
      fallbackText: "1",
      style: "primary",
      value: handoffValue(params.context),
    });
  }

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
      ...actions.map((action, index) => `${index + 1}. ${action.label}`),
      `Reply with ${actions.map((_, index) => index + 1).join(" or ")}, Back, Refresh, or Cancel.`,
    ].join("\n"),
    prompt: handoffOverviewText(params.context),
    choices: applyActionCapabilityLimits(
      [
        ...actions,
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

export function buildBranchPickerPage(params: {
  branches: string[];
  branchActionId: string;
  branchValue: (branch: string) => MessagingJsonValue;
  capabilityProfile?: MessagingCapabilityProfile;
  maxPageSize?: number;
  navActionCountBase?: number;
  navActionCountMultipage?: number;
  nextActionId: string;
  pageIndex?: number;
  pageSize?: number;
  pageValue?: (pageIndex: number) => MessagingJsonValue;
  previousActionId: string;
}): {
  branchChoices: MessagingSurfaceAction[];
  pageActions: MessagingSurfaceAction[];
  pageIndex: number;
  pageSize: number;
  totalPages: number;
} {
  const navActionCountBase = params.navActionCountBase ?? 3;
  const navActionCountMultipage = params.navActionCountMultipage ?? 5;
  const maxPageSize = params.maxPageSize ?? BRANCH_PICKER_PAGE_SIZE;
  const totalBranches = params.branches.length;
  const profilePageSize = (navActionCount: number): number =>
    params.capabilityProfile
      ? capabilityProfilePageSize(
          params.capabilityProfile,
          navActionCount,
          maxPageSize,
        )
      : maxPageSize;
  const singlePagePageSize = profilePageSize(navActionCountBase);
  const pageSize = Math.max(
    1,
    params.pageSize
      ?? (totalBranches <= singlePagePageSize
        ? singlePagePageSize
        : profilePageSize(navActionCountMultipage)),
  );
  const totalPages = Math.max(1, Math.ceil(totalBranches / pageSize));
  const pageIndex = clampPageIndex(params.pageIndex ?? 0, totalPages);
  const pageStart = pageIndex * pageSize;
  const pageBranches = params.branches.slice(pageStart, pageStart + pageSize);
  const pageValue = params.pageValue ?? ((index) => ({ pageIndex: index }));

  const branchChoices = pageBranches.map((branch, index) => {
    const branchNumber = pageStart + index + 1;
    return {
      id: params.branchActionId,
      label: `${branchNumber}. ${formatHandoffBranchChoiceLabel(branch)}`,
      fallbackText: String(branchNumber),
      style: "secondary" as const,
      priority: 100 + index,
      value: params.branchValue(branch),
    };
  });
  const pageActions: MessagingSurfaceAction[] = [
    ...(pageIndex > 0
      ? [
          {
            id: params.previousActionId,
            label: "Previous",
            fallbackText: "previous",
            style: "secondary" as const,
            priority: 4,
            value: pageValue(pageIndex - 1),
          },
        ]
      : []),
    ...(pageIndex < totalPages - 1
      ? [
          {
            id: params.nextActionId,
            label: "Next",
            fallbackText: "next",
            style: "secondary" as const,
            priority: 5,
            value: pageValue(pageIndex + 1),
          },
        ]
      : []),
  ];

  return {
    branchChoices,
    pageActions,
    pageIndex,
    pageSize,
    totalPages,
  };
}

function formatHandoffBranchChoiceLabel(branch: string): string {
  return branch === "HEAD" ? "Detached HEAD" : branch;
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
  const page = buildBranchPickerPage({
    branches: params.context.leaveLocalBranches,
    branchActionId: "handoff:select-leave-branch",
    branchValue: (branch) => ({
      ...handoffValue(params.context),
      leaveLocalBranch: branch,
    }),
    capabilityProfile: params.capabilityProfile,
    nextActionId: "handoff:branches:next",
    pageIndex: params.pageIndex,
    pageSize: params.pageSize,
    pageValue: (pageIndex) => ({
      ...handoffValue(params.context),
      pageIndex,
    }),
    previousActionId: "handoff:branches:previous",
  });

  const choices = applyActionCapabilityLimits(
    [
      ...page.branchChoices,
      ...page.pageActions,
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
      page.totalPages > 1
        ? `Page ${page.pageIndex + 1}/${page.totalPages}.`
        : undefined,
      ...page.branchChoices.map((choice) => choice.label),
      "Reply with a number, Back, Refresh, or Cancel.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    prompt: [
      "Choose the branch that should remain checked out in Local.",
      page.totalPages > 1
        ? `Page ${page.pageIndex + 1}/${page.totalPages}.`
        : undefined,
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
  strategy?: HandoffThreadWorkspaceRequest["strategy"];
}): MessagingConfirmationIntent {
  const direction =
    params.context.workspaceKind === "local" ? "local-to-worktree" : "worktree-to-local";
  const body = [
    params.strategy === "detached-changes"
      ? "Confirm new detached-head worktree."
      : direction === "local-to-worktree"
        ? "Confirm moving this branch to a new worktree."
        : "Confirm handoff to Local.",
    `Thread: ${params.context.threadTitle ?? params.context.threadId} (${params.context.backend})`,
    `Project: ${params.context.projectLabel ?? unavailable()}`,
    `Repository: ${params.context.repositoryPath}`,
    `Working directory: ${params.context.workingDirectoryPath}`,
    `Branch: ${params.context.branch ?? unavailable()}`,
    params.leaveLocalBranch
      ? `Leave Local on: ${formatHandoffBranchChoiceLabel(params.leaveLocalBranch)}`
      : undefined,
    params.strategy ? `Strategy: ${params.strategy}` : undefined,
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
            ...(params.strategy ? { strategy: params.strategy } : {}),
            ...(params.leaveLocalBranch
              ? { leaveLocalBranch: params.leaveLocalBranch }
              : {}),
          },
        },
        {
          id: params.context.workspaceKind === "local"
            ? params.strategy === "move-branch"
              ? "handoff:move-branch"
              : "status:handoff"
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
    strategy:
      value.strategy === "move-branch" ||
      value.strategy === "detached-changes" ||
      value.strategy === "new-branch"
        ? value.strategy
        : undefined,
    repositoryPath: value.repositoryPath,
    sourcePath: value.sourcePath,
    sourceBranch: typeof value.sourceBranch === "string" ? value.sourceBranch : undefined,
    leaveLocalBranch:
      typeof value.leaveLocalBranch === "string" ? value.leaveLocalBranch : undefined,
    newBranchName:
      typeof value.newBranchName === "string" ? value.newBranchName : undefined,
  };
}

export function buildStatusModelPickerIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  currentModelId?: string;
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
          label: `${model.label ?? model.id}${
            (params.currentModelId ? model.id === params.currentModelId : model.current)
              ? " (current)"
              : ""
          }`,
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
  currentReasoningEffort?: string;
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
          label: `${effort}${effort === params.currentReasoningEffort ? " (current)" : ""}`,
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

export function buildStatusAcpRuntimeModePickerIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  choices: MessagingAcpRuntimeModeChoice[];
  createdAt: number;
  id: string;
  prompt?: string;
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
    fallbackText: "Reply with a permissions option number, Back, or Cancel.",
    prompt: params.prompt ?? "Select Permissions",
    choices: applyActionCapabilityLimits(
      [
        ...params.choices.map((choice, index) => ({
          id: "status:set-runtime-mode",
          label: `${choice.label}${choice.selected ? " (current)" : ""}`,
          fallbackText: String(index + 1),
          style: "secondary" as const,
          priority: 10 + index,
          value: {
            optionId: choice.optionId,
            source: choice.source,
            value: choice.value,
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

export function buildStatusPermissionsPickerIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  currentMode: ThreadExecutionMode;
  id: string;
}): MessagingSingleSelectIntent {
  const choices: Array<{ label: string; mode: ThreadExecutionMode }> = [
    { label: "Default", mode: "default" },
    { label: "Full Access", mode: "full-access" },
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
    fallbackText: "Reply with a permissions option number, Back, or Cancel.",
    prompt: "Select Permissions",
    choices: applyActionCapabilityLimits(
      [
        ...choices.map((choice, index) => ({
          id: "status:set-permissions",
          label: `${choice.label}${choice.mode === params.currentMode ? " (current)" : ""}`,
          fallbackText: String(index + 1),
          style: "secondary" as const,
          priority: 10 + index,
          value: {
            executionMode: choice.mode,
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

export function buildStatusToolUpdateModePickerIntent(params: {
  binding: MessagingBindingRecord;
  capabilityProfile?: MessagingCapabilityProfile;
  choices: MessagingToolUpdateModeChoice[];
  createdAt: number;
  id: string;
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
    fallbackText: "Reply with a tools option number, Back, or Cancel.",
    prompt: "Select Tools",
    choices: applyActionCapabilityLimits(
      [
        ...params.choices.map((choice, index) => ({
          id: "status:set-tool-updates",
          label: `${choice.label}${choice.current ? " (current)" : ""}`,
          fallbackText: String(index + 1),
          style: "secondary" as const,
          priority: 10 + index,
          value: {
            toolUpdateMode: choice.mode,
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

export function buildNewThreadEnvironmentPickerIntent(params: {
  browseSessionId: string;
  capabilityProfile?: MessagingCapabilityProfile;
  createdAt: number;
  currentEnvironmentId?: string | null;
  id: string;
  options: CodexEnvironmentOption[];
  targetSurface?: MessagingStatusIntent["targetSurface"];
}): MessagingSingleSelectIntent {
  return {
    id: params.id,
    kind: "single_select",
    browseSessionId: params.browseSessionId,
    createdAt: params.createdAt,
    delivery: params.targetSurface
      ? { mode: "update", replaceMarkup: true }
      : undefined,
    targetSurface: params.targetSurface,
    fallbackText: "Reply with an environment number, Back, or Cancel.",
    prompt: "Select Environment",
    choices: applyActionCapabilityLimits(
      [
        {
          id: "browse:new:set-environment",
          label: `None${params.currentEnvironmentId ? "" : " (current)"}`,
          fallbackText: "none",
          style: "secondary" as const,
          priority: 10,
          value: {
            environmentId: null,
          },
        },
        ...params.options.map((option, index) => ({
          id: "browse:new:set-environment",
          label: `${option.name}${option.id === params.currentEnvironmentId ? " (current)" : ""}`,
          fallbackText: String(index + 1),
          style: "secondary" as const,
          priority: 20 + index,
          value: {
            environmentId: option.id,
          },
        })),
        {
          id: "browse:new:environment:back",
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

export function formatPermissionsActionDisplayLabel(params: {
  acpRuntimeLabel?: string;
  current: string;
  queued?: ThreadExecutionMode;
}): string {
  return formatPermissionsDisplayLabel({
    acpRuntimeLabel: params.acpRuntimeLabel,
    executionLabel: formatPermissionsActionLabel(params.current, params.queued).replace(
      /^Permissions:\s*/,
      "",
    ),
    current: params.current,
    queued: params.queued,
  });
}

export function formatPermissionsLineDisplayLabel(params: {
  acpRuntimeLabel?: string;
  current: string;
  queued?: ThreadExecutionMode;
}): string {
  return formatPermissionsDisplayLabel({
    acpRuntimeLabel: params.acpRuntimeLabel,
    executionLabel: formatPermissionsLineLabel(params.current, params.queued),
    current: params.current,
    queued: params.queued,
  });
}

function formatPermissionsDisplayLabel(params: {
  acpRuntimeLabel?: string;
  executionLabel: string;
  current: string;
  queued?: ThreadExecutionMode;
}): string {
  if (!params.acpRuntimeLabel) {
    return params.executionLabel;
  }
  if (params.current === "default" && !params.queued) {
    return params.acpRuntimeLabel;
  }
  return `${params.acpRuntimeLabel} + ${params.executionLabel}`;
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
