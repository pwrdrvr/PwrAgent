import {
  type ReactNode,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { JSONContent } from "@tiptap/react";
import type {
  AppServerAvailableCommandSummary,
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  BackendSummary,
  CodexEnvironmentOption,
  CodexEnvironmentActionRun,
  CodexThreadEnvironmentRuntime,
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  HandoffThreadWorkspaceRequest,
  NavigationDirectorySummary,
  NavigationGitCommitSummary,
  NavigationLaunchpadDraft,
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
  NavigationThreadSummary,
  ThreadWorkspaceHandoffStrategy,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { readCodexEnvironmentActionRuns } from "@pwragent/shared";
import {
  BranchIcon,
  CheckIcon,
  ChevronUpIcon,
  CloseIcon,
  FileCodeIcon,
  FolderIcon,
  LightningIcon,
  PlanIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
} from "../../icons";
import { AppIcon } from "../../components/AppIcon";
import { ImageLightbox } from "../thread-detail/ImageLightbox";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { formatBackendLabel } from "../../lib/backend-label";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  acpRuntimeModeRequiresFullAccess,
  formatExecutionModeLabel,
  getAcpRuntimeModeControl,
} from "../../lib/execution-mode";
import { isSameWorktreeSubthreadLaunchpad } from "../../lib/subthread-launchpads";
import {
  buildDirectoryReferenceInsertText,
  buildDirectoryReferenceMarkdown,
  buildDirectoryReferenceTooltip,
  buildFileReferenceTooltip,
  decodeMarkdownDestination,
  fileLabelFromPath,
  filterDirectoryReferenceCandidates,
  findDirectoryReferenceTrigger,
  listReferencedDirectories,
} from "../../lib/directory-references";
import { expandTildePath } from "../../lib/tildify-path";
import { normalizeImageFile } from "../../lib/image-normalization";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import {
  findSkillTrigger,
  hydrateSkillLabelsWithMarkdown,
  listMentionedSkills,
  parseSkillMentionParts,
  buildSkillMentionMarkdown,
} from "../../lib/skill-mentions";
import { parseReviewCommand } from "../../../../shared/review-command";
import {
  type ComposerInputChangeMetadata,
  type ComposerInputHandle,
  type ComposerSkillToken,
} from "./ComposerInputTypes";
import { ComposerTiptapInput } from "./ComposerTiptapInput";
import { ProjectPicker } from "./ProjectPicker";
import { ReferencePicker, type ReferencePickerFile } from "./ReferencePicker";
import { TranscriptCopyButton } from "../thread-detail/TranscriptCopyButton";
import {
  EnvActionRunEntry,
  EnvActionRunsView,
  formatDurationMs,
  formatRunningDurationMs,
} from "../thread-detail/EnvActionRunsView";
import {
  getNextReleasableQueuedTurn,
  useComposerDraftStore,
  type ComposerDraftSnapshot,
  type ComposerDraftStore,
  type ComposerPendingSteerSnapshot,
  type ComposerQueuedTurnSnapshot,
} from "./useComposerDraftStore";

type ComposerProps = {
  activeTurnId?: string;
  addOptimisticReviewEntry?: (displayText: string) => string;
  addOptimisticUserMessage?: (
    text: string,
    imageParts?: AppServerThreadImagePart[]
  ) => string;
  backends?: BackendSummary[];
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: DesktopApi;
  /**
   * Surface a transient app-level toast (image attachment limit reached,
   * pasted image rejected on a non-vision model). Plumbed up to the shared
   * AppNoticeToast stack in App.tsx.
   */
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
  directory?: NavigationDirectorySummary;
  /**
   * Full set of currently-tracked directories from the navigation
   * snapshot. Used by the project picker (issue #223) to render the
   * "recent directories" list. Optional so tests / threads-only
   * surfaces don't have to provide it.
   */
  directories?: NavigationDirectorySummary[];
  disabled?: boolean;
  contextWindow?: ThreadContextWindowState;
  composerImplementation?: DesktopChatReplyComposer;
  draftStore?: ComposerDraftStore;
  launchpad?: NavigationLaunchpadDraft;
  launchpadError?: string;
  unavailableReason?: string;
  onActiveTurnIdChange?: (turnId?: string) => void;
  fullAccessRiskWarningDismissed?: boolean;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  onDismissFullAccessRiskWarning?: () => Promise<void>;
  pendingRequestActive?: boolean;
  pendingUserInputActive?: boolean;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest,
    reviewTarget?: AppServerReviewTarget,
    /**
     * Paths of tracked directories the draft references (`@`-inserted or
     * typed by hand). Linked to the new thread right after it is created.
     */
    extraDirectoryPaths?: string[]
  ) => Promise<void>;
  /** Discard this launchpad draft (the "Cancel" button next to "Start thread"). */
  onCancelLaunchpad?: (directoryKey: string) => void;
  onMoveEnvActionsToSidebar?: () => void;
  onDismissEnvActionRun?: (run: CodexEnvironmentActionRun) => void;
  onStopEnvActionRun?: (
    run: CodexEnvironmentActionRun,
    mode: "stop" | "terminate"
  ) => void;
  hiddenEnvActionRunIds?: ReadonlySet<string>;
  showEnvActionAnchors?: boolean;
  onBeforeSendTurn?: () => void;
  onPendingStatusChange?: (status?: string) => void;
  onRefreshNavigation?: () => Promise<void>;
  pastedImageMaxPatches?: number;
  onUpdateLaunchpad?: (
    directoryKey: string,
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "prompt"
        | "editorDocument"
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "acpRuntime"
        | "workMode"
        | "branchName"
        | "codexEnvironmentId"
        | "codexEnvironmentExecutionTarget"
        | "codexEnvironmentActionId"
        | "directoryLabel"
        | "directoryPath"
        | "imageAttachments"
        | "fileAttachments"
      >
    >,
    options?: { stickySettingsChanged?: boolean }
  ) => Promise<void>;
  removeOptimisticMessage?: (id: string) => void;
  /**
   * Project-directory picker plumbing (issue #223). Optional — surfaces
   * that don't render a launchpad (read-only thread views) won't pass
   * these through and the picker won't render.
   */
  onSelectDirectoryFromPicker?: (directory: NavigationDirectorySummary) => void;
  onSelectNoDirectoryFromPicker?: () => void;
  onPickAndRegisterDirectory?: () => void;
  onPickAndAttachDirectoryToThread?: () => void;
  /**
   * Link draft-referenced directories to the thread the turn was sent to
   * (the launchpad path rides on `onMaterializeLaunchpad`'s
   * `extraDirectoryPaths` instead). The composer names the target thread
   * explicitly so a selection change while the send was in flight — or a
   * queued turn firing later — cannot attach to the wrong thread.
   * Fire-and-forget; failures must not block the turn.
   */
  onAttachDirectoryReferences?: (
    paths: string[],
    target: {
      backend: NavigationThreadSummary["source"];
      threadId: string;
    },
  ) => void;
  /**
   * "@ → Add directory…" / "+"-menu picker: opens the OS directory dialog,
   * registers the pick as a tracked directory WITHOUT navigating, and
   * resolves with its label/path so the composer can mint a reference chip
   * in place. Resolves undefined on cancel or failure (failures surface
   * via `pickDirectoryError`).
   */
  onPickDirectoryForReference?: () => Promise<
    { label: string; path: string } | undefined
  >;
  onClearPickDirectoryError?: () => void;
  pickDirectoryError?: string;
  pickingDirectory?: boolean;
  setExecutionModeError?: string;
  skillError?: string;
  skillLoading?: boolean;
  providerCommands?: AppServerAvailableCommandSummary[];
  skills: AppServerSkillSummary[];
  thread?: NavigationThreadSummary;
  /** Selected-thread Thinking state from useThreadSessionState. Do not rebuild it here. */
  threadBusy?: boolean;
  updatingExecutionMode?: ThreadExecutionMode;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
  onSetAcpRuntimeOption?: (params: {
    source: "configOption" | "mode";
    optionId: string;
    value: string;
  }) => Promise<void>;
  onCancelExecutionModeQueue?: () => Promise<void>;
  onHandoffThreadWorkspace?: (
    request: Omit<HandoffThreadWorkspaceRequest, "backend" | "threadId">
  ) => Promise<void>;
  onBeforeStartTurn?: () => Promise<boolean>;
  onSetThreadModelSettings?: (
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  threadModelSettingsError?: string;
};

type LocalHandoffStrategy = ThreadWorkspaceHandoffStrategy;

type ComposerImageAttachment = NavigationLaunchpadImageAttachment;

type ComposerFileAttachment = NavigationLaunchpadFileAttachment;

/**
 * Maximum number of image attachments allowed on a single message. No
 * provider currently advertises its own per-message image limit, so this is
 * the default cap; if a backend ever reports one, prefer the smaller value.
 */
const MAX_COMPOSER_IMAGE_ATTACHMENTS = 5;

/**
 * Maximum number of path-only file references on a single message. Higher
 * than the image cap because references are a few bytes of text each — the
 * limit only guards against an accidental mass drop.
 */
const MAX_COMPOSER_FILE_ATTACHMENTS = 20;

type ComposerDropdownOption = {
  disabled?: boolean;
  label: string;
  value: string;
};

type ComposerDropdownIcon = (props: { size?: number }) => ReactNode;

function resolveSelectedCodexEnvironmentActionId(params: {
  environment?: CodexEnvironmentOption;
  actionId?: string;
  actionIdByEnvironmentId?: Record<string, string>;
}): string | undefined {
  const { environment } = params;
  if (!environment) {
    return undefined;
  }
  if (environment.actions.some((action) => action.id === params.actionId)) {
    return params.actionId;
  }
  const mappedActionId = params.actionIdByEnvironmentId?.[environment.id];
  if (environment.actions.some((action) => action.id === mappedActionId)) {
    return mappedActionId;
  }
  return environment.actions[0]?.id;
}

type QueuedTurnDraft = {
  id: string;
  input?: AppServerTurnInputItem[];
  imageAttachments: ComposerImageAttachment[];
  fileAttachments: ComposerFileAttachment[];
  scheduledSendAt?: number;
  reviewCommand?: {
    cwd?: string;
    displayText: string;
    target: AppServerReviewTarget;
  };
  text: string;
};

type PendingSteerDraft = QueuedTurnDraft & {
  status: "pending" | "steering";
};

type DeletedSkillTokenHistoryEntry = {
  draft: string;
  selectionStart: number;
  skillTokens: ComposerSkillToken[];
};

type RecoveryLookupRequest = {
  lookupId: number;
  scopeKey: string;
  version: number;
};

type PendingProgrammaticComposerChange = {
  expectedDraft: string;
  expectedSkillTokensSignature: string;
  staleDraft: string;
  staleSkillTokensSignature: string;
};

type ComposerImageFile = {
  file: File;
  type: string;
};

type ModelOption = NonNullable<
  NonNullable<BackendSummary["launchpadOptions"]>["models"]
>[number];

type SlashCommandSuggestion = {
  aliases?: string[];
  description: string;
  id: string;
  insertText: string;
  label: string;
  source: "provider" | "pwragent";
  sourceLabel: string;
};

type AutocompleteKind = "skills" | "slash" | "directories";
type ReviewTargetChoice = AppServerReviewTarget["type"];

const CONTEXT_MOON_PHASES = [
  "new moon",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full moon",
  "waning gibbous",
  "third quarter",
  "waning crescent",
  "critical",
] as const;

type ReviewConfigState = {
  branch: string;
  branchSource?: "auto" | "user";
  commit: string;
  customInstructions: string;
  target?: ReviewTargetChoice;
  workspaceCwd?: string;
};

type ReviewWorkspaceOption = {
  cwd: string;
  key: string;
  label: string;
  path: string;
};

const DEFAULT_REASONING_EFFORT = "medium";
const SCHEDULED_SEND_OPTIONS = [
  { label: "Send in 15m", delayMs: 15 * 60_000 },
  { label: "Send in 30m", delayMs: 30 * 60_000 },
  { label: "Send in 1h", delayMs: 60 * 60_000 },
  { label: "Send in 2h", delayMs: 2 * 60 * 60_000 },
] as const;

type ScheduledSendMenuOption = {
  delayMs?: number;
  label: string;
  scheduledSendAt?: number;
};

let queuedTurnIdSequence = 0;

function createQueuedTurnId(): string {
  queuedTurnIdSequence += 1;
  return `queued-turn-${Date.now().toString(36)}-${queuedTurnIdSequence.toString(36)}`;
}

const globalQueuedTurnReleaseScopeKeys = new Set<string>();

function getFutureScheduledSendAt(
  scheduledSendAt: number | undefined,
  now = Date.now(),
): number | undefined {
  if (typeof scheduledSendAt !== "number" || !Number.isFinite(scheduledSendAt)) {
    return undefined;
  }
  return scheduledSendAt > now ? scheduledSendAt : undefined;
}

function formatScheduledSendCountdown(
  scheduledSendAt: number,
  now = Date.now(),
): string {
  return formatRunningDurationMs(Math.max(0, scheduledSendAt - now));
}

function isFiveHourRateLimitName(value?: string): boolean {
  return value?.toLowerCase().endsWith("5h limit") ?? false;
}

function rateLimitMatchesModel(
  rateLimit: NonNullable<BackendSummary["rateLimits"]>[number],
  selectedModelOption?: ModelOption,
): boolean {
  const modelTerms = [
    selectedModelOption?.id,
    selectedModelOption?.label,
  ]
    .filter((term): term is string => Boolean(term))
    .map((term) => term.toLowerCase());
  if (modelTerms.length === 0) {
    return false;
  }

  const searchable = [
    rateLimit.limitId,
    rateLimit.name,
  ]
    .filter((term): term is string => Boolean(term))
    .map((term) => term.toLowerCase());
  return modelTerms.some((term) =>
    searchable.some((candidate) => candidate.includes(term))
  );
}

function getFiveHourRateLimitResetAt(params: {
  backend?: BackendSummary;
  now: number;
  selectedModelOption?: ModelOption;
}): number | undefined {
  const candidates = (params.backend?.rateLimits ?? []).filter((rateLimit) => {
    const resetAt = rateLimit.resetAt;
    return (
      typeof resetAt === "number" &&
      Number.isFinite(resetAt) &&
      resetAt > params.now &&
      (isFiveHourRateLimitName(rateLimit.name) ||
        isFiveHourRateLimitName(rateLimit.limitId))
    );
  });
  if (candidates.length === 0) {
    return undefined;
  }

  const modelSpecific = candidates.filter((candidate) =>
    rateLimitMatchesModel(candidate, params.selectedModelOption)
  );
  const generic = candidates.filter(
    (candidate) => candidate.name.toLowerCase() === "5h limit",
  );
  const ordered =
    modelSpecific.length > 0
      ? modelSpecific
      : generic.length > 0
        ? generic
        : candidates;
  return Math.min(...ordered.map((candidate) => candidate.resetAt!));
}

const SLASH_COMMANDS: SlashCommandSuggestion[] = [
  {
    id: "review-current",
    label: "/review",
    insertText: "/review",
    description: "Review current staged, unstaged, and untracked changes",
    source: "pwragent",
    sourceLabel: "PwrAgent",
  },
];

function providerCommandToSlashSuggestion(
  command: AppServerAvailableCommandSummary,
  backends: BackendSummary[] = [],
): SlashCommandSuggestion {
  const commandName = command.name.startsWith("/")
    ? command.name.slice(1)
    : command.name;
  const sourceLabel = command.backend
    ? formatBackendLabel(command.backend, backends)
    : "Provider";
  return {
    id: `provider:${command.backend ?? "unknown"}:${commandName}`,
    label: `/${commandName}`,
    insertText: `/${commandName}`,
    description: command.description ?? "Provider command",
    aliases: command.aliases,
    source: "provider",
    sourceLabel,
  };
}

function slashCommandMatchesText(
  command: SlashCommandSuggestion,
  text: string,
): boolean {
  const normalizedText = text.toLowerCase();
  return (
    command.label.toLowerCase() === normalizedText ||
    (command.aliases ?? []).some(
      (alias) => `/${alias}`.toLowerCase() === normalizedText,
    )
  );
}

const REVIEW_TARGET_OPTIONS: Array<{
  description: string;
  label: string;
  target: ReviewTargetChoice;
}> = [
  {
    target: "baseBranch",
    label: "Base branch",
    description: "Compare this branch with a base branch",
  },
  {
    target: "uncommittedChanges",
    label: "Current changes",
    description: "Review staged, unstaged, and untracked files",
  },
  {
    target: "commit",
    label: "Commit",
    description: "Review one commit by SHA",
  },
  {
    target: "custom",
    label: "Custom",
    description: "Review using custom instructions",
  },
];

const REVIEW_PREFERRED_BASE_BRANCHES = ["main", "master", "develop", "trunk"];
const REVIEW_REMOTE_AGNOSTIC_BASE_BRANCH_PATTERN =
  /^(main|master|develop|development|trunk)$|^(release|releases|stable|support|maintenance)\//;

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
  return reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : reasoningEfforts[0];
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

function buildReviewBranchOptions(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
}): string[] {
  const threadCurrentBranches = [
    params.thread?.gitBranch,
    params.thread?.observedGitBranch,
  ]
    .map((branch) => branch?.trim())
    .filter((branch): branch is string => Boolean(branch));
  const currentBranches = new Set(
    [
      ...threadCurrentBranches,
      ...(threadCurrentBranches.length === 0
        ? [params.directory?.gitStatus?.currentBranch]
        : []),
    ]
      .map((branch) => branch?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  const isCurrentBranch = (candidate?: string): boolean => {
    const value = candidate?.trim();
    if (!value) {
      return false;
    }
    if (currentBranches.has(value)) {
      return true;
    }
    return (
      value.startsWith("origin/") &&
      currentBranches.has(value.slice("origin/".length))
    );
  };
  const upstreamBranch = params.directory?.gitStatus?.upstreamBranch?.replace(
    /^origin\//,
    "",
  );
  const directoryCurrentBranch = params.directory?.gitStatus?.currentBranch
    ?.trim()
    .replace(/^origin\//, "");
  const directoryDefaultBranch = params.directory?.gitStatus?.defaultBranch
    ?.trim()
    .replace(/^origin\//, "");
  const baseBranches = params.directory?.gitStatus?.baseBranches ?? [];
  const knownBranches = new Set(
    [
      ...baseBranches,
      ...(params.directory?.gitStatus?.branches ?? []),
      params.directory?.gitStatus?.defaultBranch,
      upstreamBranch,
    ]
      .map((branch) => branch?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  const options = new Set<string>();
  const push = (
    candidate?: string,
    optionsForCandidate?: { allowCurrent?: boolean },
  ): void => {
    const value = candidate?.trim();
    if (
      value &&
      (optionsForCandidate?.allowCurrent || !isCurrentBranch(value))
    ) {
      options.add(value);
    }
  };
  const pushIfKnown = (candidate?: string): void => {
    const value = candidate?.trim();
    if (value && knownBranches.has(value)) {
      push(value);
    }
  };
  const pushPreferredDefault = (candidate?: string): void => {
    const value = candidate?.trim().replace(/^origin\//, "");
    if (!value) {
      return;
    }
    pushIfKnown(`origin/${value}`);
    pushIfKnown(value);
  };
  const pushDirectoryDefault = (): void => {
    if (!directoryDefaultBranch) {
      return;
    }
    if (
      threadCurrentBranches.length > 0 &&
      directoryDefaultBranch === directoryCurrentBranch &&
      !REVIEW_REMOTE_AGNOSTIC_BASE_BRANCH_PATTERN.test(directoryDefaultBranch)
    ) {
      return;
    }
    pushPreferredDefault(directoryDefaultBranch);
  };
  const pushInferredBaseBranch = (candidate?: string): void => {
    const value = candidate?.trim();
    if (!value) {
      return;
    }

    const optionCount = options.size;
    if (value.startsWith("origin/")) {
      pushIfKnown(value);
      pushIfKnown(value.slice("origin/".length));
    } else if (REVIEW_REMOTE_AGNOSTIC_BASE_BRANCH_PATTERN.test(value)) {
      pushIfKnown(`origin/${value}`);
      pushIfKnown(value);
    } else {
      pushIfKnown(value);
    }

    if (options.size === optionCount) {
      push(value);
    }
  };

  pushInferredBaseBranch(params.thread?.gitWorkingState?.baseBranch);
  pushDirectoryDefault();
  for (const branch of REVIEW_PREFERRED_BASE_BRANCHES) {
    pushPreferredDefault(branch);
  }
  push("main", { allowCurrent: true });
  pushIfKnown(upstreamBranch);
  for (const candidate of baseBranches) {
    push(candidate);
  }
  push(params.thread?.gitBranch);
  push(params.thread?.observedGitBranch);
  push(params.directory?.gitStatus?.currentBranch);
  for (const candidate of params.directory?.gitStatus?.branches ?? []) {
    push(candidate);
  }
  return [...options];
}

function buildReviewBranchPickerOptions(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
}): LaunchpadBranchOption[] {
  const details =
    params.directory?.gitStatus?.baseBranchDetails ??
    params.directory?.gitStatus?.branchDetails ??
    [];
  const detailByName = new Map(details.map((detail) => [detail.name, detail]));
  const currentBranch = normalizeSelectableLaunchpadBranch(
    params.thread?.gitBranch ??
      params.thread?.observedGitBranch ??
      params.directory?.gitStatus?.currentBranch,
  );
  const defaultBranch = normalizeSelectableLaunchpadBranch(
    params.directory?.gitStatus?.defaultBranch,
  );

  return buildReviewBranchOptions(params).map((name) => {
    const detail = detailByName.get(name);
    return {
      name,
      lastCommitAt: detail?.lastCommitAt,
      inUse: detail?.inUse,
      current: currentBranch ? name === currentBranch : false,
      isDefault: defaultBranch ? name === defaultBranch : false,
    };
  });
}

function buildReviewCommitOptions(
  directory?: NavigationDirectorySummary,
): NavigationGitCommitSummary[] {
  return (directory?.gitStatus?.recentCommits ?? []).slice(0, 20);
}

function getLaunchpadDirectoryKeyFromScope(scopeKey: string): string | undefined {
  return scopeKey.startsWith("launchpad:")
    ? scopeKey.slice("launchpad:".length)
    : undefined;
}

function getThreadComposerScopeKey(backend: string, threadId: string): string {
  return `thread:${backend}:${threadId}`;
}

function createReviewConfig(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
  reviewCommand?: {
    cwd?: string;
    target: AppServerReviewTarget;
  };
}): ReviewConfigState {
  const workspaceOptions = buildReviewWorkspaceOptions(params.thread);
  const config: ReviewConfigState = {
    branch: buildReviewBranchOptions(params)[0] ?? "main",
    branchSource: "auto",
    commit: "",
    customInstructions: "",
    target: "baseBranch",
    workspaceCwd: params.reviewCommand?.cwd ?? (
      workspaceOptions.length === 1 ? workspaceOptions[0]?.cwd : undefined
    ),
  };
  const target = params.reviewCommand?.target;
  if (!target) {
    return config;
  }
  if (target.type === "uncommittedChanges") {
    return { ...config, target: "uncommittedChanges" };
  }
  if (target.type === "baseBranch") {
    return {
      ...config,
      branch: target.branch,
      branchSource: "user",
      target: "baseBranch",
    };
  }
  if (target.type === "commit") {
    return { ...config, commit: target.sha, target: "commit" };
  }
  return {
    ...config,
    customInstructions: target.instructions,
    target: "custom",
  };
}

function linkedDirectoryReviewCwd(
  directory: NavigationThreadSummary["linkedDirectories"][number],
): string | undefined {
  const cwd = (directory.worktreePath ?? directory.path).trim();
  return cwd || undefined;
}

function buildReviewWorkspaceOptions(
  thread?: NavigationThreadSummary,
): ReviewWorkspaceOption[] {
  const options: ReviewWorkspaceOption[] = [];
  const seen = new Set<string>();
  for (const directory of thread?.linkedDirectories ?? []) {
    const cwd = linkedDirectoryReviewCwd(directory);
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    const label = directory.label.trim() || cwd;
    options.push({
      cwd,
      key: `${directory.id}:${cwd}`,
      label,
      path: cwd,
    });
  }
  return options;
}

function normalizeReviewWorkspacePath(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function reviewWorkspacePathMatches(
  left?: string,
  right?: string,
): boolean {
  const normalizedLeft = normalizeReviewWorkspacePath(left);
  const normalizedRight = normalizeReviewWorkspacePath(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft === normalizedRight,
  );
}

function findReviewDirectoryForWorkspace(params: {
  directories?: NavigationDirectorySummary[];
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
  workspaceCwd?: string;
}): NavigationDirectorySummary | undefined {
  const workspaceCwd = normalizeReviewWorkspacePath(params.workspaceCwd);
  if (!workspaceCwd) {
    return params.directory;
  }

  const directories = [
    params.directory,
    ...(params.directories ?? []),
  ].filter((directory): directory is NavigationDirectorySummary =>
    Boolean(directory)
  );
  const directMatch = directories.find((directory) =>
    reviewWorkspacePathMatches(directory.path, workspaceCwd) ||
      reviewWorkspacePathMatches(
        directory.key.startsWith("directory:")
          ? directory.key.slice("directory:".length)
          : directory.key,
        workspaceCwd,
      )
  );
  if (directMatch) {
    return directMatch;
  }

  const linkedDirectory = params.thread?.linkedDirectories.find((directory) =>
    reviewWorkspacePathMatches(directory.worktreePath, workspaceCwd) ||
      reviewWorkspacePathMatches(directory.path, workspaceCwd)
  );
  if (!linkedDirectory) {
    return params.directory;
  }

  return directories.find((directory) =>
    reviewWorkspacePathMatches(directory.path, linkedDirectory.path) ||
      reviewWorkspacePathMatches(directory.path, linkedDirectory.worktreePath) ||
      reviewWorkspacePathMatches(
        directory.key.startsWith("directory:")
          ? directory.key.slice("directory:".length)
          : directory.key,
        linkedDirectory.path,
      )
  ) ?? params.directory;
}

function buildConfiguredReviewCommand(
  config: ReviewConfigState | undefined
): { cwd?: string; displayText: string; target: AppServerReviewTarget } | undefined {
  if (!config?.target) {
    return undefined;
  }
  const cwd = config.workspaceCwd?.trim() || undefined;

  if (config.target === "uncommittedChanges") {
    return {
      ...(cwd ? { cwd } : {}),
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
    };
  }

  if (config.target === "baseBranch") {
    const branch = config.branch.trim();
    return branch
      ? {
          ...(cwd ? { cwd } : {}),
          target: { type: "baseBranch", branch },
          displayText: `Review changes against ${branch}`,
        }
      : undefined;
  }

  if (config.target === "commit") {
    const sha = config.commit.trim();
    return sha
      ? {
          ...(cwd ? { cwd } : {}),
          target: { type: "commit", sha, title: null },
          displayText: `Review commit ${sha}`,
        }
      : undefined;
  }

  const instructions = config.customInstructions.trim();
  return instructions
    ? {
        ...(cwd ? { cwd } : {}),
        target: { type: "custom", instructions },
        displayText: "Review custom instructions",
      }
    : undefined;
}

function findSlashCommandTrigger(text: string, caret: number): {
  end: number;
  query: string;
  start: number;
} | undefined {
  const prefix = text.slice(0, caret);
  if (/\s$/.test(prefix)) {
    return undefined;
  }
  const match = /^\/([^\r\n]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }

  return {
    start: 0,
    end: caret,
    query: match[1] ?? "",
  };
}

function formatDraftPreview(draft: QueuedTurnDraft): string {
  if (draft.reviewCommand) {
    return draft.reviewCommand.displayText;
  }

  const text = draft.text.trim();
  if (text) {
    return text;
  }

  if (draft.imageAttachments.length === 0 && draft.fileAttachments.length > 0) {
    return `${draft.fileAttachments.length} file${
      draft.fileAttachments.length === 1 ? "" : "s"
    }`;
  }

  return `${draft.imageAttachments.length} image${
    draft.imageAttachments.length === 1 ? "" : "s"
  }`;
}

function QueuedImageAttachments(props: {
  attachments: ComposerImageAttachment[];
}): ReactNode {
  if (props.attachments.length === 0) {
    return null;
  }

  const visibleAttachments = props.attachments.slice(0, 3);
  const overflowCount = props.attachments.length - visibleAttachments.length;

  return (
    <div
      className="composer__queued-images"
      aria-label={`Queued image attachments: ${props.attachments.length}`}
    >
      {visibleAttachments.map((attachment, index) => (
        <img
          className="composer__queued-image"
          key={attachment.id}
          src={attachment.url}
          alt={formatPastedImageAlt(attachment, index)}
        />
      ))}
      {overflowCount > 0 ? (
        <span className="composer__queued-image-count">
          +{overflowCount}
        </span>
      ) : null}
    </div>
  );
}

const ENV_ACTION_RUN_CONFIRMATION_MS = 5_000;

type ThreadEnvActionStartingKey = {
  actionId: string;
  backend: NavigationThreadSummary["source"];
  threadId: string;
};

function sameThreadEnvActionStartingKey(
  left: ThreadEnvActionStartingKey | undefined,
  right: ThreadEnvActionStartingKey | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.backend === right.backend &&
    left.threadId === right.threadId &&
    left.actionId === right.actionId
  );
}

export { formatDurationMs, formatRunningDurationMs };

/**
 * Set of run identities the user has explicitly dismissed in this session.
 * Module-level so it survives Composer remounts (thread switches), but
 * cleared on page reload — fresh runs always show, since each run gets a
 * new runId on the server.
 */
const dismissedEnvActionAnchorKeys = new Set<string>();

/**
 * Approximate moment the renderer started this session. Runs whose latest
 * activity timestamp predates this are treated as historical (persisted
 * from a prior app launch) and not surfaced — otherwise the user would
 * have to re-dismiss the same finished run on every restart. The
 * persisted fields stay on the runtime so logs and a future "show last
 * run" affordance can still inspect them.
 */
const envActionAnchorSessionStartedAt = Date.now();

// Exported solely so the list filter + dismiss machinery can be unit-
// tested without standing up the full Composer; consumers should still
// reach the anchor through the Composer.
export function EnvActionAnchorList(props: {
  runtime?: Pick<CodexThreadEnvironmentRuntime, "actionRuns" | "environmentName"> | undefined;
  hiddenRunIds?: ReadonlySet<string>;
  onDismissRun?: (run: CodexEnvironmentActionRun) => void;
  onMoveToSidebar?: () => void;
  onStopRun?: (run: CodexEnvironmentActionRun, mode: "stop" | "terminate") => void;
}): ReactNode {
  const runs = readCodexEnvironmentActionRuns(props.runtime);
  const visible = runs.filter((run) => {
    if (props.hiddenRunIds?.has(run.runId)) return false;
    if (dismissedEnvActionAnchorKeys.has(run.runId)) return false;
    const latestActivityAt = Math.max(run.exitedAt ?? 0, run.startedAt ?? 0);
    // Anything not started during this renderer session is treated as
    // historical / zombie and hidden. Note: the `< envActionAnchorSessionStartedAt`
    // check catches runs with timestamps that predate this session AND
    // runs with missing/zero timestamps (legacy overlay rows from before
    // actionStartedAt existed synthesise startedAt=0 via
    // readCodexEnvironmentActionRuns). The earlier `latestActivityAt > 0`
    // guard let those legacy entries slip through, leaving the user with
    // an undismissable "running" zombie after an app crash — see the
    // PwrAgent termination repro in PR #505 review.
    if (latestActivityAt < envActionAnchorSessionStartedAt) {
      return false;
    }
    return true;
  });
  // Bumped after dismissal to force a re-render (the dismissed-set lives
  // outside React state).
  const [, setDismissTick] = useState(0);

  if (visible.length === 0) return null;

  return (
    <EnvActionRunsView
      environmentName={props.runtime?.environmentName}
      onDismiss={(run) => {
        dismissedEnvActionAnchorKeys.add(run.runId);
        props.onDismissRun?.(run);
        setDismissTick((tick) => tick + 1);
      }}
      onMoveToSidebar={props.onMoveToSidebar}
      onStop={props.onStopRun}
      placement="composer"
      runs={visible}
    />
  );
}

// Exported solely so the entry can be unit-tested without standing up the
// full Composer; consumers should still go through EnvActionAnchorList.
export function EnvActionAnchorEntry(props: {
  run: CodexEnvironmentActionRun;
  environmentName: string | undefined;
  onDismiss: () => void;
  onStop?: (run: CodexEnvironmentActionRun, mode: "stop" | "terminate") => void;
}): ReactNode {
  return (
    <EnvActionRunEntry
      environmentName={props.environmentName}
      onDismiss={() => props.onDismiss()}
      onStop={props.onStop}
      placement="composer"
      run={props.run}
    />
  );
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry));
  }

  const record = value as Record<string, unknown>;
  const directText = ["text", "content", "message", "input"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key] as string] : []
  );
  const nestedText = ["content", "parts", "input", "item"].flatMap((key) =>
    typeof record[key] === "string" ? [] : collectTextFragments(record[key])
  );
  return [...directText, ...nestedText];
}

function collectImageUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectImageUrls(entry));
  }

  const record = value as Record<string, unknown>;
  const directImages = Object.entries(record).flatMap(([key, entry]) =>
    typeof entry === "string" &&
    (key === "url" ||
      key === "image_url" ||
      key === "imageUrl" ||
      key === "image" ||
      key === "src" ||
      entry.startsWith("data:image/"))
      ? [entry]
      : []
  );
  const nestedImages = Object.values(record).flatMap((entry) =>
    typeof entry === "string" ? [] : collectImageUrls(entry)
  );
  return [...directImages, ...nestedImages];
}

function notificationIncludesDraftContent(
  params: unknown,
  draft: QueuedTurnDraft,
): boolean {
  const preview = draft.text.trim();
  if (preview) {
    return collectTextFragments(params).some((fragment) =>
      fragment.includes(preview)
    );
  }

  const attachmentUrls = draft.imageAttachments.map(
    (attachment) => attachment.url,
  );
  if (attachmentUrls.length === 0) {
    return false;
  }

  const notificationImageUrls = new Set(collectImageUrls(params));
  return attachmentUrls.every((url) => notificationImageUrls.has(url));
}

function isSteerInjectionOpportunity(method: string): boolean {
  return method === "item/completed" || method === "exec_command/ended";
}

function parseStaleSteerError(
  error: unknown
): { activeTurnId?: string; active: boolean } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("no active turn to steer")) {
    return { active: false };
  }

  const activeTurnMatch = message.match(/found `([^`]+)`/);
  if (
    normalized.includes("expected active turn id") &&
    activeTurnMatch?.[1]
  ) {
    return {
      active: true,
      activeTurnId: activeTurnMatch[1],
    };
  }

  return undefined;
}

function parseStaleInterruptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no active turn to interrupt");
}

function reviewCommandToDraftText(command: {
  cwd?: string;
  target: AppServerReviewTarget;
}): string {
  const target = command.target;
  if (target.type === "uncommittedChanges") {
    return "/review";
  }
  if (target.type === "baseBranch") {
    return `/review ${target.branch}`;
  }
  if (target.type === "commit") {
    return `/review --commit ${[target.sha, target.title].filter(Boolean).join(" ")}`;
  }
  return `/review --custom ${target.instructions}`;
}

function reviewSubmissionKey(command: {
  cwd?: string;
  target: AppServerReviewTarget;
}): string {
  const cwdPart = command.cwd ? `:${command.cwd}` : "";
  const target = command.target;
  switch (target.type) {
    case "baseBranch":
      return `review:baseBranch${cwdPart}:${target.branch}`;
    case "commit":
      return `review:commit${cwdPart}:${target.sha}:${target.title ?? ""}`;
    case "custom":
      return `review:custom${cwdPart}:${target.instructions}`;
    default:
      return `review${cwdPart}:${JSON.stringify(target)}`;
  }
}

function HighlightedAutocompleteLabel(props: {
  label: string;
  query: string;
}) {
  if (!props.query || !props.label.toLowerCase().startsWith(props.query.toLowerCase())) {
    return <span>{props.label}</span>;
  }

  return (
    <span>
      <span className="composer__autocomplete-match">
        {props.label.slice(0, props.query.length)}
      </span>
      {props.label.slice(props.query.length)}
    </span>
  );
}

function createComposerSkillToken(
  skill: AppServerSkillSummary,
  index: number,
): ComposerSkillToken {
  return {
    ...skill,
    id: `${skill.path ?? skill.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

function createComposerDirectoryToken(
  directory: Pick<NavigationDirectorySummary, "label" | "path">,
  index: number,
): ComposerSkillToken {
  return {
    kind: "directory",
    name: directory.label,
    path: directory.path,
    id: `${directory.path ?? directory.label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

// Exported for the `@`-popover / picker surfaces that mint file-reference
// chips; the drop/paste tray uses the pill list instead of chips.
export function createComposerFileToken(
  file: { label: string; path: string },
  index: number,
): ComposerSkillToken {
  return {
    kind: "file",
    name: file.label,
    path: file.path,
    id: `${file.path}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

/**
 * Append path-only file references to outgoing text as one
 * `[@label](~/path)` line per file, separated from the typed draft by a
 * blank line. A files-only message is just the reference block.
 */
function appendFileReferenceMarkdown(
  text: string,
  fileRefs: ComposerFileAttachment[],
): string {
  if (fileRefs.length === 0) {
    return text;
  }
  const referenceBlock = fileRefs
    .map((fileRef) =>
      buildDirectoryReferenceMarkdown({
        label: fileRef.label,
        path: fileRef.path,
      }),
    )
    .join("\n");
  return text ? `${text}\n\n${referenceBlock}` : referenceBlock;
}

function getComposerSkillTokensSignature(skillTokens: ComposerSkillToken[]): string {
  return JSON.stringify(
    skillTokens.map((token) => ({
      id: token.id,
      index: token.index,
      kind: token.kind,
      name: token.name,
      path: token.path,
    })),
  );
}

function clampSkillTokenIndex(index: number, draft: string): number {
  return Math.max(0, Math.min(index, draft.length));
}

function serializeDraftWithSkillTokens(
  draft: string,
  skillTokens: ComposerSkillToken[],
): string {
  if (skillTokens.length === 0) {
    return draft;
  }

  const sortedTokens = [...skillTokens].sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return left.id.localeCompare(right.id);
  });

  let output = "";
  let cursor = 0;
  for (const token of sortedTokens) {
    const index = clampSkillTokenIndex(token.index, draft);
    output += draft.slice(cursor, index);
    // Directory- and file-reference chips serialize to `[@label](~/path)`
    // markdown — the parens bound the path so adjacent text can't glue
    // onto it, the transcript renders it back as a chip, and
    // hydrateComposerDraft rebuilds the token from a prompt-only restore.
    // Skills keep their `[$name](path)` markdown.
    output += token.kind === "directory" || token.kind === "file"
      ? buildDirectoryReferenceMarkdown({
          label: token.name,
          path: token.path ?? "",
        })
      : buildSkillMentionMarkdown(token);
    cursor = index;
  }

  output += draft.slice(cursor);
  return output;
}

function hydrateComposerDraft(
  canonicalDraft: string,
  skills: AppServerSkillSummary[],
): {
  draft: string;
  skillTokens: ComposerSkillToken[];
} {
  let draft = "";
  const skillTokens: ComposerSkillToken[] = [];

  for (const part of parseSkillMentionParts(canonicalDraft)) {
    if (part.type === "text") {
      draft += part.text;
      continue;
    }

    if (part.type === "directory") {
      // Serialized paths are percent-encoded tilde form; the token
      // carries the decoded absolute path so send-time attach can use
      // it directly. File-reference chips serialize to the same
      // `[@label](~/path)` form, so a restored file chip degrades to a
      // directory-kind chip here — acceptable: the outgoing text is
      // identical either way.
      skillTokens.push(
        createComposerDirectoryToken(
          {
            label: part.name,
            path: expandTildePath(decodeMarkdownDestination(part.path)),
          },
          draft.length,
        ),
      );
      continue;
    }

    const matchingSkill =
      skills.find((skill) => skill.path === part.path) ??
      skills.find((skill) => skill.name === part.name);
    skillTokens.push(
      createComposerSkillToken(
        matchingSkill ?? {
          name: part.name,
          path: part.path,
        },
        draft.length,
      ),
    );
  }

  return { draft, skillTokens };
}

function adjustSkillTokenIndexesForTextChange(params: {
  currentDraft: string;
  nextDraft: string;
  skillTokens: ComposerSkillToken[];
}): ComposerSkillToken[] {
  const { currentDraft, nextDraft, skillTokens } = params;
  if (currentDraft === nextDraft || skillTokens.length === 0) {
    return skillTokens;
  }

  let prefixLength = 0;
  while (
    prefixLength < currentDraft.length &&
    prefixLength < nextDraft.length &&
    currentDraft[prefixLength] === nextDraft[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentDraft.length - prefixLength &&
    suffixLength < nextDraft.length - prefixLength &&
    currentDraft[currentDraft.length - 1 - suffixLength] ===
      nextDraft[nextDraft.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const currentChangedEnd = currentDraft.length - suffixLength;
  const nextChangedEnd = nextDraft.length - suffixLength;
  const delta = nextChangedEnd - currentChangedEnd;

  return skillTokens.map((token) => {
    if (token.index <= prefixLength) {
      return token;
    }

    if (token.index >= currentChangedEnd) {
      return {
        ...token,
        index: clampSkillTokenIndex(token.index + delta, nextDraft),
      };
    }

    return {
      ...token,
      index: clampSkillTokenIndex(prefixLength, nextDraft),
    };
  });
}

function rankSkillAutocompleteMatch(
  skill: AppServerSkillSummary,
  normalizedQuery: string,
): number | undefined {
  if (!normalizedQuery) {
    return 0;
  }

  const name = skill.name.toLowerCase();
  const shortDescription = skill.shortDescription?.toLowerCase() ?? "";
  const description = skill.description?.toLowerCase() ?? "";

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(`${normalizedQuery}:`)) {
    return 1;
  }
  if (name.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery)) {
    return 3;
  }
  if (shortDescription.includes(normalizedQuery)) {
    return 4;
  }
  if (description.includes(normalizedQuery)) {
    return 5;
  }

  return undefined;
}

function useDismissableMenu<T extends HTMLElement>(
  open: boolean,
  onDismiss: () => void,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open]);

  return ref;
}

function ComposerDropdown(props: {
  ariaLabel: string;
  compact?: boolean;
  disabled?: boolean;
  icon?: ComposerDropdownIcon;
  id?: string;
  kind?: "branch";
  tone?: "danger";
  onChange: (value: string) => void;
  options: ComposerDropdownOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const selectedOption =
    props.options.find((option) => option.value === props.value) ?? props.options[0];
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  const Icon = props.icon;

  return (
    <div
      className={[
        "composer-dropdown",
        props.compact ? "composer-dropdown--compact" : "",
        props.kind === "branch" ? "composer-dropdown--branch" : "",
        props.tone === "danger" ? "composer-dropdown--danger" : "",
        open ? "composer-dropdown--open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
    >
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        className="composer-dropdown__button"
        data-value={props.value}
        disabled={props.disabled || props.options.length === 0}
        id={props.id}
        type="button"
        value={props.value}
        onClick={() => setOpen((current) => !current)}
      >
        {Icon ? (
          <span aria-hidden="true" className="composer-dropdown__icon">
            <Icon size={13} />
          </span>
        ) : null}
        <span className="composer-dropdown__label">
          {selectedOption?.label ?? props.value}
        </span>
      </button>
      {open ? (
        <div className="composer-dropdown__menu" id={listboxId} role="listbox">
          {props.options.map((option) => (
            <button
              aria-selected={option.value === props.value}
              className="composer-dropdown__option"
              disabled={option.disabled}
              key={option.value}
              role="option"
              type="button"
              onClick={() => {
                setOpen(false);
                if (option.value !== props.value) {
                  props.onChange(option.value);
                }
              }}
            >
              {option.value === props.value ? (
                <span aria-hidden="true" className="composer-dropdown__check">
                  ✓
                </span>
              ) : (
                <span aria-hidden="true" className="composer-dropdown__check" />
              )}
              <span className="composer-dropdown__option-label">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type LaunchpadBranchOption = {
  name: string;
  /** Last commit time on the branch tip, in unix seconds. */
  lastCommitAt?: number;
  /** Checked out by another worktree. */
  inUse?: boolean;
  /** The repository's currently checked-out branch. */
  current?: boolean;
  /** The repository's default branch (origin/HEAD, or main/master/...). */
  isDefault?: boolean;
};

/**
 * Searchable branch picker for the worktree launchpad. Replaces the plain
 * dropdown with a filterable list that shows each branch's recency ("2m ago")
 * and whether it is the current branch or already in use by a worktree.
 *
 * Preserves the dropdown's a11y contract — trigger labelled "Base branch" with
 * `value`/`data-value`, a `composer-dropdown--branch` wrapper, and a
 * `role="listbox"` of `role="option"` rows — so existing tests and e2e specs
 * keep targeting it the same way.
 */
function BranchPicker(props: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: string) => void;
  options: LaunchpadBranchOption[];
  projectLabel?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuShift, setMenuShift] = useState(0);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));

  const normalizedQuery = query.trim().toLowerCase();
  // Pin the anchor branches — the one you'll branch off (selected), the repo
  // default, and the checked-out branch — to the top, deduped in that
  // priority order. Everything else follows in recency order. When the three
  // anchors are the same branch (the common case) this is a single pinned row.
  const { pinnedOptions, restOptions } = useMemo(() => {
    const byName = new Map(props.options.map((option) => [option.name, option]));
    const pinnedNames = new Set<string>();
    const pinned: LaunchpadBranchOption[] = [];
    const addPin = (option?: LaunchpadBranchOption): void => {
      if (option && !pinnedNames.has(option.name)) {
        pinnedNames.add(option.name);
        pinned.push(option);
      }
    };
    addPin(byName.get(props.value));
    addPin(props.options.find((option) => option.isDefault));
    addPin(props.options.find((option) => option.current));
    const rest = props.options.filter((option) => !pinnedNames.has(option.name));
    return { pinnedOptions: pinned, restOptions: rest };
  }, [props.options, props.value]);

  const matchesQuery = (option: LaunchpadBranchOption): boolean =>
    !normalizedQuery || option.name.toLowerCase().includes(normalizedQuery);
  const visiblePinned = pinnedOptions.filter(matchesQuery);
  const visibleRest = restOptions.filter(matchesQuery);
  const flatVisible = [...visiblePinned, ...visibleRest];

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // The popover is anchored to the trigger, which sits near the right edge of
  // the composer toolbar — keep it inside the viewport by nudging it back in
  // when it would overflow either gutter. Runs before paint so there's no
  // visible jump, and re-clamps on resize while open.
  useLayoutEffect(() => {
    if (!open) {
      setMenuShift(0);
      return;
    }
    const clamp = (): void => {
      const menu = menuRef.current;
      if (!menu) {
        return;
      }
      const gutter = 12;
      const rect = menu.getBoundingClientRect();
      const overflowRight = rect.right - (window.innerWidth - gutter);
      const overflowLeft = gutter - rect.left;
      setMenuShift((current) => {
        if (overflowRight > 0) {
          return current - overflowRight;
        }
        if (overflowLeft > 0) {
          return current + overflowLeft;
        }
        return current;
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [open]);

  const nowMs = Date.now();
  const selectedOption =
    props.options.find((option) => option.name === props.value) ??
    props.options[0];

  const commit = (name: string): void => {
    setOpen(false);
    setQuery("");
    if (name !== props.value) {
      props.onChange(name);
    }
  };

  const handleInputKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        flatVisible.length === 0
          ? 0
          : Math.min(flatVisible.length - 1, current + 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = flatVisible[activeIndex];
      if (option) {
        commit(option.name);
      }
    }
  };

  const renderOption = (
    option: LaunchpadBranchOption,
    flatIndex: number,
  ): ReactNode => {
    const isSelected = option.name === props.value;
    const relativeTime = formatBranchRelativeTime(option.lastCommitAt, nowMs);
    return (
      <button
        aria-label={option.name}
        aria-selected={isSelected}
        className={[
          "branch-picker__option",
          flatIndex === activeIndex ? "is-active" : "",
          isSelected ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        key={option.name}
        role="option"
        type="button"
        onClick={() => commit(option.name)}
        onMouseEnter={() => setActiveIndex(flatIndex)}
      >
        <span aria-hidden="true" className="branch-picker__option-check">
          {isSelected ? "✓" : ""}
        </span>
        <span aria-hidden="true" className="branch-picker__option-icon">
          <BranchIcon size={12} />
        </span>
        <span className="branch-picker__option-name">{option.name}</span>
        {option.current ? (
          <span
            aria-hidden="true"
            className="branch-picker__badge branch-picker__badge--current"
          >
            Current
          </span>
        ) : null}
        {option.isDefault ? (
          <span
            aria-hidden="true"
            className="branch-picker__badge branch-picker__badge--default"
          >
            Default
          </span>
        ) : null}
        {option.inUse ? (
          <span
            aria-hidden="true"
            className="branch-picker__badge branch-picker__badge--in-use"
          >
            In use
          </span>
        ) : null}
        {relativeTime ? (
          <span aria-hidden="true" className="branch-picker__option-time">
            {relativeTime}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      className={[
        "composer-dropdown composer-dropdown--compact composer-dropdown--branch branch-picker",
        open ? "composer-dropdown--open" : "",
        props.className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
    >
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        className="composer-dropdown__button"
        data-value={props.value}
        disabled={props.disabled || props.options.length === 0}
        id={props.id}
        type="button"
        value={props.value}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true" className="composer-dropdown__icon">
          <BranchIcon size={13} />
        </span>
        <span className="composer-dropdown__label">
          {selectedOption?.name ?? props.value}
        </span>
        <span aria-hidden="true" className="composer-dropdown__chevron">
          ⌄
        </span>
      </button>
      {open ? (
        <div
          className="branch-picker__menu"
          ref={menuRef}
          style={
            menuShift ? { transform: `translateX(${menuShift}px)` } : undefined
          }
        >
          <div className="branch-picker__search">
            <span aria-hidden="true" className="branch-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              aria-label="Find a branch"
              className="branch-picker__search-input"
              placeholder="Find a branch"
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
            />
          </div>
          {props.projectLabel ? (
            <div aria-hidden="true" className="branch-picker__eyebrow">
              Branch off from <span>{props.projectLabel}</span>
            </div>
          ) : null}
          <div
            aria-label={props.ariaLabel}
            className="branch-picker__list"
            id={listboxId}
            role="listbox"
          >
            {flatVisible.length === 0 ? (
              <p className="branch-picker__empty">No branches match your filter.</p>
            ) : (
              <>
                {visiblePinned.map((option, index) =>
                  renderOption(option, index),
                )}
                {visiblePinned.length > 0 && visibleRest.length > 0 ? (
                  <div
                    aria-hidden="true"
                    className="branch-picker__divider"
                    role="presentation"
                  />
                ) : null}
                {visibleRest.map((option, index) =>
                  renderOption(option, visiblePinned.length + index),
                )}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReviewBranchPicker(props: {
  ariaLabel: string;
  onChange: (value: string) => void;
  options: LaunchpadBranchOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filterText, setFilterText] = useState("");
  const inputId = useId();
  const listboxId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  const nowMs = Date.now();
  const query = filterText.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!query) {
      return props.options;
    }
    return props.options.filter((option) =>
      option.name.toLowerCase().includes(query),
    );
  }, [props.options, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filterText]);

  useEffect(() => {
    setActiveIndex((current) =>
      visibleOptions.length === 0
        ? 0
        : Math.min(current, visibleOptions.length - 1),
    );
  }, [visibleOptions.length]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const option = optionRefs.current[activeIndex];
    if (typeof option?.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const commit = (name: string): void => {
    props.onChange(name);
    setFilterText("");
    setOpen(false);
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "ArrowDown") {
      if (visibleOptions.length === 0) {
        return;
      }
      event.preventDefault();
      const wasOpen = open;
      setOpen(true);
      setActiveIndex((current) =>
        wasOpen ? Math.min(visibleOptions.length - 1, current + 1) : 0,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      if (visibleOptions.length === 0) {
        return;
      }
      event.preventDefault();
      const wasOpen = open;
      setOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
      if (!wasOpen) {
        setActiveIndex(visibleOptions.length - 1);
      }
      return;
    }
    if (event.key === "Enter" && open) {
      const option = visibleOptions[activeIndex];
      if (option) {
        event.preventDefault();
        commit(option.name);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const shouldShowMenu = open && props.options.length > 0;
  const activeOptionId = shouldShowMenu && visibleOptions.length > 0
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className="review-branch-picker" ref={ref}>
      <input
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-controls={shouldShowMenu ? listboxId : undefined}
        aria-expanded={shouldShowMenu}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        className="composer__review-input"
        id={inputId}
        role="combobox"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
          setFilterText(event.target.value);
          setOpen(true);
        }}
        onClick={() => {
          setFilterText("");
          setOpen(props.options.length > 0);
        }}
        onFocus={() => {
          setFilterText("");
          setOpen(props.options.length > 0);
        }}
        onKeyDown={handleKeyDown}
      />
      {shouldShowMenu ? (
        <div className="branch-picker__menu review-branch-picker__menu">
          <div className="branch-picker__search">
            <span aria-hidden="true" className="branch-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              aria-label="Find a branch"
              className="branch-picker__search-input"
              placeholder="Find a branch"
              type="text"
              value={filterText}
              onChange={(event) => {
                setFilterText(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div
            aria-label={`${props.ariaLabel} options`}
            className="branch-picker__list"
            id={listboxId}
            role="listbox"
          >
            {visibleOptions.length === 0 ? (
              <p className="branch-picker__empty">No branches match your filter.</p>
            ) : (
              visibleOptions.map((option, index) => {
                const isSelected = option.name === props.value.trim();
                const relativeTime = formatBranchRelativeTime(
                  option.lastCommitAt,
                  nowMs,
                );
                return (
                  <button
                    aria-label={option.name}
                    aria-selected={isSelected}
                    className={[
                      "branch-picker__option",
                      index === activeIndex ? "is-active" : "",
                      isSelected ? "is-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    id={`${listboxId}-option-${index}`}
                    key={option.name}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    role="option"
                    tabIndex={-1}
                    type="button"
                    onClick={() => commit(option.name)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span aria-hidden="true" className="branch-picker__option-check">
                      {isSelected ? "✓" : ""}
                    </span>
                    <span aria-hidden="true" className="branch-picker__option-icon">
                      <BranchIcon size={12} />
                    </span>
                    <span className="branch-picker__option-name">{option.name}</span>
                    {option.current ? (
                      <span
                        aria-hidden="true"
                        className="branch-picker__badge branch-picker__badge--current"
                      >
                        Current
                      </span>
                    ) : null}
                    {option.isDefault ? (
                      <span
                        aria-hidden="true"
                        className="branch-picker__badge branch-picker__badge--default"
                      >
                        Default
                      </span>
                    ) : null}
                    {option.inUse ? (
                      <span
                        aria-hidden="true"
                        className="branch-picker__badge branch-picker__badge--in-use"
                      >
                        In use
                      </span>
                    ) : null}
                    {relativeTime ? (
                      <span aria-hidden="true" className="branch-picker__option-time">
                        {relativeTime}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReviewCommitPicker(props: {
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  options: NavigationGitCommitSummary[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputId = useId();
  const listboxId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  const nowMs = Date.now();
  const query = props.value.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!query) {
      return props.options.slice(0, 20);
    }
    return props.options
      .filter((option) => {
        const haystack = `${option.sha} ${option.shortSha} ${option.subject}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 20);
  }, [props.options, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    setActiveIndex((current) =>
      visibleOptions.length === 0
        ? 0
        : Math.min(current, visibleOptions.length - 1),
    );
  }, [visibleOptions.length]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const option = optionRefs.current[activeIndex];
    if (typeof option?.scrollIntoView === "function") {
      option.scrollIntoView({
        block: "nearest",
      });
    }
  }, [activeIndex, open]);

  const commit = (option: NavigationGitCommitSummary): void => {
    props.onChange(option.sha);
    setOpen(false);
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "ArrowDown") {
      if (visibleOptions.length === 0) {
        return;
      }
      event.preventDefault();
      const wasOpen = open;
      setOpen(true);
      setActiveIndex((current) =>
        wasOpen ? Math.min(visibleOptions.length - 1, current + 1) : 0,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      if (visibleOptions.length === 0) {
        return;
      }
      event.preventDefault();
      const wasOpen = open;
      setOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
      if (!wasOpen) {
        setActiveIndex(visibleOptions.length - 1);
      }
      return;
    }
    if (event.key === "Enter" && open) {
      const option = visibleOptions[activeIndex];
      if (option) {
        event.preventDefault();
        commit(option);
      }
      return;
    }
    if (event.key === "Escape") {
      if (shouldShowMenu) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }
  };

  const shouldShowMenu = open && visibleOptions.length > 0;
  const activeOptionId = shouldShowMenu
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className="review-commit-picker" ref={ref}>
      <label htmlFor={inputId}>Commit SHA</label>
      <input
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        aria-controls={shouldShowMenu ? listboxId : undefined}
        aria-expanded={shouldShowMenu}
        aria-haspopup="listbox"
        className="composer__review-input"
        id={inputId}
        ref={props.inputRef}
        role="combobox"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
          setOpen(true);
        }}
        onClick={() => {
          setActiveIndex(0);
          setOpen(visibleOptions.length > 0);
        }}
        onFocus={() => {
          setActiveIndex(0);
          setOpen(visibleOptions.length > 0);
        }}
        onKeyDown={handleKeyDown}
      />
      {shouldShowMenu ? (
        <div
          aria-label="Recent commits"
          className="review-commit-picker__menu"
          id={listboxId}
          role="listbox"
        >
          {visibleOptions.map((option, index) => {
            const relativeTime = formatBranchRelativeTime(
              option.committedAt,
              nowMs,
            );
            return (
              <button
                aria-label={`${option.shortSha} ${option.subject}`}
                aria-selected={option.sha === props.value.trim()}
                className={[
                  "review-commit-picker__option",
                  index === activeIndex ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                id={`${listboxId}-option-${index}`}
                key={option.sha}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                role="option"
                tabIndex={-1}
                type="button"
                onClick={() => commit(option)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="review-commit-picker__sha">
                  {option.shortSha}
                </span>
                <span className="review-commit-picker__subject">
                  {option.subject || "Untitled commit"}
                </span>
                {relativeTime ? (
                  <span
                    aria-hidden="true"
                    className="review-commit-picker__time"
                  >
                    {relativeTime}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ComposerApplicationButton(props: {
  application: DesktopApplicationDiscoveryCandidate;
  label: string;
  onOpen: (application: DesktopApplicationDiscoveryCandidate) => Promise<void>;
}) {
  // A real OS icon (iconDataUrl) is a recognizable brand mark, so collapse to
  // an icon-only chip — the name stays available via aria-label + tooltip.
  // Fallback glyphs keep the text label, since a generic editor/terminal glyph
  // alone is ambiguous.
  const hasRealIcon = Boolean(props.application.iconDataUrl);
  return (
    <button
      aria-label={props.application.name}
      className={
        hasRealIcon
          ? "composer__application-button composer__application-button--icon-only"
          : "composer__application-button"
      }
      title={`Open workspace in ${props.application.name}`}
      type="button"
      onClick={() => {
        void props.onOpen(props.application);
      }}
    >
      <AppIcon
        application={props.application}
        className="composer__application-icon"
        size={16}
      />
      {hasRealIcon ? null : <span>{props.label}</span>}
    </button>
  );
}

function CopyableComposerError(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  label: string;
  text: string;
}) {
  return (
    <div className="composer__meta composer__meta--error composer__meta--copyable">
      <span className="composer__meta-text">{props.text}</span>
      <TranscriptCopyButton
        className="transcript-copy-button--composer-error"
        copiedLabel="Copied error"
        desktopApi={props.desktopApi}
        label={props.label}
        text={props.text}
      />
    </div>
  );
}

export function Composer(props: ComposerProps) {
  const inputRef = useRef<ComposerInputHandle>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const autocompleteListRef = useRef<HTMLDivElement>(null);
  const activeTurnIdRef = useRef<string | undefined>(props.activeTurnId);
  const confirmedActiveTurnIdRef = useRef<string | undefined>(undefined);
  const activeReviewTurnIdRef = useRef<string | undefined>(undefined);
  const inFlightReviewSubmissionKeyRef = useRef<string | undefined>(undefined);
  const autocompleteOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reviewOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reviewCommitInputRef = useRef<HTMLInputElement | null>(null);
  const reviewCustomTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const skillListboxId = useId();
  const slashListboxId = useId();
  const directoryRefListboxId = useId();
  const hydratedLaunchpadKeyRef = useRef<string | undefined>(undefined);
  const pendingProgrammaticComposerChangeRef =
    useRef<PendingProgrammaticComposerChange | undefined>(undefined);
  const composerScopeKey = props.launchpad
    ? `launchpad:${props.launchpad.directoryKey}`
    : props.thread
      ? `thread:${props.thread.source}:${props.thread.id}`
      : "empty";
  const localDraftStore = useComposerDraftStore();
  const draftStore = props.draftStore ?? localDraftStore;
  const draftStoreHydrationVersion = draftStore.hydrationVersion ?? 0;
  const savedInitialDraft = draftStore.get(composerScopeKey);
  const savedInitialQueuedTurns = props.thread
    ? draftStore.getQueuedTurns(composerScopeKey)
    : undefined;
  const savedInitialPendingSteer = props.thread
    ? draftStore.getPendingSteer(composerScopeKey)
    : undefined;
  const hydratedInitialLaunchpad =
    savedInitialDraft || !props.launchpad
      ? undefined
      : hydrateComposerDraft(props.launchpad.prompt ?? "", props.skills);
  const activeComposerScopeKeyRef = useRef(composerScopeKey);
  const pasteScopeRef = useRef({ key: composerScopeKey, version: 0 });
  const submittedDraftScopeKeysRef = useRef<Set<string>>(new Set());
  const recoveryCycleRef = useRef<{
    activeIndex?: number;
    candidates: ComposerDraftSnapshot[];
    scopeKey: string;
  } | undefined>(undefined);
  const recoveryEligibilityVersionRef = useRef(0);
  const recoveryLookupSequenceRef = useRef(0);
  const recoveringDraftRef = useRef(false);
  const composerSelectionRequestSequenceRef = useRef(0);
  const deletedSkillTokenHistoryRef = useRef<DeletedSkillTokenHistoryEntry[]>([]);
  const latestDraftSnapshotRef = useRef<{
    scopeKey: string;
    snapshot: ComposerDraftSnapshot;
  }>({
    scopeKey: composerScopeKey,
    snapshot: {
      draft: savedInitialDraft?.draft ?? hydratedInitialLaunchpad?.draft ?? "",
      editorDocument:
        savedInitialDraft?.editorDocument ??
        (props.launchpad?.editorDocument as JSONContent | undefined),
      imageAttachments:
        savedInitialDraft?.imageAttachments ??
        props.launchpad?.imageAttachments ??
        [],
      fileAttachments:
        savedInitialDraft?.fileAttachments ??
        props.launchpad?.fileAttachments ??
        [],
      skillTokens:
        savedInitialDraft?.skillTokens ?? hydratedInitialLaunchpad?.skillTokens ?? [],
    },
  });
  const launchpadUpdateRef = useRef(props.onUpdateLaunchpad);
  const [draft, setDraft] = useState(
    latestDraftSnapshotRef.current.snapshot.draft
  );
  const [editorDocument, setEditorDocument] = useState(
    latestDraftSnapshotRef.current.snapshot.editorDocument
  );
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useDismissableMenu<HTMLDivElement>(
    workspaceMenuOpen,
    () => setWorkspaceMenuOpen(false),
  );
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  const scheduleMenuRef = useDismissableMenu<HTMLDivElement>(
    scheduleMenuOpen,
    () => setScheduleMenuOpen(false),
  );
  const [addReferenceMenuOpen, setAddReferenceMenuOpen] = useState(false);
  // Recently referenced files for the reference picker's Files tab —
  // loaded lazily from the main process each time the picker opens.
  const [recentFileReferences, setRecentFileReferences] = useState<
    ReferencePickerFile[]
  >([]);
  const [scheduleTick, setScheduleTick] = useState(() => Date.now());
  const [scheduledDraftSendAt, setScheduledDraftSendAt] = useState<
    number | undefined
  >();
  // Whether the pending draft schedule (when one exists, e.g. after editing a
  // scheduled item) is "armed". Armed → Send keeps the schedule (send later);
  // unarmed → Send sends now. Defaults armed so a freshly-loaded schedule is
  // preserved unless the operator explicitly unchecks it.
  const [scheduleArmed, setScheduleArmed] = useState(true);
  const [handoffDialog, setHandoffDialog] = useState<
    HandoffThreadWorkspaceRequest["direction"] | undefined
  >();
  const [localHandoffStrategy, setLocalHandoffStrategy] =
    useState<LocalHandoffStrategy>("detached-changes");
  const [leaveLocalBranch, setLeaveLocalBranch] = useState("");
  const [newLocalBranch, setNewLocalBranch] = useState("");
  const [handoffError, setHandoffError] = useState<string | undefined>();
  const [handoffSubmitting, setHandoffSubmitting] = useState(false);
  const [sending, setSendingState] = useState(false);
  const sendingRef = useRef(false);
  const updateSending = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSendingState(nextSending);
  };
  const [interrupting, setInterrupting] = useState(false);
  const [steering, setSteering] = useState(false);
  const [queuedTurns, setQueuedTurnsState] = useState<QueuedTurnDraft[]>(
    savedInitialQueuedTurns ?? []
  );
  const queuedAutoReleaseAttemptIdRef = useRef<string | undefined>(undefined);
  const serverQueuedTurnEntryIdsRef = useRef(new Map<string, string>());
  const [serverQueuedTurnEntryId, setServerQueuedTurnEntryIdState] =
    useState<string>();
  const updateServerQueuedTurnEntryId = (
    nextEntryId?: string,
    scopeKey = composerScopeKey,
  ): void => {
    if (nextEntryId) {
      serverQueuedTurnEntryIdsRef.current.set(scopeKey, nextEntryId);
    } else {
      serverQueuedTurnEntryIdsRef.current.delete(scopeKey);
    }
    if (scopeKey === composerScopeKey) {
      setServerQueuedTurnEntryIdState(nextEntryId);
    }
  };
  const [pendingSteer, setPendingSteerState] = useState<
    PendingSteerDraft | undefined
  >(
    savedInitialPendingSteer
      ? { ...savedInitialPendingSteer, status: "pending" }
      : undefined
  );
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>(
    props.activeTurnId
  );
  const [sendError, setSendError] = useState<string>();
  const [applicationOpenError, setApplicationOpenError] = useState<string>();
  const [threadEnvActionStarting, setThreadEnvActionStartingState] =
    useState<ThreadEnvActionStartingKey>();
  const threadEnvActionStartingRef =
    useRef<ThreadEnvActionStartingKey | undefined>(undefined);
  const threadEnvActionStartingTimeoutRef = useRef<number | undefined>(undefined);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>(
    latestDraftSnapshotRef.current.snapshot.imageAttachments
  );
  const [fileAttachments, setFileAttachments] = useState<ComposerFileAttachment[]>(
    latestDraftSnapshotRef.current.snapshot.fileAttachments ?? []
  );
  // Per-attachment content signature (`<size>:<hash>`) cache used to reject
  // exact-duplicate pastes. Computed lazily on first use and kept only in
  // memory — signatures are never part of the persisted draft snapshot.
  const imageSignatureCacheRef = useRef(new Map<string, string>());
  const getImageSignature = (attachment: ComposerImageAttachment): string => {
    const cache = imageSignatureCacheRef.current;
    const cached = cache.get(attachment.id);
    if (cached !== undefined) {
      return cached;
    }
    const signature = `${attachment.size}:${hashImageDataUrl(attachment.url)}`;
    cache.set(attachment.id, signature);
    return signature;
  };
  // Currently expanded attachment shown in the full-size lightbox, or
  // undefined when the lightbox is closed.
  const [lightboxAttachment, setLightboxAttachment] =
    useState<ComposerImageAttachment>();
  // Escape-to-close is owned by `ImageLightbox` itself.
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [skillTokens, setSkillTokens] = useState<ComposerSkillToken[]>(
    latestDraftSnapshotRef.current.snapshot.skillTokens
  );
  const [composerSelectionRequest, setComposerSelectionRequest] = useState<{
    id: string;
    index: number;
  }>();
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [activeDirectoryRefIndex, setActiveDirectoryRefIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string>();

  const setThreadEnvActionStarting = (
    next: ThreadEnvActionStartingKey | undefined,
  ): void => {
    threadEnvActionStartingRef.current = next;
    setThreadEnvActionStartingState(next);
  };

  const clearThreadEnvActionStarting = (
    key?: ThreadEnvActionStartingKey,
  ): void => {
    if (key && !sameThreadEnvActionStartingKey(threadEnvActionStartingRef.current, key)) {
      return;
    }
    if (threadEnvActionStartingTimeoutRef.current !== undefined) {
      window.clearTimeout(threadEnvActionStartingTimeoutRef.current);
      threadEnvActionStartingTimeoutRef.current = undefined;
    }
    setThreadEnvActionStarting(undefined);
  };

  const showThreadEnvActionStarting = (
    key: ThreadEnvActionStartingKey,
  ): void => {
    if (threadEnvActionStartingTimeoutRef.current !== undefined) {
      window.clearTimeout(threadEnvActionStartingTimeoutRef.current);
      threadEnvActionStartingTimeoutRef.current = undefined;
    }
    setThreadEnvActionStarting(key);
  };

  const finishThreadEnvActionStarting = (
    key: ThreadEnvActionStartingKey,
    elapsedMs: number,
  ): void => {
    if (!sameThreadEnvActionStartingKey(threadEnvActionStartingRef.current, key)) {
      return;
    }
    if (threadEnvActionStartingTimeoutRef.current !== undefined) {
      window.clearTimeout(threadEnvActionStartingTimeoutRef.current);
    }
    const remainingMs = Math.max(0, ENV_ACTION_RUN_CONFIRMATION_MS - elapsedMs);
    if (remainingMs === 0) {
      threadEnvActionStartingTimeoutRef.current = undefined;
      setThreadEnvActionStarting(undefined);
      return;
    }
    threadEnvActionStartingTimeoutRef.current = window.setTimeout(() => {
      if (!sameThreadEnvActionStartingKey(threadEnvActionStartingRef.current, key)) {
        return;
      }
      threadEnvActionStartingTimeoutRef.current = undefined;
      setThreadEnvActionStarting(undefined);
    }, remainingMs);
  };

  useEffect(() => {
    return () => {
      if (threadEnvActionStartingTimeoutRef.current !== undefined) {
        window.clearTimeout(threadEnvActionStartingTimeoutRef.current);
        threadEnvActionStartingTimeoutRef.current = undefined;
      }
    };
  }, []);
  const [fullAccessRiskDialogOpen, setFullAccessRiskDialogOpen] =
    useState(false);
  const [fullAccessRiskDontWarnAgain, setFullAccessRiskDontWarnAgain] =
    useState(false);
  const [fullAccessRiskSaving, setFullAccessRiskSaving] = useState(false);
  const [fullAccessRiskError, setFullAccessRiskError] = useState<string>();
  const [autocompleteLayout, setAutocompleteLayout] = useState<{
    maxHeight: number;
    placement: "above" | "below";
  }>({ maxHeight: 320, placement: "above" });
  const [activeOptimisticMessageId, setActiveOptimisticMessageId] = useState<string>();
  const [reviewConfig, setReviewConfig] = useState<ReviewConfigState>();
  const isLaunchpad = Boolean(props.launchpad && props.directory);
  const launchpad = props.launchpad;
  const backend = useMemo(
    () =>
      props.backends?.find((candidate) =>
        candidate.kind === (props.launchpad?.backend ?? props.thread?.source)
      ),
    [props.backends, props.launchpad?.backend, props.thread?.source]
  );
  const supportsReview =
    backend?.kind.startsWith("acp:") === true
      ? backend.capabilities.startReview !== false
      : true;
  const supportsCompactCommand = Boolean(
    props.providerCommands?.some((command) => {
      const commandName = command.name.startsWith("/")
        ? command.name.slice(1)
        : command.name;
      return (
        commandName === "compact" &&
        (!props.thread || !command.backend || command.backend === props.thread.source)
      );
    })
  );

  const selectionStart = Math.min(
    inputRef.current?.selectionStart ?? draft.length,
    draft.length,
  );
  const isDraftStoreScope = (scopeKey: string): boolean =>
    scopeKey === "empty" ||
    scopeKey.startsWith("thread:") ||
    scopeKey.startsWith("launchpad:");
  const canonicalDraft = useMemo(
    () => serializeDraftWithSkillTokens(draft, skillTokens),
    [draft, skillTokens]
  );
  const hasComposerContent =
    draft.trim().length > 0 || skillTokens.length > 0;
  const queuedTurn = queuedTurns[0];
  const nextReleasableQueuedTurn = getNextReleasableQueuedTurn(queuedTurns);
  const futureScheduledDraftSendAt = getFutureScheduledSendAt(
    scheduledDraftSendAt,
    scheduleTick,
  );
  launchpadUpdateRef.current = props.onUpdateLaunchpad;
  latestDraftSnapshotRef.current = {
    scopeKey: composerScopeKey,
    snapshot: {
      draft,
      editorDocument,
      imageAttachments,
      fileAttachments,
      skillTokens,
    },
  };
  const setComposerDraftFromCanonical = (nextDraft: string): void => {
    deletedSkillTokenHistoryRef.current = [];
    setEditorDocument(undefined);
    const hydrated = hydrateComposerDraft(nextDraft, props.skills);
    setDraft(hydrated.draft);
    setSkillTokens(hydrated.skillTokens);
  };
  const clearComposerDraft = (): void => {
    deletedSkillTokenHistoryRef.current = [];
    setEditorDocument(undefined);
    setDraft("");
    setSkillTokens([]);
  };
  const createEmptyComposerDraftSnapshot = (): ComposerDraftSnapshot => ({
    draft: "",
    editorDocument: undefined,
    imageAttachments: [],
    fileAttachments: [],
    skillTokens: [],
  });
  const clearSubmittedComposerDraftForStart = (
    scopeKey: string,
  ): void => {
    clearComposerDraftSnapshot(scopeKey);
    latestDraftSnapshotRef.current = {
      scopeKey,
      snapshot: createEmptyComposerDraftSnapshot(),
    };
    clearComposerDraft();
    setImageAttachments([]);
    setFileAttachments([]);
  };
  const hasLiveComposerContent = (): boolean => {
    const latest = latestDraftSnapshotRef.current;
    return Boolean(
      (inputRef.current?.value ?? latest.snapshot.draft).trim() ||
        (inputRef.current?.skillTokenCount ??
          latest.snapshot.skillTokens.length) > 0 ||
        latest.snapshot.imageAttachments.length > 0 ||
        (latest.snapshot.fileAttachments?.length ?? 0) > 0,
    );
  };
  const updateVisibleDraft = (
    nextDraft: string,
    nextSkillTokens?: ComposerSkillToken[],
    options?: { preserveRecoveryCycle?: boolean },
  ): void => {
    if (!recoveringDraftRef.current && !options?.preserveRecoveryCycle) {
      recoveryCycleRef.current = undefined;
    }
    deletedSkillTokenHistoryRef.current = [];
    setEditorDocument(undefined);
    if (nextSkillTokens) {
      setSkillTokens(nextSkillTokens);
    } else {
      setSkillTokens((current) =>
        adjustSkillTokenIndexesForTextChange({
          currentDraft: draft,
          nextDraft,
          skillTokens: current,
        })
      );
    }
    setDraft(nextDraft);
  };
  const saveComposerDraftSnapshot = (
    scopeKey: string,
    state: ComposerDraftSnapshot,
  ): void => {
    if (!isDraftStoreScope(scopeKey)) {
      return;
    }

    if (
      !state.draft.trim() &&
      state.skillTokens.length === 0 &&
      state.imageAttachments.length === 0 &&
      (state.fileAttachments?.length ?? 0) === 0
    ) {
      const previous = latestDraftSnapshotRef.current;
      if (
        previous.scopeKey === scopeKey &&
        (previous.snapshot.draft.trim() ||
          previous.snapshot.skillTokens.length > 0 ||
          previous.snapshot.imageAttachments.length > 0 ||
          (previous.snapshot.fileAttachments?.length ?? 0) > 0)
      ) {
        recordComposerDraftHistory(scopeKey, previous.snapshot, "abandoned");
      }
      draftStore.delete(scopeKey);
      return;
    }

    draftStore.set(scopeKey, state);
  };
  const clearComposerDraftSnapshot = (scopeKey: string): void => {
    if (isDraftStoreScope(scopeKey)) {
      draftStore.delete(scopeKey);
    }
  };
  const recordComposerDraftHistory = (
    scopeKey: string,
    state: ComposerDraftSnapshot,
    status: "unsent" | "sent" | "abandoned",
  ): void => {
    if (!isDraftStoreScope(scopeKey)) {
      return;
    }
    draftStore.recordHistory?.(scopeKey, state, status);
  };
  const getComposerDraftSnapshotSignature = (
    snapshot: ComposerDraftSnapshot,
  ): string =>
    JSON.stringify({
      draft: snapshot.draft,
      editorDocument: snapshot.editorDocument,
      imageAttachments: snapshot.imageAttachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        url: attachment.url,
      })),
      fileAttachments: (snapshot.fileAttachments ?? []).map((attachment) => ({
        label: attachment.label,
        path: attachment.path,
      })),
      skillTokens: snapshot.skillTokens.map((token) => ({
        index: token.index,
        name: token.name,
        path: token.path,
      })),
    });
  const dedupeComposerDraftSnapshots = (
    snapshots: ComposerDraftSnapshot[],
  ): ComposerDraftSnapshot[] => {
    const seen = new Set<string>();
    return snapshots.filter((snapshot) => {
      const signature = getComposerDraftSnapshotSignature(snapshot);
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    });
  };
  const applyRecoveredComposerDraft = (
    snapshot: ComposerDraftSnapshot,
  ): void => {
    recoveringDraftRef.current = true;
    deletedSkillTokenHistoryRef.current = [];
    flushSync(() => {
      setDraft(snapshot.draft);
      setEditorDocument(snapshot.editorDocument);
      setImageAttachments(snapshot.imageAttachments);
      setFileAttachments(snapshot.fileAttachments ?? []);
      setSkillTokens(snapshot.skillTokens);
      setComposerSelectionRequest({
        id: `recovery:${++composerSelectionRequestSequenceRef.current}`,
        index: 0,
      });
    });
    saveComposerDraftSnapshot(composerScopeKey, snapshot);
    setSendError(undefined);
    requestAnimationFrame(() => {
      recoveringDraftRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, 0);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(0, 0);
      });
    });
  };
  const hasNewLiveComposerContentSinceSubmittedClear = (
    submittedSnapshot: ComposerDraftSnapshot,
  ): boolean => {
    const latest = latestDraftSnapshotRef.current;
    const latestSnapshot =
      latest.scopeKey === composerScopeKey
        ? latest.snapshot
        : createEmptyComposerDraftSnapshot();
    const liveDraft = inputRef.current?.value ?? latestSnapshot.draft;
    const liveSkillTokenCount =
      inputRef.current?.skillTokenCount ?? latestSnapshot.skillTokens.length;
    const latestSnapshotIsCleared =
      !latestSnapshot.draft.trim() &&
      latestSnapshot.skillTokens.length === 0 &&
      latestSnapshot.imageAttachments.length === 0 &&
      (latestSnapshot.fileAttachments?.length ?? 0) === 0;

    if (
      latestSnapshotIsCleared &&
      liveDraft === submittedSnapshot.draft &&
      liveSkillTokenCount === submittedSnapshot.skillTokens.length
    ) {
      return false;
    }

    return Boolean(
      liveDraft.trim() ||
        liveSkillTokenCount > 0 ||
        latestSnapshot.imageAttachments.length > 0 ||
        (latestSnapshot.fileAttachments?.length ?? 0) > 0,
    );
  };
  const recoverSubmittedComposerDraft = (
    snapshot: ComposerDraftSnapshot,
  ): boolean => {
    if (hasNewLiveComposerContentSinceSubmittedClear(snapshot)) {
      recordComposerDraftHistory(composerScopeKey, snapshot, "unsent");
      return false;
    }

    applyRecoveredComposerDraft(snapshot);
    return true;
  };
  const clearRecoveredComposerDraft = (): void => {
    recoveryCycleRef.current = undefined;
    recoveringDraftRef.current = true;
    deletedSkillTokenHistoryRef.current = [];
    clearComposerDraftSnapshot(composerScopeKey);
    flushSync(() => {
      setDraft("");
      setEditorDocument(undefined);
      setImageAttachments([]);
      setFileAttachments([]);
      setSkillTokens([]);
      setComposerSelectionRequest({
        id: `recovery:${++composerSelectionRequestSequenceRef.current}`,
        index: 0,
      });
    });
    setSendError(undefined);
    requestAnimationFrame(() => {
      recoveringDraftRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, 0);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(0, 0);
      });
    });
  };
  const isRecoveryLookupCurrent = (
    request: RecoveryLookupRequest,
  ): boolean =>
    recoveryLookupSequenceRef.current === request.lookupId &&
    recoveryEligibilityVersionRef.current === request.version &&
    activeComposerScopeKeyRef.current === request.scopeKey &&
    latestDraftSnapshotRef.current.scopeKey === request.scopeKey &&
    !hasLiveComposerContent();
  const getOrCreateRecoveryCycle = async (
    request?: RecoveryLookupRequest,
  ): Promise<
    NonNullable<typeof recoveryCycleRef.current> | undefined
  > => {
    if (!draftStore.listRecoveryCandidates) {
      return undefined;
    }

    let cycle = recoveryCycleRef.current;
    if (!cycle || cycle.scopeKey !== composerScopeKey) {
      let response = await draftStore
        .listRecoveryCandidates({
          backend: props.thread?.source,
          directoryKey: props.launchpad?.directoryKey ?? props.directory?.key,
          includeSent: true,
          limit: 20,
          scopeKey: composerScopeKey,
          threadId: props.thread?.id,
        })
        .catch((error) => {
          console.warn("Failed to list composer draft recovery candidates", error);
          return [];
        });
      if (response.length === 0) {
        response = await draftStore
          .listRecoveryCandidates({
            includeSent: true,
            limit: 20,
          })
          .catch((error) => {
            console.warn(
              "Failed to list global composer draft recovery candidates",
              error,
            );
            return [];
          });
      }
      if (request && !isRecoveryLookupCurrent(request)) {
        return undefined;
      }
      const candidates = response
        .map((candidate) => ({
          draft: candidate.text,
          editorDocument: candidate.editorDocument as JSONContent | undefined,
          imageAttachments: candidate.imageAttachments,
          fileAttachments: candidate.fileAttachments,
          skillTokens: candidate.skillTokens as ComposerSkillToken[],
        }))
        .filter(
          (candidate) =>
            candidate.draft.trim() ||
            candidate.skillTokens.length > 0 ||
            candidate.imageAttachments.length > 0 ||
            (candidate.fileAttachments?.length ?? 0) > 0,
        );
      const uniqueCandidates = dedupeComposerDraftSnapshots(candidates);
      if (uniqueCandidates.length === 0) {
        return;
      }
      cycle = {
        activeIndex: undefined,
        candidates: uniqueCandidates,
        scopeKey: composerScopeKey,
      };
    }

    return cycle;
  };
  const recoverPreviousComposerDraft = async (): Promise<void> => {
    const existingCycle = recoveryCycleRef.current;
    const lookupRequest =
      !existingCycle || existingCycle.scopeKey !== composerScopeKey
        ? {
            lookupId: ++recoveryLookupSequenceRef.current,
            scopeKey: composerScopeKey,
            version: recoveryEligibilityVersionRef.current,
          }
        : undefined;
    const cycle = await getOrCreateRecoveryCycle(lookupRequest);
    if (!cycle) {
      return;
    }
    if (lookupRequest && !isRecoveryLookupCurrent(lookupRequest)) {
      return;
    }

    const activeIndex = cycle.activeIndex ?? -1;
    const nextIndex = Math.min(activeIndex + 1, cycle.candidates.length - 1);
    const candidate = cycle.candidates[nextIndex];
    recoveryCycleRef.current = {
      ...cycle,
      activeIndex: nextIndex,
    };
    applyRecoveredComposerDraft(candidate);
  };
  const recoverNextComposerDraft = (): void => {
    const cycle = recoveryCycleRef.current;
    if (!cycle || cycle.scopeKey !== composerScopeKey) {
      return;
    }

    const activeIndex = cycle.activeIndex ?? 0;
    const nextIndex = activeIndex - 1;
    if (nextIndex < 0) {
      clearRecoveredComposerDraft();
      return;
    }

    recoveryCycleRef.current = {
      ...cycle,
      activeIndex: nextIndex,
    };
    applyRecoveredComposerDraft(cycle.candidates[nextIndex]);
  };
  const isQueuedTurnStoreScope = (scopeKey: string): boolean =>
    scopeKey.startsWith("thread:");
  const savePendingSteerSnapshot = (
    scopeKey: string,
    state?: ComposerPendingSteerSnapshot,
  ): void => {
    if (!isQueuedTurnStoreScope(scopeKey)) {
      return;
    }

    if (
      !state ||
      (!state.text.trim() &&
        state.imageAttachments.length === 0 &&
        state.fileAttachments.length === 0)
    ) {
      draftStore.deletePendingSteer(scopeKey);
      return;
    }

    draftStore.setPendingSteer(scopeKey, state);
  };
  const saveQueuedTurnSnapshots = (
    scopeKey: string,
    state: ComposerQueuedTurnSnapshot[],
  ): void => {
    if (!isQueuedTurnStoreScope(scopeKey)) {
      return;
    }

    const snapshots = state.filter(
      (entry) =>
        entry.reviewCommand ||
        entry.text.trim() ||
        entry.imageAttachments.length > 0 ||
        entry.fileAttachments.length > 0 ||
        entry.input?.length,
    );

    if (snapshots.length === 0) {
      draftStore.deleteQueuedTurn(scopeKey);
      return;
    }

    draftStore.setQueuedTurns(scopeKey, snapshots);
  };
  const setQueuedTurns = (nextQueuedTurns: QueuedTurnDraft[]): void => {
    saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
    setQueuedTurnsState(nextQueuedTurns);
  };
  const setQueuedTurn = (nextQueuedTurn?: QueuedTurnDraft): void => {
    setQueuedTurns(nextQueuedTurn ? [nextQueuedTurn] : []);
  };
  const enqueueQueuedTurn = (nextQueuedTurn: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = [...current, nextQueuedTurn];
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const removeQueuedTurnAt = (index: number): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = current.filter((_, candidateIndex) => {
        return candidateIndex !== index;
      });
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const removeQueuedTurn = (queued: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = current.filter((candidate) => {
        return candidate.id !== queued.id;
      });
      if (nextQueuedTurns.length === current.length) {
        return current;
      }
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const removeLocalQueuedTurn = (queued: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) =>
      current.filter((candidate) => candidate.id !== queued.id)
    );
  };
  const claimQueuedTurn = (queued: QueuedTurnDraft): QueuedTurnDraft | undefined => {
    if (!isQueuedTurnStoreScope(composerScopeKey)) {
      return queued;
    }

    const claimed = draftStore.removeQueuedTurnById(composerScopeKey, queued.id);
    if (!claimed) {
      removeLocalQueuedTurn(queued);
      return undefined;
    }

    removeLocalQueuedTurn(queued);
    return claimed as QueuedTurnDraft;
  };
  const restoreClaimedQueuedTurn = (queued: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      if (current.some((candidate) => candidate.id === queued.id)) {
        return current;
      }

      const nextQueuedTurns = [queued, ...current];
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const restoreQueuedTurnIfClaimed = (
    queued: QueuedTurnDraft | undefined,
    queueClaimed: boolean | undefined,
  ): void => {
    if (queued && queueClaimed) {
      restoreClaimedQueuedTurn(queued);
    }
  };
  const releaseQueuedTurnScopeLockIfClaimed = (
    queued: QueuedTurnDraft | undefined,
    queueClaimed: boolean | undefined,
  ): void => {
    if (queued && queueClaimed) {
      globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
    }
  };
  const setPendingSteer = (nextPendingSteer?: PendingSteerDraft): void => {
    if (nextPendingSteer?.status === "pending") {
      savePendingSteerSnapshot(composerScopeKey, nextPendingSteer);
    } else {
      savePendingSteerSnapshot(composerScopeKey);
    }
    setPendingSteerState(nextPendingSteer);
  };
  const updatePendingSteer = (
    updater: (current?: PendingSteerDraft) => PendingSteerDraft | undefined,
  ): void => {
    setPendingSteerState((current) => {
      const nextPendingSteer = updater(current);
      if (nextPendingSteer?.status === "pending") {
        savePendingSteerSnapshot(composerScopeKey, nextPendingSteer);
      } else {
        savePendingSteerSnapshot(composerScopeKey);
      }
      return nextPendingSteer;
    });
  };
  useEffect(() => {
    const hasFutureScheduledQueue = queuedTurns.some((entry) =>
      Boolean(getFutureScheduledSendAt(entry.scheduledSendAt))
    );
    if (!futureScheduledDraftSendAt && !hasFutureScheduledQueue) {
      return;
    }

    const timer = window.setInterval(() => {
      setScheduleTick(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [futureScheduledDraftSendAt, queuedTurns]);

  useEffect(() => {
    if (scheduledDraftSendAt && !futureScheduledDraftSendAt) {
      setScheduledDraftSendAt(undefined);
      setScheduleArmed(true);
    }
  }, [futureScheduledDraftSendAt, scheduledDraftSendAt]);

  const markComposerDraftSubmitted = (scopeKey: string): void => {
    if (!isDraftStoreScope(scopeKey)) {
      return;
    }

    submittedDraftScopeKeysRef.current.add(scopeKey);
    clearComposerDraftSnapshot(scopeKey);
  };
  const unmarkComposerDraftSubmitted = (scopeKey: string): void => {
    submittedDraftScopeKeysRef.current.delete(scopeKey);
  };
  const clearSubmittedComposerDraft = (scopeKey: string): void => {
    const emptySnapshot: ComposerDraftSnapshot = {
      draft: "",
      editorDocument: undefined,
      imageAttachments: [],
      fileAttachments: [],
      skillTokens: [],
    };

    const latest = latestDraftSnapshotRef.current;
    if (latest.scopeKey === scopeKey) {
      recordComposerDraftHistory(scopeKey, latest.snapshot, "sent");
    }
    clearComposerDraftSnapshot(scopeKey);
    latestDraftSnapshotRef.current = {
      scopeKey,
      snapshot: emptySnapshot,
    };
    clearComposerDraft();
    setImageAttachments([]);
    setFileAttachments([]);
  };
  const persistLaunchpadDraftSnapshot = (
    scopeKey: string,
    snapshot: ComposerDraftSnapshot,
  ): void => {
    const directoryKey = getLaunchpadDirectoryKeyFromScope(scopeKey);
    const updateLaunchpad = launchpadUpdateRef.current;
    if (!directoryKey || !updateLaunchpad) {
      return;
    }

    void updateLaunchpad(directoryKey, {
      imageAttachments:
        snapshot.imageAttachments.length > 0 ? snapshot.imageAttachments : undefined,
      fileAttachments:
        snapshot.fileAttachments?.length ? snapshot.fileAttachments : undefined,
      prompt: serializeDraftWithSkillTokens(snapshot.draft, snapshot.skillTokens),
    });
  };
  const flushComposerDraftSnapshot = (
    scopeKey: string,
    snapshot: ComposerDraftSnapshot,
  ): void => {
    if (submittedDraftScopeKeysRef.current.has(scopeKey)) {
      clearComposerDraftSnapshot(scopeKey);
      return;
    }

    saveComposerDraftSnapshot(scopeKey, snapshot);
    persistLaunchpadDraftSnapshot(scopeKey, snapshot);
  };
  const updateActiveTurnId = (
    nextTurnId?: string,
    options?: { review?: boolean },
  ): void => {
    if (options?.review) {
      activeReviewTurnIdRef.current = nextTurnId;
    } else if (!nextTurnId || activeReviewTurnIdRef.current !== nextTurnId) {
      activeReviewTurnIdRef.current = undefined;
    }
    if (!nextTurnId || confirmedActiveTurnIdRef.current !== nextTurnId) {
      confirmedActiveTurnIdRef.current = undefined;
    }
    activeTurnIdRef.current = nextTurnId;
    setActiveTurnId(nextTurnId);
  };
  const trigger = findSkillTrigger(draft, selectionStart);
  const slashTrigger = findSlashCommandTrigger(draft, selectionStart);
  const directoryRefTrigger = findDirectoryReferenceTrigger(draft, selectionStart);
  const filteredSkills = useMemo(() => {
    if (!trigger) {
      return [];
    }

    const normalizedQuery = trigger.query.trim().toLowerCase();
    return props.skills
      .map((skill, index) => ({
        index,
        score: skill.path
          ? rankSkillAutocompleteMatch(skill, normalizedQuery)
          : undefined,
        skill,
      }))
      .filter(
        (match): match is { index: number; score: number; skill: AppServerSkillSummary } =>
          match.score !== undefined
      )
      .sort((left, right) => {
        if (left.score !== right.score) {
          return left.score - right.score;
        }
        return left.index - right.index;
      })
      .map((match) => match.skill);
  }, [props.skills, trigger]);
  const slashCommandSuggestions = useMemo(() => {
    const commands =
      props.providerCommands?.map((command) =>
        providerCommandToSlashSuggestion(command, props.backends)
      ) ?? [];
    return supportsReview ? [...SLASH_COMMANDS, ...commands] : commands;
  }, [props.backends, props.providerCommands, supportsReview]);
  const filteredSlashCommands = useMemo(() => {
    if (!slashTrigger) {
      return [];
    }

    const typed = `/${slashTrigger.query}`.toLowerCase();
    const query = slashTrigger.query.toLowerCase();
    return slashCommandSuggestions.filter((command) => {
      const aliases = command.aliases ?? [];
      return (
        command.label.toLowerCase().startsWith(typed) ||
        aliases.some((alias) => `/${alias}`.toLowerCase().startsWith(typed)) ||
        command.description.toLowerCase().includes(query)
      );
    });
  }, [slashCommandSuggestions, slashTrigger?.query]);
  const filteredDirectoryRefs = useMemo(() => {
    if (!directoryRefTrigger) {
      return [];
    }

    return filterDirectoryReferenceCandidates(
      props.directories ?? [],
      directoryRefTrigger.query,
    );
  }, [props.directories, directoryRefTrigger]);
  const availableAutocompleteKind: AutocompleteKind | undefined = trigger && filteredSkills.length > 0
    ? "skills"
    : slashTrigger && filteredSlashCommands.length > 0
      ? "slash"
      : directoryRefTrigger && filteredDirectoryRefs.length > 0
        ? "directories"
        : undefined;
  const autocompleteKey =
    availableAutocompleteKind === "skills" && trigger
      ? `skills:${trigger.start}:${trigger.end}:${trigger.query}`
      : availableAutocompleteKind === "slash" && slashTrigger
        ? `slash:${slashTrigger.start}:${slashTrigger.end}:/${slashTrigger.query}`
        : availableAutocompleteKind === "directories" && directoryRefTrigger
          ? `directories:${directoryRefTrigger.start}:${directoryRefTrigger.end}:@${directoryRefTrigger.query}`
          : undefined;
  const displayedAutocompleteKind =
    autocompleteKey && autocompleteKey === dismissedAutocompleteKey
      ? undefined
      : availableAutocompleteKind;
  const autocompleteKind: AutocompleteKind | undefined = reviewConfig
    ? undefined
    : displayedAutocompleteKind;
  const hasAutocomplete = Boolean(autocompleteKind);
  const activeAutocompleteIndex =
    autocompleteKind === "skills"
      ? activeSkillIndex
      : autocompleteKind === "directories"
        ? activeDirectoryRefIndex
        : activeSlashIndex;
  const autocompleteLength =
    autocompleteKind === "skills"
      ? filteredSkills.length
      : autocompleteKind === "directories"
        ? filteredDirectoryRefs.length
        : filteredSlashCommands.length;
  const autocompleteListboxId =
    autocompleteKind === "skills"
      ? skillListboxId
      : autocompleteKind === "slash"
        ? slashListboxId
        : autocompleteKind === "directories"
          ? directoryRefListboxId
          : undefined;
  const activeAutocompleteOptionId =
    autocompleteListboxId && autocompleteKind
      ? `${autocompleteListboxId}-option-${activeAutocompleteIndex}`
      : undefined;
  // Directories the draft references: `@` chips (authoritative, from the
  // token state) unioned with paths typed or pasted as plain text (from
  // the serialized-draft scan). Deleting a chip or a typed path drops the
  // reference. Directories that are already linked (the launchpad's own
  // directory; a thread's linked directories, including worktree
  // checkouts) are excluded so send-time attach only sees new references.
  const listDraftReferencedDirectories = (
    text: string,
    tokens?: ComposerSkillToken[],
  ): NavigationDirectorySummary[] => {
    const excludePaths = [
      props.directory?.path,
      props.launchpad?.directoryPath,
      ...(props.thread?.linkedDirectories ?? []).flatMap((linked) => [
        linked.path,
        linked.worktreePath,
      ]),
    ].filter((path): path is string => Boolean(path));
    const excluded = new Set(excludePaths.map((path) => path.replace(/[/\\]+$/, "")));
    const scanned = listReferencedDirectories(text, props.directories ?? [], {
      excludePaths,
    });
    const seenPaths = new Set(
      scanned
        .map((directory) => directory.path?.replace(/[/\\]+$/, ""))
        .filter((path): path is string => Boolean(path)),
    );
    const fromTokens: NavigationDirectorySummary[] = [];
    for (const token of tokens ?? []) {
      // Only directory-kind tokens are attachable directories. File-kind
      // tokens are excluded here — a file's containing repo still links
      // via the text scan's deeper-path matching above.
      if (token.kind !== "directory" || !token.path) {
        continue;
      }
      const path = token.path.replace(/[/\\]+$/, "");
      if (!path || seenPaths.has(path) || excluded.has(path)) {
        continue;
      }
      seenPaths.add(path);
      const tracked = (props.directories ?? []).find(
        (directory) => directory.path?.replace(/[/\\]+$/, "") === path,
      );
      fromTokens.push(
        tracked ?? {
          key: `directory-reference:${path}`,
          kind: "directory",
          label: token.name,
          path: token.path,
          threadKeys: [],
          needsAttentionCount: 0,
        },
      );
    }
    return [...scanned, ...fromTokens];
  };
  const referencedDirectories = listDraftReferencedDirectories(
    canonicalDraft,
    skillTokens,
  );
  const reviewDirectory = useMemo(
    () =>
      findReviewDirectoryForWorkspace({
        directories: props.directories,
        directory: props.directory,
        thread: props.thread,
        workspaceCwd: reviewConfig?.workspaceCwd,
      }),
    [
      props.directories,
      props.directory,
      props.thread,
      reviewConfig?.workspaceCwd,
    ],
  );
  const reviewBranchPickerOptions = useMemo(
    () =>
      buildReviewBranchPickerOptions({
        directory: reviewDirectory,
        thread: props.thread,
      }),
    [reviewDirectory, props.thread],
  );
  const defaultReviewBranch = useMemo(
    () =>
      buildReviewBranchOptions({
        directory: reviewDirectory,
        thread: props.thread,
      })[0] ?? "main",
    [reviewDirectory, props.thread],
  );
  const reviewCommitOptions = useMemo(
    () => buildReviewCommitOptions(reviewDirectory),
    [reviewDirectory],
  );
  const reviewWorkspaceOptions = useMemo(
    () => buildReviewWorkspaceOptions(props.thread),
    [props.thread],
  );
  const reviewWorkspaceSelectionRequired = reviewWorkspaceOptions.length > 1;
  const parsedReviewCommand = supportsReview ? parseReviewCommand(draft) : undefined;
  const isBareReviewCommand = draft.trim() === "/review";
  const isCompactCommand = supportsCompactCommand && draft.trim() === "/compact";
  const isReviewComposerOpen = Boolean(
    supportsReview && reviewConfig && parsedReviewCommand
  );

  useEffect(() => {
    if (!isReviewComposerOpen) {
      return;
    }
    const target = reviewConfig?.target ?? "baseBranch";
    const optionIndex = REVIEW_TARGET_OPTIONS.findIndex(
      (option) => option.target === target,
    );
    reviewOptionRefs.current[optionIndex === -1 ? 0 : optionIndex]?.focus();
  }, [isReviewComposerOpen, reviewConfig?.target]);

  useEffect(() => {
    if (!supportsReview && reviewConfig) {
      setReviewConfig(undefined);
    }
  }, [reviewConfig, supportsReview]);

  useEffect(() => {
    if (
      !isReviewComposerOpen ||
      reviewConfig?.target !== "baseBranch" ||
      reviewConfig.branchSource !== "auto" ||
      reviewConfig.branch === defaultReviewBranch
    ) {
      return;
    }

    setReviewConfig((current) => {
      if (
        current?.target !== "baseBranch" ||
        current.branchSource !== "auto" ||
        current.branch === defaultReviewBranch
      ) {
        return current;
      }

      return {
        ...current,
        branch: defaultReviewBranch,
      };
    });
  }, [
    defaultReviewBranch,
    isReviewComposerOpen,
    reviewConfig?.branch,
    reviewConfig?.branchSource,
    reviewConfig?.target,
  ]);

  useEffect(() => {
    return () => {
      const latest = latestDraftSnapshotRef.current;
      flushComposerDraftSnapshot(latest.scopeKey, latest.snapshot);
    };
  }, []);

  useEffect(() => {
    const previousScopeKey = activeComposerScopeKeyRef.current;
    if (previousScopeKey === composerScopeKey) {
      return;
    }

    recoveryEligibilityVersionRef.current += 1;
    recoveryLookupSequenceRef.current += 1;
    const previousSnapshot = {
      draft,
      editorDocument,
      imageAttachments,
      fileAttachments,
      skillTokens,
    };
    flushComposerDraftSnapshot(previousScopeKey, previousSnapshot);
    if (!props.thread && previousScopeKey.startsWith("thread:")) {
      serverQueuedTurnEntryIdsRef.current.delete(previousScopeKey);
      globalQueuedTurnReleaseScopeKeys.delete(previousScopeKey);
    }

    activeComposerScopeKeyRef.current = composerScopeKey;
    const current = pasteScopeRef.current;
    pasteScopeRef.current = {
      key: composerScopeKey,
      version: current.version + 1,
    };

    if (props.thread) {
      const saved = draftStore.get(composerScopeKey);
      const savedPendingSteer = draftStore.getPendingSteer(composerScopeKey);
      const savedQueuedTurns = draftStore.getQueuedTurns(composerScopeKey);
      setDraft(saved?.draft ?? "");
      setEditorDocument(saved?.editorDocument);
      setImageAttachments(saved?.imageAttachments ?? []);
      setFileAttachments(saved?.fileAttachments ?? []);
      setSkillTokens(saved?.skillTokens ?? []);
      setPendingSteerState(
        savedPendingSteer ? { ...savedPendingSteer, status: "pending" } : undefined
      );
      setQueuedTurnsState(savedQueuedTurns);
    } else {
      setPendingSteerState(undefined);
      setQueuedTurnsState([]);
    }
    updateSending(false);
    setInterrupting(false);
    setSteering(false);
    setScheduleMenuOpen(false);
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
    setServerQueuedTurnEntryIdState(
      serverQueuedTurnEntryIdsRef.current.get(composerScopeKey)
    );
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
  }, [composerScopeKey, draft, editorDocument, imageAttachments, fileAttachments, skillTokens]);

  useEffect(() => {
    const saved = draftStore.get(composerScopeKey);
    if (!saved) {
      return;
    }
    const latest = latestDraftSnapshotRef.current;
    if (latest.scopeKey !== composerScopeKey) {
      return;
    }
    if (
      latest.snapshot.draft.trim() ||
      latest.snapshot.skillTokens.length > 0 ||
      latest.snapshot.imageAttachments.length > 0 ||
      (latest.snapshot.fileAttachments?.length ?? 0) > 0
    ) {
      return;
    }

    setDraft(saved.draft);
    setEditorDocument(saved.editorDocument);
    setImageAttachments(saved.imageAttachments);
    setFileAttachments(saved.fileAttachments ?? []);
    setSkillTokens(saved.skillTokens);
  }, [composerScopeKey, draftStore, draftStoreHydrationVersion]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [trigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashTrigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    setActiveDirectoryRefIndex(0);
  }, [directoryRefTrigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    if (!dismissedAutocompleteKey) {
      return;
    }

    if (!autocompleteKey || autocompleteKey !== dismissedAutocompleteKey) {
      setDismissedAutocompleteKey(undefined);
    }
  }, [autocompleteKey, dismissedAutocompleteKey]);

  useEffect(() => {
    deletedSkillTokenHistoryRef.current = [];
    if (skillTokens.length === 0 && draft.includes("](")) {
      const hydrated = hydrateComposerDraft(draft, props.skills);
      if (hydrated.skillTokens.length > 0) {
        setDraft(hydrated.draft);
        setSkillTokens(hydrated.skillTokens);
      }
    }
  }, [draft, props.skills, skillTokens.length]);

  useEffect(() => {
    if (!autocompleteKind) {
      return;
    }

    autocompleteOptionRefs.current[activeAutocompleteIndex]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeAutocompleteIndex, autocompleteKind]);

  useEffect(() => {
    if (!autocompleteKind) {
      return;
    }

    const updateAutocompleteLayout = (): void => {
      const inputWrap = inputWrapRef.current;
      if (!inputWrap) {
        return;
      }

      const viewportPadding = 12;
      const gap = 10;
      const rect = inputWrap.getBoundingClientRect();
      const availableAbove = rect.top - viewportPadding - gap;
      const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
      const placement =
        availableAbove >= 180 || availableAbove >= availableBelow ? "above" : "below";
      const available = placement === "above" ? availableAbove : availableBelow;
      setAutocompleteLayout({
        placement,
        maxHeight: Math.max(140, Math.min(320, available)),
      });
    };

    updateAutocompleteLayout();
    window.addEventListener("resize", updateAutocompleteLayout);
    return () => {
      window.removeEventListener("resize", updateAutocompleteLayout);
    };
  }, [activeAutocompleteIndex, autocompleteKind]);

  useEffect(() => {
    if (!trigger && !slashTrigger) {
      return;
    }

    void props.onEnsureSkillsLoaded?.();
  }, [
    props.onEnsureSkillsLoaded,
    slashTrigger?.end,
    slashTrigger?.query,
    slashTrigger?.start,
    trigger?.end,
    trigger?.query,
    trigger?.start,
  ]);

  useEffect(() => {
    if (!isLaunchpad) {
      hydratedLaunchpadKeyRef.current = undefined;
      return;
    }

    if (hydratedLaunchpadKeyRef.current === props.launchpad?.directoryKey) {
      return;
    }

    hydratedLaunchpadKeyRef.current = props.launchpad?.directoryKey;
    const saved = draftStore.get(composerScopeKey);
    if (saved) {
      setDraft(saved.draft);
      setEditorDocument(saved.editorDocument);
      setImageAttachments(saved.imageAttachments);
      setFileAttachments(saved.fileAttachments ?? []);
      setSkillTokens(saved.skillTokens);
    } else {
      setComposerDraftFromCanonical(props.launchpad?.prompt ?? "");
      setEditorDocument(
        props.launchpad?.editorDocument as JSONContent | undefined,
      );
      setImageAttachments(props.launchpad?.imageAttachments ?? []);
      setFileAttachments(props.launchpad?.fileAttachments ?? []);
    }
    updateSending(false);
    setInterrupting(false);
    setSteering(false);
    setServerQueuedTurnEntryIdState(undefined);
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
    setQueuedTurnsState([]);
    setPendingSteer(undefined);
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  }, [
    composerScopeKey,
    draftStore,
    isLaunchpad,
    props.launchpad?.directoryKey,
    props.launchpad?.prompt,
    props.skills,
  ]);

  useEffect(() => {
    if (!props.thread) {
      return;
    }

    activeComposerScopeKeyRef.current = composerScopeKey;
  }, [composerScopeKey, props.thread]);

  useEffect(() => {
    return () => {
      globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
    };
  }, [composerScopeKey]);

  useEffect(() => {
    updateActiveTurnId(props.activeTurnId);

    if (!props.activeTurnId) {
      updateSending(false);
      setInterrupting(false);
      setSteering(false);
    }
  }, [props.activeTurnId]);

  useEffect(() => {
    if (!props.desktopApi?.onAgentEvent || !props.thread) {
      return;
    }

    const thread = props.thread;

    return props.desktopApi.onAgentEvent((event) => {
      const notificationThreadId =
        "threadId" in event.notification.params &&
        typeof event.notification.params.threadId === "string"
          ? event.notification.params.threadId
          : undefined;
      const statusRecord =
        event.notification.method === "thread/status/changed" &&
        typeof event.notification.params.status === "object" &&
        event.notification.params.status !== null
          ? (event.notification.params.status as { type?: unknown })
          : undefined;
      const startedTurnRecord =
        event.notification.method === "turn/started" &&
        typeof event.notification.params.turn === "object" &&
        event.notification.params.turn !== null
          ? (event.notification.params.turn as { id?: unknown })
          : undefined;
      const startedTurnId =
        typeof startedTurnRecord?.id === "string"
          ? startedTurnRecord.id
          : event.notification.method === "turn/started" &&
              typeof event.notification.params.turnId === "string"
            ? event.notification.params.turnId
            : undefined;
      const turnQueueRecord =
        event.notification.method === "thread/turnQueue/updated" &&
        typeof event.notification.params === "object" &&
        event.notification.params !== null
          ? (event.notification.params as {
              errorMessage?: unknown;
              queueEntryId?: unknown;
              status?: unknown;
              turnId?: unknown;
            })
          : undefined;

      if (
        notificationThreadId &&
        typeof turnQueueRecord?.queueEntryId === "string" &&
        turnQueueRecord.queueEntryId ===
          serverQueuedTurnEntryIdsRef.current.get(
            getThreadComposerScopeKey(event.backend, notificationThreadId)
          )
      ) {
        const queueScopeKey = getThreadComposerScopeKey(
          event.backend,
          notificationThreadId,
        );
        const queueEventIsCurrentThread =
          event.backend === thread.source && notificationThreadId === thread.id;
        if (
          queueEventIsCurrentThread &&
          turnQueueRecord.status === "started" &&
          typeof turnQueueRecord.turnId === "string"
        ) {
          updateActiveTurnId(turnQueueRecord.turnId);
          props.onActiveTurnIdChange?.(turnQueueRecord.turnId);
          props.onPendingStatusChange?.("Thinking");
        }
        if (
          turnQueueRecord.status === "terminal" ||
          turnQueueRecord.status === "failed" ||
          turnQueueRecord.status === "cancelled"
        ) {
          globalQueuedTurnReleaseScopeKeys.delete(queueScopeKey);
          updateServerQueuedTurnEntryId(undefined, queueScopeKey);
          if (
            queueEventIsCurrentThread &&
            !activeTurnIdRef.current &&
            (turnQueueRecord.status === "failed" ||
              turnQueueRecord.status === "cancelled")
          ) {
            if (activeOptimisticMessageId) {
              props.removeOptimisticMessage?.(activeOptimisticMessageId);
            }
            props.onPendingStatusChange?.(undefined);
            updateSending(false);
            setInterrupting(false);
            setSteering(false);
            setActiveOptimisticMessageId(undefined);
            setSendError(
              typeof turnQueueRecord.errorMessage === "string"
                ? turnQueueRecord.errorMessage
                : turnQueueRecord.status === "cancelled"
                  ? "Queued turn was cancelled before it started."
                  : "Queued turn failed before it started."
            );
          }
        }
      }

      if (event.backend !== thread.source || notificationThreadId !== thread.id) {
        return;
      }

      if (
        pendingSteer?.status === "steering" &&
        event.notification.method === "item/completed" &&
        notificationIncludesDraftContent(event.notification.params, pendingSteer)
      ) {
        setPendingSteer(undefined);
        setSteering(false);
        props.onPendingStatusChange?.("Thinking");
      }

      if (
        pendingSteer?.status === "pending" &&
        activeTurnIdRef.current &&
        isSteerInjectionOpportunity(event.notification.method)
      ) {
        void submitPendingSteer(pendingSteer);
      }

      if (
        event.notification.method === "turn/started" &&
        typeof startedTurnId === "string"
      ) {
        if (
          activeReviewTurnIdRef.current &&
          startedTurnId !== activeReviewTurnIdRef.current
        ) {
          // Codex reviews can surface a separate turn/started id while all
          // review items and the terminal event stay on review/start's turn.
          // Keep Stop/active-turn wiring pointed at the real review turn.
          return;
        }
        updateActiveTurnId(startedTurnId);
        confirmedActiveTurnIdRef.current = startedTurnId;
        props.onActiveTurnIdChange?.(startedTurnId);
      }

      if (
        event.notification.method === "turn/completed" ||
        event.notification.method === "turn/failed" ||
        event.notification.method === "turn/cancelled"
      ) {
        const terminalTurnId =
          typeof event.notification.params.turnId === "string"
            ? event.notification.params.turnId
            : undefined;
        if (
          activeTurnIdRef.current &&
          terminalTurnId &&
          terminalTurnId !== activeTurnIdRef.current
        ) {
          return;
        }
        const clearsReleasedQueuedTurn =
          Boolean(activeTurnIdRef.current) &&
          (!terminalTurnId || terminalTurnId === activeTurnIdRef.current);

        if (
          activeOptimisticMessageId &&
          (event.notification.method === "turn/failed" ||
            event.notification.method === "turn/cancelled")
        ) {
          props.removeOptimisticMessage?.(activeOptimisticMessageId);
        }
        props.onPendingStatusChange?.(undefined);
        if (clearsReleasedQueuedTurn) {
          globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
        }
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        if (pendingSteer?.status === "pending") {
          if (queuedTurn) {
            setComposerDraftFromCanonical(pendingSteer.text);
            setImageAttachments(pendingSteer.imageAttachments);
            setFileAttachments(pendingSteer.fileAttachments);
          } else {
            setQueuedTurn({
              id: createQueuedTurnId(),
              text: pendingSteer.text,
              imageAttachments: pendingSteer.imageAttachments,
              fileAttachments: pendingSteer.fileAttachments,
            });
          }
        }
        setPendingSteer(undefined);
        updateActiveTurnId(undefined);
        props.onActiveTurnIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
        return;
      }

      if (
        event.notification.method === "thread/status/changed" &&
        statusRecord?.type === "idle"
      ) {
        if (
          activeReviewTurnIdRef.current &&
          activeTurnIdRef.current === activeReviewTurnIdRef.current
        ) {
          return;
        }
        if (
          activeTurnIdRef.current &&
          activeTurnIdRef.current === confirmedActiveTurnIdRef.current
        ) {
          return;
        }
        props.onPendingStatusChange?.(undefined);
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        setPendingSteer(undefined);
        updateActiveTurnId(undefined);
        props.onActiveTurnIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
      }
    });
  }, [
    activeOptimisticMessageId,
    props.desktopApi,
    props.onActiveTurnIdChange,
    props.onPendingStatusChange,
    props.removeOptimisticMessage,
    props.thread,
    pendingSteer,
    queuedTurn,
  ]);

  useEffect(() => {
    if (!launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    const editorDocumentChanged =
      JSON.stringify(launchpad.editorDocument) !== JSON.stringify(editorDocument);
    if (canonicalDraft === launchpad.prompt && !editorDocumentChanged) {
      return;
    }

    const timeout = window.setTimeout(() => {
      if (submittedDraftScopeKeysRef.current.has(composerScopeKey)) {
        return;
      }

      void props.onUpdateLaunchpad?.(launchpad.directoryKey, {
        imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
        fileAttachments: fileAttachments.length > 0 ? fileAttachments : undefined,
        prompt: canonicalDraft,
        editorDocument: editorDocument as Record<string, unknown> | undefined,
      });
    }, 250);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    canonicalDraft,
    composerScopeKey,
    editorDocument,
    imageAttachments,
    fileAttachments,
    launchpad,
    props.onUpdateLaunchpad,
  ]);

  const submitReviewCommand = async (reviewCommand: {
    cwd?: string;
    displayText: string;
    target: AppServerReviewTarget;
  }, options?: {
    queueClaimed?: boolean;
    queued?: QueuedTurnDraft;
  }): Promise<void> => {
    const submissionKey = reviewSubmissionKey(reviewCommand);
    if (
      sendingRef.current &&
      inFlightReviewSubmissionKeyRef.current === submissionKey
    ) {
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      releaseQueuedTurnScopeLockIfClaimed(options?.queued, options?.queueClaimed);
      return;
    }
    if (props.disabled) {
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      releaseQueuedTurnScopeLockIfClaimed(options?.queued, options?.queueClaimed);
      return;
    }
    if (!supportsReview) {
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      releaseQueuedTurnScopeLockIfClaimed(options?.queued, options?.queueClaimed);
      setSendError("Selected backend does not support reviews.");
      return;
    }
    if (!options?.queued && imageAttachments.length > 0) {
      setSendError("/review does not accept image attachments.");
      return;
    }
    if (
      !options?.queued &&
      reviewWorkspaceSelectionRequired &&
      !reviewCommand.cwd
    ) {
      setReviewConfig(
        createReviewConfig({
          directory: props.directory,
          reviewCommand,
          thread: props.thread,
        })
      );
      setSendError("Choose a project to review.");
      return;
    }
    if (!options?.queued && shouldQueueThreadSubmit()) {
      queueReviewCommand(reviewCommand);
      return;
    }

    setSendError(undefined);
    inFlightReviewSubmissionKeyRef.current = submissionKey;
    updateSending(true);
    props.onPendingStatusChange?.("Reviewing");

    if (props.launchpad && props.onMaterializeLaunchpad) {
      const submittedScopeKey = composerScopeKey;
      markComposerDraftSubmitted(submittedScopeKey);
      props.onPendingStatusChange?.(
        props.launchpad.codexEnvironmentId &&
          selectedCodexEnvironment?.setupScript
          ? "Running environment setup"
          : "Reviewing",
      );
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          undefined,
          undefined,
          reviewCommand.target,
          // No turn payload is built for a review materialize, so append
          // the file references by hand — a dropped file inside a tracked
          // repo should still link that repo to the new thread.
          listDraftReferencedDirectories(
            appendFileReferenceMarkdown(canonicalDraft, fileAttachments),
            skillTokens,
          )
            .map((directory) => directory.path)
            .filter((path): path is string => Boolean(path))
        );
        clearSubmittedComposerDraft(submittedScopeKey);
        setReviewConfig(undefined);
      } catch (error) {
        unmarkComposerDraftSubmitted(submittedScopeKey);
        inFlightReviewSubmissionKeyRef.current = undefined;
        props.onPendingStatusChange?.(undefined);
        restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
        releaseQueuedTurnScopeLockIfClaimed(options?.queued, options?.queueClaimed);
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        updateSending(false);
      }
      return;
    }

    if (!props.thread || !props.desktopApi?.startReview) {
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      releaseQueuedTurnScopeLockIfClaimed(options?.queued, options?.queueClaimed);
      return;
    }

    const optimisticReviewId = props.addOptimisticReviewEntry?.(
      reviewCommand.displayText
    );
    setActiveOptimisticMessageId(optimisticReviewId);
    const submittedSnapshot = latestDraftSnapshotRef.current.snapshot;
    if (!options?.queued) {
      clearSubmittedComposerDraftForStart(composerScopeKey);
      setReviewConfig(undefined);
    }
    try {
      const response = await props.desktopApi.startReview({
        backend: props.thread.source,
        threadId: props.thread.id,
        target: reviewCommand.target,
        delivery: "inline",
        ...(reviewCommand.cwd ? { cwd: reviewCommand.cwd } : {}),
        ...(selectedModelOption?.id ? { model: selectedModelOption.id } : {}),
        ...(supportsReasoning && selectedReasoningEffort
          ? { reasoningEffort: selectedReasoningEffort }
          : {}),
        ...(selectedServiceTier ? { serviceTier: selectedServiceTier } : {}),
        ...(props.thread.source === "codex" && supportsFast
          ? { fastMode: Boolean(currentSettings?.fastMode) }
          : {}),
      });
      inFlightReviewSubmissionKeyRef.current = undefined;
      updateActiveTurnId(response.turnId, { review: true });
      props.onActiveTurnIdChange?.(response.turnId);
      if (options?.queued) {
        if (!options.queueClaimed) {
          removeQueuedTurn(options.queued);
        }
      } else {
        recordComposerDraftHistory(
          composerScopeKey,
          submittedSnapshot,
          "sent",
        );
      }
    } catch (error) {
      if (optimisticReviewId) {
        props.removeOptimisticMessage?.(optimisticReviewId);
      }
      inFlightReviewSubmissionKeyRef.current = undefined;
      if (!options?.queued) {
        recoverSubmittedComposerDraft(submittedSnapshot);
      }
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      setInterrupting(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      releaseQueuedTurnScopeLockIfClaimed(options?.queued, options?.queueClaimed);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitCompactThread = async (): Promise<void> => {
    if (props.disabled) {
      return;
    }
    if (!supportsCompactCommand) {
      setSendError("Selected backend does not support compaction.");
      return;
    }
    if (imageAttachments.length > 0 || fileAttachments.length > 0) {
      setSendError("/compact does not accept attachments.");
      return;
    }
    if (shouldQueueThreadSubmit()) {
      setSendError("Cannot compact while a turn is in progress.");
      return;
    }
    if (!props.thread || !props.desktopApi?.compactThread) {
      setSendError("Compaction is not available for this thread.");
      return;
    }

    setSendError(undefined);
    updateSending(true);
    props.onPendingStatusChange?.("Compacting");
    const submittedScopeKey = composerScopeKey;
    const submittedSnapshot = latestDraftSnapshotRef.current.snapshot;
    const emptySnapshot: ComposerDraftSnapshot = {
      draft: "",
      editorDocument: undefined,
      imageAttachments: [],
      fileAttachments: [],
      skillTokens: [],
    };
    clearComposerDraftSnapshot(submittedScopeKey);
    latestDraftSnapshotRef.current = {
      scopeKey: submittedScopeKey,
      snapshot: emptySnapshot,
    };
    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: "",
      expectedSkillTokensSignature: getComposerSkillTokensSignature([]),
      staleDraft: submittedSnapshot.draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(
        submittedSnapshot.skillTokens,
      ),
    };
    flushSync(() => {
      clearComposerDraft();
      setImageAttachments([]);
      setFileAttachments([]);
      setReviewConfig(undefined);
    });

    try {
      const response = await props.desktopApi.compactThread({
        backend: props.thread.source,
        threadId: props.thread.id,
      });
      updateActiveTurnId(response.turnId);
      props.onActiveTurnIdChange?.(response.turnId);
      recordComposerDraftHistory(
        submittedScopeKey,
        submittedSnapshot,
        "sent",
      );
    } catch (error) {
      latestDraftSnapshotRef.current = {
        scopeKey: submittedScopeKey,
        snapshot: submittedSnapshot,
      };
      saveComposerDraftSnapshot(submittedScopeKey, submittedSnapshot);
      setDraft(submittedSnapshot.draft);
      setEditorDocument(submittedSnapshot.editorDocument);
      setImageAttachments(submittedSnapshot.imageAttachments);
      setFileAttachments(submittedSnapshot.fileAttachments ?? []);
      setSkillTokens(submittedSnapshot.skillTokens);
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      setInterrupting(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const enterReviewComposer = (): void => {
    setReviewConfig(
      createReviewConfig({
        directory: props.directory,
        thread: props.thread,
      })
    );
    updateVisibleDraft("/review");
    setDismissedAutocompleteKey(autocompleteKey);
    setActiveSkillIndex(0);
    setActiveSlashIndex(0);
    setSendError(undefined);
  };

  const exitReviewComposer = (): void => {
    setReviewConfig(undefined);
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
    clearComposerDraft();
    setSendError(undefined);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submitConfiguredReviewComposer = async (): Promise<void> => {
    await submitReviewConfig(reviewConfig);
  };

  const submitReviewConfig = async (
    config: ReviewConfigState | undefined,
  ): Promise<void> => {
    const configuredReviewCommand = buildConfiguredReviewCommand(config);
    if (!configuredReviewCommand) {
      return;
    }
    if (futureScheduledDraftSendAt) {
      queueReviewCommand(configuredReviewCommand, {
        scheduledSendAt: futureScheduledDraftSendAt,
      });
      return;
    }

    await submitReviewCommand(configuredReviewCommand);
  };

  const focusReviewOption = (index: number): void => {
    requestAnimationFrame(() => {
      reviewOptionRefs.current[index]?.focus();
    });
  };

  const focusReviewDetail = (target: ReviewTargetChoice): void => {
    requestAnimationFrame(() => {
      if (target === "commit") {
        reviewCommitInputRef.current?.focus();
      } else if (target === "custom") {
        reviewCustomTextareaRef.current?.focus();
      }
    });
  };

  const getReviewConfigWithTarget = (
    target: ReviewTargetChoice,
  ): ReviewConfigState => ({
    ...(reviewConfig ??
      createReviewConfig({
        directory: props.directory,
        thread: props.thread,
      })),
    target,
  });

  const selectReviewTarget = (
    target: ReviewTargetChoice,
    options?: { focusDetail?: boolean },
  ): void => {
    setReviewConfig((current) => ({
      ...(current ??
        createReviewConfig({
          directory: props.directory,
          thread: props.thread,
        })),
      target,
    }));
    setSendError(undefined);
    if (options?.focusDetail) {
      focusReviewDetail(target);
    }
  };

  const submitFocusedReviewTarget = (
    target: ReviewTargetChoice,
  ): void => {
    const nextConfig = getReviewConfigWithTarget(target);
    setReviewConfig(nextConfig);
    setSendError(undefined);
    if (
      (target === "commit" && !nextConfig.commit.trim()) ||
      (target === "custom" && !nextConfig.customInstructions.trim())
    ) {
      focusReviewDetail(target);
      return;
    }
    void submitReviewConfig(nextConfig);
  };

  const handleReviewConfigKeyDown = (
    event: ReactKeyboardEvent<HTMLFieldSetElement>,
  ): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    exitReviewComposer();
  };

  const handleReviewOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submitFocusedReviewTarget(REVIEW_TARGET_OPTIONS[index]!.target);
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex =
      (index + direction + REVIEW_TARGET_OPTIONS.length) %
      REVIEW_TARGET_OPTIONS.length;
    selectReviewTarget(REVIEW_TARGET_OPTIONS[nextIndex]!.target);
    focusReviewOption(nextIndex);
  };

  const buildTurnPayload = (
    textDraft: string,
    attachments: ComposerImageAttachment[],
    fileRefs: ComposerFileAttachment[],
  ): {
    displayText: string;
    imageParts: AppServerThreadImagePart[];
    input: AppServerTurnInputItem[];
  } => {
    const turnSkills = listMentionedSkills(textDraft, props.skills);
    // File-reference pills ride the outgoing text as `[@label](~/path)`
    // markdown appended after the typed draft — part of BOTH the display
    // text and the text input item, so the agent and the transcript see
    // the same message.
    const displayText = appendFileReferenceMarkdown(
      hydrateSkillLabelsWithMarkdown(textDraft.trim(), turnSkills),
      fileRefs,
    );
    const imageParts = attachments.map((attachment, index) => ({
      type: "image" as const,
      url: attachment.url,
      alt: formatPastedImageAlt(attachment, index),
    }));
    const input: AppServerTurnInputItem[] = [
      ...(displayText ? [{ type: "text" as const, text: displayText }] : []),
      ...attachments.map((attachment) => ({
        type: "image" as const,
        name: attachment.name,
        url: attachment.url,
      })),
    ];

    return { displayText, imageParts, input };
  };

  const sendThreadTurn = async (
    queued?: QueuedTurnDraft,
    options?: { queueClaimed?: boolean },
  ): Promise<void> => {
    if (!props.thread || !props.desktopApi?.startTurn) {
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
      return;
    }

    const payload = queued
      ? buildTurnPayload(
          queued.text,
          queued.imageAttachments,
          queued.fileAttachments ?? [],
        )
      : buildTurnPayload(canonicalDraft, imageAttachments, fileAttachments);
    if (payload.input.length === 0 || props.disabled) {
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
      return;
    }

    const collaborationMode =
      !queued && planModeEnabled && supportsPlanMode
        ? ({
            mode: "plan",
            settings: {
              developerInstructions: null,
            },
          } satisfies AppServerCollaborationModeRequest)
        : undefined;

    if (!queued && props.onBeforeStartTurn && !(await props.onBeforeStartTurn())) {
      updateSending(false);
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
      return;
    }

    props.onBeforeSendTurn?.();
    props.onPendingStatusChange?.(collaborationMode ? "Planning" : "Thinking");
    const optimisticMessageId = props.addOptimisticUserMessage?.(
      payload.displayText,
      payload.imageParts
    );
    setActiveOptimisticMessageId(optimisticMessageId);
    const submittedSnapshot = latestDraftSnapshotRef.current.snapshot;
    if (!queued) {
      clearSubmittedComposerDraftForStart(composerScopeKey);
      if (collaborationMode) {
        setPlanModeEnabled(false);
      }
    }

    try {
      const response = await props.desktopApi.startTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        input: payload.input,
        executionMode: props.thread.executionMode,
        collaborationMode,
        model: selectedModelOption?.id,
        reasoningEffort: supportsReasoning ? selectedReasoningEffort : undefined,
        serviceTier: selectedServiceTier,
        fastMode: props.thread.source === "codex" && supportsFast
          ? Boolean(currentSettings?.fastMode)
          : undefined,
      });
      if (response.queueStatus === "queued") {
        updateServerQueuedTurnEntryId(response.queueEntryId ?? response.turnId);
      } else {
        updateActiveTurnId(response.turnId);
        props.onActiveTurnIdChange?.(response.turnId);
      }
      // Queued turns only carry their serialized text, but that text is
      // self-describing (`[@label](~/path)` markdown), so the scan alone
      // recovers chip references there. Scan the outgoing display text —
      // it also carries the appended file references, so a dropped file
      // inside a tracked repo links that repo.
      const sentReferencedDirectoryPaths = listDraftReferencedDirectories(
        payload.displayText,
        queued ? undefined : skillTokens,
      )
        .map((directory) => directory.path)
        .filter((path): path is string => Boolean(path));
      if (sentReferencedDirectoryPaths.length > 0) {
        props.onAttachDirectoryReferences?.(sentReferencedDirectoryPaths, {
          backend: props.thread.source,
          threadId: props.thread.id,
        });
      }
      if (queued) {
        if (!options?.queueClaimed) {
          removeQueuedTurn(queued);
        }
      } else {
        recordComposerDraftHistory(
          composerScopeKey,
          submittedSnapshot,
          "sent",
        );
      }
    } catch (error) {
      if (optimisticMessageId) {
        props.removeOptimisticMessage?.(optimisticMessageId);
      }
      if (!queued) {
        const recoveredSubmittedDraft =
          recoverSubmittedComposerDraft(submittedSnapshot);
        if (collaborationMode && recoveredSubmittedDraft) {
          setPlanModeEnabled(true);
        }
      }
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      setInterrupting(false);
      setSteering(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setActiveOptimisticMessageId(undefined);
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const sendQueuedTurn = async (queued: QueuedTurnDraft): Promise<void> => {
    const claimedQueuedTurn = claimQueuedTurn(queued);
    if (!claimedQueuedTurn) {
      globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      return;
    }

    if (claimedQueuedTurn.reviewCommand) {
      await submitReviewCommand(claimedQueuedTurn.reviewCommand, {
        queueClaimed: true,
        queued: claimedQueuedTurn,
      });
      return;
    }

    await sendThreadTurn(claimedQueuedTurn, { queueClaimed: true });
  };

  // Operator-initiated "Send now" on a queued/scheduled entry. Bypasses the
  // release schedule and fires the turn immediately. Mirrors the auto-release
  // effect's coordination (global scope-key guard + sending flag) so the
  // background releaser in useQueuedTurnRelease can't double-send the claimed
  // turn.
  const sendQueuedTurnNow = (queued: QueuedTurnDraft): void => {
    if (
      props.disabled ||
      sending ||
      activeTurnIdRef.current ||
      globalQueuedTurnReleaseScopeKeys.has(composerScopeKey)
    ) {
      return;
    }
    globalQueuedTurnReleaseScopeKeys.add(composerScopeKey);
    updateSending(true);
    void sendQueuedTurn(queued).finally(() => {
      updateSending(false);
    });
  };

  useEffect(() => {
    if (activeTurnId) {
      queuedAutoReleaseAttemptIdRef.current = undefined;
      return;
    }
    if (
      !nextReleasableQueuedTurn ||
      globalQueuedTurnReleaseScopeKeys.has(composerScopeKey) ||
      props.threadBusy ||
      activeTurnId ||
      serverQueuedTurnEntryId ||
      sending ||
      props.launchpad ||
      props.disabled
    ) {
      return;
    }
    if (queuedAutoReleaseAttemptIdRef.current === nextReleasableQueuedTurn.id) {
      return;
    }

    queuedAutoReleaseAttemptIdRef.current = nextReleasableQueuedTurn.id;
    globalQueuedTurnReleaseScopeKeys.add(composerScopeKey);
    updateSending(true);
    void sendQueuedTurn(nextReleasableQueuedTurn).finally(() => {
      updateSending(false);
    });
  }, [
    activeTurnId,
    nextReleasableQueuedTurn,
    serverQueuedTurnEntryId,
    scheduleTick,
    sending,
    props.threadBusy,
    props.disabled,
    props.launchpad,
  ]);

  useEffect(() => {
    if (
      !pendingSteer ||
      pendingSteer.status !== "pending" ||
      activeTurnId ||
      props.launchpad
    ) {
      return;
    }

    if (queuedTurn) {
      setComposerDraftFromCanonical(pendingSteer.text);
      setImageAttachments(pendingSteer.imageAttachments);
      setFileAttachments(pendingSteer.fileAttachments);
    } else {
      setQueuedTurn({
        id: createQueuedTurnId(),
        text: pendingSteer.text,
        imageAttachments: pendingSteer.imageAttachments,
        fileAttachments: pendingSteer.fileAttachments,
      });
    }
    setPendingSteer(undefined);
  }, [activeTurnId, pendingSteer, props.launchpad, queuedTurn]);

  const queueCurrentDraft = (options?: { scheduledSendAt?: number }): void => {
    if (
      !hasComposerContent &&
      imageAttachments.length === 0 &&
      fileAttachments.length === 0
    ) {
      return;
    }

    const payload = buildTurnPayload(canonicalDraft, imageAttachments, fileAttachments);
    if (payload.input.length === 0) {
      return;
    }

    enqueueQueuedTurn({
      id: createQueuedTurnId(),
      input: payload.input,
      text: canonicalDraft,
      imageAttachments,
      fileAttachments,
      ...(options?.scheduledSendAt
        ? { scheduledSendAt: options.scheduledSendAt }
        : {}),
    });
    recordComposerDraftHistory(
      composerScopeKey,
      latestDraftSnapshotRef.current.snapshot,
      "unsent",
    );
    clearComposerDraftSnapshot(composerScopeKey);
    clearComposerDraft();
    setImageAttachments([]);
    setFileAttachments([]);
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
    setReviewConfig(undefined);
    setSendError(undefined);
  };

  const queueReviewCommand = (
    reviewCommand: {
      cwd?: string;
      displayText: string;
      target: AppServerReviewTarget;
    },
    options?: { scheduledSendAt?: number },
  ): void => {
    enqueueQueuedTurn({
      id: createQueuedTurnId(),
      text: reviewCommandToDraftText(reviewCommand),
      imageAttachments: [],
      fileAttachments: [],
      ...(options?.scheduledSendAt
        ? { scheduledSendAt: options.scheduledSendAt }
        : {}),
      reviewCommand,
    });
    recordComposerDraftHistory(
      composerScopeKey,
      latestDraftSnapshotRef.current.snapshot,
      "unsent",
    );
    clearComposerDraftSnapshot(composerScopeKey);
    clearComposerDraft();
    setImageAttachments([]);
    setFileAttachments([]);
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
    setReviewConfig(undefined);
    setSendError(undefined);
  };

  const shouldQueueThreadSubmit = (): boolean =>
    !props.launchpad &&
    (Boolean(props.threadBusy) ||
      Boolean(activeTurnIdRef.current) ||
      Boolean(serverQueuedTurnEntryIdsRef.current.get(composerScopeKey)) ||
      sendingRef.current);

  const scheduleCurrentDraft = (scheduledSendAt: number): void => {
    if (props.launchpad || props.disabled) {
      return;
    }

    const reviewCommand = parsedReviewCommand;
    if (reviewCommand) {
      if (isBareReviewCommand) {
        setScheduledDraftSendAt(scheduledSendAt);
        setScheduleArmed(true);
        setReviewConfig(
          reviewConfig ??
            createReviewConfig({
              directory: props.directory,
              thread: props.thread,
            })
        );
        setSendError(undefined);
        return;
      }
      if (imageAttachments.length > 0) {
        setSendError("/review does not accept image attachments.");
        return;
      }
      if (reviewWorkspaceSelectionRequired) {
        setScheduledDraftSendAt(scheduledSendAt);
        setScheduleArmed(true);
        setReviewConfig(
          createReviewConfig({
            directory: props.directory,
            reviewCommand,
            thread: props.thread,
          })
        );
        setSendError("Choose a project to review.");
        return;
      }
      queueReviewCommand(reviewCommand, { scheduledSendAt });
      return;
    }

    queueCurrentDraft({ scheduledSendAt });
  };

  const submitPendingSteer = async (pending: QueuedTurnDraft): Promise<void> => {
    const turnId = activeTurnIdRef.current;
    if (!props.thread || !turnId || !props.desktopApi?.steerTurn) {
      setSendError("Steering is not available for this backend.");
      return;
    }
    if (!supportsSteering) {
      setSendError("Steering is not available for this model.");
      return;
    }

    const payload = buildTurnPayload(
      pending.text,
      pending.imageAttachments,
      pending.fileAttachments,
    );
    if (payload.input.length === 0 || props.disabled || steering) {
      return;
    }

    setSendError(undefined);
    setSteering(true);
    updatePendingSteer((current) =>
      current?.text === pending.text &&
      current.imageAttachments === pending.imageAttachments
        ? { ...current, status: "steering" }
        : current
    );
    props.onPendingStatusChange?.("Steering");
    try {
      await props.desktopApi.steerTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        expectedTurnId: turnId,
        input: payload.input,
      });
    } catch (error) {
      const staleSteer = parseStaleSteerError(error);
      if (staleSteer) {
        if (queuedTurn) {
          setDraft(pending.text);
          setImageAttachments(pending.imageAttachments);
          setFileAttachments(pending.fileAttachments);
        } else {
          setQueuedTurn({
            id: createQueuedTurnId(),
            text: pending.text,
            imageAttachments: pending.imageAttachments,
            fileAttachments: pending.fileAttachments,
          });
        }
        setPendingSteer(undefined);
        setSendError(undefined);
        const nextActiveTurnId = staleSteer.active ? staleSteer.activeTurnId : undefined;
        updateActiveTurnId(nextActiveTurnId);
        props.onActiveTurnIdChange?.(nextActiveTurnId);
        props.onPendingStatusChange?.(staleSteer.active ? "Thinking" : undefined);
        return;
      }
      updatePendingSteer((current) =>
        current?.text === pending.text &&
        current.imageAttachments === pending.imageAttachments
          ? { ...current, status: "pending" }
          : current
      );
      props.onPendingStatusChange?.("Thinking");
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSteering(false);
    }
  };

  const createPendingSteer = (pending: QueuedTurnDraft): boolean => {
    const turnId = activeTurnIdRef.current;
    if (!props.thread || !turnId || !props.desktopApi?.steerTurn || !supportsSteering) {
      setSendError("Steering is not available for this model.");
      return false;
    }

    const payload = buildTurnPayload(
      pending.text,
      pending.imageAttachments,
      pending.fileAttachments,
    );
    if (payload.input.length === 0 || props.disabled || pendingSteer) {
      return false;
    }

    setSendError(undefined);
    setPendingSteer({
      id: pending.id,
      text: pending.text,
      imageAttachments: pending.imageAttachments,
      fileAttachments: pending.fileAttachments,
      status: "pending",
    });
    recordComposerDraftHistory(
      composerScopeKey,
      latestDraftSnapshotRef.current.snapshot,
      "unsent",
    );
    clearComposerDraftSnapshot(composerScopeKey);
    clearComposerDraft();
    setImageAttachments([]);
    setFileAttachments([]);
    setReviewConfig(undefined);
    return true;
  };

  const steerCurrentDraft = (): void => {
    if (!props.thread || !activeTurnIdRef.current || !props.desktopApi?.steerTurn) {
      queueCurrentDraft();
      setSendError("Steering is not available for this backend.");
      return;
    }
    if (!supportsSteering) {
      queueCurrentDraft();
      setSendError("Steering is not available for this model.");
      return;
    }

    createPendingSteer({
      id: createQueuedTurnId(),
      text: canonicalDraft,
      imageAttachments,
      fileAttachments,
    });
  };

  const steerQueuedTurn = (queued: QueuedTurnDraft): void => {
    if (!createPendingSteer(queued)) {
      return;
    }
    removeQueuedTurn(queued);
    if (activeTurnIdRef.current) {
      void submitPendingSteer(queued);
    }
  };

  const submitTurn = async (mode: "default" | "steer" = "default"): Promise<void> => {
    const reviewCommand = parsedReviewCommand;
    if (
      reviewCommand &&
      sendingRef.current &&
      inFlightReviewSubmissionKeyRef.current === reviewSubmissionKey(reviewCommand)
    ) {
      return;
    }
    if (isCompactCommand) {
      await submitCompactThread();
      return;
    }

    if (shouldQueueThreadSubmit()) {
      if (activeTurnIdRef.current && mode === "steer") {
        steerCurrentDraft();
      } else if (reviewCommand && isBareReviewCommand) {
        setReviewConfig(
          reviewConfig ??
            createReviewConfig({
              directory: props.directory,
              thread: props.thread,
            })
        );
        setSendError(undefined);
      } else if (reviewCommand) {
        if (imageAttachments.length > 0) {
          setSendError("/review does not accept image attachments.");
          return;
        }
        if (reviewWorkspaceSelectionRequired) {
          setReviewConfig(
            createReviewConfig({
              directory: props.directory,
              reviewCommand,
              thread: props.thread,
            })
          );
          setSendError("Choose a project to review.");
          return;
        }
        queueReviewCommand(
          reviewCommand,
          effectiveScheduledSendAt
            ? { scheduledSendAt: effectiveScheduledSendAt }
            : undefined,
        );
      } else {
        queueCurrentDraft(
          effectiveScheduledSendAt
            ? { scheduledSendAt: effectiveScheduledSendAt }
            : undefined,
        );
      }
      return;
    }

    if (reviewCommand) {
      if (isBareReviewCommand) {
        setReviewConfig(
          reviewConfig ??
            createReviewConfig({
              directory: props.directory,
              thread: props.thread,
            })
        );
        setSendError(undefined);
        return;
      }

      if (effectiveScheduledSendAt) {
        queueReviewCommand(reviewCommand, {
          scheduledSendAt: effectiveScheduledSendAt,
        });
        return;
      }

      // Unarmed schedule ("send now" on an edited scheduled review) — drop the
      // pending time before firing so it doesn't linger and re-arm the toggle.
      setScheduledDraftSendAt(undefined);
      setScheduleArmed(true);
      await submitReviewCommand(reviewCommand);
      return;
    }

    if (effectiveScheduledSendAt) {
      queueCurrentDraft({ scheduledSendAt: effectiveScheduledSendAt });
      return;
    }

    // Unarmed schedule ("send now" on an edited scheduled message) — clear the
    // pending time so the toggle doesn't reappear after the immediate send.
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
    const payload = buildTurnPayload(canonicalDraft, imageAttachments, fileAttachments);
    const collaborationMode = planModeEnabled && supportsPlanMode
      ? ({
          mode: "plan",
          settings: {
            developerInstructions: null,
          },
        } satisfies AppServerCollaborationModeRequest)
      : undefined;

    if (payload.input.length === 0 || props.disabled) {
      return;
    }

    setSendError(undefined);
    updateSending(true);

    if (props.launchpad && props.onMaterializeLaunchpad) {
      const submittedScopeKey = composerScopeKey;
      markComposerDraftSubmitted(submittedScopeKey);
      props.onPendingStatusChange?.(
        props.launchpad.codexEnvironmentId &&
          selectedCodexEnvironment?.setupScript
          ? "Running environment setup"
          : collaborationMode
            ? "Planning"
            : "Thinking",
      );
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          payload.input,
          collaborationMode,
          undefined,
          // Scan the outgoing display text so the appended file
          // references also link their containing tracked repos.
          listDraftReferencedDirectories(payload.displayText, skillTokens)
            .map((directory) => directory.path)
            .filter((path): path is string => Boolean(path))
        );
        clearSubmittedComposerDraft(submittedScopeKey);
        if (collaborationMode) {
          setPlanModeEnabled(false);
        }
      } catch (error) {
        unmarkComposerDraftSubmitted(submittedScopeKey);
        props.onPendingStatusChange?.(undefined);
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        updateSending(false);
      }
      return;
    }

    if (!props.thread || !props.desktopApi?.startTurn) {
      updateSending(false);
      return;
    }

    await sendThreadTurn();
  };

  const stopTurn = async (): Promise<void> => {
    const turnId = activeTurnIdRef.current;
    if (
      !props.thread ||
      !turnId ||
      !props.desktopApi?.interruptTurn ||
      interrupting
    ) {
      return;
    }

    setSendError(undefined);
    setInterrupting(true);
    props.onPendingStatusChange?.("Stopping");

    try {
      await props.desktopApi.interruptTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        turnId,
      });
    } catch (error) {
      setInterrupting(false);
      if (parseStaleInterruptError(error)) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
        queuedAutoReleaseAttemptIdRef.current = undefined;
        updateSending(false);
        setSteering(false);
        updateActiveTurnId(undefined);
        props.onActiveTurnIdChange?.(undefined);
        props.onPendingStatusChange?.(undefined);
        setSendError(undefined);
        return;
      }
      props.onPendingStatusChange?.(
        props.pendingRequestActive
          ? "Waiting for approval"
          : props.pendingUserInputActive
            ? "Waiting for input"
            : "Thinking"
      );
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const applySkill = (skill: AppServerSkillSummary): void => {
    if (!inputRef.current) {
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    const trigger =
      findSkillTrigger(draft, selectionStart) ?? findSkillTrigger(draft, draft.length);
    if (!trigger) {
      return;
    }

    const before = draft.slice(0, trigger.start);
    const after = draft.slice(Math.max(trigger.end, selectionEnd));
    // Always leave one space after the chip — including at the end of the
    // draft — and park the caret after it, so typing straight on never
    // glues onto the chip's serialized form.
    const nextAfter = /^\s/.test(after) ? after : ` ${after}`;
    const nextDraft = `${before}${nextAfter}`;
    const tokenIndex = before.length;
    const nextSelection = tokenIndex + 1;
    const nextSkillTokens = [
      ...adjustSkillTokenIndexesForTextChange({
        currentDraft: draft,
        nextDraft,
        skillTokens,
      }),
      createComposerSkillToken(skill, tokenIndex),
    ];

    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: nextDraft,
      expectedSkillTokensSignature:
        getComposerSkillTokensSignature(nextSkillTokens),
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    flushSync(() => {
      setSkillTokens(nextSkillTokens);
      setDraft(nextDraft);
      setActiveSkillIndex(0);
    });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  const applySlashCommand = (command: SlashCommandSuggestion): void => {
    if (!inputRef.current) {
      return;
    }

    if (command.id === "review-current") {
      enterReviewComposer();
      return;
    }

    if (shouldQueueThreadSubmit()) {
      queueCurrentDraft();
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    const trigger = findSlashCommandTrigger(draft, selectionStart);
    if (!trigger) {
      return;
    }

    const before = draft.slice(0, trigger.start);
    const after = draft.slice(Math.max(trigger.end, selectionEnd));
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    const nextDraft = `${before}${command.insertText}${needsTrailingSpace ? " " : ""}${after}`;
    const nextSelection = before.length + command.insertText.length + (needsTrailingSpace ? 1 : 0);
    const nextSkillTokens = adjustSkillTokenIndexesForTextChange({
      currentDraft: draft,
      nextDraft,
      skillTokens,
    });

    // Same protected-update dance as applySkill / applyDirectoryReference:
    // the editability sync in ComposerTiptapInput re-emits the editor's
    // (still pre-insert) content through onChange before the external-value
    // sync applies the new draft. The pending-programmatic guard in
    // handleComposerChange swallows that stale replay so the two sides
    // can't ping-pong.
    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: nextDraft,
      expectedSkillTokensSignature:
        getComposerSkillTokensSignature(nextSkillTokens),
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    // The caret lives in a ref, so the commit below re-renders with the
    // PRE-insert caret still inside the inserted "/command" text — that
    // prefix is itself a valid slash trigger, which would keep the popover
    // open until the next interaction. Dismiss that phantom trigger's key;
    // the dismissal self-clears as soon as the trigger key changes.
    const lingeringTrigger = findSlashCommandTrigger(
      nextDraft,
      Math.min(selectionStart, nextDraft.length),
    );
    flushSync(() => {
      setSkillTokens(nextSkillTokens);
      setDraft(nextDraft);
      setActiveSlashIndex(0);
      setDismissedAutocompleteKey(
        lingeringTrigger
          ? `slash:${lingeringTrigger.start}:${lingeringTrigger.end}:/${lingeringTrigger.query}`
          : undefined,
      );
    });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  const applyDirectoryReference = (
    directory: Pick<NavigationDirectorySummary, "label" | "path">,
  ): void => {
    if (!inputRef.current) {
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    // Prefer replacing the `@` trigger the popover opened from; when the
    // reference arrives without one (the "+"-menu picker, or the trigger
    // vanished while an OS dialog was open) fall back to a zero-width
    // "trigger" at the current caret so the chip still lands in place.
    const refTrigger =
      findDirectoryReferenceTrigger(draft, selectionStart)
      ?? findDirectoryReferenceTrigger(draft, draft.length)
      ?? { start: selectionStart, end: selectionEnd };
    if (!directory.path) {
      return;
    }

    // Mint a durable mention token (the `@label` chip) instead of
    // splicing path text — mirrors applySkill. The chip is zero-width in
    // the plain draft; serializeDraftWithSkillTokens splices the markdown
    // link back in for the outgoing text and launchpad prompt. Like
    // applySkill, always leave one space after the chip and park the
    // caret after it.
    const before = draft.slice(0, refTrigger.start);
    const after = draft.slice(Math.max(refTrigger.end, selectionEnd));
    const nextAfter = /^\s/.test(after) ? after : ` ${after}`;
    const nextDraft = `${before}${nextAfter}`;
    const tokenIndex = before.length;
    const nextSelection = tokenIndex + 1;
    const nextSkillTokens = [
      ...adjustSkillTokenIndexesForTextChange({
        currentDraft: draft,
        nextDraft,
        skillTokens,
      }),
      createComposerDirectoryToken(directory, tokenIndex),
    ];

    // Same protected-update dance as applySkill: the editability sync in
    // ComposerTiptapInput re-emits the editor's (still pre-insert) content
    // through onChange before the external-value sync applies the new
    // draft. The pending-programmatic guard in handleComposerChange
    // swallows that stale replay so the two sides can't ping-pong.
    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: nextDraft,
      expectedSkillTokensSignature:
        getComposerSkillTokensSignature(nextSkillTokens),
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    flushSync(() => {
      setSkillTokens(nextSkillTokens);
      setDraft(nextDraft);
      setActiveDirectoryRefIndex(0);
    });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  /**
   * "@ → Add directory…" / "+"-menu action: run the OS picker (which also
   * registers the pick as a tracked directory, without navigating) and
   * mint the returned directory as a chip. The trigger is recomputed
   * inside `applyDirectoryReference` AFTER the dialog resolves, with a
   * caret fallback for the no-trigger paths.
   */
  const applyPickedDirectoryReference = async (): Promise<void> => {
    const picked = await props.onPickDirectoryForReference?.();
    if (!picked?.path) {
      return;
    }
    applyDirectoryReference(picked);
  };

  /**
   * Mint file-reference chips at the `@` trigger (or the caret when no
   * trigger survives) — the multi-token sibling of
   * `applyDirectoryReference`. The plain draft gets n-1 separator spaces
   * plus the guaranteed post-chip space, placing the n zero-width tokens
   * at consecutive indexes so the serialized draft reads
   * `chip␠chip␠…chip␠after` with exactly one space after every chip.
   */
  const applyFileReferences = (paths: string[]): void => {
    if (!inputRef.current || paths.length === 0) {
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    const refTrigger =
      findDirectoryReferenceTrigger(draft, selectionStart)
      ?? findDirectoryReferenceTrigger(draft, draft.length)
      ?? { start: selectionStart, end: selectionEnd };

    const before = draft.slice(0, refTrigger.start);
    const after = draft.slice(Math.max(refTrigger.end, selectionEnd));
    const nextAfter = /^\s/.test(after) ? after : ` ${after}`;
    const nextDraft = `${before}${" ".repeat(paths.length - 1)}${nextAfter}`;
    const nextSelection = before.length + paths.length;
    const nextSkillTokens = [
      ...adjustSkillTokenIndexesForTextChange({
        currentDraft: draft,
        nextDraft,
        skillTokens,
      }),
      ...paths.map((path, index) =>
        createComposerFileToken(
          { label: fileLabelFromPath(path), path },
          before.length + index,
        ),
      ),
    ];

    // Same protected-update dance as applySkill / applyDirectoryReference:
    // the editability sync in ComposerTiptapInput re-emits the editor's
    // (still pre-insert) content through onChange before the
    // external-value sync applies the new draft. The pending-programmatic
    // guard in handleComposerChange swallows that stale replay so the two
    // sides can't ping-pong.
    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: nextDraft,
      expectedSkillTokensSignature:
        getComposerSkillTokensSignature(nextSkillTokens),
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    flushSync(() => {
      setSkillTokens(nextSkillTokens);
      setDraft(nextDraft);
      setActiveDirectoryRefIndex(0);
    });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });

    // Feed the reference picker's Files tab — fire-and-forget.
    void props.desktopApi
      ?.recordRecentFileReferences?.({ paths })
      ?.catch(() => undefined);
  };

  /** "@ → Add file…" action: OS file picker → file-reference chips. */
  const applyPickedFileReferences = async (): Promise<void> => {
    const result = await props.desktopApi?.pickFileFromDisk?.();
    if (!result || result.canceled || result.paths.length === 0) {
      return;
    }
    applyFileReferences(result.paths);
  };

  /**
   * Mint directory-reference chips for a batch of picked directories —
   * the multi-token sibling of `applyDirectoryReference`, sharing
   * `applyFileReferences`' token layout (n-1 separator spaces plus the
   * guaranteed post-chip space). Needed because the single-directory
   * helper can't be called twice in one tick: each call captures the
   * pre-insert draft, so the second insert would clobber the first.
   */
  const applyDirectoryReferenceChips = (
    directories: { label: string; path: string }[],
  ): void => {
    if (!inputRef.current || directories.length === 0) {
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    const refTrigger =
      findDirectoryReferenceTrigger(draft, selectionStart)
      ?? findDirectoryReferenceTrigger(draft, draft.length)
      ?? { start: selectionStart, end: selectionEnd };

    const before = draft.slice(0, refTrigger.start);
    const after = draft.slice(Math.max(refTrigger.end, selectionEnd));
    const nextAfter = /^\s/.test(after) ? after : ` ${after}`;
    const nextDraft = `${before}${" ".repeat(directories.length - 1)}${nextAfter}`;
    const nextSelection = before.length + directories.length;
    const nextSkillTokens = [
      ...adjustSkillTokenIndexesForTextChange({
        currentDraft: draft,
        nextDraft,
        skillTokens,
      }),
      ...directories.map((directory, index) =>
        createComposerDirectoryToken(directory, before.length + index),
      ),
    ];

    // Same protected-update dance as applySkill / applyDirectoryReference:
    // the editability sync in ComposerTiptapInput re-emits the editor's
    // (still pre-insert) content through onChange before the
    // external-value sync applies the new draft. The pending-programmatic
    // guard in handleComposerChange swallows that stale replay so the two
    // sides can't ping-pong.
    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: nextDraft,
      expectedSkillTokensSignature:
        getComposerSkillTokensSignature(nextSkillTokens),
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    flushSync(() => {
      setSkillTokens(nextSkillTokens);
      setDraft(nextDraft);
      setActiveDirectoryRefIndex(0);
    });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  /**
   * Combined "+ Add file or directory…" picker (macOS only): one OS
   * dialog returns a mix of files and directories. Files land in the
   * attachment tray (the "+ flow attaches" rule); directories are
   * registered as tracked directories (non-fatal — the send-time attach
   * re-registers anyway) and minted as reference chips. The tray attach
   * runs first because it snapshots the current draft, which the chip
   * mint is about to rewrite.
   */
  const applyPickedReferencesFromDisk = async (): Promise<void> => {
    const result = await props.desktopApi?.pickReferenceFromDisk?.();
    if (!result || result.canceled || result.entries.length === 0) {
      return;
    }
    const filePaths = result.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path);
    const directoryPaths = result.entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.path);
    if (filePaths.length > 0) {
      attachFilePaths(filePaths);
    }
    for (const directoryPath of directoryPaths) {
      void props.desktopApi
        ?.registerDirectoryFromDisk?.({ path: directoryPath })
        ?.then((response) => {
          if (response && !response.ok) {
            console.warn(
              `Could not register picked directory ${directoryPath}: ${response.message}`,
            );
          }
        })
        .catch(() => undefined);
    }
    if (directoryPaths.length > 0) {
      applyDirectoryReferenceChips(
        directoryPaths.map((directoryPath) => ({
          label: fileLabelFromPath(directoryPath),
          path: directoryPath,
        })),
      );
    }
  };

  /**
   * Load the reference picker's Files tab from the main process. Called
   * on every picker open; failures keep the previous list — recents are
   * a convenience surface, not load-bearing.
   */
  const refreshRecentFileReferences = async (): Promise<void> => {
    try {
      const response = await props.desktopApi?.listRecentFileReferences?.();
      setRecentFileReferences(response?.files ?? []);
    } catch {
      // Keep whatever list we had.
    }
  };

  const removeImageAttachment = (id: string): void => {
    setImageAttachments((current) => {
      const nextAttachments = current.filter((attachment) => attachment.id !== id);
      saveComposerDraftSnapshot(composerScopeKey, {
        draft,
        editorDocument,
        imageAttachments: nextAttachments,
        fileAttachments,
        skillTokens,
      });
      persistLaunchpadImageAttachments(nextAttachments);
      return nextAttachments;
    });
  };

  const removeFileAttachment = (id: string): void => {
    setFileAttachments((current) => {
      const nextAttachments = current.filter((attachment) => attachment.id !== id);
      saveComposerDraftSnapshot(composerScopeKey, {
        draft,
        editorDocument,
        imageAttachments,
        fileAttachments: nextAttachments,
        skillTokens,
      });
      persistLaunchpadImageAttachments(imageAttachments, nextAttachments);
      return nextAttachments;
    });
  };

  const persistLaunchpadImageAttachments = (
    attachments: ComposerImageAttachment[],
    files: ComposerFileAttachment[] = fileAttachments,
  ): void => {
    if (!props.launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    void props.onUpdateLaunchpad(props.launchpad.directoryKey, {
      imageAttachments: attachments.length > 0 ? attachments : undefined,
      fileAttachments: files.length > 0 ? files : undefined,
      prompt: canonicalDraft,
    });
  };

  const showComposerNotice = (notice: Omit<AppNoticeToastNotice, "id">): void => {
    props.onShowNotice?.({
      id: `composer-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...notice,
    });
  };

  /**
   * Apply image-support + attachment-limit policy to a freshly pasted/dropped
   * batch. Returns the subset that should be attached, or `null` to reject the
   * whole batch. Surfaces a toast for every rejection (non-vision model) and
   * whenever the per-message limit clamps or blocks the batch.
   */
  const gateImageFilesForAttachment = (
    files: ComposerImageFile[],
  ): ComposerImageFile[] | null => {
    if (!imagesSupported) {
      showComposerNotice({
        title: "Images not supported",
        message: `${imagesUnsupportedLabel} doesn't support image attachments.`,
      });
      return null;
    }

    const remaining = MAX_COMPOSER_IMAGE_ATTACHMENTS - imageAttachments.length;
    if (remaining <= 0) {
      showComposerNotice({
        title: "Attachment limit reached",
        message: `You can attach up to ${MAX_COMPOSER_IMAGE_ATTACHMENTS} images per message.`,
      });
      return null;
    }

    if (files.length > remaining) {
      showComposerNotice({
        title: "Attachment limit reached",
        message: `You can attach up to ${MAX_COMPOSER_IMAGE_ATTACHMENTS} images per message.`,
      });
      return files.slice(0, remaining);
    }

    return files;
  };

  /**
   * Add path-only file attachments to the tray. Shared by drop/paste
   * (after `attachFiles` resolves each File's path) and the "+"-menu
   * "Add file…" picker (which already has paths). Dedupes against the
   * pills already in the tray, caps the total, and persists the snapshot.
   * Toasts once per batch when the cap clamps it.
   */
  const attachFilePaths = (paths: string[]): void => {
    const resolved: ComposerFileAttachment[] = [];
    const seenPaths = new Set(fileAttachments.map((attachment) => attachment.path));
    for (const path of paths) {
      if (!path || seenPaths.has(path)) {
        continue;
      }
      seenPaths.add(path);
      resolved.push({
        id: `${path}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        label: fileLabelFromPath(path),
        path,
      });
    }
    if (resolved.length === 0) {
      return;
    }

    const remaining = MAX_COMPOSER_FILE_ATTACHMENTS - fileAttachments.length;
    if (resolved.length > remaining) {
      showComposerNotice({
        title: "Attachment limit reached",
        message: `You can attach up to ${MAX_COMPOSER_FILE_ATTACHMENTS} files per message.`,
      });
    }
    const accepted = resolved.slice(0, Math.max(0, remaining));
    if (accepted.length === 0) {
      return;
    }

    const nextAttachments = [...fileAttachments, ...accepted];
    setFileAttachments(nextAttachments);
    saveComposerDraftSnapshot(composerScopeKey, {
      draft,
      editorDocument,
      imageAttachments,
      fileAttachments: nextAttachments,
      skillTokens,
    });
    persistLaunchpadImageAttachments(imageAttachments, nextAttachments);

    // Feed the reference picker's Files tab — fire-and-forget.
    void props.desktopApi
      ?.recordRecentFileReferences?.({
        paths: accepted.map((attachment) => attachment.path),
      })
      ?.catch(() => undefined);
  };

  /**
   * Turn dropped/pasted non-image Files into path-only file attachments.
   * Resolves each path via Electron's webUtils bridge (contents are never
   * read) and hands off to `attachFilePaths` for dedupe/cap/persist.
   * Toasts once per batch for unresolvable paths.
   */
  const attachFiles = (files: File[]): void => {
    let unresolvedCount = 0;
    const paths: string[] = [];
    for (const file of files) {
      const path = props.desktopApi?.getPathForFile?.(file) ?? "";
      if (!path) {
        unresolvedCount += 1;
        continue;
      }
      paths.push(path);
    }

    if (unresolvedCount > 0) {
      showComposerNotice({
        title: "File path unavailable",
        message: "Could not resolve a path for the dropped file.",
      });
    }
    attachFilePaths(paths);
  };

  /** "+"-menu "Add file…" action: OS file picker → tray pills. */
  const attachPickedFilesToTray = async (): Promise<void> => {
    const result = await props.desktopApi?.pickFileFromDisk?.();
    if (!result || result.canceled || result.paths.length === 0) {
      return;
    }
    attachFilePaths(result.paths);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>): void => {
    const pastedFiles = getImageFilesFromDataTransfer(event.clipboardData);
    // Non-image FILES only (kind === "file" items) — plain text paste
    // must fall through to the editor untouched.
    const pastedNonImageFiles = getNonImageFilesFromDataTransfer(
      event.clipboardData,
    );
    if (pastedFiles.length === 0 && pastedNonImageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setSendError(undefined);
    if (pastedNonImageFiles.length > 0) {
      attachFiles(pastedNonImageFiles);
    }
    if (pastedFiles.length === 0) {
      return;
    }
    const accepted = gateImageFilesForAttachment(pastedFiles);
    if (!accepted || accepted.length === 0) {
      return;
    }
    void attachImages(accepted);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasAnyFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    const droppedFiles = getImageFilesFromDataTransfer(event.dataTransfer);
    const droppedNonImageFiles = getNonImageFilesFromDataTransfer(
      event.dataTransfer,
    );
    if (droppedFiles.length === 0 && droppedNonImageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setSendError(undefined);
    if (droppedNonImageFiles.length > 0) {
      attachFiles(droppedNonImageFiles);
    }
    if (droppedFiles.length === 0) {
      return;
    }
    const accepted = gateImageFilesForAttachment(droppedFiles);
    if (!accepted || accepted.length === 0) {
      return;
    }
    void attachImages(accepted);
  };

  const attachImages = async (files: ComposerImageFile[]): Promise<void> => {
    const pasteScope = pasteScopeRef.current;
    const pasteDraft = draft;
    const pasteEditorDocument = editorDocument;
    const pasteImageAttachments = imageAttachments;
    const pasteFileAttachments = fileAttachments;

    try {
      const nextAttachments = await Promise.all(
        files.map(async ({ file, type }, index) => {
          const fallbackName = formatPastedImageName(type, index);
          if (isGifFile(file, type)) {
            // GIFs skip normalization (to preserve animation), so they have no
            // measured dimensions — the card shows only the size chip for them.
            return {
              id: `pasted-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
              name: file.name || fallbackName,
              size: file.size,
              type: "image/gif",
              url: await readFileAsImageDataUrl(file, "image/gif"),
            };
          }

          const normalized = await normalizeImageFile(file, {
            fallback: props.desktopApi?.normalizeImageForUpload,
            maxPatchCount: props.pastedImageMaxPatches,
            sourceMimeType: type,
          });
          void props.desktopApi?.recordImageUploadNormalization?.({
            fileName: file.name || fallbackName,
            original: {
              height: normalized.original.height,
              mimeType: normalized.original.mimeType,
              size: normalized.original.size,
              width: normalized.original.width,
            },
            normalized: {
              height: normalized.height,
              mimeType: normalized.mimeType,
              size: normalized.size,
              width: normalized.width,
            },
            path: normalized.conversionPath,
            resized:
              normalized.original.width !== normalized.width ||
              normalized.original.height !== normalized.height,
          });
          return {
            id: `pasted-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || fallbackName,
            size: normalized.size,
            type: normalized.mimeType,
            url: normalized.dataUrl,
            width: normalized.width,
            height: normalized.height,
          };
        })
      );

      if (activeComposerScopeKeyRef.current !== pasteScope.key) {
        const saved = draftStore.get(pasteScope.key) ?? {
          draft: pasteDraft,
          editorDocument: pasteEditorDocument,
          imageAttachments: pasteImageAttachments,
          fileAttachments: pasteFileAttachments,
          skillTokens,
        };
        // Drop exact duplicates against the background scope's own attachments
        // (no toast — this composer isn't the one on screen).
        const { unique } = partitionNewImageAttachments(
          saved.imageAttachments,
          nextAttachments,
          getImageSignature,
        );
        const nextSnapshot = {
          draft: saved.draft,
          editorDocument: saved.editorDocument,
          imageAttachments: [...saved.imageAttachments, ...unique].slice(
            0,
            MAX_COMPOSER_IMAGE_ATTACHMENTS,
          ),
          fileAttachments: saved.fileAttachments,
          skillTokens: saved.skillTokens,
        };
        saveComposerDraftSnapshot(pasteScope.key, nextSnapshot);
        persistLaunchpadDraftSnapshot(pasteScope.key, nextSnapshot);
        return;
      }

      // Reject exact-duplicate pastes so the same image can't stack up. Toast
      // off the snapshot captured when this paste started — accurate for the
      // sequential paste-the-same-image case — then re-check inside the state
      // updater below against the freshest list for the rare paste race.
      const { unique, duplicateCount } = partitionNewImageAttachments(
        pasteImageAttachments,
        nextAttachments,
        getImageSignature,
      );
      if (duplicateCount > 0) {
        showComposerNotice({
          title: "Image already attached",
          message:
            duplicateCount === 1
              ? "That image is already attached to this message."
              : `${duplicateCount} of those images are already attached to this message.`,
        });
      }
      if (unique.length === 0) {
        return;
      }

      setImageAttachments((current) => {
        // Re-run de-dup and the cap against the latest state (not the snapshot
        // captured when this paste began) so a second identical paste arriving
        // while an earlier one is still normalizing can never slip a duplicate
        // through or exceed the limit.
        const { unique: freshlyUnique } = partitionNewImageAttachments(
          current,
          unique,
          getImageSignature,
        );
        const mergedAttachments = [...current, ...freshlyUnique].slice(
          0,
          MAX_COMPOSER_IMAGE_ATTACHMENTS,
        );
        // Read file pills from the latest snapshot ref, not the paste-time
        // closure — a mixed drop attaches files synchronously before this
        // async image path lands, and the stale list would wipe them.
        const latestFileAttachments =
          latestDraftSnapshotRef.current.snapshot.fileAttachments ??
          pasteFileAttachments;
        const nextSnapshot = {
          draft,
          editorDocument,
          imageAttachments: mergedAttachments,
          fileAttachments: latestFileAttachments,
          skillTokens,
        };
        saveComposerDraftSnapshot(pasteScope.key, nextSnapshot);
        persistLaunchpadImageAttachments(mergedAttachments, latestFileAttachments);
        return mergedAttachments;
      });
    } catch (error) {
      if (activeComposerScopeKeyRef.current !== pasteScope.key) {
        return;
      }

      setSendError(
        error instanceof Error ? error.message : "The pasted image could not be read."
      );
    }
  };

  const handleLaunchpadPatch = (
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "workMode"
        | "acpRuntime"
        | "branchName"
        | "codexEnvironmentId"
        | "codexEnvironmentExecutionTarget"
        | "codexEnvironmentActionId"
      >
    >
  ): void => {
    if (!props.launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    setSendError(undefined);
    void props.onUpdateLaunchpad(
      props.launchpad.directoryKey,
      {
        imageAttachments:
          imageAttachments.length > 0 ? imageAttachments : undefined,
        fileAttachments:
          fileAttachments.length > 0 ? fileAttachments : undefined,
        prompt: canonicalDraft,
        ...patch,
      },
      {
        stickySettingsChanged: true,
      },
    );
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  };

  const runThreadCodexEnvironmentAction = async (): Promise<void> => {
    if (
      !props.thread ||
      !props.desktopApi?.runCodexEnvironmentAction ||
      !selectedThreadCodexAction ||
      !currentThreadEnvActionStartingKey
    ) {
      return;
    }

    const thread = props.thread;
    const action = selectedThreadCodexAction;
    const startingKey = currentThreadEnvActionStartingKey;
    const cwd = workspaceOpenPath;
    setSendError(undefined);
    props.onPendingStatusChange?.(`Starting ${action.name}`);
    showThreadEnvActionStarting(startingKey);
    const startedAt = Date.now();
    let actionStarted = false;
    try {
      await props.desktopApi.runCodexEnvironmentAction({
        backend: thread.source,
        threadId: thread.id,
        actionId: action.id,
        ...(cwd ? { cwd } : {}),
      });
      actionStarted = true;
      finishThreadEnvActionStarting(startingKey, Date.now() - startedAt);
      await props.onRefreshNavigation?.();
    } catch (error) {
      if (!actionStarted) {
        clearThreadEnvActionStarting(startingKey);
      }
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      props.onPendingStatusChange?.(undefined);
    }
  };

  const setThreadCodexEnvironment = async (
    environmentId?: string,
    actionId?: string,
  ): Promise<void> => {
    if (
      !props.thread ||
      !props.desktopApi?.setCodexThreadEnvironment
    ) {
      return;
    }

    setSendError(undefined);
    props.onPendingStatusChange?.(
      environmentId ? "Selecting environment" : "Clearing environment",
    );
    try {
      await props.desktopApi.setCodexThreadEnvironment({
        backend: props.thread.source,
        threadId: props.thread.id,
        environmentId,
        actionId,
      });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      props.onPendingStatusChange?.(undefined);
    }
  };

  const applyExecutionModeSelection = (
    executionMode: ThreadExecutionMode,
  ): void => {
    if (props.launchpad) {
      if (props.launchpad.executionMode !== executionMode) {
        handleLaunchpadPatch({ executionMode });
      }
      return;
    }

    if (
      props.thread &&
      props.thread.executionMode !== executionMode &&
      !props.updatingExecutionMode
    ) {
      setSendError(undefined);
      void props.onSetExecutionMode?.(executionMode);
    }
  };

  const requestExecutionModeSelection = (
    executionMode: ThreadExecutionMode,
  ): void => {
    const currentExecutionMode =
      props.launchpad?.executionMode ?? props.thread?.executionMode ?? "default";
    if (
      currentExecutionMode === "default" &&
      executionMode === "full-access" &&
      !props.fullAccessRiskWarningDismissed
    ) {
      setFullAccessRiskDontWarnAgain(false);
      setFullAccessRiskError(undefined);
      setFullAccessRiskDialogOpen(true);
      return;
    }

    applyExecutionModeSelection(executionMode);
  };

  const confirmFullAccessRisk = async (): Promise<void> => {
    setFullAccessRiskSaving(true);
    setFullAccessRiskError(undefined);
    try {
      if (fullAccessRiskDontWarnAgain) {
        await props.onDismissFullAccessRiskWarning?.();
      }
      setFullAccessRiskDialogOpen(false);
      applyExecutionModeSelection("full-access");
    } catch (error) {
      setFullAccessRiskError(error instanceof Error ? error.message : String(error));
    } finally {
      setFullAccessRiskSaving(false);
    }
  };

  const handleThreadModelSettingsPatch = (
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ): void => {
    if (!props.thread || !props.onSetThreadModelSettings) {
      return;
    }

    setSendError(undefined);
    void props.onSetThreadModelSettings(patch);
  };

  const currentSettings = props.launchpad ?? props.thread;
  const modelOptions = backend?.launchpadOptions?.models ?? [];
  const selectedModelOption =
    modelOptions.find((option) => option.id === currentSettings?.model) ??
    getDefaultModelOption(backend);
  // Image attachments are allowed unless the active model explicitly reports
  // no image support (Codex Spark) or the ACP agent advertises
  // `prompt.image: false`. `undefined` on either signal means "assume
  // supported" so existing backends keep working.
  const imagesSupported =
    selectedModelOption?.supportsImage !== false &&
    backend?.acp?.runtime?.agentCapabilities?.prompt?.image !== false;
  const imagesUnsupportedLabel =
    selectedModelOption?.label ?? currentSettings?.model ?? "This mode";
  const supportsReasoning =
    selectedModelOption?.supportsReasoning ??
    Boolean(backend?.launchpadOptions?.reasoningEfforts?.length);
  const selectedReasoningEffort = supportsReasoning
    ? getReasoningEffortValue(
        backend,
        selectedModelOption,
        currentSettings?.reasoningEffort,
      )
    : undefined;
  const supportsFast =
    backend?.kind === "codex"
      ? selectedModelOption?.supportsFast ??
        backend.launchpadOptions?.supportsFastMode ??
        false
      : false;
  const selectedServiceTier =
    currentSettings?.serviceTier ?? backend?.launchpadOptions?.serviceTiers?.[0];
  const acpRuntimeModeControl = getAcpRuntimeModeControl(backend, currentSettings);
  const providerOptions =
    props.backends?.filter(
      (candidate) => candidate.available && candidate.capabilities.createThread
    ) ?? [];
  const availableExecutionModes =
    backend?.executionModes.filter((mode) => mode.available) ?? [];
  const workspaceLabel = formatThreadWorkspaceLabel(props.thread);
  const supportsPlanMode =
    (props.launchpad?.backend ?? props.thread?.source) === "codex";
  const supportsSteering =
    Boolean(backend?.capabilities.steerTurn) &&
    selectedModelOption?.supportsSteering !== false &&
    props.thread?.source !== "grok";
  const launchpadSubmitting = isLaunchpad && sending;
  const fiveHourResetAt = getFiveHourRateLimitResetAt({
    backend,
    now: scheduleTick,
    selectedModelOption,
  });
  const scheduledSendOptions: ScheduledSendMenuOption[] = [
    ...SCHEDULED_SEND_OPTIONS.map((option) => ({
      delayMs: option.delayMs,
      label: option.label,
    })),
    ...(fiveHourResetAt
      ? [
          {
            label: `Send in ${formatScheduledSendCountdown(
              fiveHourResetAt,
              scheduleTick,
            )} (5h context reset)`,
            scheduledSendAt: fiveHourResetAt,
          },
        ]
      : []),
  ];
  const sendButtonDisabled =
    props.disabled ||
    steering ||
    (!activeTurnId && sending) ||
    (!hasComposerContent &&
      imageAttachments.length === 0 &&
      fileAttachments.length === 0);
  const scheduleButtonDisabled =
    sendButtonDisabled ||
    Boolean(props.launchpad) ||
    !props.thread ||
    isCompactCommand;
  // Only surface the schedule caret where scheduling actually applies. In the
  // launchpad, compact command, or a thread-less composer there is nothing to
  // schedule, so the split collapses to a plain Send pill instead of parking a
  // permanently-dimmed half-button next to it.
  const scheduleAffordanceVisible =
    Boolean(props.thread) && !props.launchpad && !isCompactCommand;
  // A pending draft schedule (e.g. after editing a scheduled item) surfaces as
  // a checkable toggle between the caret and Send rather than hijacking the
  // Send label into a countdown. Armed → Send keeps the schedule; unarmed →
  // Send fires now. The toggle only shows where scheduling applies — and never
  // while the review-config panel is open, since that panel owns its own
  // scheduled-send button and doesn't read `scheduleArmed`; showing the toggle
  // there would let an operator "uncheck" a schedule the review submit ignores.
  const scheduleToggleVisible =
    scheduleAffordanceVisible
    && Boolean(futureScheduledDraftSendAt)
    && !isReviewComposerOpen;
  const effectiveScheduledSendAt = scheduleArmed
    ? futureScheduledDraftSendAt
    : undefined;
  const submitButtonLabel =
    activeTurnId || serverQueuedTurnEntryId || props.threadBusy
      ? "Queue"
      : sending
        ? props.launchpad
          ? "Starting…"
          : "Sending…"
        : props.launchpad
          ? "Start thread"
          : "Send";
  const launchpadWorkspaceOptions = props.launchpad
    ? buildLaunchpadWorkspaceOptions(props.launchpad, props.directory)
    : [];
  const launchpadWorkspaceValue =
    props.launchpad &&
    launchpadWorkspaceOptions.some((option) => option.value === props.launchpad?.workMode)
      ? props.launchpad.workMode
      : "local";
  // Pure function of the launchpad draft + directory git status; memoize so
  // typing in the prompt (which re-renders the composer) doesn't rebuild the
  // branch option list every keystroke.
  const launchpadBranchPickerOptions = useMemo(
    () =>
      props.launchpad
        ? buildLaunchpadBranchPickerOptions(props.launchpad, props.directory)
        : [],
    [props.launchpad, props.directory],
  );
  const launchpadCodexEnvironmentOptions =
    props.launchpad?.codexEnvironmentOptions ?? [];
  const selectedCodexEnvironment = launchpadCodexEnvironmentOptions.find(
    (environment) => environment.id === props.launchpad?.codexEnvironmentId,
  );
  const threadCodexEnvironmentOptions =
    props.thread?.codexEnvironmentOptions ?? [];
  const selectedThreadCodexEnvironmentOption = threadCodexEnvironmentOptions.find(
    (environment) =>
      environment.id === props.thread?.codexEnvironmentRuntime?.environmentId,
  );
  const runtimeThreadCodexEnvironmentActions =
    props.thread?.codexEnvironmentRuntime?.actions ?? [];
  const threadCodexEnvironmentActions =
    runtimeThreadCodexEnvironmentActions.length > 0
      ? runtimeThreadCodexEnvironmentActions
      : selectedThreadCodexEnvironmentOption?.actions ?? [];
  const selectedThreadCodexEnvironmentForAction =
    selectedThreadCodexEnvironmentOption ??
    (props.thread?.codexEnvironmentRuntime
      ? {
          id: props.thread.codexEnvironmentRuntime.environmentId,
          name: props.thread.codexEnvironmentRuntime.environmentName,
          sourcePath: props.thread.codexEnvironmentRuntime.sourcePath ?? "",
          actions: threadCodexEnvironmentActions,
        }
      : undefined);
  const selectedThreadCodexActionId = resolveSelectedCodexEnvironmentActionId({
    environment: selectedThreadCodexEnvironmentForAction,
    actionId:
      props.thread?.codexEnvironmentRuntime?.selectedActionIdByEnvironmentId?.[
        props.thread.codexEnvironmentRuntime.environmentId
      ],
    actionIdByEnvironmentId:
      props.thread?.codexEnvironmentRuntime?.selectedActionIdByEnvironmentId,
  });
  const selectedThreadCodexAction =
    threadCodexEnvironmentActions.find(
      (action) => action.id === selectedThreadCodexActionId,
    ) ?? threadCodexEnvironmentActions[0];
  const currentThreadEnvActionStartingKey =
    props.thread && selectedThreadCodexAction
      ? {
          actionId: selectedThreadCodexAction.id,
          backend: props.thread.source,
          threadId: props.thread.id,
        }
      : undefined;
  const currentThreadEnvActionStarting = sameThreadEnvActionStartingKey(
    threadEnvActionStarting,
    currentThreadEnvActionStartingKey,
  );
  const threadWorkspace = props.thread ? getThreadWorkspace(props.thread) : undefined;
  const workspaceOpenPath = getComposerWorkspaceOpenPath({
    directory: props.directory,
    launchpad: props.launchpad,
    threadWorkspace,
  });
  const editorApplication = props.applications?.editors.find(
    (application) =>
      application.canOpenWorkspace &&
      application.id === props.applications?.preferredEditorId.value,
  ) ?? props.applications?.editors.find(
    (application) => application.canOpenWorkspace,
  );
  const terminalApplication = props.applications?.terminals.find(
    (application) =>
      application.canOpenWorkspace &&
      application.id === props.applications?.preferredTerminalId.value,
  ) ?? props.applications?.terminals.find(
    (application) => application.canOpenWorkspace,
  );
  const sourceBranch =
    threadWorkspace?.mode === "worktree"
      ? props.thread?.observedGitBranch ??
        props.thread?.gitBranch ??
        props.directory?.gitStatus?.currentBranch
      : props.directory?.gitStatus?.currentBranch ??
        props.thread?.observedGitBranch ??
        props.thread?.gitBranch;
  const branchOptions = getLeaveLocalBranchOptions({
    currentBranch: sourceBranch,
    directory: props.directory,
  });
  const canHandoffThreadWorkspace = Boolean(
    props.thread &&
      threadWorkspace &&
      isThreadWorkspaceHandoffEligible({ sourceBranch, threadWorkspace }) &&
      props.onHandoffThreadWorkspace &&
      props.thread.workspaceHandoff?.available !== false &&
      !sending &&
      !activeTurnId &&
      !serverQueuedTurnEntryId &&
      !props.pendingRequestActive &&
      !props.pendingUserInputActive &&
      !handoffSubmitting
  );

  useEffect(() => {
    if (activeTurnId) {
      setWorkspaceMenuOpen(false);
    }
  }, [activeTurnId]);

  const openHandoffDialog = (
    direction: HandoffThreadWorkspaceRequest["direction"]
  ): void => {
    setWorkspaceMenuOpen(false);
    setHandoffError(undefined);
    setHandoffDialog(direction);
    if (direction === "local-to-worktree") {
      setLocalHandoffStrategy("detached-changes");
      setLeaveLocalBranch(branchOptions[0] ?? "");
      setNewLocalBranch(buildHandoffBranchSuggestion(sourceBranch));
    }
  };

  const submitHandoff = async (): Promise<void> => {
    if (!threadWorkspace || !props.onHandoffThreadWorkspace) {
      return;
    }

    setHandoffSubmitting(true);
    setHandoffError(undefined);
    try {
      const handoffStrategy =
        handoffDialog === "local-to-worktree"
          ? localHandoffStrategy
          : undefined;
      await props.onHandoffThreadWorkspace({
        direction: handoffDialog!,
        ...(handoffStrategy ? { strategy: handoffStrategy } : {}),
        repositoryPath: threadWorkspace.repositoryPath,
        sourcePath: threadWorkspace.sourcePath,
        sourceBranch,
        ...(handoffDialog === "local-to-worktree" && handoffStrategy === "move-branch"
          ? { leaveLocalBranch: leaveLocalBranch || undefined }
          : {}),
        ...(handoffDialog === "local-to-worktree" && handoffStrategy === "new-branch"
          ? { newBranchName: newLocalBranch || undefined }
          : {}),
      });
      setHandoffDialog(undefined);
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandoffSubmitting(false);
    }
  };

  const openWorkspaceApplication = async (
    application: DesktopApplicationDiscoveryCandidate,
  ): Promise<void> => {
    if (!props.desktopApi?.openApplication) {
      setApplicationOpenError("Desktop bridge is missing openApplication().");
      return;
    }
    if (!workspaceOpenPath) {
      setApplicationOpenError("No workspace path is available for this thread.");
      return;
    }

    setApplicationOpenError(undefined);
    try {
      await props.desktopApi.openApplication({
        applicationId: application.id,
        kind: application.kind,
        targetPath: workspaceOpenPath,
      });
    } catch (error) {
      setApplicationOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  const handoffDisabled =
    handoffSubmitting ||
    !sourceBranch ||
    (handoffDialog === "local-to-worktree" &&
      ((localHandoffStrategy === "move-branch" && !leaveLocalBranch) ||
        (localHandoffStrategy === "new-branch" && !newLocalBranch.trim())));

  const commitActiveAutocomplete = (): void => {
    if (autocompleteKind === "skills") {
      applySkill(filteredSkills[activeSkillIndex] ?? filteredSkills[0]!);
      return;
    }

    if (autocompleteKind === "directories") {
      applyDirectoryReference(
        filteredDirectoryRefs[activeDirectoryRefIndex] ?? filteredDirectoryRefs[0]!,
      );
      return;
    }

    const currentSlashText = slashTrigger
      ? `/${slashTrigger.query}`.toLowerCase()
      : undefined;
    const exactSlashCommand = currentSlashText
      ? filteredSlashCommands.find((command) =>
          slashCommandMatchesText(command, currentSlashText)
        )
      : undefined;
    applySlashCommand(
      exactSlashCommand ??
        filteredSlashCommands[activeSlashIndex] ??
        filteredSlashCommands[0]!
    );
  };

  const runSlashCommand = (command: SlashCommandSuggestion): boolean => {
    if (command.id === "review-current") {
      enterReviewComposer();
      return true;
    }

    if (command.label.toLowerCase() === "/compact") {
      void submitCompactThread();
      return true;
    }

    return false;
  };

  const getActiveSlashCommand = (): SlashCommandSuggestion | undefined => {
    if (autocompleteKind !== "slash") {
      return undefined;
    }

    const currentSlashText = slashTrigger
      ? `/${slashTrigger.query}`.toLowerCase()
      : undefined;
    return (
      (currentSlashText
        ? filteredSlashCommands.find((candidate) =>
            slashCommandMatchesText(candidate, currentSlashText)
          )
        : undefined) ??
      filteredSlashCommands[activeSlashIndex] ??
      filteredSlashCommands[0]
    );
  };

  const restoreDeletedSkillToken = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): boolean => {
    if (
      event.key.toLowerCase() !== "z" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.shiftKey ||
      deletedSkillTokenHistoryRef.current.length === 0
    ) {
      return false;
    }

    const previous = deletedSkillTokenHistoryRef.current.pop()!;
    event.preventDefault();
    setDraft(previous.draft);
    setSkillTokens(previous.skillTokens);
    setEditorDocument(undefined);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(
        previous.selectionStart,
        previous.selectionStart,
      );
    });
    return true;
  };

  const handleAutocompleteKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (!hasAutocomplete && event.key !== "Escape") {
      return;
    }

    const updateActiveAutocompleteIndex = (
      updater: (current: number) => number,
    ): void => {
      if (autocompleteKind === "skills") {
        setActiveSkillIndex(updater);
      } else if (autocompleteKind === "directories") {
        setActiveDirectoryRefIndex(updater);
      } else {
        setActiveSlashIndex(updater);
      }
    };

    const getAutocompletePageStep = (): number => {
      const list = autocompleteListRef.current;
      const option = autocompleteOptionRefs.current.find(Boolean);
      const optionHeight = option?.getBoundingClientRect().height ?? 0;
      if (list && optionHeight > 0) {
        return Math.max(1, Math.floor(list.clientHeight / optionHeight));
      }
      return Math.max(1, Math.min(6, autocompleteLength - 1));
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      updateActiveAutocompleteIndex((current) =>
        Math.min(current + 1, autocompleteLength - 1)
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      updateActiveAutocompleteIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "PageDown") {
      event.preventDefault();
      const pageStep = getAutocompletePageStep();
      updateActiveAutocompleteIndex((current) =>
        Math.min(current + pageStep, autocompleteLength - 1)
      );
      return;
    }

    if (event.key === "PageUp") {
      event.preventDefault();
      const pageStep = getAutocompletePageStep();
      updateActiveAutocompleteIndex((current) => Math.max(current - pageStep, 0));
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (autocompleteKey) {
        setDismissedAutocompleteKey(autocompleteKey);
      }
      setActiveSkillIndex(0);
      setActiveSlashIndex(0);
      setActiveDirectoryRefIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    const optionHasFocus = event.currentTarget instanceof HTMLButtonElement;
    if (
      (event.key === "Tab" && !event.shiftKey) ||
      event.key === "Enter" ||
      (event.key === " " && optionHasFocus)
    ) {
      if (event.key === "Enter" && event.shiftKey) {
        return;
      }
      event.preventDefault();
      const slashCommand =
        event.key === "Enter" && autocompleteKind === "slash"
          ? getActiveSlashCommand()
          : undefined;
      if (
        slashCommand &&
        runSlashCommand(slashCommand)
      ) {
        return;
      }
      commitActiveAutocomplete();
    }
  };

  const composerDisabled =
    launchpadSubmitting || (props.disabled && !hasComposerContent);
  const composerPlaceholder = isLaunchpad
    ? `Start a new thread in ${props.launchpad?.directoryLabel ?? "this directory"}`
    : "Reply to this thread";
  const handleComposerChange = (
    nextDraft: string,
    nextSkillTokens?: ComposerSkillToken[],
    metadata?: ComposerInputChangeMetadata,
  ): void => {
    if (!recoveringDraftRef.current) {
      recoveryCycleRef.current = undefined;
      recoveryEligibilityVersionRef.current += 1;
    }
    unmarkComposerDraftSubmitted(composerScopeKey);
    const pendingProgrammaticChange =
      pendingProgrammaticComposerChangeRef.current;
    if (pendingProgrammaticChange && nextSkillTokens) {
      const nextSkillTokensSignature =
        getComposerSkillTokensSignature(nextSkillTokens);
      if (
        nextDraft === pendingProgrammaticChange.staleDraft &&
        nextSkillTokensSignature ===
          pendingProgrammaticChange.staleSkillTokensSignature
      ) {
        return;
      }
      pendingProgrammaticComposerChangeRef.current = undefined;
    }

    const deletedSkillTokenHistoryEntry =
      nextSkillTokens &&
      nextSkillTokens.length < skillTokens.length
        ? (() => {
            const nextTokenIds = new Set(
              nextSkillTokens.map((token) => token.id),
            );
            const deletedToken = skillTokens.find(
              (token) => !nextTokenIds.has(token.id),
            );
            return deletedToken
              ? {
                  draft,
                  selectionStart: deletedToken.index,
                  skillTokens,
                }
              : undefined;
          })()
        : undefined;
    const storedSkillTokens = nextSkillTokens ?? skillTokens;
    const preserveRecoveryCycle =
      !recoveringDraftRef.current &&
      recoveryCycleRef.current?.candidates.some(
        (candidate) =>
          getComposerDraftSnapshotSignature(candidate) ===
          getComposerDraftSnapshotSignature({
            draft: nextDraft,
            editorDocument: metadata?.editorDocument,
            imageAttachments,
            fileAttachments,
            skillTokens: storedSkillTokens,
          }),
      ) === true;

    updateVisibleDraft(nextDraft, nextSkillTokens, { preserveRecoveryCycle });
    setEditorDocument(metadata?.editorDocument);
    saveComposerDraftSnapshot(composerScopeKey, {
      draft: nextDraft,
      editorDocument: metadata?.editorDocument,
      imageAttachments,
      fileAttachments,
      skillTokens: storedSkillTokens,
    });
    if (deletedSkillTokenHistoryEntry) {
      deletedSkillTokenHistoryRef.current.push(deletedSkillTokenHistoryEntry);
    }
    if (nextDraft.trim() !== "/review") {
      setReviewConfig(undefined);
    }
    setSendError(undefined);
  };
  const handleComposerClick = (): void => {
    setActiveSkillIndex(0);
    setActiveSlashIndex(0);
    setActiveDirectoryRefIndex(0);
  };
  const handlePlainComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (event.defaultPrevented) {
      return;
    }

    if (!hasAutocomplete) {
      const liveHasComposerContent = Boolean(
        (inputRef.current?.value ?? draft).trim() ||
          (inputRef.current?.skillTokenCount ?? skillTokens.length) > 0,
      );
      const liveHasAnyComposerContent =
        liveHasComposerContent ||
        imageAttachments.length > 0 ||
        fileAttachments.length > 0;
      const recoveryCycle = recoveryCycleRef.current;
      const liveSelectionAtStart =
        (inputRef.current?.selectionStart ?? 0) === 0 &&
        (inputRef.current?.selectionEnd ?? 0) === 0;
      const canCycleActiveRecovery =
        recoveryCycle?.scopeKey === composerScopeKey && liveSelectionAtStart;
      if (recoveryCycle && !canCycleActiveRecovery) {
        recoveryCycleRef.current = undefined;
        recoveryEligibilityVersionRef.current += 1;
      }
      if (
        recoveryCycle &&
        canCycleActiveRecovery &&
        liveHasAnyComposerContent &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown"
      ) {
        recoveryCycleRef.current = undefined;
        recoveryEligibilityVersionRef.current += 1;
      }
      if (
        event.key === "ArrowUp" &&
        (!liveHasComposerContent || canCycleActiveRecovery) &&
        (imageAttachments.length === 0 || canCycleActiveRecovery) &&
        (fileAttachments.length === 0 || canCycleActiveRecovery)
      ) {
        event.preventDefault();
        void recoverPreviousComposerDraft();
        return;
      }
      if (
        event.key === "ArrowDown" &&
        liveHasAnyComposerContent &&
        canCycleActiveRecovery &&
        (imageAttachments.length === 0 || canCycleActiveRecovery) &&
        (fileAttachments.length === 0 || canCycleActiveRecovery)
      ) {
        event.preventDefault();
        recoverNextComposerDraft();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void submitTurn(event.metaKey ? "steer" : "default");
      }
      return;
    }

    handleAutocompleteKeyDown(event);
  };
  const handleTiptapComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.defaultPrevented) {
      return;
    }

    if (restoreDeletedSkillToken(event)) {
      return;
    }

    handlePlainComposerKeyDown(event);
  };

  const fullAccessRiskDialog = fullAccessRiskDialogOpen
    ? createPortal(
        <div className="full-access-warning-modal">
          <div
            aria-labelledby="full-access-warning-title"
            aria-modal="true"
            className="full-access-warning-dialog"
            role="dialog"
          >
            <div className="full-access-warning-dialog__header">
              <h2 id="full-access-warning-title">Enable Full Access?</h2>
              <button
                aria-label="Cancel Full Access warning"
                className="workspace-handoff-dialog__close"
                disabled={fullAccessRiskSaving}
                type="button"
                onClick={() => {
                  setFullAccessRiskDialogOpen(false);
                }}
              >
                ×
              </button>
            </div>
            <p>
              Full Access allows network access and read/write access to almost
              all files on this machine.
            </p>
            <p>
              That means data can be exfiltrated unintentionally, or by
              malicious code the agent downloads and executes through a supply
              chain attack on npm, PyPI, Rust crates, Go modules, or a similar
              dependency source.
            </p>
            <label className="composer__checkbox full-access-warning-dialog__checkbox">
              <input
                checked={fullAccessRiskDontWarnAgain}
                disabled={fullAccessRiskSaving}
                type="checkbox"
                onChange={(event) =>
                  setFullAccessRiskDontWarnAgain(event.currentTarget.checked)
                }
              />
              <span>Do not warn me again on this desktop.</span>
            </label>
            {fullAccessRiskError ? (
              <p className="full-access-warning-dialog__error" role="alert">
                {fullAccessRiskError}
              </p>
            ) : null}
            <div className="full-access-warning-dialog__actions">
              <button
                className="button button--secondary"
                disabled={fullAccessRiskSaving}
                type="button"
                onClick={() => {
                  setFullAccessRiskDialogOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                disabled={fullAccessRiskSaving}
                type="button"
                onClick={() => {
                  void confirmFullAccessRisk();
                }}
              >
                I Understand and Accept the Risks
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;
  const imageLightbox = lightboxAttachment ? (
    <ImageLightbox
      src={lightboxAttachment.url}
      alt={formatPastedImageAlt(lightboxAttachment, 0)}
      onClose={() => setLightboxAttachment(undefined)}
    />
  ) : null;
  const workspaceHandoffDialog =
    handoffDialog && threadWorkspace
      ? createPortal(
          <div className="workspace-handoff-modal">
            <div
              aria-label={
                handoffDialog === "local-to-worktree"
                  ? "Handoff to New Worktree"
                  : "Handoff to Local"
              }
              aria-modal="true"
              className="workspace-handoff-dialog"
              role="dialog"
            >
              <h2>
                {handoffDialog === "local-to-worktree"
                  ? "Handoff to New Worktree"
                  : "Handoff to Local"}
              </h2>
              <p>
                {handoffDialog === "local-to-worktree"
                  ? "Choose how this thread should move into a new worktree."
                  : "Move this worktree branch back to Local. Dirty tracked and non-ignored files will be stashed and applied in Local, then the old worktree will be archived."}
              </p>
              <dl className="workspace-handoff-dialog__summary">
                <div>
                  <dt>
                    {handoffDialog === "worktree-to-local" && sourceBranch === "HEAD"
                      ? "Detached HEAD to move"
                      : handoffDialog === "local-to-worktree" &&
                          localHandoffStrategy === "detached-changes"
                        ? "Current branch"
                        : "Branch to move"}
                  </dt>
                  <dd>{sourceBranch ?? "Unknown branch"}</dd>
                </div>
              </dl>
              {handoffDialog === "local-to-worktree" ? (
                <>
                  <div
                    aria-label="Handoff strategy"
                    className="workspace-handoff-dialog__strategy-list"
                    role="radiogroup"
                  >
                    <button
                      aria-checked={localHandoffStrategy === "detached-changes"}
                      className="workspace-handoff-dialog__strategy"
                      disabled={handoffSubmitting}
                      role="radio"
                      type="button"
                      onClick={() => setLocalHandoffStrategy("detached-changes")}
                    >
                      <span className="workspace-handoff-dialog__strategy-title">
                        Handoff to Detached HEAD
                      </span>
                      <span>
                        Keep Local on the current branch. Create a detached worktree at
                        the current branch tip and move dirty non-ignored changes on top.
                      </span>
                    </button>
                    <button
                      aria-checked={localHandoffStrategy === "new-branch"}
                      className="workspace-handoff-dialog__strategy"
                      disabled={handoffSubmitting}
                      role="radio"
                      type="button"
                      onClick={() => setLocalHandoffStrategy("new-branch")}
                    >
                      <span className="workspace-handoff-dialog__strategy-title">
                        Handoff to New Branch
                      </span>
                      <span>
                        Keep Local on this branch. Create a named branch in the new
                        worktree and move dirty non-ignored changes on top.
                      </span>
                    </button>
                    <button
                      aria-checked={localHandoffStrategy === "move-branch"}
                      className="workspace-handoff-dialog__strategy"
                      disabled={handoffSubmitting || branchOptions.length === 0}
                      role="radio"
                      type="button"
                      onClick={() => setLocalHandoffStrategy("move-branch")}
                    >
                      <span className="workspace-handoff-dialog__strategy-title">
                        Handoff Current Branch
                      </span>
                      <span>
                        Move this branch into the new worktree, then switch this checkout to
                        a selected branch.
                      </span>
                    </button>
                  </div>
                  {localHandoffStrategy === "move-branch" ? (
                    <label className="workspace-handoff-dialog__field">
                      Leave current checkout on
                      <select
                        aria-label="Leave current checkout on"
                        className="composer__select"
                        disabled={handoffSubmitting || branchOptions.length === 0}
                        value={leaveLocalBranch}
                        onChange={(event) => setLeaveLocalBranch(event.target.value)}
                      >
                        {branchOptions.map((branch) => (
                          <option key={branch} value={branch}>
                            {formatLeaveLocalBranchOption(branch)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {localHandoffStrategy === "new-branch" ? (
                    <label className="workspace-handoff-dialog__field">
                      New branch name
                      <input
                        aria-label="New branch name"
                        className="workspace-handoff-dialog__text-input"
                        disabled={handoffSubmitting}
                        spellCheck={false}
                        type="text"
                        value={newLocalBranch}
                        onChange={(event) => setNewLocalBranch(event.target.value)}
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {handoffDialog === "local-to-worktree" &&
              localHandoffStrategy === "move-branch" &&
              branchOptions.length === 0 ? (
                <p className="workspace-handoff-dialog__note">
                  No available local branch can be checked out before moving this branch.
                </p>
              ) : null}
              {handoffDialog === "local-to-worktree" &&
              localHandoffStrategy === "detached-changes" ? (
                <p className="workspace-handoff-dialog__note">
                  The new worktree starts at the current tip of{" "}
                  {sourceBranch ?? "this branch"} and receives dirty non-ignored changes on
                  top.
                </p>
              ) : null}
              {handoffDialog === "local-to-worktree" &&
              localHandoffStrategy === "new-branch" ? (
                <p className="workspace-handoff-dialog__note">
                  The new worktree creates{" "}
                  {newLocalBranch.trim() ? (
                    <code>{newLocalBranch.trim()}</code>
                  ) : (
                    "a named branch"
                  )}{" "}
                  at the current tip of {sourceBranch ?? "this branch"} and receives
                  dirty non-ignored changes on top.
                </p>
              ) : null}
              <p className="workspace-handoff-dialog__note">
                Ignored files are not moved by handoff.
              </p>
              {handoffError ? (
                <p className="workspace-handoff-dialog__error">{handoffError}</p>
              ) : null}
              <div className="workspace-handoff-dialog__actions">
                <button
                  className="button button--ghost"
                  disabled={handoffSubmitting}
                  type="button"
                  onClick={() => setHandoffDialog(undefined)}
                >
                  Cancel
                </button>
                <button
                  className="button button--primary"
                  disabled={handoffDisabled}
                  type="button"
                  onClick={() => {
                    void submitHandoff();
                  }}
                >
                  {handoffSubmitting ? "Handing off..." : "Handoff"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <form
        className="composer"
        data-composer-implementation="tiptap-wysiwyg-markdown-chips"
        onSubmit={(event) => {
          event.preventDefault();
          setScheduleMenuOpen(false);
          if (isReviewComposerOpen) {
            void submitConfiguredReviewComposer();
          } else {
            void submitTurn();
          }
        }}
      >
        {/* Issue #240: removed the visible "Reply" / "New thread" /
          "Review" eyebrow that used to sit above the composer. The
          input itself carries the same name through its `aria-label`
          (the `label` prop on the inner ComposerRichInput /
          ComposerTiptapInput / ComposerTextareaInput is rendered as
          the input's `aria-label`), and the placeholder text already
          conveys the action prompt visually. Stacking another header
          above an input that already names itself was redundant
          chrome. */}

      {props.showEnvActionAnchors === false ? null : (
        <EnvActionAnchorList
          runtime={props.thread?.codexEnvironmentRuntime}
          hiddenRunIds={props.hiddenEnvActionRunIds}
          onDismissRun={props.onDismissEnvActionRun}
          onMoveToSidebar={props.onMoveEnvActionsToSidebar}
          onStopRun={props.onStopEnvActionRun}
        />
      )}

      {pendingSteer ? (
        <div
          className="composer__queued composer__queued--steer"
          aria-label="Pending steer message"
        >
          <div className="composer__queued-copy">
            <span className="composer__queued-label">
              {pendingSteer.status === "steering" ? "Steering now" : "Pending steer"}
            </span>
            <span className="composer__queued-text">
              {formatDraftPreview(pendingSteer)}
            </span>
          </div>
          <QueuedImageAttachments attachments={pendingSteer.imageAttachments} />
          <div className="composer__queued-actions">
            {pendingSteer.status === "pending" ? (
              <>
                <button
                  className="composer__secondary-action"
                  type="button"
                  onClick={() => {
                    setComposerDraftFromCanonical(pendingSteer.text);
                    setImageAttachments(pendingSteer.imageAttachments);
                    setFileAttachments(pendingSteer.fileAttachments);
                    setPendingSteer(undefined);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  Edit
                </button>
                <button
                  className="composer__secondary-action"
                  type="button"
                  onClick={() => {
                    setPendingSteer(undefined);
                  }}
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {props.thread?.queuedExecutionMode &&
      props.thread.queuedExecutionMode !== props.thread.executionMode ? (
        <div
          className="composer__queued composer__queued--permissions"
          aria-label="Queued permissions change"
        >
          <div className="composer__queued-copy">
            <span className="composer__queued-label">Permissions queued</span>
            <span className="composer__queued-text">
              Will switch to{" "}
              {formatExecutionModeLabel(props.thread.queuedExecutionMode)} when
              the current turn ends
            </span>
          </div>
          <div className="composer__queued-actions">
            <button
              className="composer__secondary-action"
              type="button"
              disabled={!props.onCancelExecutionModeQueue}
              onClick={() => {
                void props.onCancelExecutionModeQueue?.();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {queuedTurns.map((queued, index) => {
        const scheduledSendAt = getFutureScheduledSendAt(
          queued.scheduledSendAt,
          scheduleTick,
        );
        const queuedLabel = scheduledSendAt
          ? `Sends in ${formatScheduledSendCountdown(scheduledSendAt, scheduleTick)}`
          : index === 0
            ? "Queued next"
            : `Queued #${index + 1}`;

        return (
          <div
            className={[
              "composer__queued",
              scheduledSendAt ? "composer__queued--scheduled" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={index === 0 ? "Queued message" : `Queued message ${index + 1}`}
            key={`${index}:${queued.text}:${queued.imageAttachments.length}:${queued.fileAttachments.length}:${queued.scheduledSendAt ?? ""}`}
          >
            <div className="composer__queued-copy">
              <span className="composer__queued-label">
                {queuedLabel}
              </span>
              <span className="composer__queued-text">
                {formatDraftPreview(queued)}
              </span>
            </div>
            <QueuedImageAttachments attachments={queued.imageAttachments} />
            <div className="composer__queued-actions">
              {activeTurnId ? (
                supportsSteering && !queued.reviewCommand ? (
                  <button
                    className="composer__secondary-action"
                    disabled={props.disabled || steering}
                    type="button"
                    onClick={() => {
                      steerQueuedTurn(queued);
                    }}
                  >
                    {steering ? "Steering..." : "Steer"}
                  </button>
                ) : null
              ) : (
                <button
                  className="composer__secondary-action"
                  disabled={props.disabled || sending}
                  type="button"
                  onClick={() => {
                    sendQueuedTurnNow(queued);
                  }}
                >
                  Send now
                </button>
              )}
              <button
                className="composer__secondary-action"
                type="button"
                onClick={() => {
                  setComposerDraftFromCanonical(queued.text);
                  setImageAttachments(queued.imageAttachments);
                  setFileAttachments(queued.fileAttachments);
                  setScheduledDraftSendAt(scheduledSendAt);
                  setScheduleArmed(true);
                  removeQueuedTurnAt(index);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                Edit
              </button>
              <button
                className="composer__secondary-action"
                type="button"
                onClick={() => {
                  removeQueuedTurnAt(index);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}

      {imageAttachments.length > 0 || fileAttachments.length > 0 ? (
        <div
          className="composer__attachments"
          aria-label={fileAttachments.length > 0 ? "Attachments" : "Pasted images"}
        >
          {imageAttachments.map((attachment, index) => {
            const dimensions = formatImageDimensions(
              attachment.width,
              attachment.height,
            );
            return (
              <div className="composer__attachment" key={attachment.id}>
                <div className="composer__attachment-thumb">
                  <button
                    aria-label={`Expand ${attachment.name}`}
                    className="composer__attachment-open"
                    type="button"
                    onClick={() => {
                      setLightboxAttachment(attachment);
                    }}
                  >
                    <img
                      className="composer__attachment-preview"
                      src={attachment.url}
                      alt={formatPastedImageAlt(attachment, index)}
                    />
                  </button>
                  <button
                    aria-label={`Remove ${attachment.name}`}
                    className="composer__attachment-remove"
                    type="button"
                    onClick={() => {
                      removeImageAttachment(attachment.id);
                    }}
                  >
                    <CloseIcon size={12} aria-hidden="true" />
                  </button>
                </div>
                <div className="composer__attachment-chips">
                  <span className="composer__attachment-chip">
                    {formatBytes(attachment.size)}
                  </span>
                  {dimensions ? (
                    <span className="composer__attachment-chip">{dimensions}</span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {fileAttachments.map((attachment) => (
            <span
              className="composer__file-attachment tooltip-target"
              data-tooltip={buildFileReferenceTooltip(attachment.path)}
              key={attachment.id}
            >
              <FileCodeIcon size={13} aria-hidden="true" />
              <span className="composer__file-attachment-label">
                {attachment.label}
              </span>
              <button
                aria-label={`Remove ${attachment.label}`}
                className="composer__file-attachment-remove"
                type="button"
                onClick={() => {
                  removeFileAttachment(attachment.id);
                }}
              >
                <CloseIcon size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {imageAttachments.length > 0 && !imagesSupported ? (
        <p className="composer__meta composer__meta--warning" role="status">
          {imagesUnsupportedLabel} doesn&apos;t support image attachments —
          remove them or switch models before sending.
        </p>
      ) : null}

      <div className="composer__input-wrap" ref={inputWrapRef}>
        {isReviewComposerOpen ? (
          <fieldset
            className="composer__review-config"
            aria-label="Review target"
            onKeyDown={handleReviewConfigKeyDown}
          >
            <legend>Review target</legend>
            {reviewWorkspaceSelectionRequired ? (
              <label className="composer__review-field">
                <span>Project</span>
                <select
                  aria-label="Review project"
                  className="composer__review-input"
                  value={reviewConfig?.workspaceCwd ?? ""}
                  onChange={(event) => {
                    const workspaceCwd = event.target.value;
                    const directory = findReviewDirectoryForWorkspace({
                      directories: props.directories,
                      directory: props.directory,
                      thread: props.thread,
                      workspaceCwd,
                    });
                    const branch =
                      buildReviewBranchOptions({
                        directory,
                        thread: props.thread,
                      })[0] ?? "main";
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory,
                          thread: props.thread,
                        })),
                      branch,
                      branchSource: "auto",
                      workspaceCwd,
                    }));
                    setSendError(undefined);
                  }}
                >
                  <option value="" disabled>
                    Choose project
                  </option>
                  {reviewWorkspaceOptions.map((option) => (
                    <option key={option.key} value={option.cwd}>
                      {option.label} - {option.path}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="composer__review-options">
              {REVIEW_TARGET_OPTIONS.map((option, index) => (
                <button
                  key={option.target}
                  ref={(element) => {
                    reviewOptionRefs.current[index] = element;
                  }}
                  type="button"
                  aria-pressed={reviewConfig?.target === option.target}
                  className={`composer__review-option${reviewConfig?.target === option.target ? " is-active" : ""}`}
                  tabIndex={reviewConfig?.target === option.target ? 0 : -1}
                  onClick={() => {
                    selectReviewTarget(option.target, {
                      focusDetail:
                        option.target === "commit" || option.target === "custom",
                    });
                  }}
                  onKeyDown={(event) => handleReviewOptionKeyDown(event, index)}
                >
                  <span>{option.label}</span>
                  <small>{option.description}</small>
                </button>
              ))}
            </div>

            {reviewConfig?.target === "baseBranch" ? (
              <div className="composer__review-field">
                <span>Base branch</span>
                <ReviewBranchPicker
                  ariaLabel="Base branch"
                  options={reviewBranchPickerOptions}
                  value={reviewConfig.branch}
                  onChange={(branch) => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      branch,
                      branchSource: "user",
                      target: "baseBranch",
                    }));
                    setSendError(undefined);
                  }}
                />
              </div>
            ) : null}

            {reviewConfig?.target === "commit" ? (
              <div className="composer__review-field">
                <ReviewCommitPicker
                  inputRef={reviewCommitInputRef}
                  options={reviewCommitOptions}
                  value={reviewConfig.commit}
                  onChange={(commit) => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      commit,
                      target: "commit",
                    }));
                    setSendError(undefined);
                  }}
                />
              </div>
            ) : null}

            {reviewConfig?.target === "custom" ? (
              <label className="composer__review-field">
                <span>Instructions</span>
                <textarea
                  className="composer__review-input composer__review-input--textarea"
                  ref={reviewCustomTextareaRef}
                  value={reviewConfig.customInstructions}
                  onChange={(event) => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      customInstructions: event.target.value,
                      target: "custom",
                    }));
                    setSendError(undefined);
                  }}
                />
              </label>
            ) : null}

            <div className="composer__review-actions">
              <button
                type="button"
                className="composer__secondary-action"
                onClick={exitReviewComposer}
              >
                Cancel
              </button>
              <button
                type="button"
                className="composer__primary-action"
                disabled={
                  !buildConfiguredReviewCommand(reviewConfig) ||
                  (reviewWorkspaceSelectionRequired && !reviewConfig?.workspaceCwd)
                }
                onClick={() => {
                  void submitConfiguredReviewComposer();
                }}
              >
                {futureScheduledDraftSendAt
                  ? `Send in ${formatScheduledSendCountdown(
                      futureScheduledDraftSendAt,
                      scheduleTick,
                    )}`
                  : "Start review"}
              </button>
            </div>
          </fieldset>
        ) : (
          <ComposerTiptapInput
            ref={inputRef}
            id="thread-composer"
            ariaActiveDescendant={activeAutocompleteOptionId}
            ariaControls={autocompleteListboxId}
            ariaExpanded={hasAutocomplete}
            disabled={composerDisabled}
            label={isLaunchpad ? "New thread" : "Reply"}
            markdownConversion
            placeholder={composerPlaceholder}
            selectionRequest={composerSelectionRequest}
            editorDocument={editorDocument}
            skillTokens={skillTokens}
            value={draft}
            onChange={handleComposerChange}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={handleComposerClick}
            onKeyDown={handleTiptapComposerKeyDown}
          />
        )}

        {autocompleteKind === "skills" ? (
          <div
            className={`composer__autocomplete composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            role="listbox"
            aria-label="Skills"
            id={skillListboxId}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            {filteredSkills.map((skill, index) => (
              <button
                key={skill.path ?? skill.name}
                id={`${skillListboxId}-option-${index}`}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeSkillIndex}
                className={`composer__autocomplete-option${index === activeSkillIndex ? " is-active" : ""}`}
                tabIndex={index === activeSkillIndex ? 0 : -1}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySkill(skill);
                }}
                onClick={() => {
                  applySkill(skill);
                }}
                onFocus={() => {
                  setActiveSkillIndex(index);
                }}
                onKeyDown={handleAutocompleteKeyDown}
              >
                <span className="composer__autocomplete-title">
                  <span aria-hidden="true">🧰</span>
                  <HighlightedAutocompleteLabel
                    label={`$${skill.name}`}
                    query={trigger?.query ? `$${trigger.query}` : "$"}
                  />
                </span>
                <span className="composer__autocomplete-meta">
                  {skill.shortDescription || skill.description || skill.path}
                </span>
              </button>
            ))}
          </div>
        ) : autocompleteKind === "slash" ? (
          <div
            className={`composer__autocomplete composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            role="listbox"
            aria-label="Commands"
            id={slashListboxId}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            {filteredSlashCommands.map((command, index) => (
              <button
                key={command.id}
                id={`${slashListboxId}-option-${index}`}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeSlashIndex}
                className={`composer__autocomplete-option${index === activeSlashIndex ? " is-active" : ""}`}
                tabIndex={index === activeSlashIndex ? 0 : -1}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySlashCommand(command);
                }}
                onClick={() => {
                  applySlashCommand(command);
                }}
                onFocus={() => {
                  setActiveSlashIndex(index);
                }}
                onKeyDown={handleAutocompleteKeyDown}
              >
                <span className="composer__autocomplete-title">
                  <span className="composer__autocomplete-token" aria-hidden="true">/</span>
                  <HighlightedAutocompleteLabel
                    label={command.label}
                    query={slashTrigger ? `/${slashTrigger.query}` : "/"}
                  />
                  <span
                    className={`composer__autocomplete-source composer__autocomplete-source--${command.source}`}
                  >
                    {command.sourceLabel}
                  </span>
                </span>
                <span className="composer__autocomplete-meta">
                  {command.description}
                </span>
              </button>
            ))}
          </div>
        ) : autocompleteKind === "directories" ? (
          <div
            className={`composer__autocomplete composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            role="listbox"
            aria-label="Directories"
            id={directoryRefListboxId}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            {filteredDirectoryRefs.map((directory, index) => (
              <button
                key={directory.key}
                id={`${directoryRefListboxId}-option-${index}`}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeDirectoryRefIndex}
                className={`composer__autocomplete-option${index === activeDirectoryRefIndex ? " is-active" : ""}`}
                tabIndex={index === activeDirectoryRefIndex ? 0 : -1}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyDirectoryReference(directory);
                }}
                onClick={() => {
                  applyDirectoryReference(directory);
                }}
                onFocus={() => {
                  setActiveDirectoryRefIndex(index);
                }}
                onKeyDown={handleAutocompleteKeyDown}
              >
                <span className="composer__autocomplete-title">
                  <FolderIcon size={13} aria-hidden="true" />
                  <HighlightedAutocompleteLabel
                    label={directory.label}
                    query={directoryRefTrigger?.query ?? ""}
                  />
                </span>
                <span className="composer__autocomplete-meta">
                  {buildDirectoryReferenceInsertText(directory)}
                </span>
              </button>
            ))}
            {props.onPickDirectoryForReference ||
            props.desktopApi?.pickFileFromDisk ? (
              <div
                className="composer__autocomplete-separator"
                role="separator"
              />
            ) : null}
            {props.onPickDirectoryForReference ? (
              <button
                className="composer__autocomplete-option composer__autocomplete-option--action"
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  void applyPickedDirectoryReference();
                }}
              >
                <span className="composer__autocomplete-title">
                  + Add directory…
                </span>
              </button>
            ) : null}
            {props.desktopApi?.pickFileFromDisk ? (
              <button
                className="composer__autocomplete-option composer__autocomplete-option--action"
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  void applyPickedFileReferences();
                }}
              >
                <span className="composer__autocomplete-title">
                  + Add file…
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {props.launchpad || props.thread ? (
        <div
          className="composer__setup"
          aria-label={props.launchpad ? "New thread settings" : "Thread settings"}
        >
          {props.launchpad && providerOptions.length > 0 ? (
            <ComposerDropdown
              id="composer-provider"
              ariaLabel="Provider"
              disabled={launchpadSubmitting}
              value={props.launchpad.backend}
              options={providerOptions.map((candidate) => ({
                label: formatBackendLabel(candidate.kind, props.backends),
                value: candidate.kind,
              }))}
              onChange={(value) => {
                const currentLaunchpad = props.launchpad;
                if (!currentLaunchpad) {
                  return;
                }
                const nextBackend = value as NavigationLaunchpadDraft["backend"];
                const nextBackendSummary = props.backends?.find(
                  (candidate) => candidate.kind === nextBackend
                );
                const executionModeStillAvailable = nextBackendSummary?.executionModes.some(
                  (mode) => mode.available && mode.mode === currentLaunchpad.executionMode
                );
                const nextModelOption = getDefaultModelOption(nextBackendSummary);
                handleLaunchpadPatch({
                  backend: nextBackend,
                  executionMode: executionModeStillAvailable
                    ? currentLaunchpad.executionMode
                    : "default",
                  model: nextModelOption?.id,
                  reasoningEffort: nextModelOption?.supportsReasoning
                    ? getDefaultReasoningEffort(nextBackendSummary, nextModelOption)
                    : undefined,
                  serviceTier: undefined,
                  fastMode: undefined,
                  codexEnvironmentId: undefined,
                  codexEnvironmentExecutionTarget: undefined,
                  codexEnvironmentActionId: undefined,
                });
              }}
            />
          ) : props.thread ? (
            <span className="composer__fixed-value" aria-label="Provider">
              {formatBackendLabel(props.thread.source, props.backends)}
            </span>
          ) : null}

          {availableExecutionModes.length > 0 &&
          (props.launchpad || (props.thread && props.onSetExecutionMode)) ? (
            <ComposerDropdown
              ariaLabel="Access mode"
              compact
              tone={
                (props.launchpad?.executionMode ??
                  props.thread?.executionMode ??
                  "default") === "full-access"
                  ? "danger"
                  : undefined
              }
              disabled={launchpadSubmitting || Boolean(props.updatingExecutionMode)}
              value={
                props.launchpad?.executionMode ??
                props.thread?.executionMode ??
                "default"
              }
              options={availableExecutionModes.map((mode) => ({
                label: formatExecutionModeLabel(mode.mode),
                value: mode.mode,
              }))}
              onChange={(value) => {
                const executionMode = value as ThreadExecutionMode;
                requestExecutionModeSelection(executionMode);
              }}
            />
          ) : null}

          {acpRuntimeModeControl ? (
            <ComposerDropdown
              ariaLabel="Agent mode"
              compact
              disabled={
                launchpadSubmitting ||
                (!props.launchpad && !props.onSetAcpRuntimeOption)
              }
              value={acpRuntimeModeControl.value}
              options={acpRuntimeModeControl.options}
              onChange={(value) => {
                if (props.launchpad) {
                  const executionMode = acpRuntimeModeRequiresFullAccess(value)
                    ? "full-access"
                    : "default";
                  handleLaunchpadPatch({
                    executionMode,
                    acpRuntime: {
                      ...props.launchpad.acpRuntime,
                      configValues:
                        acpRuntimeModeControl.source === "configOption"
                          ? {
                              ...(props.launchpad.acpRuntime?.configValues ?? {}),
                              [acpRuntimeModeControl.optionId]: value,
                            }
                          : props.launchpad.acpRuntime?.configValues,
                      currentModeId:
                        acpRuntimeModeControl.source === "mode"
                          ? value
                          : undefined,
                    },
                  });
                  return;
                }
                void props.onSetAcpRuntimeOption?.({
                  source: acpRuntimeModeControl.source,
                  optionId: acpRuntimeModeControl.optionId,
                  value,
                });
              }}
            />
          ) : null}

          {props.launchpad &&
          (props.onSelectDirectoryFromPicker || props.onPickAndRegisterDirectory) ? (
            // Project picker (issue #223). Only render in the launchpad
            // surface — once a thread exists, the directory binding is
            // immutable. The current directory shows as the trigger
            // value when the launchpad is anchored to an actual
            // directory; the synthesized "workspace:new-thread"
            // launchpad reads as "No selected project" instead.
            <ProjectPicker
              value={
                props.directory && props.directory.kind === "directory"
                  ? props.directory
                  : undefined
              }
              directories={props.directories ?? []}
              disabled={launchpadSubmitting}
              pickError={props.pickDirectoryError}
              picking={props.pickingDirectory}
              onSelect={(directory) => {
                props.onClearPickDirectoryError?.();
                props.onSelectDirectoryFromPicker?.(directory);
              }}
              onSelectNoDirectory={
                props.onSelectNoDirectoryFromPicker
                  ? () => {
                      props.onClearPickDirectoryError?.();
                      props.onSelectNoDirectoryFromPicker?.();
                    }
                  : undefined
              }
              onPickFromDisk={() => {
                props.onClearPickDirectoryError?.();
                props.onPickAndRegisterDirectory?.();
              }}
            />
          ) : null}

          {props.thread && props.onPickAndAttachDirectoryToThread ? (
            <>
              <button
                className="composer__action-button composer__attach-directory-button"
                disabled={props.pickingDirectory}
                type="button"
                onClick={() => {
                  props.onClearPickDirectoryError?.();
                  props.onPickAndAttachDirectoryToThread?.();
                }}
              >
                <FolderIcon size={14} aria-hidden="true" />
                <span>{props.pickingDirectory ? "Adding" : "Add directory"}</span>
              </button>
              {props.pickDirectoryError ? (
                <span className="composer__inline-error" role="alert">
                  {props.pickDirectoryError}
                </span>
              ) : null}
            </>
          ) : null}

          {referencedDirectories.map((directory) => (
            <span
              key={directory.key}
              className="composer__directory-reference tooltip-target"
              data-tooltip={buildDirectoryReferenceTooltip(directory.path ?? "")}
            >
              <FolderIcon size={13} aria-hidden="true" />
              <span className="composer__directory-reference-label">
                {directory.label}
              </span>
            </span>
          ))}

          {props.launchpad ? (
            <ComposerDropdown
              ariaLabel="Workspace mode"
              compact
              disabled={
                launchpadSubmitting ||
                !props.onUpdateLaunchpad ||
                launchpadWorkspaceOptions.length <= 1
              }
              value={launchpadWorkspaceValue}
              options={launchpadWorkspaceOptions.map((option) => ({
                label: option.label,
                value: option.value,
              }))}
              onChange={(value) => {
                handleLaunchpadPatch({
                  workMode: value as NavigationLaunchpadDraft["workMode"],
                });
              }}
            />
          ) : workspaceLabel && threadWorkspace ? (
            <div
              className={`composer-dropdown composer-dropdown--compact${
                workspaceMenuOpen ? " composer-dropdown--open" : ""
              }`}
              ref={workspaceMenuRef}
            >
              <button
                aria-expanded={workspaceMenuOpen}
                aria-haspopup="menu"
                aria-label="Workspace mode"
                className="composer-dropdown__button"
                disabled={!canHandoffThreadWorkspace}
                type="button"
                value={threadWorkspace.mode}
                onClick={() => setWorkspaceMenuOpen((open) => !open)}
              >
                <span className="composer-dropdown__label">{workspaceLabel}</span>
              </button>
              {workspaceMenuOpen ? (
                <div className="composer-dropdown__menu" role="menu">
                  <button className="composer-dropdown__option" disabled type="button">
                    <span aria-hidden="true" className="composer-dropdown__check">
                      ✓
                    </span>
                    {workspaceLabel}
                  </button>
                  <div className="composer-dropdown__separator" role="separator" />
                  <button
                    className="composer-dropdown__option"
                    disabled={!canHandoffThreadWorkspace}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      openHandoffDialog(
                        threadWorkspace.mode === "worktree"
                          ? "worktree-to-local"
                          : "local-to-worktree"
                      );
                    }}
                  >
                    <span aria-hidden="true" className="composer-dropdown__check" />
                    {threadWorkspace.mode === "worktree"
                      ? "Handoff to Local"
                      : "Handoff to New Worktree"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {props.launchpad &&
          launchpadWorkspaceValue === "worktree" &&
          launchpadBranchPickerOptions.length > 0 ? (
            <BranchPicker
              ariaLabel="Base branch"
              id="launchpad-branch"
              disabled={launchpadSubmitting}
              projectLabel={props.directory?.label}
              value={
                normalizeSelectableLaunchpadBranch(props.launchpad.branchName) ??
                normalizeSelectableLaunchpadBranch(props.directory?.gitStatus?.currentBranch) ??
                props.directory?.gitStatus?.defaultBranch ??
                ""
              }
              options={launchpadBranchPickerOptions}
              onChange={(value) => {
                handleLaunchpadPatch({ branchName: value || undefined });
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) && backend?.launchpadOptions?.models?.length ? (
            <ComposerDropdown
              id="composer-model"
              ariaLabel="Model"
              disabled={launchpadSubmitting}
              value={selectedModelOption?.id ?? ""}
              options={backend.launchpadOptions.models.map((model) => ({
                label: model.label ?? model.id,
                value: model.id,
              }))}
              onChange={(value) => {
                const model = value;
                const nextModelOption = backend.launchpadOptions?.models?.find(
                  (option) => option.id === model
                );
                const nextSupportsReasoning =
                  nextModelOption?.supportsReasoning ??
                  Boolean(backend.launchpadOptions?.reasoningEfforts?.length);
                const nextSupportsFast =
                  backend.kind === "codex"
                    ? nextModelOption?.supportsFast ??
                      backend.launchpadOptions?.supportsFastMode ??
                      false
                    : false;
                if (props.launchpad) {
                  handleLaunchpadPatch({
                    model,
                    ...(nextSupportsFast ? {} : { fastMode: undefined }),
                  });
                  return;
                }
                if (nextSupportsReasoning) {
                  handleThreadModelSettingsPatch({
                    model,
                    ...(nextSupportsFast ? {} : { fastMode: undefined }),
                  });
                  return;
                }
                const patch = {
                  model,
                  reasoningEffort: undefined,
                  ...(nextSupportsFast ? {} : { fastMode: undefined }),
                };
                handleThreadModelSettingsPatch(patch);
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) &&
          supportsReasoning &&
          getReasoningEffortsForModel(backend, selectedModelOption).length ? (
            <ComposerDropdown
              id="composer-reasoning"
              ariaLabel="Reasoning"
              disabled={launchpadSubmitting}
              value={selectedReasoningEffort ?? ""}
              options={getReasoningEffortsForModel(
                backend,
                selectedModelOption,
              ).map((effort) => ({
                label: effort,
                value: effort,
              }))}
              onChange={(value) => {
                const reasoningEffort = value;
                if (props.launchpad) {
                  handleLaunchpadPatch({ reasoningEffort });
                  return;
                }
                handleThreadModelSettingsPatch({ reasoningEffort });
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) && backend?.launchpadOptions?.serviceTiers?.length ? (
            <ComposerDropdown
              id="composer-service-tier"
              ariaLabel="Service tier"
              disabled={launchpadSubmitting}
              value={selectedServiceTier ?? ""}
              options={backend.launchpadOptions.serviceTiers.map((tier) => ({
                label: tier,
                value: tier,
              }))}
              onChange={(value) => {
                const serviceTier = value;
                if (props.launchpad) {
                  handleLaunchpadPatch({ serviceTier });
                  return;
                }
                handleThreadModelSettingsPatch({ serviceTier });
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) && supportsFast ? (
            <button
              type="button"
              className={`composer__toggle tooltip-target${
                currentSettings?.fastMode ? " is-active" : ""
              }`}
              aria-label="Fast mode"
              aria-pressed={Boolean(currentSettings?.fastMode)}
              data-tooltip="Fast mode — faster, lower-latency responses"
              disabled={launchpadSubmitting}
              onClick={() => {
                const next = !currentSettings?.fastMode;
                if (props.launchpad) {
                  handleLaunchpadPatch({ fastMode: next });
                  return;
                }
                handleThreadModelSettingsPatch({ fastMode: next });
              }}
            >
              <LightningIcon size={15} aria-hidden="true" />
            </button>
          ) : null}

          {supportsPlanMode ? (
            <button
              type="button"
              className={`composer__toggle tooltip-target${
                planModeEnabled ? " is-active" : ""
              }`}
              aria-label="Plan mode"
              aria-pressed={planModeEnabled}
              data-tooltip="Plan mode — plan the work before making changes"
              disabled={sending}
              onClick={() => setPlanModeEnabled((current) => !current)}
            >
              <PlanIcon size={15} aria-hidden="true" />
            </button>
          ) : null}

          {props.onPickDirectoryForReference ||
          props.desktopApi?.pickFileFromDisk ? (
            <ReferencePicker
              open={addReferenceMenuOpen}
              onClose={() => setAddReferenceMenuOpen(false)}
              directories={props.directories ?? []}
              recentFiles={recentFileReferences}
              platform={props.desktopApi?.platform}
              onSelectDirectory={(directory) => {
                setAddReferenceMenuOpen(false);
                applyDirectoryReference(directory);
              }}
              onSelectFile={(path) => {
                setAddReferenceMenuOpen(false);
                attachFilePaths([path]);
              }}
              onPickFromDisk={
                props.desktopApi?.pickReferenceFromDisk
                  ? () => {
                      // Close before the OS dialog opens so the sheet
                      // doesn't float over a stale popover.
                      setAddReferenceMenuOpen(false);
                      void applyPickedReferencesFromDisk();
                    }
                  : undefined
              }
              onPickDirectoryFromDisk={
                props.onPickDirectoryForReference
                  ? () => {
                      setAddReferenceMenuOpen(false);
                      void applyPickedDirectoryReference();
                    }
                  : undefined
              }
              onPickFileFromDisk={
                props.desktopApi?.pickFileFromDisk
                  ? () => {
                      setAddReferenceMenuOpen(false);
                      void attachPickedFilesToTray();
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className="composer__toggle tooltip-target"
                aria-label="Add reference"
                aria-haspopup="dialog"
                aria-expanded={addReferenceMenuOpen}
                // Omit the CSS tooltip while the popover is open — the
                // pseudo-element otherwise lingers over the panel.
                data-tooltip={
                  addReferenceMenuOpen
                    ? undefined
                    : "Reference a directory or file"
                }
                disabled={launchpadSubmitting}
                onClick={() => {
                  const next = !addReferenceMenuOpen;
                  setAddReferenceMenuOpen(next);
                  if (next) {
                    void refreshRecentFileReferences();
                  }
                }}
              >
                <PlusIcon size={15} aria-hidden="true" />
              </button>
            </ReferencePicker>
          ) : null}
        </div>
      ) : null}

      {workspaceHandoffDialog}

      {props.skillError ? <p className="composer__meta composer__meta--error">{props.skillError}</p> : null}
      {props.unavailableReason ? (
       <p className="composer__meta composer__meta--error">
         {props.unavailableReason}
       </p>
      ) : null}
      {props.launchpadError ? (
        <CopyableComposerError
          desktopApi={props.desktopApi}
          label="Copy launchpad error"
          text={props.launchpadError}
        />
      ) : null}
      {sendError ? <p className="composer__meta composer__meta--error">{sendError}</p> : null}
      {applicationOpenError ? (
        <p className="composer__meta composer__meta--error">{applicationOpenError}</p>
      ) : null}
      {props.setExecutionModeError ? (
        <p className="composer__meta composer__meta--error">
          {props.setExecutionModeError}
        </p>
      ) : null}
      {props.threadModelSettingsError ? (
        <p className="composer__meta composer__meta--error">
          {props.threadModelSettingsError}
        </p>
      ) : null}
      {!props.skillError && props.skillLoading ? (
        <p className="composer__meta">Loading skills…</p>
      ) : null}
      {props.launchpad &&
      launchpadSubmitting &&
      props.launchpad.codexEnvironmentId &&
      selectedCodexEnvironment?.setupScript ? (
        <p className="composer__meta">Running environment setup…</p>
      ) : null}
      {props.updatingExecutionMode ? (
        <p className="composer__meta">
          Switching to {formatExecutionModeLabel(props.updatingExecutionMode)}…
        </p>
      ) : null}
      {props.disabled ? (
        <p className="composer__meta">
          {props.launchpad
            ? "This backend is unavailable right now. Your draft stays here until send is available again."
            : "This thread's backend is unavailable right now. You can keep drafting, but send is unavailable."}
        </p>
      ) : props.pendingRequestActive ? (
        <p className="composer__meta">
          Waiting for approval before this turn can continue.
        </p>
      ) : props.pendingUserInputActive ? (
        <p className="composer__meta">
          Waiting for input before this turn can continue.
        </p>
      ) : null}

      <div className="composer__footer">
        {launchpadCodexEnvironmentOptions.length > 0 ||
        threadCodexEnvironmentOptions.length > 0 ||
        props.thread?.codexEnvironmentRuntime ||
        (workspaceOpenPath && (editorApplication || terminalApplication)) ? (
          <div className="composer__application-actions" aria-label="Composer tools">
            {props.launchpad && launchpadCodexEnvironmentOptions.length > 0 ? (
              <ComposerDropdown
                ariaLabel="Environment"
                compact
                disabled={launchpadSubmitting}
                icon={FileCodeIcon}
                value={props.launchpad.codexEnvironmentId ?? ""}
                options={[
                  { label: "No environment", value: "" },
                  ...launchpadCodexEnvironmentOptions.map((environment) => ({
                    label: environment.name,
                    value: environment.id,
                  })),
                ]}
                onChange={(value) => {
                  const environment = launchpadCodexEnvironmentOptions.find(
                    (candidate) => candidate.id === value,
                  );
                  handleLaunchpadPatch({
                    codexEnvironmentId: environment?.id,
                    codexEnvironmentExecutionTarget: environment
                      ? props.launchpad?.codexEnvironmentExecutionTarget ?? "local"
                      : undefined,
                    codexEnvironmentActionId: undefined,
                  });
                }}
              />
            ) : null}

            {!props.launchpad && threadCodexEnvironmentOptions.length > 0 ? (
              <ComposerDropdown
                ariaLabel="Environment"
                compact
                disabled={!props.desktopApi?.setCodexThreadEnvironment}
                icon={FileCodeIcon}
                value={props.thread?.codexEnvironmentRuntime?.environmentId ?? ""}
                options={[
                  { label: "No environment", value: "" },
                  ...threadCodexEnvironmentOptions.map((environment) => ({
                    label: environment.name,
                    value: environment.id,
                  })),
                ]}
                onChange={(value) => {
                  const environment = threadCodexEnvironmentOptions.find(
                    (candidate) => candidate.id === value,
                  );
                  const actionId = resolveSelectedCodexEnvironmentActionId({
                    environment,
                    actionIdByEnvironmentId:
                      props.thread?.codexEnvironmentRuntime
                        ?.selectedActionIdByEnvironmentId,
                  });
                  void setThreadCodexEnvironment(value || undefined, actionId);
                }}
              />
            ) : null}

            {props.thread?.codexEnvironmentRuntime ? (
              // Split chip (issue #240 follow-up): the left segment runs the
              // selected command (orange CTA hover); the right segment is the
              // command picker. Click left to run, right to choose.
              <div className="composer__run-split">
                <button
                  aria-label="Run"
                  className="composer__run-split-play tooltip-target"
                  data-tooltip={
                    selectedThreadCodexAction
                      ? `Run ${selectedThreadCodexAction.name}`
                      : "Run command"
                  }
                  disabled={
                    currentThreadEnvActionStarting ||
                    !selectedThreadCodexAction ||
                    !props.desktopApi?.runCodexEnvironmentAction
                  }
                  type="button"
                  onClick={() => {
                    void runThreadCodexEnvironmentAction();
                  }}
                >
                  {currentThreadEnvActionStarting ? (
                    <span
                      aria-hidden="true"
                      className="composer__action-button-spinner"
                    />
                  ) : (
                    <PlayIcon size={13} aria-hidden="true" />
                  )}
                </button>
                <ComposerDropdown
                  ariaLabel="Environment command"
                  compact
                  disabled={
                    threadCodexEnvironmentActions.length === 0 ||
                    !props.desktopApi?.runCodexEnvironmentAction
                  }
                  value={selectedThreadCodexAction?.id ?? ""}
                  options={
                    threadCodexEnvironmentActions.length > 0
                      ? threadCodexEnvironmentActions.map((action) => ({
                          label: action.name,
                          value: action.id,
                        }))
                      : [{ label: "No commands", value: "" }]
                  }
                  onChange={(value) => {
                    void setThreadCodexEnvironment(
                      props.thread?.codexEnvironmentRuntime?.environmentId,
                      value || undefined,
                    );
                  }}
                />
              </div>
            ) : null}

            {workspaceOpenPath && editorApplication ? (
              <ComposerApplicationButton
                application={editorApplication}
                label={editorApplication.name}
                onOpen={openWorkspaceApplication}
              />
            ) : null}
            {workspaceOpenPath && terminalApplication ? (
              <ComposerApplicationButton
                application={terminalApplication}
                label={terminalApplication.name}
                onOpen={openWorkspaceApplication}
              />
            ) : null}
          </div>
        ) : (
          <span aria-hidden="true" className="composer__footer-spacer" />
        )}

        <div className="composer__actions">
          <ContextWindowMoon contextWindow={props.contextWindow} />
          {activeTurnId ? (
            <button
              className="button button--ghost"
              disabled={props.disabled || interrupting}
              type="button"
              onClick={() => {
                void stopTurn();
              }}
            >
              {interrupting ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          {props.launchpad && props.onCancelLaunchpad ? (
            <button
              className="button button--ghost"
              disabled={sending}
              type="button"
              onClick={() => {
                props.onCancelLaunchpad?.(props.launchpad!.directoryKey);
              }}
            >
              Cancel
            </button>
          ) : null}
          <div
            className={[
              "composer__send-split",
              scheduleMenuOpen ? "composer__send-split--open" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            ref={scheduleMenuRef}
          >
            <div
              className={[
                "composer__send-split-pill",
                sendButtonDisabled ? "is-disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {scheduleAffordanceVisible ? (
                <button
                  aria-expanded={scheduleMenuOpen}
                  aria-haspopup="menu"
                  aria-label="Schedule message"
                  className="button composer__send-schedule-button"
                  disabled={scheduleButtonDisabled}
                  type="button"
                  onClick={() => {
                    setScheduleTick(Date.now());
                    setScheduleMenuOpen((current) => !current);
                  }}
                >
                  <ChevronUpIcon size={14} />
                </button>
              ) : null}
              {scheduleToggleVisible ? (
                <button
                  aria-checked={scheduleArmed}
                  aria-label={
                    scheduleArmed
                      ? `Send later, in ${formatScheduledSendCountdown(
                          futureScheduledDraftSendAt!,
                          scheduleTick,
                        )}. Uncheck to send now.`
                      : `Send now. Check to send later, in ${formatScheduledSendCountdown(
                          futureScheduledDraftSendAt!,
                          scheduleTick,
                        )}.`
                  }
                  className={[
                    "composer__send-schedule-toggle",
                    scheduleArmed ? "is-armed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={sendButtonDisabled}
                  role="switch"
                  type="button"
                  onClick={() => {
                    setScheduleTick(Date.now());
                    setScheduleArmed((current) => !current);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="composer__send-schedule-toggle-box"
                  >
                    {scheduleArmed ? <CheckIcon size={12} /> : null}
                  </span>
                  <span className="composer__send-schedule-toggle-label">
                    in{" "}
                    {formatScheduledSendCountdown(
                      futureScheduledDraftSendAt!,
                      scheduleTick,
                    )}
                  </span>
                </button>
              ) : null}
              <button
                className="button composer__send-submit-button"
                disabled={sendButtonDisabled}
                type="submit"
              >
                {submitButtonLabel}
              </button>
            </div>
            {scheduleAffordanceVisible && scheduleMenuOpen ? (
              <div className="composer__schedule-menu" role="menu">
                {scheduledSendOptions.map((option) => (
                  <button
                    className="composer__schedule-menu-item"
                    key={option.label}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setScheduleMenuOpen(false);
                      scheduleCurrentDraft(
                        option.scheduledSendAt ?? Date.now() + option.delayMs!,
                      );
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      </form>
      {fullAccessRiskDialog}
      {imageLightbox}
    </>
  );
}

function ContextWindowMoon({
  contextWindow,
}: {
  contextWindow?: ThreadContextWindowState;
}) {
  if (!contextWindow) {
    return null;
  }

  const phase = Math.min(CONTEXT_MOON_PHASES.length - 1, Math.max(0, contextWindow.phase));
  const phaseLabel = CONTEXT_MOON_PHASES[phase];
  const percentLabel = `${Math.round(contextWindow.usedPercent)}%`;
  const tokenLabel = `${formatCompactNumber(
    contextWindow.totalTokens
  )}/${formatCompactNumber(contextWindow.modelContextWindow)}`;
  const label = `Context window ${percentLabel} full, ${tokenLabel} tokens, ${phaseLabel}`;
  const tooltip = buildContextWindowTooltip(contextWindow, phaseLabel);

  return (
    <div
      aria-label={label}
      className="context-window-moon tooltip-target"
      data-tooltip={tooltip}
      role="img"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={`context-window-moon__sprite context-window-moon__sprite--phase-${phase}`}
      >
        <span className="context-window-moon__disc" />
      </span>
      <span className="context-window-moon__label">{percentLabel}</span>
    </div>
  );
}

function buildContextWindowTooltip(
  contextWindow: ThreadContextWindowState,
  phaseLabel: string
): string {
  const lines = [
    `Context window: ${Math.round(contextWindow.usedPercent)}% full (${phaseLabel})`,
    `Current snapshot: ${formatCompactNumber(contextWindow.totalTokens)} / ${formatCompactNumber(
      contextWindow.modelContextWindow
    )} tokens`,
  ];

  if (typeof contextWindow.remainingTokens === "number") {
    const remainingPercent =
      typeof contextWindow.remainingPercent === "number"
        ? `, ${Math.round(contextWindow.remainingPercent)}% remaining`
        : "";
    lines.push(
      `Remaining: ${formatCompactNumber(contextWindow.remainingTokens)} tokens${remainingPercent}`
    );
  }

  const breakdown = [
    formatOptionalTokenDetail("input", contextWindow.inputTokens),
    formatCachedTokenDetail(contextWindow.cachedInputTokens, contextWindow.inputTokens),
    formatOptionalTokenDetail("output", contextWindow.outputTokens),
    formatOptionalTokenDetail("reasoning", contextWindow.reasoningOutputTokens),
  ].filter((detail): detail is string => Boolean(detail));

  if (breakdown.length > 0) {
    lines.push(`Current breakdown: ${breakdown.join(", ")}`);
  }

  if (typeof contextWindow.cumulativeTotalTokens === "number") {
    lines.push(
      `Cumulative usage reported: ${formatCompactNumber(
        contextWindow.cumulativeTotalTokens
      )} tokens`
    );
    const cumulativeCachedInput = formatCachedInputSummary(
      contextWindow.cumulativeCachedInputTokens,
      contextWindow.cumulativeInputTokens
    );
    if (cumulativeCachedInput) {
      lines.push(`Cumulative cached input: ${cumulativeCachedInput}`);
    }
    const cumulativeOutput = formatCumulativeOutputSummary(
      contextWindow.cumulativeOutputTokens,
      contextWindow.cumulativeReasoningOutputTokens
    );
    if (cumulativeOutput) {
      lines.push(`Cumulative output: ${cumulativeOutput}`);
    }
  }

  return lines.join("\n");
}

function formatOptionalTokenDetail(label: string, value: number | undefined): string | undefined {
  return typeof value === "number" ? `${formatCompactNumber(value)} ${label}` : undefined;
}

function formatCachedTokenDetail(
  cachedInputTokens: number | undefined,
  inputTokens: number | undefined
): string | undefined {
  if (typeof cachedInputTokens !== "number") {
    return undefined;
  }

  const percent = formatCachedInputPercent(cachedInputTokens, inputTokens);
  return `${formatCompactNumber(cachedInputTokens)} cached${percent ? ` (${percent})` : ""}`;
}

function formatCumulativeOutputSummary(
  outputTokens: number | undefined,
  reasoningOutputTokens: number | undefined
): string | undefined {
  const details = [
    formatOptionalTokenDetail("output", outputTokens),
    formatOptionalTokenDetail("reasoning", reasoningOutputTokens),
  ].filter((detail): detail is string => Boolean(detail));

  return details.length > 0 ? details.join(", ") : undefined;
}

function formatCachedInputSummary(
  cachedInputTokens: number | undefined,
  inputTokens: number | undefined
): string | undefined {
  if (typeof cachedInputTokens !== "number") {
    return undefined;
  }

  const percent = formatCachedInputPercent(cachedInputTokens, inputTokens);
  return `${formatCompactNumber(cachedInputTokens)}${percent ? ` (${percent})` : ""}`;
}

function formatCachedInputPercent(
  cachedInputTokens: number,
  inputTokens: number | undefined
): string | undefined {
  if (typeof inputTokens !== "number" || inputTokens <= 0) {
    return undefined;
  }

  const percent = Math.max(0, Math.min(100, (cachedInputTokens / inputTokens) * 100));
  return formatPercent(percent);
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}k`;
  }

  return String(Math.round(value));
}

function getImageFilesFromDataTransfer(dataTransfer: DataTransfer): ComposerImageFile[] {
  const files: ComposerImageFile[] = [];
  const seenFiles = new Set<string>();
  let foundImageItem = false;

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const type = isImageMimeType(item.type) ? item.type : inferTransferImageType(file);
    if (!type) {
      continue;
    }

    foundImageItem = true;
    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type });
      seenFiles.add(key);
    }
  }

  if (foundImageItem) {
    return files;
  }

  for (const file of Array.from(dataTransfer.files)) {
    const type = inferTransferImageType(file);
    if (!type) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type });
      seenFiles.add(key);
    }
  }

  return files;
}

/**
 * Sibling of getImageFilesFromDataTransfer for the path-only file tray:
 * every dropped/pasted File that is NOT an image (those keep the existing
 * attach-image path), deduped by content key.
 */
function getNonImageFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  const seenFiles = new Set<string>();
  let foundFileItem = false;

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    foundFileItem = true;
    if (isImageMimeType(item.type) || inferTransferImageType(file)) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push(file);
      seenFiles.add(key);
    }
  }

  if (foundFileItem) {
    return files;
  }

  for (const file of Array.from(dataTransfer.files)) {
    if (inferTransferImageType(file)) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push(file);
      seenFiles.add(key);
    }
  }

  return files;
}

function hasAnyFiles(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind === "file") {
      return true;
    }
  }

  return dataTransfer.files.length > 0;
}

function buildFileKey(file: File): string {
  return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
}

function inferTransferImageType(file: File): string | undefined {
  if (isImageMimeType(file.type)) {
    return file.type;
  }

  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "gif" ? "image/gif" : undefined;
}

function isImageMimeType(type: string): boolean {
  return type.toLowerCase().startsWith("image/");
}

function isGifFile(file: File, type: string): boolean {
  return inferTransferImageType(file) === "image/gif" || type.toLowerCase() === "image/gif";
}

function readFileAsImageDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        if (reader.result.startsWith(`data:${mimeType}`)) {
          resolve(reader.result);
          return;
        }
        if (/^data:[^,]*,/i.test(reader.result)) {
          resolve(reader.result.replace(/^data:[^,]*,/i, `data:${mimeType};base64,`));
          return;
        }
      }
      reject(new Error("The image did not produce an image data URL."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The image could not be read."));
    });
    reader.readAsDataURL(file);
  });
}

/**
 * Small, fast, non-cryptographic 53-bit hash (cyrb53) over an image data URL.
 * Used only to bucket like-sized attachments for in-memory de-duplication; it
 * is never persisted or sent, and hash collisions are resolved by an exact
 * data-URL comparison, so a weak hash is safe here.
 */
function hashImageDataUrl(value: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Split a freshly-normalized batch into genuinely new attachments versus exact
 * duplicates of something already attached (or of an earlier item in the same
 * batch). A mismatched `size` rules out most pairs up front via the signature
 * prefix; only same-size candidates land in the same bucket, where an exact
 * data-URL compare confirms the match so two distinct same-size images are
 * never wrongly merged on a hash collision.
 */
function partitionNewImageAttachments(
  existing: ComposerImageAttachment[],
  incoming: ComposerImageAttachment[],
  signatureFor: (attachment: ComposerImageAttachment) => string,
): { unique: ComposerImageAttachment[]; duplicateCount: number } {
  const seen = new Map<string, string[]>();
  const remember = (attachment: ComposerImageAttachment): void => {
    const signature = signatureFor(attachment);
    const urls = seen.get(signature);
    if (urls) {
      urls.push(attachment.url);
    } else {
      seen.set(signature, [attachment.url]);
    }
  };
  for (const attachment of existing) {
    remember(attachment);
  }
  const unique: ComposerImageAttachment[] = [];
  let duplicateCount = 0;
  for (const attachment of incoming) {
    if (seen.get(signatureFor(attachment))?.includes(attachment.url)) {
      duplicateCount += 1;
      continue;
    }
    unique.push(attachment);
    remember(attachment);
  }
  return { unique, duplicateCount };
}

function formatImageDimensions(
  width: number | undefined,
  height: number | undefined,
): string | undefined {
  if (
    !width ||
    !height ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  return `${Math.round(width)}×${Math.round(height)}`;
}

function formatPastedImageName(type: string, index: number): string {
  const extension = type.split("/")[1] || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

function formatPastedImageAlt(
  attachment: Pick<ComposerImageAttachment, "name">,
  index: number
): string {
  return attachment.name || `Pasted image ${index + 1}`;
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "Unknown size";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  const mib = size / (1024 * 1024);
  if (mib < 10) {
    return `${Number(mib.toFixed(1))} MB`;
  }

  return `${Math.round(mib)} MB`;
}

function formatLaunchpadWorkspaceLabel(
  launchpad?: NavigationLaunchpadDraft,
  directory?: NavigationDirectorySummary
): string | undefined {
  if (!launchpad) {
    return undefined;
  }

  if (launchpad.workMode === "worktree") {
    return "New worktree";
  }

  if (isSameWorktreeSubthreadLaunchpad(launchpad.directoryKey)) {
    return "Same worktree";
  }

  if (directory?.kind === "workspace") {
    return "Workspace";
  }

  return directory?.gitStatus?.currentBranch
    ? `Local (${directory.gitStatus.currentBranch})`
    : "Local";
}

function buildLaunchpadWorkspaceOptions(
  launchpad: NavigationLaunchpadDraft,
  directory?: NavigationDirectorySummary
): Array<{ value: NavigationLaunchpadDraft["workMode"]; label: string }> {
  const localLabel = formatLaunchpadWorkspaceLabel(
    { ...launchpad, workMode: "local" },
    directory
  );
  if (isSameWorktreeSubthreadLaunchpad(launchpad.directoryKey)) {
    return [{ value: "local", label: localLabel ?? "Same worktree" }];
  }

  const canCreateWorktree = Boolean(
    directory?.path &&
      directory.kind === "directory" &&
      (directory.gitStatus?.currentBranch ||
        (directory.gitStatus?.branches?.length ?? 0) > 0 ||
        (launchpad.workMode === "worktree" &&
          Boolean(launchpad.parentThreadId)))
  );
  const options: Array<{ value: NavigationLaunchpadDraft["workMode"]; label: string }> = [
    { value: "local", label: localLabel ?? "Local" },
  ];

  if (canCreateWorktree) {
    options.push({ value: "worktree", label: "New worktree" });
  }

  return options;
}

function normalizeSelectableLaunchpadBranch(branch?: string): string | undefined {
  const value = branch?.trim();
  if (!value || value.toUpperCase() === "HEAD") {
    return undefined;
  }
  return value;
}

/**
 * Builds the recency-ordered, metadata-enriched branch list for the worktree
 * launchpad picker. Git branches (already sorted most-recently-touched first)
 * come first, then the selected/current/default branches as fallbacks so the
 * picker still functions before directory git status has loaded.
 */
function buildLaunchpadBranchPickerOptions(
  launchpad: NavigationLaunchpadDraft,
  directory?: NavigationDirectorySummary,
): LaunchpadBranchOption[] {
  const details =
    directory?.gitStatus?.baseBranchDetails ??
    directory?.gitStatus?.branchDetails ??
    [];
  const detailByName = new Map(details.map((detail) => [detail.name, detail]));
  const currentBranch = normalizeSelectableLaunchpadBranch(
    directory?.gitStatus?.currentBranch,
  );
  const defaultBranch = normalizeSelectableLaunchpadBranch(
    directory?.gitStatus?.defaultBranch,
  );
  const ordered: LaunchpadBranchOption[] = [];
  const seen = new Set<string>();
  const push = (candidate?: string): void => {
    const name = normalizeSelectableLaunchpadBranch(candidate);
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    const detail = detailByName.get(name);
    ordered.push({
      name,
      lastCommitAt: detail?.lastCommitAt,
      inUse: detail?.inUse,
      current: currentBranch ? name === currentBranch : false,
      isDefault: defaultBranch ? name === defaultBranch : false,
    });
  };
  // Recency-ordered branches: prefer the enriched details, fall back to the
  // plain name list when details are unavailable (older snapshots, fixtures).
  const orderedNames =
    details.length > 0
      ? details.map((detail) => detail.name)
      : (directory?.gitStatus?.baseBranches ?? directory?.gitStatus?.branches ?? []);
  for (const name of orderedNames) {
    push(name);
  }
  push(launchpad.branchName);
  push(directory?.gitStatus?.currentBranch);
  push(directory?.gitStatus?.defaultBranch);
  return ordered;
}

/**
 * Formats a branch tip's last-commit time as a compact "touched ago" label
 * ("just now", "2m ago", "yesterday", "3w ago"). Returns undefined when the
 * timestamp is missing so the picker can omit the column.
 */
function formatBranchRelativeTime(
  lastCommitAt: number | undefined,
  nowMs: number,
): string | undefined {
  if (!lastCommitAt || !Number.isFinite(lastCommitAt)) {
    return undefined;
  }
  const deltaSeconds = Math.round((nowMs - lastCommitAt * 1000) / 1000);
  if (deltaSeconds < 45) {
    return "just now";
  }
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(deltaSeconds / 3600);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(deltaSeconds / 86400);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  if (days < 30) {
    return `${Math.round(days / 7)}w ago`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.round(days / 365)}y ago`;
}

function formatThreadWorkspaceLabel(thread?: NavigationThreadSummary): string | undefined {
  if (!thread) {
    return undefined;
  }

  if (thread.linkedDirectories.some((directory) => directory.kind === "worktree")) {
    return "Worktree";
  }

  if (
    thread.linkedDirectories.some((directory) => directory.kind === "local") ||
    thread.projectKey
  ) {
    return "Local";
  }

  return undefined;
}

type ThreadWorkspace = {
  mode: "local" | "worktree";
  /** True only when the path is known to be a git local/worktree relationship. */
  gitBacked: boolean;
  /** Repository/local checkout path. In Worktree mode this is not the command CWD. */
  repositoryPath: string;
  /** Current workspace path for opening apps and running thread-scoped commands. */
  sourcePath: string;
};

/**
 * Single renderer source of truth for workspace-opening commands in the
 * thread composer. VS Code, terminal, and environment Run must all use this
 * value so Worktree threads launch from worktreePath and Local threads launch
 * from path.
 */
function getComposerWorkspaceOpenPath(params: {
  directory?: NavigationDirectorySummary;
  launchpad?: NavigationLaunchpadDraft;
  threadWorkspace?: ThreadWorkspace;
}): string | undefined {
  if (params.launchpad) {
    return undefined;
  }

  return params.threadWorkspace?.sourcePath ?? params.directory?.path;
}

function getThreadWorkspace(thread: NavigationThreadSummary): ThreadWorkspace | undefined {
  const worktreeDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree"
  );
  if (worktreeDirectory) {
    return {
      mode: "worktree",
      gitBacked: true,
      repositoryPath: worktreeDirectory.path,
      sourcePath: worktreeDirectory.worktreePath ?? worktreeDirectory.path,
    };
  }

  const localDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "local"
  );
  if (localDirectory) {
    return {
      mode: "local",
      gitBacked: true,
      repositoryPath: localDirectory.path,
      sourcePath: localDirectory.path,
    };
  }

  if (thread.projectKey) {
    return {
      mode: "local",
      gitBacked: false,
      repositoryPath: thread.projectKey,
      sourcePath: thread.projectKey,
    };
  }

  return undefined;
}

function isThreadWorkspaceHandoffEligible(params: {
  sourceBranch?: string;
  threadWorkspace?: ThreadWorkspace;
}): boolean {
  if (!params.threadWorkspace) {
    return false;
  }

  if (!params.threadWorkspace.gitBacked) {
    return false;
  }

  if (params.threadWorkspace.mode === "worktree") {
    return true;
  }

  return Boolean(params.sourceBranch?.trim());
}

function buildHandoffBranchSuggestion(sourceBranch: string | undefined): string {
  const normalizedSource = sourceBranch
    ?.replace(/^refs\/heads\//, "")
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
  const branchSlug =
    normalizedSource && normalizedSource !== "HEAD" ? normalizedSource : "detached";
  return `pwragent/${branchSlug}-handoff`;
}

function getLeaveLocalBranchOptions(params: {
  currentBranch?: string;
  directory?: NavigationDirectorySummary;
}): string[] {
  const currentBranch = params.currentBranch?.trim();
  const explicitHandoffBranches = params.directory?.gitStatus?.handoffBranches;
  const branches = explicitHandoffBranches ?? params.directory?.gitStatus?.branches ?? [];
  const candidates = branches.filter(
    (branch) => branch && branch !== "HEAD" && branch !== currentBranch
  );
  const defaultBranch = params.directory?.gitStatus?.defaultBranch;
  const preferred =
    defaultBranch && candidates.includes(defaultBranch)
      ? defaultBranch
      : ["main", "master", "develop", "trunk"].find((branch) =>
          candidates.includes(branch)
        );
  const ordered = preferred
    ? [preferred, ...candidates.filter((branch) => branch !== preferred)]
    : candidates;

  return ["HEAD", ...new Set(ordered)];
}

function formatLeaveLocalBranchOption(branch: string): string {
  return branch === "HEAD" ? "Detached HEAD" : branch;
}
