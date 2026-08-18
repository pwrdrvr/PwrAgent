import {
  Fragment,
  type ReactNode,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  useCallback,
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
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  BackendSummary,
  CodexEnvironmentOption,
  CodexEnvironmentActionRun,
  CodexMcpInventoryDetail,
  CodexThreadEnvironmentRuntime,
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  DesktopProviderModelDefaults,
  FederationTarget,
  HandoffThreadWorkspaceRequest,
  ModelSettingsRecent,
  NavigationDirectorySummary,
  NavigationGitCommitSummary,
  NavigationLaunchpadDraft,
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
  NavigationThreadSummary,
  PrSummary,
  RenderComposerPdfPreviewResponse,
  ThreadWorkspaceHandoffStrategy,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  buildThreadMarkdownLink,
  buildThreadUrl,
  buildReviewBranchOptions,
  federatedThreadIdentityKey,
  findPreferredReviewWorkspaceCwd,
  isRemoteFederationTarget,
  normalizeGitOriginUrl,
  parseThreadUrl,
  readCodexEnvironmentActionRuns,
  threadHasExactPrNumberMatch,
} from "@pwragent/shared";
import {
  BranchIcon,
  CheckIcon,
  ChevronUpIcon,
  CloseIcon,
  FileCodeIcon,
  FolderIcon,
  LightningIcon,
  MoreVerticalIcon,
  PlanIcon,
  PlayIcon,
  PlusIcon,
  PullRequestIcon,
  SearchIcon,
  ThreadIcon,
} from "../../icons";
import { AppIcon } from "../../components/AppIcon";
import { InstanceChip } from "../federation/InstanceGlyph";
import { ImageLightbox } from "../thread-detail/ImageLightbox";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { formatBackendLabel } from "../../lib/backend-label";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { agentEventMatchesThread } from "../../lib/federated-thread-events";
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
import {
  collapseHashReferenceWhitespace,
  filterHashReferenceCandidates,
  findHashReferenceTrigger,
  formatHashReferenceThreadLabel,
  formatHashReferenceThreadTooltip,
  hashReferenceAnchorKey,
  HASH_ANCHOR_COLD_QUERY_LENGTH,
} from "../../lib/hash-references";
import { normalizeImageFile } from "../../lib/image-normalization";
import {
  AGENT_THREAD_CAPABILITIES,
  CODEX_AGENT_THREAD_CREATION_NOTE,
  canChangeExistingThreadAgentDesignation,
  createDesktopAgentThread,
} from "../../lib/agent-thread";
import { parsePullRequestUrl } from "../../lib/pull-request-links";
import {
  resolveThreadHref,
  resolveThreadIdText,
  useThreadLinks,
  type ResolvedThreadLink,
  type ThreadLinkContextValue,
} from "../../lib/thread-links";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import {
  FEDERATED_THREAD_SEARCH_LIMIT,
  useFederatedThreadSearch,
} from "../../lib/useFederatedThreadSearch";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  findSkillTrigger,
  hydrateSkillLabelsWithMarkdown,
  listMentionedSkills,
  parseSkillMentionParts,
  buildSkillMentionMarkdown,
} from "../../lib/skill-mentions";
import {
  formatReviewCommand,
  parseReviewCommand,
} from "../../../../shared/review-command";
import {
  type ComposerInputChangeMetadata,
  type ComposerInputHandle,
  type ComposerSkillToken,
} from "./ComposerInputTypes";
import { ComposerTiptapInput } from "./ComposerTiptapInput";
import { ProjectPicker } from "./ProjectPicker";
import {
  ComposerDropdown,
  useDismissableMenu,
} from "./ComposerDropdown";
import type { ComposerDropdownIcon, ComposerDropdownOption } from "./ComposerDropdown";
import { ReferencePicker, type ReferencePickerFile } from "./ReferencePicker";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "./native-picker-boundary";
import { TranscriptCopyButton } from "../thread-detail/TranscriptCopyButton";
import {
  EnvActionRunEntry,
  EnvActionRunsView,
  formatDurationMs,
  formatRunningDurationMs,
} from "../thread-detail/EnvActionRunsView";
import { ActiveSubAgentsStrip } from "../thread-detail/ActiveSubAgentsStrip";
import { ActiveAutomationRunsStrip } from "../automations/ActiveAutomationRunsStrip";
import {
  buildThreadComposerScopeKey,
  getNextReleasableQueuedTurn,
  hasComposerDraftContent,
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
  codexFastAllowed?: boolean;
  backgroundPrPollingEnabled?: boolean;
  prAutoDispatchAllowed?: boolean;
  providerModelDefaults?: Record<string, DesktopProviderModelDefaults>;
  desktopApi?: DesktopApi;
  /**
   * Surface a transient app-level toast (image attachment limit reached,
   * pasted image rejected on a non-vision model). Plumbed up to the shared
   * AppNoticeToast stack in App.tsx.
   */
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
  onProviderSelected?: (
    backend: NavigationLaunchpadDraft["backend"],
  ) => BackendSummary | undefined | Promise<BackendSummary | undefined>;
  directory?: NavigationDirectorySummary;
  /**
   * Full set of currently-tracked directories from the navigation
   * snapshot. Used by the project picker (issue #223) to render the
   * "recent directories" list. Optional so tests / threads-only
   * surfaces don't have to provide it.
   */
  directories?: NavigationDirectorySummary[];
  /** Threads searchable from the inline `#` reference picker. */
  threads?: NavigationThreadSummary[];
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
    extraDirectoryPaths?: string[],
    scheduledFor?: number,
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
  /**
   * The operator replied to this thread (sent a turn, or steered a running
   * one). The Attention lens treats this as its only unread-clearing signal,
   * because focusing a thread from a work queue must not empty the queue.
   */
  onUserRepliedToThread?: (thread: NavigationThreadSummary) => void;
  onRefreshNavigation?: () => Promise<void>;
  pastedImageMaxPatches?: number;
  pdfAnalysisEnabled?: boolean;
  /** Global Token Miser setting, so the thread menu can show the effective state. */
  tokenMiserEnabled?: boolean;
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
        | "agent"
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
      federationTarget?: FederationTarget;
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
  onShowMcpInventory?: (detail: CodexMcpInventoryDetail) => void;
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
  onSetThreadPrAutoDispatch?: (enabled: boolean) => Promise<void>;
  onCancelThreadPrAutoDispatch?: (fingerprint: string) => Promise<void>;
  onSendThreadPrAutoDispatchNow?: (fingerprint: string) => Promise<void>;
  threadModelSettingsError?: string;
};

const providerCatalogsRefreshedThisSession = new Set<AppServerBackendKind>();

async function refreshProviderCatalogOnFirstSelection(
  desktopApi: DesktopApi | undefined,
  backend: AppServerBackendKind,
): Promise<void> {
  if (
    providerCatalogsRefreshedThisSession.has(backend)
    || !desktopApi?.listBackends
  ) {
    return;
  }
  providerCatalogsRefreshedThisSession.add(backend);
  try {
    if (backend.startsWith("acp:") && desktopApi.listAcpAgents) {
      await desktopApi.listAcpAgents({ refresh: true });
    }
    await desktopApi.listBackends({
      includeUnavailable: true,
      refreshModels: backend,
    });
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  } catch {
    providerCatalogsRefreshedThisSession.delete(backend);
  }
}

type LocalHandoffStrategy = ThreadWorkspaceHandoffStrategy;

type ComposerImageAttachment = NavigationLaunchpadImageAttachment;

type ComposerFileAttachment = NavigationLaunchpadFileAttachment;

type ComposerReferenceInspection = {
  filePaths: string[];
  pdfPaths: string[];
};

type ComposerReferencePathInspection = {
  isFile: boolean;
  isPdf: boolean;
};

type ComposerPdfPreview = Extract<
  RenderComposerPdfPreviewResponse,
  { unchanged: false }
>;

type ComposerPdfPreviewState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { preview: ComposerPdfPreview; refreshing: boolean; status: "ready" };

type ComposerPdfReference = {
  attachmentId?: string;
  label: string;
  path: string;
};

const EMPTY_COMPOSER_REFERENCE_INSPECTION: ComposerReferenceInspection = {
  filePaths: [],
  pdfPaths: [],
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

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
  backendQueuePending?: boolean;
  queueEntryId?: string;
  scheduledActionId?: string;
  failedScheduledActionId?: string;
  errorMessage?: string;
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
  clearComposerDraftOnAdmission?: boolean;
  expectedTurnId: string;
  status: "pending" | "queued" | "steering";
};

function scheduledActionFailureMessage(action: {
  errorMessage?: string;
  status: string;
}): string | undefined {
  return action.status === "failed"
    ? action.errorMessage ?? "The scheduled action could not be dispatched."
    : undefined;
}

type ComposerTurnPayload = {
  displayText: string;
  imageParts: AppServerThreadImagePart[];
  input: AppServerTurnInputItem[];
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

type AutocompleteKind =
  | "directories"
  | "hash-references"
  | "skills"
  | "slash";
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
  /**
   * Explicitly picked reviewer. Undefined means the review inherits the
   * thread's own provider/model/reasoning — the row reads the thread's values
   * either way, so the reset control is what signals divergence. Lives on the
   * panel's state so it clears whenever the panel closes: a reviewer override
   * applies to one review, never to the thread.
   */
  reviewer?: ModelSettingsRecent;
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

const CODEX_MCP_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  {
    id: "codex-mcp",
    label: "/mcp",
    insertText: "/mcp",
    description: "List MCP tools and authentication status",
    source: "pwragent",
    sourceLabel: "Codex",
  },
  {
    id: "codex-mcp-verbose",
    label: "/mcp verbose",
    insertText: "/mcp verbose",
    description: "List MCP tools, resources, and resource templates",
    source: "pwragent",
    sourceLabel: "Codex",
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

function getDefaultModelOption(backend?: BackendSummary): ModelOption | undefined {
  const models = backend?.launchpadOptions?.models ?? [];
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

/**
 * Resolve what the reviewer chips display. With no override the row mirrors
 * the thread's own settings; with one, every value resolves against the picked
 * provider's catalog so a model from the thread's provider can never leak into
 * another provider's review.
 */
function resolveReviewerSelection(params: {
  backends?: BackendSummary[];
  override?: ModelSettingsRecent;
  threadBackend?: AppServerBackendKind;
  threadModel?: string;
  threadReasoningEffort?: string;
}): {
  backend?: AppServerBackendKind;
  model?: ModelOption;
  reasoningEffort?: string;
  summary?: BackendSummary;
} {
  const backendKind = params.override?.backend ?? params.threadBackend;
  const summary = params.backends?.find(
    (candidate) => candidate.kind === backendKind,
  );
  const models = summary?.launchpadOptions?.models ?? [];
  const requestedModel = params.override
    ? params.override.model
    : params.threadModel;
  const model =
    models.find((candidate) => candidate.id === requestedModel)
    ?? getDefaultModelOption(summary);
  const requestedReasoning = params.override
    ? params.override.reasoningEffort
    : params.threadReasoningEffort;
  return {
    backend: backendKind,
    model,
    reasoningEffort: getReasoningEffortValue(summary, model, requestedReasoning),
    summary,
  };
}

/** Compact "Codex · gpt-5.6-sol · high" label for a remembered combination. */
function formatReviewerRecentLabel(
  recent: ModelSettingsRecent,
  backends?: BackendSummary[],
): string {
  return [
    formatBackendLabel(recent.backend, backends),
    recent.model,
    recent.reasoningEffort,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
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

function createReviewConfig(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
  reviewCommand?: {
    cwd?: string;
    target: AppServerReviewTarget;
  };
}): ReviewConfigState {
  const workspaceOptions = buildReviewWorkspaceOptions(params.thread);
  const preferredWorkspaceCwd = findPreferredReviewWorkspaceCwd(params.thread);
  const config: ReviewConfigState = {
    branch: buildReviewBranchOptions(params)[0] ?? "main",
    branchSource: "auto",
    commit: "",
    customInstructions: "",
    target: "baseBranch",
    workspaceCwd: params.reviewCommand?.cwd ?? (
      preferredWorkspaceCwd ??
      (workspaceOptions.length === 1 ? workspaceOptions[0]?.cwd : undefined)
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

function parseStaleInterruptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no active turn to interrupt");
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

/**
 * `matchAnywhere` is for populations the picker matches by substring —
 * thread titles, where the query rarely starts the name. Prefix-ranked
 * populations ($ skills, / commands, @ directories) keep the leading-run
 * highlight so the emphasis always sits on what was typed.
 */
function HighlightedAutocompleteLabel(props: {
  label: string;
  matchAnywhere?: boolean;
  query: string;
}) {
  const matchIndex = !props.query
    ? -1
    : props.matchAnywhere
      ? props.label.toLowerCase().indexOf(props.query.toLowerCase())
      : props.label.toLowerCase().startsWith(props.query.toLowerCase())
        ? 0
        : -1;
  if (matchIndex < 0) {
    return <span>{props.label}</span>;
  }

  return (
    <span>
      {props.label.slice(0, matchIndex)}
      <span className="composer__autocomplete-match">
        {props.label.slice(matchIndex, matchIndex + props.query.length)}
      </span>
      {props.label.slice(matchIndex + props.query.length)}
    </span>
  );
}

function describeHashReferenceThread(
  thread: NavigationThreadSummary,
  query: string,
): string {
  const parts: string[] = [];
  const pullRequest = threadHasExactPrNumberMatch(thread, query)
    ? (thread.prs ?? []).find(
        (candidate) => candidate.number === Number(query.trim()),
      )
    : (thread.prs ?? [])[0];
  if (pullRequest) {
    parts.push(`#${pullRequest.number}`);
  }
  if (thread.gitBranch) {
    parts.push(thread.gitBranch);
  }
  const directory = (thread.linkedDirectories ?? [])[0];
  if (directory?.label) {
    parts.push(directory.label);
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  // The id is the last-resort disambiguator between same-named threads. A
  // thread with no title is already showing that same id as its label, so
  // repeating it here would just print the uuid twice.
  return collapseHashReferenceWhitespace(thread.title) ? thread.id : "";
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

function createComposerThreadToken(
  thread: ResolvedThreadLink,
  index: number,
): ComposerSkillToken {
  const path = buildThreadUrl({
    backend: thread.backend,
    ...(thread.instanceId ? { instanceId: thread.instanceId } : {}),
    threadId: thread.threadId,
  });
  return {
    kind: "thread",
    // Every thread chip is minted here — picker, pasted url, and the draft
    // rehydrate that rebuilds tokens from the live thread summary rather
    // than from the saved link text. Formatting at the choke point is what
    // makes the clamp survive a restore, and it makes the round trip
    // converge: `format` of an already-formatted title is itself.
    name: formatHashReferenceThreadLabel({
      id: thread.threadId,
      title: thread.title,
    }),
    path,
    id: `${path}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

function createComposerPullRequestToken(
  pullRequest: PrSummary,
  index: number,
): ComposerSkillToken {
  return {
    kind: "pull-request",
    name: `#${pullRequest.number}`,
    path: pullRequest.url,
    description: pullRequest.title,
    shortDescription: `${pullRequest.org}/${pullRequest.repo}`,
    id: `${pullRequest.url}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

function resolveThreadSummaryReference(
  thread: NavigationThreadSummary,
): ResolvedThreadLink {
  const federationTarget = thread.federation?.ref.target;
  return {
    backend: thread.source,
    ...(federationTarget && isRemoteFederationTarget(federationTarget)
      ? { instanceId: federationTarget.instanceId }
      : {}),
    threadId: thread.id,
    title: thread.title,
    titleSource: thread.titleSource,
    gitBranch: thread.gitBranch,
    linkedDirectories: thread.linkedDirectories,
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

/**
 * Paths carried by an explicit Composer reference. We intentionally do not
 * scan arbitrary text for filesystem-looking values: a tray attachment or an
 * `@` reference token is the user action that authorizes local inspection.
 */
function listExplicitComposerReferencePaths(
  fileRefs: ComposerFileAttachment[],
  skillTokens: ComposerSkillToken[],
): string[] {
  const paths = new Set<string>();
  const add = (rawPath: string | undefined): void => {
    const filePath = rawPath?.trim();
    if (
      filePath
      && (
        filePath.startsWith("/")
        || filePath.startsWith("\\\\")
        || /^[A-Za-z]:[\\/]/u.test(filePath)
      )
    ) {
      paths.add(filePath);
    }
  };

  for (const fileRef of fileRefs) {
    add(fileRef.path);
  }
  for (const token of skillTokens) {
    if (token.kind === "file" || token.kind === "directory") {
      add(token.path);
    }
  }
  return [...paths].sort();
}

function listComposerPdfReferences(params: {
  fileAttachments: ComposerFileAttachment[];
  pdfPaths: string[];
  skillTokens: ComposerSkillToken[];
}): ComposerPdfReference[] {
  const attachmentByPath = new Map(
    params.fileAttachments.map((attachment) => [attachment.path, attachment]),
  );
  const labelByPath = new Map<string, string>();
  for (const token of params.skillTokens) {
    if (
      (token.kind === "file" || token.kind === "directory")
      && token.path
      && !labelByPath.has(token.path)
    ) {
      labelByPath.set(token.path, token.name);
    }
  }

  return params.pdfPaths.map((path) => {
    const attachment = attachmentByPath.get(path);
    return {
      ...(attachment ? { attachmentId: attachment.id } : {}),
      label: attachment?.label ?? labelByPath.get(path) ?? fileLabelFromPath(path),
      path,
    };
  });
}

/**
 * Keep the normal markdown reference visible in the transcript, while also
 * preserving the explicit user selection for main-process document handling.
 * File-tray entries and file chips are known local files; a hydrated generic
 * `@` chip joins them only after the bounded main-process inspection confirms
 * it is a regular file.
 */
function buildLocalFileInputs(
  fileRefs: ComposerFileAttachment[],
  skillTokens: ComposerSkillToken[],
  inspectedFilePaths: Iterable<string> = [],
): Extract<AppServerTurnInputItem, { type: "localFile" }>[] {
  const inputsByPath = new Map<
    string,
    Extract<AppServerTurnInputItem, { type: "localFile" }>
  >();
  const inspectedPaths = new Set(inspectedFilePaths);
  const add = (name: string | undefined, rawPath: string | undefined): void => {
    const filePath = rawPath?.trim();
    if (!filePath || inputsByPath.has(filePath)) {
      return;
    }
    const label = name?.trim();
    inputsByPath.set(filePath, {
      type: "localFile",
      ...(label ? { name: label } : {}),
      path: filePath,
    });
  };

  for (const fileRef of fileRefs) {
    add(fileRef.label, fileRef.path);
  }
  for (const token of skillTokens) {
    if (
      token.kind === "file"
      || (token.kind === "directory" && inspectedPaths.has(token.path ?? ""))
    ) {
      add(token.name, token.path);
    }
  }
  return [...inputsByPath.values()];
}

function mergeDerivedLocalFileInputs(
  existingInput: AppServerTurnInputItem[] | undefined,
  derivedInput: AppServerTurnInputItem[],
): AppServerTurnInputItem[] {
  if (!existingInput?.length) {
    return derivedInput;
  }

  const localFilePaths = new Set<string>();
  const merged = existingInput.filter((item) => {
    if (item.type !== "localFile") {
      return true;
    }
    if (localFilePaths.has(item.path)) {
      return false;
    }
    localFilePaths.add(item.path);
    return true;
  });
  for (const item of derivedInput) {
    if (item.type === "localFile" && !localFilePaths.has(item.path)) {
      localFilePaths.add(item.path);
      merged.push(item);
    }
  }
  return merged;
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
    if (token.kind === "directory" || token.kind === "file") {
      output += buildDirectoryReferenceMarkdown({
        label: token.name,
        path: token.path ?? "",
      });
    } else if (token.kind === "thread") {
      const ref = parseThreadUrl(token.path ?? "");
      output += ref
        ? buildThreadMarkdownLink({ ...ref, title: token.name })
        : token.path ?? token.name;
    } else if (token.kind === "pull-request") {
      output += token.path
        ? `[${token.name}](${token.path})`
        : token.name;
    } else {
      output += buildSkillMentionMarkdown(token);
    }
    cursor = index;
  }

  output += draft.slice(cursor);
  return output;
}

function hydrateComposerDraft(
  canonicalDraft: string,
  skills: AppServerSkillSummary[],
  threadLinks: ThreadLinkContextValue | undefined,
): {
  draft: string;
  skillTokens: ComposerSkillToken[];
} {
  let draft = "";
  const skillTokens: ComposerSkillToken[] = [];

  const hydrateSkillAndDirectoryParts = (text: string): void => {
    for (const part of parseSkillMentionParts(text)) {
      if (part.type === "text") {
        draft += part.text;
        continue;
      }

      if (part.type === "directory") {
        // Serialized paths are percent-encoded tilde form; the token
        // carries the decoded absolute path so send-time attach can use
        // it directly. File-reference chips serialize to the same
        // `[@label](~/path)` form, so restored Markdown starts as a
        // generic reference chip. The bounded main-process inspection
        // upgrades regular files to `kind: "file"` without ever scanning
        // free-form typed paths.
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
  };

  // Thread and PR labels may legitimately begin with `$` or `@`, so recognize
  // their destinations before passing surrounding Markdown through the skill
  // and directory parser. Unknown links remain literal Markdown.
  const referenceLinkPattern = /\[((?:\\.|[^\]\\\r\n])*)\]\((pwragent:\/\/thread\/[^)\s]+|https:\/\/[^)\s]+)\)/gi;
  let cursor = 0;
  for (const match of canonicalDraft.matchAll(referenceLinkPattern)) {
    const matchIndex = match.index ?? 0;
    hydrateSkillAndDirectoryParts(canonicalDraft.slice(cursor, matchIndex));
    const href = match[2] ?? "";
    const resolvedThread = resolveThreadHref(href, threadLinks);
    if (resolvedThread) {
      skillTokens.push(createComposerThreadToken(resolvedThread, draft.length));
    } else {
      const pullRequest = parsePullRequestUrl(href);
      if (pullRequest) {
        skillTokens.push(
          createComposerPullRequestToken(pullRequest, draft.length),
        );
      } else {
        draft += match[0];
      }
    }
    cursor = matchIndex + match[0].length;
  }
  hydrateSkillAndDirectoryParts(canonicalDraft.slice(cursor));

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

function ComposerThreadOptionsMenu(props: {
  agentThread: boolean;
  disabled?: boolean;
  existingCodexThread?: boolean;
  onAgentThreadChange?: (agentThread: boolean) => void;
  onShowMcpInventory?: () => void;
  /**
   * Effective Token Miser state for this thread — the per-thread override when
   * one is set, else the global setting. Undefined hides the item (no Codex
   * thread to scope it to).
   */
  tokenMiser?: boolean;
  tokenMiserOverridden?: boolean;
  onTokenMiserChange?: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  const agentThreadChangeDisabled =
    props.disabled ||
    props.existingCodexThread ||
    !props.onAgentThreadChange;

  return (
    <div className="composer-thread-options" ref={ref}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Thread options"
        className={`composer__toggle tooltip-target${
          props.agentThread ? " is-active" : ""
        }`}
        data-tooltip={open ? undefined : "Thread options"}
        disabled={props.disabled}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVerticalIcon size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div
          aria-label="Thread options"
          className="composer-dropdown__menu composer-thread-options__menu"
          id={menuId}
          role="menu"
        >
          <div
            className="composer-thread-options__item tooltip-target"
            data-tooltip={
              props.existingCodexThread
                ? CODEX_AGENT_THREAD_CREATION_NOTE
                : AGENT_THREAD_CAPABILITIES
            }
          >
            <button
              aria-checked={props.agentThread}
              className="composer-dropdown__option composer-thread-options__option"
              disabled={agentThreadChangeDisabled}
              role="menuitemcheckbox"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onAgentThreadChange?.(!props.agentThread);
              }}
            >
              <span className="composer-thread-options__label">Agent thread</span>
              <span
                aria-hidden="true"
                className={`composer-thread-options__toggle${
                  props.agentThread ? " is-checked" : ""
                }`}
              >
                <span className="composer-thread-options__toggle-thumb" />
              </span>
            </button>
          </div>
          {props.tokenMiser !== undefined && props.onTokenMiserChange ? (
            <div
              className="composer-thread-options__item tooltip-target"
              data-tooltip={
                "Summarize large tool results with a helper model before they "
                + "enter this thread's context. Saves context and replay cost; "
                + "each gated result adds a helper round trip to the turn."
                + (props.tokenMiserOverridden
                  ? " This thread overrides the global setting."
                  : "")
              }
            >
              <button
                aria-checked={props.tokenMiser}
                className="composer-dropdown__option composer-thread-options__option"
                disabled={props.disabled}
                role="menuitemcheckbox"
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onTokenMiserChange?.(!props.tokenMiser);
                }}
              >
                <span className="composer-thread-options__label">
                  Token Miser
                  {props.tokenMiserOverridden ? (
                    <span className="composer-thread-options__note"> · this thread</span>
                  ) : null}
                </span>
                <span
                  aria-hidden="true"
                  className={`composer-thread-options__toggle${
                    props.tokenMiser ? " is-checked" : ""
                  }`}
                >
                  <span className="composer-thread-options__toggle-thumb" />
                </span>
              </button>
            </div>
          ) : null}
          {props.onShowMcpInventory ? (
            <>
              <div className="composer-dropdown__separator" role="separator" />
              <button
                className="composer-dropdown__option composer-thread-options__option"
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onShowMcpInventory?.();
                }}
              >
                <span className="composer-thread-options__label">MCP tools</span>
              </button>
            </>
          ) : null}
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
  /**
   * Display text for rows whose `name` is a sentinel rather than a branch
   * (the handoff dialog's `"HEAD"` → "Detached HEAD"). Falls back to `name`.
   */
  label?: string;
  /**
   * Hold the row above the recency-ordered list no matter what is selected.
   * A sentinel row has no commit date, so recency ordering would drop it in
   * an arbitrary spot once the operator picks a real branch.
   */
  pinned?: boolean;
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
  const [menuWidthLimit, setMenuWidthLimit] = useState<number>();
  const listboxId = useId();
  const selectedLabelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuShiftRef = useRef(0);
  const menuWidthLimitRef = useRef<number | undefined>(undefined);
  const naturalMenuWidthRef = useRef(0);
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));

  const normalizedQuery = query.trim().toLowerCase();
  // Pin the anchor branches — caller-pinned sentinels, the one you'll branch
  // off (selected), the repo default, and the checked-out branch — to the top,
  // deduped in that priority order. Everything else follows in recency order.
  // When the three anchors are the same branch (the common case) this is a
  // single pinned row.
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
    for (const option of props.options) {
      if (option.pinned) {
        addPin(option);
      }
    }
    addPin(byName.get(props.value));
    addPin(props.options.find((option) => option.isDefault));
    addPin(props.options.find((option) => option.current));
    const rest = props.options.filter((option) => !pinnedNames.has(option.name));
    return { pinnedOptions: pinned, restOptions: rest };
  }, [props.options, props.value]);

  const matchesQuery = (option: LaunchpadBranchOption): boolean =>
    !normalizedQuery
    || option.name.toLowerCase().includes(normalizedQuery)
    || Boolean(option.label?.toLowerCase().includes(normalizedQuery));
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
  // the composer toolbar. In the launchpad, keep it inside the settings row so
  // it cannot extend beneath the thread sidebar; dialog uses fall back to the
  // viewport gutters. Runs before paint so there's no visible jump, and
  // re-clamps on resize while open.
  useLayoutEffect(() => {
    if (!open) {
      menuShiftRef.current = 0;
      menuWidthLimitRef.current = undefined;
      naturalMenuWidthRef.current = 0;
      setMenuShift(0);
      setMenuWidthLimit(undefined);
      return;
    }
    const clamp = (): void => {
      const menu = menuRef.current;
      if (!menu) {
        return;
      }
      const gutter = 12;
      const rect = menu.getBoundingClientRect();
      const composerSetup = menu.closest<HTMLElement>(".composer__setup");
      const composerBounds = composerSetup?.getBoundingClientRect();
      const leftBoundary = Math.max(gutter, composerBounds?.left ?? gutter);
      const rightBoundary = Math.max(
        leftBoundary,
        Math.min(
          window.innerWidth - gutter,
          composerBounds?.right ?? window.innerWidth - gutter,
        ),
      );
      const availableWidth = Math.max(0, rightBoundary - leftBoundary);
      naturalMenuWidthRef.current = Math.max(
        naturalMenuWidthRef.current,
        rect.width,
      );
      const targetWidth = Math.min(
        naturalMenuWidthRef.current,
        availableWidth,
      );
      const nextWidthLimit =
        targetWidth < naturalMenuWidthRef.current ? targetWidth : undefined;
      const unshiftedRight = rect.right - menuShiftRef.current;
      const unshiftedLeft = unshiftedRight - targetWidth;
      const maxLeft = rightBoundary - targetWidth;
      const targetLeft = Math.min(
        Math.max(unshiftedLeft, leftBoundary),
        maxLeft,
      );
      const nextShift = targetLeft - unshiftedLeft;

      if (menuWidthLimitRef.current !== nextWidthLimit) {
        menuWidthLimitRef.current = nextWidthLimit;
        setMenuWidthLimit(nextWidthLimit);
      }
      if (menuShiftRef.current !== nextShift) {
        menuShiftRef.current = nextShift;
        setMenuShift(nextShift);
      }
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
        aria-label={option.label ?? option.name}
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
        <span className="branch-picker__option-name">
          {option.label ?? option.name}
        </span>
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
        // `aria-label` is the field name and overrides the button's content in
        // the accessible-name computation, so without this the selected branch
        // is never announced — the native <select> this replaced did announce
        // its value. Describes rather than renames so by-name queries hold.
        aria-describedby={selectedLabelId}
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
        <span className="composer-dropdown__label" id={selectedLabelId}>
          {selectedOption?.label ?? selectedOption?.name ?? props.value}
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
            menuShift || menuWidthLimit !== undefined
              ? {
                  ...(menuShift
                    ? { transform: `translateX(${menuShift}px)` }
                    : {}),
                  ...(menuWidthLimit !== undefined
                    ? {
                        maxWidth: `${menuWidthLimit}px`,
                        minWidth: `${menuWidthLimit}px`,
                      }
                    : {}),
                }
              : undefined
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
            // Not bare `ariaLabel` — that name belongs to the trigger, and
            // duplicating it makes every by-name query ambiguous while the
            // menu is open. Mirrors ReviewBranchPicker.
            aria-label={`${props.ariaLabel} options`}
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
  const threadLinks = useThreadLinks();
  const rendererFederationTarget = readRendererFederationTarget();
  const filesystemFederationTarget =
    props.thread?.federation?.ref.target
    ?? props.launchpad?.federationTarget
    ?? rendererFederationTarget;
  const filesystemAuthorityKey = filesystemFederationTarget?.scope === "remote"
    ? `remote:${filesystemFederationTarget.instanceId}`
    : "local";
  const recentFileAuthorityKeyRef = useRef(filesystemAuthorityKey);
  recentFileAuthorityKeyRef.current = filesystemAuthorityKey;
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
  const hashReferenceListboxId = useId();
  const hydratedLaunchpadKeyRef = useRef<string | undefined>(undefined);
  const activeAcpLaunchpadRefreshKeyRef = useRef<string | undefined>(undefined);
  const pendingProviderSelectionKeyRef = useRef<string | undefined>(undefined);
  const latestLaunchpadRef =
    useRef<NavigationLaunchpadDraft | undefined>(props.launchpad);
  latestLaunchpadRef.current = props.launchpad;
  const desktopApiRef = useRef(props.desktopApi);
  desktopApiRef.current = props.desktopApi;
  const referenceInspector = props.desktopApi?.inspectPdfReferencePaths;
  const pendingProgrammaticComposerChangeRef =
    useRef<PendingProgrammaticComposerChange | undefined>(undefined);
  const composerScopeKey = props.launchpad
    ? `launchpad:${props.launchpad.directoryKey}`
    : props.thread
      ? buildThreadComposerScopeKey(props.thread.source, props.thread.id)
      : "empty";
  const prAutoDispatchPending = props.thread?.prAutoDispatchPending;
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
      : hydrateComposerDraft(
          props.launchpad.prompt ?? "",
          props.skills,
          threadLinks,
        );
  const activeComposerScopeKeyRef = useRef(composerScopeKey);
  const pasteScopeRef = useRef({ key: composerScopeKey, version: 0 });
  const pendingDraftRetargetRef = useRef<
    | {
        snapshot: ComposerDraftSnapshot;
        sourceScopeKey: string;
        targetScopeKey: string;
      }
    | undefined
  >(undefined);
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
  const [recentFileReferenceState, setRecentFileReferenceState] = useState<{
    authorityKey: string;
    files: ReferencePickerFile[];
  }>({ authorityKey: filesystemAuthorityKey, files: [] });
  const recentFileReferences =
    recentFileReferenceState.authorityKey === filesystemAuthorityKey
      ? recentFileReferenceState.files
      : [];
  // The state only schedules the next countdown render. It must not be used as
  // the clock itself: a newly received schedule can arrive long after the
  // previous tick, briefly making its first countdown look much too long.
  const [scheduleTick, setScheduleTick] = useState(0);
  const scheduleNow = Date.now();
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
  // React state only drives presentation. This ref synchronously suppresses
  // duplicate renderer calls; the registry request ID provides the durable
  // idempotency boundary shared with messaging.
  const steeringRequestIdRef = useRef<string | undefined>(undefined);
  const pendingSteerAutoAdmissionAttemptIdRef = useRef<string | undefined>(
    undefined,
  );
  const [queuedTurns, setQueuedTurnsState] = useState<QueuedTurnDraft[]>(
    savedInitialQueuedTurns ?? []
  );
  const queuedAutoReleaseAttemptIdRef = useRef<string | undefined>(undefined);
  const queueCurrentDraftInFlightRef = useRef(false);
  const pendingSteerCreationInFlightRef = useRef(false);
  const turnPayloadPreparationInFlightRef = useRef(false);
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
  const [agentThreadError, setAgentThreadError] = useState<string>();
  const [agentThreadSaving, setAgentThreadSaving] = useState(false);
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
  const referenceInspectionCacheRef = useRef(
    new Map<string, ComposerReferencePathInspection>(),
  );
  const referenceInspectionInFlightRef = useRef(new Map<string, Promise<void>>());
  const [inspectedPdfReferencePaths, setInspectedPdfReferencePaths] =
    useState<string[]>([]);
  // Preview pages are intentionally renderer-only state. Draft snapshots keep
  // only paths, and turn payload construction never reads this map.
  const [composerPdfPreviewStates, setComposerPdfPreviewStates] = useState(
    () => new Map<string, ComposerPdfPreviewState>(),
  );
  const composerPdfPreviewStatesRef = useRef(composerPdfPreviewStates);
  composerPdfPreviewStatesRef.current = composerPdfPreviewStates;
  const composerPdfPreviewRequestIdsRef = useRef(new Map<string, number>());
  const [pdfPreviewLightbox, setPdfPreviewLightbox] = useState<{
    label: string;
    path: string;
    preview: ComposerPdfPreview;
  }>();
  const [composerSelectionRequest, setComposerSelectionRequest] = useState<{
    id: string;
    index: number;
  }>();
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [activeDirectoryRefIndex, setActiveDirectoryRefIndex] = useState(0);
  const [activeHashReferenceIndex, setActiveHashReferenceIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string>();

  useEffect(() => {
    setAgentThreadError(undefined);
    setAgentThreadSaving(false);
  }, [composerScopeKey]);

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
  // Tagged with the owning instance the same way recent file references are:
  // a combination remembered on another instance names models that instance
  // has, so a response that lands after the thread changed must not paint.
  const [reviewerRecentsState, setReviewerRecentsState] = useState<{
    authorityKey: string;
    recents: ModelSettingsRecent[];
  }>({ authorityKey: "local", recents: [] });
  const reviewerAuthorityKeyRef = useRef("local");
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
  const supportsMcpInventory =
    !isLaunchpad
    && props.thread?.source === "codex"
    && Boolean(props.onShowMcpInventory);

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
  const canonicalReferenceTokens = useMemo(
    () => hydrateComposerDraft(canonicalDraft, props.skills, threadLinks).skillTokens,
    [canonicalDraft, props.skills, threadLinks],
  );
  const explicitReferencePaths = useMemo(
    () =>
      listExplicitComposerReferencePaths(fileAttachments, [
        ...skillTokens,
        ...canonicalReferenceTokens,
      ]),
    [canonicalReferenceTokens, fileAttachments, skillTokens],
  );
  const explicitReferencePathsKey = explicitReferencePaths.join("\u0000");
  const explicitReferenceTokenKey = useMemo(
    () =>
      [...skillTokens, ...canonicalReferenceTokens]
        .filter(
          (token) => token.kind === "file" || token.kind === "directory",
        )
        .map(
          (token) =>
            [token.kind, token.name, token.path ?? ""].join("\u0001"),
        )
        .sort()
        .join("\u0000"),
    [canonicalReferenceTokens, skillTokens],
  );
  const explicitReferencePathsRef = useRef(explicitReferencePaths);
  explicitReferencePathsRef.current = explicitReferencePaths;
  // Only the main-process magic-byte check identifies a PDF. In particular,
  // a regular file named `.pdf` must not opt into PDF preparation by suffix.
  const pdfReferencePaths = useMemo(() => {
    const explicitPaths = new Set(explicitReferencePaths);
    return inspectedPdfReferencePaths.filter((path) => explicitPaths.has(path));
  }, [explicitReferencePaths, inspectedPdfReferencePaths]);
  const inspectExplicitReferencePaths = useCallback(
    (
      paths: string[],
    ): ComposerReferenceInspection | Promise<ComposerReferenceInspection> => {
      const candidates = [...new Set(
        paths
          .map((path) => path.trim())
          .filter(Boolean),
      )].sort();
      if (candidates.length === 0) {
        return EMPTY_COMPOSER_REFERENCE_INSPECTION;
      }
      if (filesystemFederationTarget) {
        return EMPTY_COMPOSER_REFERENCE_INSPECTION;
      }

      const cache = referenceInspectionCacheRef.current;
      const inFlight = referenceInspectionInFlightRef.current;
      const inspector = desktopApiRef.current?.inspectPdfReferencePaths;
      const pathsToInspect: string[] = [];
      for (const candidate of candidates) {
        if (!cache.has(candidate) && !inFlight.has(candidate)) {
          pathsToInspect.push(candidate);
        }
      }

      if (inspector && pathsToInspect.length > 0) {
        const requestedPaths = [...pathsToInspect];
        const requestedPathSet = new Set(requestedPaths);
        const inspection = Promise.resolve()
          .then(async () => await inspector({ paths: requestedPaths }))
          .then((response) => {
            // `pdfPaths` is necessarily a file subset. Accepting it here also
            // keeps a renderer/main pair from adjacent app builds graceful
            // while the richer `filePaths` response rolls out.
            const returnedFilePaths = new Set(
              [
                ...(response.filePaths ?? []),
                ...response.pdfPaths,
              ].filter((path) => requestedPathSet.has(path)),
            );
            const returnedPdfPaths = new Set(
              response.pdfPaths.filter((path) => requestedPathSet.has(path)),
            );
            for (const path of requestedPaths) {
              cache.set(path, {
                isFile: returnedFilePaths.has(path),
                isPdf: returnedPdfPaths.has(path),
              });
            }
          })
          .catch(() => {
            for (const path of requestedPaths) {
              cache.set(path, { isFile: false, isPdf: false });
            }
          })
          .finally(() => {
            for (const path of requestedPaths) {
              if (inFlight.get(path) === inspection) {
                inFlight.delete(path);
              }
            }
          });
        for (const path of requestedPaths) {
          inFlight.set(path, inspection);
        }
      }

      const pendingInspections = [
        ...new Set(
          candidates
            .map((path) => inFlight.get(path))
            .filter((inspection): inspection is Promise<void> => Boolean(inspection)),
        ),
      ];
      const readCachedInspection = (): ComposerReferenceInspection => ({
        filePaths: candidates.filter((path) => cache.get(path)?.isFile),
        pdfPaths: candidates.filter((path) => cache.get(path)?.isPdf),
      });
      return pendingInspections.length > 0
        ? Promise.all(pendingInspections).then(readCachedInspection)
        : readCachedInspection();
    },
    [],
  );
  useEffect(() => {
    if (!explicitReferencePathsKey) {
      setInspectedPdfReferencePaths([]);
      return;
    }

    // Keep already-confirmed paths that remain explicit while a restored,
    // queued, or steer draft rehydrates its chips. That lets the ephemeral
    // preview state revalidate its file identity instead of flashing away
    // during a token-only rewrite; removed paths are filtered synchronously
    // by `pdfReferencePaths` above.
    setInspectedPdfReferencePaths((current) =>
      current.filter((path) => explicitReferencePathsRef.current.includes(path)),
    );
    let cancelled = false;
    void Promise.resolve(
      inspectExplicitReferencePaths(explicitReferencePathsRef.current),
    ).then((inspection) => {
      if (cancelled) {
        return;
      }
      setInspectedPdfReferencePaths(inspection.pdfPaths);
      if (inspection.filePaths.length === 0) {
        return;
      }
      const filePaths = new Set(inspection.filePaths);
      setSkillTokens((current) => {
        let changed = false;
        const next = current.map((token) => {
          if (
            token.kind !== "directory"
            || !token.path
            || !filePaths.has(token.path)
          ) {
            return token;
          }
          changed = true;
          return { ...token, kind: "file" as const };
        });
        return changed ? next : current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    explicitReferencePathsKey,
    explicitReferenceTokenKey,
    inspectExplicitReferencePaths,
    referenceInspector,
  ]);
  const pdfReferencePathsRef = useRef(pdfReferencePaths);
  pdfReferencePathsRef.current = pdfReferencePaths;
  const pdfReferencePathSetRef = useRef(new Set<string>());
  pdfReferencePathSetRef.current = new Set(pdfReferencePaths);
  const pdfPreviewReferences = useMemo(
    () =>
      listComposerPdfReferences({
        fileAttachments,
        pdfPaths: pdfReferencePaths,
        skillTokens: [...skillTokens, ...canonicalReferenceTokens],
      }),
    [canonicalReferenceTokens, fileAttachments, pdfReferencePaths, skillTokens],
  );
  const pdfPreviewPathsKey = pdfPreviewReferences
    .map((reference) => reference.path)
    .join("\u0000");
  const pdfPreviewHydrationKey = useMemo(
    () =>
      [
        composerScopeKey,
        ...fileAttachments.map((attachment) =>
          [attachment.id, attachment.label, attachment.path].join("\u0001"),
        ),
        ...skillTokens
          .filter(
            (token) => token.kind === "file" || token.kind === "directory",
          )
          .map((token) =>
            [token.id, token.index, token.kind, token.path ?? ""].join("\u0001"),
          ),
      ]
        .sort()
        .join("\u0000"),
    [composerScopeKey, fileAttachments, skillTokens],
  );
  const updateComposerPdfPreviewState = useCallback(
    (path: string, state: ComposerPdfPreviewState | undefined): void => {
      const next = new Map(composerPdfPreviewStatesRef.current);
      if (state) {
        next.set(path, state);
      } else {
        next.delete(path);
      }
      composerPdfPreviewStatesRef.current = next;
      setComposerPdfPreviewStates(next);
    },
    [],
  );
  const requestComposerPdfPreview = useCallback(
    async (path: string): Promise<void> => {
      if (!pdfReferencePathSetRef.current.has(path)) {
        return;
      }

      const current = composerPdfPreviewStatesRef.current.get(path);
      if (
        current?.status === "loading"
        || (current?.status === "ready" && current.refreshing)
      ) {
        return;
      }

      const requestId =
        (composerPdfPreviewRequestIdsRef.current.get(path) ?? 0) + 1;
      composerPdfPreviewRequestIdsRef.current.set(path, requestId);
      updateComposerPdfPreviewState(
        path,
        current?.status === "ready"
          ? { ...current, refreshing: true }
          : { status: "loading" },
      );

      const renderer = desktopApiRef.current?.renderComposerPdfPreview;
      if (!renderer) {
        updateComposerPdfPreviewState(path, {
          message: "Preview unavailable",
          status: "error",
        });
        return;
      }

      try {
        const response = await renderer({
          ...(current?.status === "ready"
            ? { knownFileIdentity: current.preview.fileIdentity }
            : {}),
          path,
        });
        if (
          composerPdfPreviewRequestIdsRef.current.get(path) !== requestId
          || !pdfReferencePathSetRef.current.has(path)
        ) {
          return;
        }

        if (response.unchanged) {
          if (current?.status === "ready") {
            updateComposerPdfPreviewState(path, {
              ...current,
              refreshing: false,
            });
          } else {
            updateComposerPdfPreviewState(path, {
              message: "Preview unavailable",
              status: "error",
            });
          }
          return;
        }

        updateComposerPdfPreviewState(path, {
          preview: response,
          refreshing: false,
          status: "ready",
        });
      } catch {
        if (
          composerPdfPreviewRequestIdsRef.current.get(path) === requestId
          && pdfReferencePathSetRef.current.has(path)
        ) {
          updateComposerPdfPreviewState(path, {
            message: "Preview unavailable",
            status: "error",
          });
        }
      }
    },
    [updateComposerPdfPreviewState],
  );
  useEffect(() => {
    const allowedPaths = new Set(pdfReferencePaths);
    const current = composerPdfPreviewStatesRef.current;
    const next = new Map(
      [...current].filter(([path]) => allowedPaths.has(path)),
    );
    if (next.size !== current.size) {
      composerPdfPreviewStatesRef.current = next;
      setComposerPdfPreviewStates(next);
    }
    setPdfPreviewLightbox((lightbox) =>
      lightbox && !allowedPaths.has(lightbox.path) ? undefined : lightbox,
    );
  }, [pdfPreviewPathsKey, pdfReferencePaths]);
  useEffect(() => {
    if (props.pdfAnalysisEnabled === false || pdfPreviewPathsKey.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      for (const path of pdfReferencePathsRef.current) {
        if (cancelled) {
          return;
        }
        await requestComposerPdfPreview(path);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    pdfPreviewHydrationKey,
    pdfPreviewPathsKey,
    props.pdfAnalysisEnabled,
    requestComposerPdfPreview,
  ]);
  useEffect(() => {
    if (props.pdfAnalysisEnabled === false || pdfPreviewPathsKey.length === 0) {
      return;
    }

    // A PDF can change in another app while PwrAgent is unfocused. Main compares
    // the opaque file identity before retaining this renderer-only raster.
    const revalidate = (): void => {
      void (async () => {
        for (const path of pdfReferencePathsRef.current) {
          await requestComposerPdfPreview(path);
        }
      })();
    };
    window.addEventListener("focus", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
    };
  }, [pdfPreviewPathsKey, props.pdfAnalysisEnabled, requestComposerPdfPreview]);
  const hasComposerContent =
    draft.trim().length > 0 || skillTokens.length > 0;
  const queuedTurn = queuedTurns[0];
  const nextReleasableQueuedTurn = getNextReleasableQueuedTurn(queuedTurns);
  const futureScheduledDraftSendAt = getFutureScheduledSendAt(
    scheduledDraftSendAt,
    scheduleNow,
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
    const hydrated = hydrateComposerDraft(nextDraft, props.skills, threadLinks);
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
  const hasComposerDraftSnapshotContent = (
    snapshot: ComposerDraftSnapshot,
  ): boolean =>
    Boolean(
      snapshot.draft.trim()
      || snapshot.skillTokens.length > 0
      || snapshot.imageAttachments.length > 0
      || (snapshot.fileAttachments?.length ?? 0) > 0,
    );
  const prepareDraftRetarget = (directoryKey: string): void => {
    const targetScopeKey = `launchpad:${directoryKey}`;
    const latest = latestDraftSnapshotRef.current;
    if (
      latest.scopeKey === targetScopeKey
      || !latest.scopeKey.startsWith("launchpad:")
      || !hasComposerDraftSnapshotContent(latest.snapshot)
    ) {
      pendingDraftRetargetRef.current = undefined;
      return;
    }

    pendingDraftRetargetRef.current = {
      snapshot: latest.snapshot,
      sourceScopeKey: latest.scopeKey,
      targetScopeKey,
    };
  };
  const resetComposerDraftAndState = (
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

    // Shared with the store's draft-presence tracking, so "the composer is
    // empty" and "this thread has no draft" can never diverge.
    if (!hasComposerDraftContent(state)) {
      const previous = latestDraftSnapshotRef.current;
      if (
        previous.scopeKey === scopeKey &&
        hasComposerDraftContent(previous.snapshot)
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
  /**
   * Discard the draft for `scopeKey` without destroying it: park whatever the
   * user composed in the recovery journal as "abandoned" (so ArrowUp can bring
   * it straight back), then reset the store AND the live component state.
   * Cancelling a launchpad should empty the composer, not lose the message.
   *
   * The record check mirrors the abandon path in `saveComposerDraftSnapshot` —
   * the live snapshot is re-stamped on every render, so it is current at click
   * time. It reuses the same `resetComposerDraftAndState` the submit path calls,
   * so a cancelled draft can't linger in local React state and get re-persisted
   * into the next scope if this Composer instance is ever reused rather than
   * remounted.
   */
  const abandonComposerDraftSnapshot = (scopeKey: string): void => {
    const latest = latestDraftSnapshotRef.current;
    if (
      latest.scopeKey === scopeKey
      && (latest.snapshot.draft.trim()
        || latest.snapshot.skillTokens.length > 0
        || latest.snapshot.imageAttachments.length > 0)
    ) {
      recordComposerDraftHistory(scopeKey, latest.snapshot, "abandoned");
    }
    resetComposerDraftAndState(scopeKey);
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
        kind: token.kind,
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
  const restoreSubmittedComposerDraftInScope = (
    scopeKey: string,
    snapshot: ComposerDraftSnapshot,
  ): boolean => {
    if (activeComposerScopeKeyRef.current === scopeKey) {
      return recoverSubmittedComposerDraft(snapshot);
    }

    const current = draftStore.get(scopeKey);
    if (current && hasComposerDraftSnapshotContent(current)) {
      draftStore.pushDraft(scopeKey, snapshot);
      return false;
    }
    saveComposerDraftSnapshot(scopeKey, snapshot);
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
  const enqueueQueuedTurn = (nextQueuedTurn: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = [...current, nextQueuedTurn];
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const enqueueQueuedTurnInScope = (
    scopeKey: string,
    nextQueuedTurn: QueuedTurnDraft,
  ): void => {
    const current = draftStore.getQueuedTurns(scopeKey);
    const nextQueuedTurns = [...current, nextQueuedTurn];
    saveQueuedTurnSnapshots(scopeKey, nextQueuedTurns);
    if (activeComposerScopeKeyRef.current === scopeKey) {
      setQueuedTurnsState(nextQueuedTurns);
    }
  };
  const upsertScheduledProjectionInScope = (
    scopeKey: string,
    projection: QueuedTurnDraft,
  ): void => {
    const current = draftStore.getQueuedTurns(scopeKey);
    const nextQueuedTurns = [
      ...current.filter(
        (candidate) =>
          candidate.scheduledActionId !== projection.scheduledActionId,
      ),
      projection,
    ];
    saveQueuedTurnSnapshots(scopeKey, nextQueuedTurns);
    if (activeComposerScopeKeyRef.current === scopeKey) {
      setQueuedTurnsState(nextQueuedTurns);
    }
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
  const updateQueuedTurnInScope = (
    scopeKey: string,
    queued: QueuedTurnDraft,
    update: (current: QueuedTurnDraft) => QueuedTurnDraft,
  ): void => {
    const current = draftStore.getQueuedTurns(scopeKey);
    const nextQueuedTurns = current.map((candidate) =>
      candidate.id === queued.id ? update(candidate) : candidate
    );
    saveQueuedTurnSnapshots(scopeKey, nextQueuedTurns);
    if (activeComposerScopeKeyRef.current === scopeKey) {
      setQueuedTurnsState(nextQueuedTurns);
    }
  };
  const removeQueuedTurnInScope = (
    scopeKey: string,
    queued: QueuedTurnDraft,
  ): void => {
    const current = draftStore.getQueuedTurns(scopeKey);
    const nextQueuedTurns = current.filter(
      (candidate) => candidate.id !== queued.id,
    );
    saveQueuedTurnSnapshots(scopeKey, nextQueuedTurns);
    if (activeComposerScopeKeyRef.current === scopeKey) {
      setQueuedTurnsState(nextQueuedTurns);
    }
  };
  const preserveCancelledQueuedTurnInScope = (
    scopeKey: string,
    queued: QueuedTurnDraft,
  ): void => {
    const current = draftStore.getQueuedTurns(scopeKey);
    const preserved = {
      ...queued,
      backendQueuePending: false,
      queueEntryId: undefined,
      scheduledActionId: undefined,
    };
    const nextQueuedTurns = current.some((candidate) => candidate.id === queued.id)
      ? current.map((candidate) =>
          candidate.id === queued.id ? preserved : candidate
        )
      : [...current, preserved];
    saveQueuedTurnSnapshots(scopeKey, nextQueuedTurns);
    if (activeComposerScopeKeyRef.current === scopeKey) {
      setQueuedTurnsState(nextQueuedTurns);
    }
  };
  const cancelServerManagedQueuedTurn = async (
    queued: QueuedTurnDraft,
    scopeKey = composerScopeKey,
  ): Promise<"cancelled" | "already_admitted" | "failed"> => {
    const reportError = (message: string): void => {
      if (activeComposerScopeKeyRef.current === scopeKey) {
        setSendError(message);
      }
    };
    if (queued.scheduledActionId) {
      if (!props.desktopApi?.cancelScheduledThreadAction) {
        reportError("Scheduled action cancellation is unavailable.");
        return "failed";
      }
      try {
        await props.desktopApi.cancelScheduledThreadAction({
          federationTarget: props.thread?.federation?.ref.target
            ?? rendererFederationTarget,
          id: queued.scheduledActionId,
        });
        return "cancelled";
      } catch (error) {
        reportError(error instanceof Error ? error.message : String(error));
        return "failed";
      }
    }
    if (!queued.queueEntryId) {
      return "cancelled";
    }
    if (!props.desktopApi?.cancelQueuedTurn) {
      reportError("Queued turn cancellation is unavailable.");
      return "failed";
    }
    try {
      const federationTarget =
        props.thread?.federation?.ref.target
        ?? readRendererFederationTarget();
      const response = await props.desktopApi.cancelQueuedTurn({
        ...(federationTarget ? { federationTarget } : {}),
        queueEntryId: queued.queueEntryId,
      });
      if (!response.cancelled) {
        if (response.disposition === "already_admitted") {
          // The owner records admission before awaiting backend startup so a
          // second cancellation cannot race back into the FIFO. Until startup
          // returns a turn id, however, this draft is still the recovery copy
          // for a possible failed lifecycle event. Keep it visible and durable
          // until `started` or `failed` resolves the admission.
          if (response.turnId) {
            removeQueuedTurnInScope(scopeKey, queued);
          }
          if (activeComposerScopeKeyRef.current === scopeKey) {
            setSendError(undefined);
          }
          return "already_admitted";
        }
        reportError("The queued turn is no longer waiting.");
        return "failed";
      }
      return "cancelled";
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
      return "failed";
    }
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
    const hasPendingPrAutoDispatch = Boolean(
      prAutoDispatchPending
      && getFutureScheduledSendAt(prAutoDispatchPending.scheduledAt),
    );
    if (
      !futureScheduledDraftSendAt
      && !hasFutureScheduledQueue
      && !hasPendingPrAutoDispatch
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setScheduleTick((current) => current + 1);
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [futureScheduledDraftSendAt, prAutoDispatchPending, queuedTurns]);

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
    const emptySnapshot = createEmptyComposerDraftSnapshot();

    const latest = latestDraftSnapshotRef.current;
    if (latest.scopeKey === scopeKey) {
      recordComposerDraftHistory(scopeKey, latest.snapshot, "sent");
    }
    clearComposerDraftSnapshot(scopeKey);
    const restoredSnapshot = draftStore.popDraft(scopeKey);
    submittedDraftScopeKeysRef.current.delete(scopeKey);
    if (restoredSnapshot) {
      pendingProgrammaticComposerChangeRef.current = {
        expectedDraft: restoredSnapshot.draft,
        expectedSkillTokensSignature: getComposerSkillTokensSignature(
          restoredSnapshot.skillTokens,
        ),
        staleDraft: latest.snapshot.draft,
        staleSkillTokensSignature: getComposerSkillTokensSignature(
          latest.snapshot.skillTokens,
        ),
      };
      saveComposerDraftSnapshot(scopeKey, restoredSnapshot);
      latestDraftSnapshotRef.current = {
        scopeKey,
        snapshot: restoredSnapshot,
      };
      setDraft(restoredSnapshot.draft);
      setEditorDocument(restoredSnapshot.editorDocument);
      setImageAttachments(restoredSnapshot.imageAttachments);
      setFileAttachments(restoredSnapshot.fileAttachments ?? []);
      setSkillTokens(restoredSnapshot.skillTokens);
      return;
    }
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
      editorDocument:
        snapshot.editorDocument as Record<string, unknown> | undefined,
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
  // `#` is the one trigger whose query spans spaces — thread titles have
  // spaces in them — so unlike `@` and `$` nothing retires it. Left alone,
  // a `#` anywhere in a sentence keeps the picker armed and the federated
  // search re-firing for the whole rest of the line. Anchors that have
  // gone cold are remembered here and their `#` reads as prose again.
  const [coldHashAnchors, setColdHashAnchors] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const rawHashReferenceTrigger = findHashReferenceTrigger(draft, selectionStart);
  const rawHashReferenceQuery = rawHashReferenceTrigger?.query;
  const hashReferenceTrigger =
    rawHashReferenceTrigger
    && !coldHashAnchors.has(hashReferenceAnchorKey(rawHashReferenceTrigger.query))
      ? rawHashReferenceTrigger
      : undefined;
  const {
    available: federatedHashSearchAvailable,
    loading: federatedHashSearchLoading,
    results: federatedHashSearchResults,
    settledQuery: federatedHashSearchSettledQuery,
  } = useFederatedThreadSearch({
    query: hashReferenceTrigger?.query ?? "",
    limit: FEDERATED_THREAD_SEARCH_LIMIT,
    search: props.desktopApi?.jumpSearchRemoteThreads,
  });
  // Have the peers answered about *this* query? `loading` is set inside
  // the hook's effect, so for one commit after a keystroke it still reads
  // `false` while holding the previous query's results — long enough for
  // a retirement check to mistake it for a settled empty answer and kill
  // the anchor before the search ever left the building.
  const federatedHashSearchSettled =
    !federatedHashSearchAvailable
    || (!federatedHashSearchLoading
      && federatedHashSearchSettledQuery === (rawHashReferenceQuery ?? "").trim());
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
    const localCommands = supportsReview ? [...SLASH_COMMANDS] : [];
    if (supportsMcpInventory) {
      localCommands.push(...CODEX_MCP_SLASH_COMMANDS);
    }
    return [...localCommands, ...commands];
  }, [
    props.backends,
    props.providerCommands,
    supportsMcpInventory,
    supportsReview,
  ]);
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
  const filteredHashReferenceOptions = useMemo(() => {
    if (!hashReferenceTrigger) {
      return [];
    }
    // Referencing the thread you are writing in tells the agent nothing it
    // does not already have, and on a bare `#` the current thread is the
    // most recently updated one — so it would otherwise take the first row.
    const currentThreadKey = props.thread
      ? buildThreadIdentityKey(props.thread.source, props.thread.id)
      : undefined;
    const isCurrentThread = (thread: NavigationThreadSummary): boolean =>
      currentThreadKey !== undefined
      && buildThreadIdentityKey(thread.source, thread.id) === currentThreadKey;
    const localCandidates = filterHashReferenceCandidates(
      (props.threads ?? []).filter((thread) => !isCurrentThread(thread)),
      hashReferenceTrigger.query,
    );
    const localThreadKeys = new Set(
      (props.threads ?? []).map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    );
    const remoteCandidates = filterHashReferenceCandidates(
      federatedHashSearchResults.filter(
        (thread) =>
          thread.federation?.ref.target.scope === "remote"
          && !isCurrentThread(thread)
          && !localThreadKeys.has(
            buildThreadIdentityKey(thread.source, thread.id),
          ),
      ),
      hashReferenceTrigger.query,
    );
    const localPullRequestKeys = new Set(
      localCandidates.pullRequests.map(buildPullRequestStatusKey),
    );
    return [
      ...localCandidates.threads.map((thread) => ({
        kind: "thread" as const,
        remote: false,
        thread,
      })),
      ...localCandidates.pullRequests.map((pullRequest) => ({
        kind: "pull-request" as const,
        pullRequest,
        remote: false,
      })),
      ...remoteCandidates.threads.map((thread) => ({
        kind: "thread" as const,
        remote: true,
        thread,
      })),
      ...remoteCandidates.pullRequests
        .filter(
          (pullRequest) =>
            !localPullRequestKeys.has(buildPullRequestStatusKey(pullRequest)),
        )
        .map((pullRequest) => ({
          kind: "pull-request" as const,
          pullRequest,
          remote: true,
        })),
    ];
  }, [
    federatedHashSearchResults,
    hashReferenceTrigger,
    props.thread?.id,
    props.thread?.source,
    props.threads,
  ]);
  const hashReferenceCount = filteredHashReferenceOptions.length;
  const availableAutocompleteKind: AutocompleteKind | undefined = trigger && filteredSkills.length > 0
    ? "skills"
    : slashTrigger && filteredSlashCommands.length > 0
      ? "slash"
      : directoryRefTrigger && filteredDirectoryRefs.length > 0
        ? "directories"
        : hashReferenceTrigger
            && (hashReferenceCount > 0 || federatedHashSearchLoading)
          ? "hash-references"
          : undefined;
  const autocompleteKey =
    availableAutocompleteKind === "skills" && trigger
      ? `skills:${trigger.start}:${trigger.end}:${trigger.query}`
      : availableAutocompleteKind === "slash" && slashTrigger
        ? `slash:${slashTrigger.start}:${slashTrigger.end}:/${slashTrigger.query}`
        : availableAutocompleteKind === "directories" && directoryRefTrigger
          ? `directories:${directoryRefTrigger.start}:${directoryRefTrigger.end}:@${directoryRefTrigger.query}`
          : availableAutocompleteKind === "hash-references" && hashReferenceTrigger
            ? `hash-references:${hashReferenceTrigger.start}:${hashReferenceTrigger.end}:#${hashReferenceTrigger.query}`
          : undefined;
  const displayedAutocompleteKind =
    autocompleteKey && autocompleteKey === dismissedAutocompleteKey
      ? undefined
      : availableAutocompleteKind;
  const autocompleteKind: AutocompleteKind | undefined = reviewConfig
    ? undefined
    : displayedAutocompleteKind;
  const activeAutocompleteIndex =
    autocompleteKind === "skills"
      ? activeSkillIndex
      : autocompleteKind === "directories"
        ? activeDirectoryRefIndex
        : autocompleteKind === "hash-references"
          ? activeHashReferenceIndex
          : activeSlashIndex;
  const autocompleteLength =
    autocompleteKind === "skills"
      ? filteredSkills.length
      : autocompleteKind === "directories"
        ? filteredDirectoryRefs.length
        : autocompleteKind === "hash-references"
          ? hashReferenceCount
          : filteredSlashCommands.length;
  const hasAutocompleteOptions = Boolean(
    autocompleteKind && autocompleteLength > 0,
  );
  const autocompleteListboxId =
    autocompleteKind === "skills"
      ? skillListboxId
      : autocompleteKind === "slash"
        ? slashListboxId
        : autocompleteKind === "directories"
          ? directoryRefListboxId
          : autocompleteKind === "hash-references"
            ? hashReferenceListboxId
          : undefined;
  const activeAutocompleteOptionId =
    autocompleteListboxId && autocompleteKind && autocompleteLength > 0
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
  const mcpInventoryDetail: CodexMcpInventoryDetail | undefined =
    supportsMcpInventory && draft.trim().toLowerCase() === "/mcp"
      ? "toolsAndAuthOnly"
      : supportsMcpInventory && draft.trim().toLowerCase() === "/mcp verbose"
        ? "full"
        : undefined;
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
    let refreshQueuedTurnsPending = false;
    let disposed = false;
    const unsubscribe = draftStore.subscribeQueuedTurns(() => {
      if (refreshQueuedTurnsPending) return;
      refreshQueuedTurnsPending = true;
      queueMicrotask(() => {
        refreshQueuedTurnsPending = false;
        if (
          disposed
          || activeComposerScopeKeyRef.current !== composerScopeKey
        ) {
          return;
        }
        setQueuedTurnsState(draftStore.getQueuedTurns(composerScopeKey));
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [composerScopeKey, draftStore]);

  useEffect(() => {
    return () => {
      const latest = latestDraftSnapshotRef.current;
      flushComposerDraftSnapshot(latest.scopeKey, latest.snapshot);
    };
  }, []);

  useEffect(() => {
    if (props.launchpadError) {
      pendingDraftRetargetRef.current = undefined;
    }
  }, [props.launchpadError]);

  useEffect(() => {
    const previousScopeKey = activeComposerScopeKeyRef.current;
    if (previousScopeKey === composerScopeKey) {
      return;
    }

    recoveryEligibilityVersionRef.current += 1;
    recoveryLookupSequenceRef.current += 1;
    const pendingRetarget = pendingDraftRetargetRef.current;
    const retargetingDraft =
      pendingRetarget?.sourceScopeKey === previousScopeKey
      && pendingRetarget.targetScopeKey === composerScopeKey
        ? pendingRetarget
        : undefined;
    const previousSnapshot = retargetingDraft?.snapshot ?? {
      draft,
      editorDocument,
      imageAttachments,
      fileAttachments,
      skillTokens,
    };
    if (retargetingDraft) {
      pendingDraftRetargetRef.current = undefined;
      const savedTargetDraft = draftStore.get(composerScopeKey);
      const hydratedTargetDraft = hydrateComposerDraft(
        props.launchpad?.prompt ?? "",
        props.skills,
        threadLinks,
      );
      const parkedTargetDraft = savedTargetDraft ?? {
        draft: hydratedTargetDraft.draft,
        editorDocument:
          props.launchpad?.editorDocument as JSONContent | undefined,
        imageAttachments: props.launchpad?.imageAttachments ?? [],
        fileAttachments: props.launchpad?.fileAttachments ?? [],
        skillTokens: hydratedTargetDraft.skillTokens,
      };
      if (hasComposerDraftSnapshotContent(parkedTargetDraft)) {
        draftStore.pushDraft(composerScopeKey, parkedTargetDraft);
      }

      clearComposerDraftSnapshot(previousScopeKey);
      const restoredSourceDraft = draftStore.popDraft(previousScopeKey);
      if (restoredSourceDraft) {
        saveComposerDraftSnapshot(previousScopeKey, restoredSourceDraft);
        persistLaunchpadDraftSnapshot(previousScopeKey, restoredSourceDraft);
      } else {
        persistLaunchpadDraftSnapshot(
          previousScopeKey,
          createEmptyComposerDraftSnapshot(),
        );
      }
      saveComposerDraftSnapshot(composerScopeKey, previousSnapshot);
      persistLaunchpadDraftSnapshot(composerScopeKey, previousSnapshot);
    } else {
      flushComposerDraftSnapshot(previousScopeKey, previousSnapshot);
    }
    if (!props.thread && previousScopeKey.startsWith("thread:")) {
      globalQueuedTurnReleaseScopeKeys.delete(previousScopeKey);
    }

    activeComposerScopeKeyRef.current = composerScopeKey;
    const current = pasteScopeRef.current;
    if (retargetingDraft && current.key === previousScopeKey) {
      current.key = composerScopeKey;
    }
    pasteScopeRef.current = {
      key: composerScopeKey,
      version: current.version + 1,
    };

    if (retargetingDraft) {
      setDraft(previousSnapshot.draft);
      setEditorDocument(previousSnapshot.editorDocument);
      setImageAttachments(previousSnapshot.imageAttachments);
      setFileAttachments(previousSnapshot.fileAttachments ?? []);
      setSkillTokens(previousSnapshot.skillTokens);
      setPendingSteerState(undefined);
      setQueuedTurnsState([]);
    } else if (props.thread) {
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
    steeringRequestIdRef.current = undefined;
    setScheduleMenuOpen(false);
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
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
    setActiveHashReferenceIndex(0);
  }, [hashReferenceTrigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  // Retire a `#` that has run long with nothing to show. Matching is
  // monotonic (see HASH_ANCHOR_COLD_QUERY_LENGTH), so an empty result set
  // past the threshold is terminal for this anchor, not a lull — every
  // longer query is a subset of one that already matched nothing.
  useEffect(() => {
    if (
      rawHashReferenceQuery === undefined
      || rawHashReferenceQuery.length < HASH_ANCHOR_COLD_QUERY_LENGTH
      // A slow peer must not retire a live anchor: "empty" only counts
      // once the federated search has answered for this exact query,
      // otherwise the anchor dies a beat before the remote rows land.
      || !federatedHashSearchSettled
      || filteredHashReferenceOptions.length > 0
    ) {
      return;
    }

    const key = hashReferenceAnchorKey(rawHashReferenceQuery);
    setColdHashAnchors((current) =>
      current.has(key) ? current : new Set(current).add(key),
    );
  }, [
    federatedHashSearchSettled,
    filteredHashReferenceOptions.length,
    rawHashReferenceQuery,
  ]);

  // Cold anchors belong to one composing session. Forget them when the
  // draft empties (sent or cleared) or the composer switches threads, so
  // a run that matched nothing an hour ago cannot suppress a `#` against
  // a thread list that has moved on since.
  useEffect(() => {
    if (draft.trim().length > 0) {
      return;
    }
    setColdHashAnchors((current) => (current.size === 0 ? current : new Set()));
  }, [draft]);

  useEffect(() => {
    setColdHashAnchors((current) => (current.size === 0 ? current : new Set()));
  }, [props.launchpad?.directoryKey, props.thread?.id]);

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
      const hydrated = hydrateComposerDraft(draft, props.skills, threadLinks);
      if (hydrated.skillTokens.length > 0) {
        // The paste update retained a rich document without mention nodes.
        // Let the controlled editor rebuild it from the hydrated tokens so
        // the visual chips and canonical draft remain in lockstep.
        setEditorDocument(undefined);
        setDraft(hydrated.draft);
        setSkillTokens(hydrated.skillTokens);
      }
    }
  }, [draft, props.skills, skillTokens.length, threadLinks]);

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
      steeringRequestIdRef.current = undefined;
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
              queueEntryCreatedAt?: unknown;
              status?: unknown;
              turnId?: unknown;
            })
          : undefined;

      if (
        notificationThreadId &&
        typeof turnQueueRecord?.queueEntryId === "string" &&
        turnQueueRecord.status === "queued"
      ) {
        // Mirror entries queued by OTHER windows (or other federated
        // viewers) — the FIFO lives in the owning instance's main
        // process and every surface should show its contents, not just
        // the window that submitted. Known ids and in-flight local
        // submissions keep their richer local state untouched.
        const mirrorScopeKey = buildThreadComposerScopeKey(
          event.backend,
          notificationThreadId,
        );
        const mirrorCurrent = draftStore.getQueuedTurns(mirrorScopeKey);
        const alreadyKnown = mirrorCurrent.some(
          (queued) =>
            queued.queueEntryId === turnQueueRecord.queueEntryId
            || queued.backendQueuePending,
        );
        if (!alreadyKnown) {
          const displayText = (
            event.notification.params as { displayText?: unknown }
          ).displayText;
          draftStore.setQueuedTurns(mirrorScopeKey, [
            ...mirrorCurrent,
            {
              id: `backend-queued:${turnQueueRecord.queueEntryId}`,
              queueEntryId: turnQueueRecord.queueEntryId,
              ...(typeof turnQueueRecord.queueEntryCreatedAt === "number"
                ? { queueEntryCreatedAt: turnQueueRecord.queueEntryCreatedAt }
                : {}),
              text: typeof displayText === "string" ? displayText : "",
              imageAttachments: [],
              fileAttachments: [],
            },
          ]);
        }
      }

      if (
        notificationThreadId &&
        typeof turnQueueRecord?.queueEntryId === "string" &&
        (
          draftStore.getQueuedTurns(
            buildThreadComposerScopeKey(event.backend, notificationThreadId),
          ).some(
            (queued) => queued.queueEntryId === turnQueueRecord.queueEntryId,
          )
          || (
            event.backend === thread.source
            && notificationThreadId === thread.id
            && queuedTurns.some(
              (queued) => queued.queueEntryId === turnQueueRecord.queueEntryId,
            )
          )
        )
      ) {
        const queueScopeKey = buildThreadComposerScopeKey(
          event.backend,
          notificationThreadId,
        );
        const queueEventIsCurrentThread =
          agentEventMatchesThread(event, thread, notificationThreadId);
        if (
          queueEventIsCurrentThread &&
          (turnQueueRecord.status === "started" ||
            turnQueueRecord.status === "terminal" ||
            turnQueueRecord.status === "failed" ||
            turnQueueRecord.status === "cancelled")
        ) {
          // The durable store is updated before React necessarily commits the
          // corresponding queued-turn state. A fast terminal notification can
          // therefore race this listener's render closure; resolve by stable
          // queue id from the store first so the UI cannot retain a dead chip.
          const queued =
            draftStore.getQueuedTurns(queueScopeKey).find(
              (candidate) =>
                candidate.queueEntryId === turnQueueRecord.queueEntryId,
            )
            ?? queuedTurns.find(
              (candidate) =>
                candidate.queueEntryId === turnQueueRecord.queueEntryId,
            );
          if (queued) {
            removeQueuedTurnInScope(queueScopeKey, queued);
          }
        }
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

      if (!agentEventMatchesThread(event, thread, notificationThreadId)) {
        return;
      }

      const completedItemRecord =
        event.notification.method === "item/completed" &&
        typeof event.notification.params.item === "object" &&
        event.notification.params.item !== null
          ? (event.notification.params.item as { type?: unknown })
          : undefined;
      const completedItemTurnId =
        event.notification.method === "item/completed" &&
        typeof event.notification.params.turnId === "string"
          ? event.notification.params.turnId
          : undefined;
      if (
        completedItemRecord?.type === "enteredReviewMode" &&
        completedItemTurnId
      ) {
        // Reviews started outside this Composer (for example from a bound
        // messaging conversation) do not pass through submitReviewCommand,
        // so claim their review turn from the first review-mode item. Codex
        // can follow it with a mismatched turn/started id that never receives
        // a terminal event; retaining the review id keeps Stop and completion
        // handling wired to the lifecycle that actually finishes.
        updateActiveTurnId(completedItemTurnId, { review: true });
        props.onActiveTurnIdChange?.(completedItemTurnId);
        props.onPendingStatusChange?.("Reviewing");
      }

      if (
        (
          pendingSteer?.status === "steering"
          || pendingSteer?.status === "queued"
        )
        && event.notification.method === "item/completed"
        && notificationIncludesDraftContent(event.notification.params, pendingSteer)
      ) {
        if (steeringRequestIdRef.current === pendingSteer.id) {
          steeringRequestIdRef.current = undefined;
        }
        setPendingSteer(undefined);
        setSteering(false);
        props.onPendingStatusChange?.("Thinking");
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
        const providerQueuedSteer = pendingSteer?.status === "queued";
        props.onPendingStatusChange?.(
          providerQueuedSteer ? "Queued" : undefined,
        );
        if (clearsReleasedQueuedTurn) {
          globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
        }
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        steeringRequestIdRef.current = undefined;
        if (pendingSteer?.status === "pending") {
          void submitPendingSteer(
            pendingSteer,
            pendingSteer.expectedTurnId,
            composerScopeKey,
          );
        }
        if (!providerQueuedSteer) {
          setPendingSteer(undefined);
        }
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
        const providerQueuedSteer = pendingSteer?.status === "queued";
        props.onPendingStatusChange?.(
          providerQueuedSteer ? "Queued" : undefined,
        );
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        steeringRequestIdRef.current = undefined;
        if (!providerQueuedSteer) {
          setPendingSteer(undefined);
        }
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
    reviewer?: ModelSettingsRecent;
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
    // A released queued review carries its own reviewer: the panel is long
    // closed by then, so reviewConfig is empty and would silently downgrade the
    // review to the thread's provider. Otherwise take the live panel state,
    // captured before it clears below.
    const submittedReviewer = reviewCommand.reviewer ?? reviewConfig?.reviewer;
    // A queued reviewer already carries resolved values; only the live panel
    // needs its chips resolved against the picked provider's catalog.
    const submittedModel = reviewCommand.reviewer
      ? reviewCommand.reviewer.model
      : reviewerSelection.model?.id;
    const submittedReasoningEffort = reviewCommand.reviewer
      ? reviewCommand.reviewer.reasoningEffort
      : reviewerSelection.reasoningEffort;
    if (!options?.queued) {
      resetComposerDraftAndState(composerScopeKey);
      setReviewConfig(undefined);
    }
    try {
      const response = await props.desktopApi.startReview({
        backend: props.thread.source,
        federationTarget: props.thread.federation?.ref.target ??
          readRendererFederationTarget(),
        threadId: props.thread.id,
        target: reviewCommand.target,
        delivery: "inline",
        ...(reviewCommand.cwd ? { cwd: reviewCommand.cwd } : {}),
        ...(submittedReviewer
          ? {
              reviewBackend: submittedReviewer.backend,
              ...(submittedModel ? { model: submittedModel } : {}),
              ...(submittedReasoningEffort
                ? { reasoningEffort: submittedReasoningEffort }
                : {}),
            }
          : {
              ...(selectedModelOption?.id
                ? { model: selectedModelOption.id }
                : {}),
              ...(supportsReasoning && selectedReasoningEffort
                ? { reasoningEffort: selectedReasoningEffort }
                : {}),
              ...(selectedServiceTier
                ? { serviceTier: selectedServiceTier }
                : {}),
              ...(props.thread.source === "codex" && supportsFast
                ? { fastMode: Boolean(currentSettings?.fastMode) }
                : {}),
            }),
      });
      if (submittedReviewer) {
        // Only an explicit pick is worth replaying; recording inherited
        // settings would push real picks off the list.
        void props.desktopApi?.recordModelSettingsRecent?.({
          ...(props.thread.federation?.ref.target ?? rendererFederationTarget
            ? {
                federationTarget:
                  props.thread.federation?.ref.target ?? rendererFederationTarget,
              }
            : {}),
          scope: "review",
          recent: {
            backend: submittedReviewer.backend,
            ...(submittedModel ? { model: submittedModel } : {}),
            ...(submittedReasoningEffort
              ? { reasoningEffort: submittedReasoningEffort }
              : {}),
          },
        })?.catch(() => undefined);
      }
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
        federationTarget: props.thread.federation?.ref.target ??
          readRendererFederationTarget(),
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

  const showMcpInventory = (detail: CodexMcpInventoryDetail): void => {
    if (imageAttachments.length > 0 || fileAttachments.length > 0) {
      setSendError("/mcp does not accept attachments.");
      return;
    }
    if (!supportsMcpInventory || !props.onShowMcpInventory) {
      setSendError("MCP inventory is not available for this thread.");
      return;
    }

    const submittedScopeKey = composerScopeKey;
    const submittedSnapshot = latestDraftSnapshotRef.current.snapshot;
    const emptySnapshot = createEmptyComposerDraftSnapshot();
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
    setSendError(undefined);
    recordComposerDraftHistory(submittedScopeKey, submittedSnapshot, "sent");
    props.onShowMcpInventory(detail);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /**
   * Read the owning instance's reviewer history. Owner-scoped because a
   * combination remembered here would name a model the owner's catalog may not
   * have — the picker and its history have to come from one catalog.
   */
  const refreshReviewerRecents = async (): Promise<void> => {
    const federationTarget =
      props.thread?.federation?.ref.target ?? rendererFederationTarget;
    const requestedAuthorityKey = reviewerAuthorityKey;
    // Clear first so a slow response cannot leave the previous owner's
    // history on screen while the new one loads.
    setReviewerRecentsState({
      authorityKey: requestedAuthorityKey,
      recents: [],
    });
    try {
      const response = await props.desktopApi?.listModelSettingsRecents?.({
        ...(federationTarget ? { federationTarget } : {}),
        scope: "review",
      });
      if (reviewerAuthorityKeyRef.current !== requestedAuthorityKey) {
        return;
      }
      setReviewerRecentsState({
        authorityKey: requestedAuthorityKey,
        recents: response?.recents ?? [],
      });
    } catch {
      if (reviewerAuthorityKeyRef.current !== requestedAuthorityKey) {
        return;
      }
      setReviewerRecentsState({
        authorityKey: requestedAuthorityKey,
        recents: [],
      });
    }
  };

  const enterReviewComposer = (): void => {
    setReviewConfig(
      createReviewConfig({
        directory: props.directory,
        thread: props.thread,
      })
    );
    void refreshReviewerRecents();
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
      if (props.launchpad) {
        await scheduleLaunchpadMaterialization(
          futureScheduledDraftSendAt,
          configuredReviewCommand.target,
        );
        return;
      }
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
    fileSkillTokens: ComposerSkillToken[] = [],
  ): ComposerTurnPayload | Promise<ComposerTurnPayload> => {
    // Text-only pasted/restored `[@label](path)` links do not have a prior
    // in-memory token, so hydrate their explicit reference form here too.
    // This keeps a fast Start/Send from bypassing the same inspection that
    // normally runs as the Composer paints its chips.
    const hydratedReferenceTokens = hydrateComposerDraft(
      textDraft,
      props.skills,
      threadLinks,
    ).skillTokens;
    const localReferenceTokens = [
      ...fileSkillTokens,
      ...hydratedReferenceTokens,
    ];
    const inspection = inspectExplicitReferencePaths(
      listExplicitComposerReferencePaths(fileRefs, localReferenceTokens),
    );
    const build = (
      resolvedInspection: ComposerReferenceInspection,
    ): ComposerTurnPayload => {
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
        ...buildLocalFileInputs(
          fileRefs,
          localReferenceTokens,
          resolvedInspection.filePaths,
        ),
      ];

      return { displayText, imageParts, input };
    };
    return isPromiseLike(inspection) ? inspection.then(build) : build(inspection);
  };

  const buildQueuedTurnPayload = (
    queued: QueuedTurnDraft,
  ): ComposerTurnPayload | Promise<ComposerTurnPayload> => {
    const payload = buildTurnPayload(
      queued.text,
      queued.imageAttachments,
      queued.fileAttachments,
    );
    const merge = (derived: ComposerTurnPayload): ComposerTurnPayload => ({
      ...derived,
      input: mergeDerivedLocalFileInputs(queued.input, derived.input),
    });
    return isPromiseLike(payload) ? payload.then(merge) : merge(payload);
  };

  const sendThreadTurn = async (
    queued?: QueuedTurnDraft,
    options?: {
      backendQueueProjection?: {
        queued: QueuedTurnDraft;
        scopeKey: string;
        submittedSnapshot: ComposerDraftSnapshot;
      };
      payload?: ComposerTurnPayload;
      queueClaimed?: boolean;
    },
  ): Promise<void> => {
    const backendQueueSubmission = options?.backendQueueProjection;
    const submittedScopeKey =
      backendQueueSubmission?.scopeKey ?? composerScopeKey;
    const submittedSnapshot =
      backendQueueSubmission?.submittedSnapshot
      ?? latestDraftSnapshotRef.current.snapshot;
    const submittedScopeIsVisible = (): boolean =>
      activeComposerScopeKeyRef.current === submittedScopeKey;

    if (!props.thread || !props.desktopApi?.startTurn) {
      if (backendQueueSubmission) {
        removeQueuedTurnInScope(
          backendQueueSubmission.scopeKey,
          backendQueueSubmission.queued,
        );
        restoreSubmittedComposerDraftInScope(
          submittedScopeKey,
          submittedSnapshot,
        );
      }
      if (!backendQueueSubmission || submittedScopeIsVisible()) {
        updateSending(false);
      }
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
      return;
    }

    const payloadOrPromise =
      options?.payload
      ?? (queued
        ? buildQueuedTurnPayload(queued)
        : buildTurnPayload(
            canonicalDraft,
            imageAttachments,
            fileAttachments,
            skillTokens,
          ));
    const payload = isPromiseLike(payloadOrPromise)
      ? await payloadOrPromise
      : payloadOrPromise;
    if (payload.input.length === 0 || props.disabled) {
      if (backendQueueSubmission) {
        removeQueuedTurnInScope(
          backendQueueSubmission.scopeKey,
          backendQueueSubmission.queued,
        );
        restoreSubmittedComposerDraftInScope(
          submittedScopeKey,
          submittedSnapshot,
        );
      }
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

    if (
      !queued &&
      !options?.backendQueueProjection &&
      props.onBeforeStartTurn &&
      !(await props.onBeforeStartTurn())
    ) {
      updateSending(false);
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
      return;
    }

    let optimisticMessageId: string | undefined;
    if (!backendQueueSubmission) {
      props.onBeforeSendTurn?.();
      props.onPendingStatusChange?.(
        collaborationMode ? "Planning" : "Thinking",
      );
      optimisticMessageId = props.addOptimisticUserMessage?.(
        payload.displayText,
        payload.imageParts,
      );
      setActiveOptimisticMessageId(optimisticMessageId);
    }
    if (!queued && !backendQueueSubmission) {
      resetComposerDraftAndState(composerScopeKey);
      if (collaborationMode) {
        setPlanModeEnabled(false);
      }
    }

    try {
      const response = await props.desktopApi.startTurn({
        backend: props.thread.source,
        federationTarget: props.thread.federation?.ref.target ??
          readRendererFederationTarget(),
        threadId: props.thread.id,
        ...(backendQueueSubmission?.queued.queueEntryId
          ? { queueEntryId: backendQueueSubmission.queued.queueEntryId }
          : {}),
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
      // Only once the turn is actually accepted. Reporting the reply before
      // the await would clear the thread out of the Attention work queue even
      // when the send threw — a message that never left, on a lens whose whole
      // purpose is to not lose work silently.
      props.onUserRepliedToThread?.(props.thread);
      if (response.queueStatus === "queued") {
        const queueEntryId = response.queueEntryId ?? response.turnId;
        if (backendQueueSubmission) {
          updateQueuedTurnInScope(
            backendQueueSubmission.scopeKey,
            backendQueueSubmission.queued,
            (current) => ({
              ...current,
              backendQueuePending: false,
              input: payload.input,
              queueEntryId,
              ...(typeof response.queueEntryCreatedAt === "number"
                ? { queueEntryCreatedAt: response.queueEntryCreatedAt }
                : {}),
            }),
          );
          if (submittedScopeIsVisible()) {
            updateSending(false);
          }
        } else {
          enqueueQueuedTurn({
            ...(queued ?? {
              id: createQueuedTurnId(),
              text: canonicalDraft,
              imageAttachments,
              fileAttachments,
            }),
            input: payload.input,
            queueEntryId,
          });
        }
      } else {
        if (backendQueueSubmission) {
          removeQueuedTurnInScope(
            backendQueueSubmission.scopeKey,
            backendQueueSubmission.queued,
          );
          if (submittedScopeIsVisible()) {
            props.onBeforeSendTurn?.();
            props.onPendingStatusChange?.(
              collaborationMode ? "Planning" : "Thinking",
            );
            optimisticMessageId = props.addOptimisticUserMessage?.(
              payload.displayText,
              payload.imageParts,
            );
            setActiveOptimisticMessageId(optimisticMessageId);
          }
        }
        if (!backendQueueSubmission || submittedScopeIsVisible()) {
          updateActiveTurnId(response.turnId);
          props.onActiveTurnIdChange?.(response.turnId);
        }
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
          federationTarget:
            props.thread.federation?.ref.target ?? rendererFederationTarget,
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
      if (backendQueueSubmission) {
        removeQueuedTurnInScope(
          backendQueueSubmission.scopeKey,
          backendQueueSubmission.queued,
        );
      }
      if (optimisticMessageId) {
        props.removeOptimisticMessage?.(optimisticMessageId);
      }
      if (!queued) {
        const recoveredSubmittedDraft = backendQueueSubmission
          ? restoreSubmittedComposerDraftInScope(
              submittedScopeKey,
              submittedSnapshot,
            )
          : recoverSubmittedComposerDraft(submittedSnapshot);
        if (
          collaborationMode
          && recoveredSubmittedDraft
          && (!backendQueueSubmission || submittedScopeIsVisible())
        ) {
          setPlanModeEnabled(true);
        }
      }
      if (!backendQueueSubmission || submittedScopeIsVisible()) {
        props.onPendingStatusChange?.(undefined);
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        updateActiveTurnId(undefined);
        props.onActiveTurnIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
        setSendError(error instanceof Error ? error.message : String(error));
      }
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      if (queued && options?.queueClaimed) {
        globalQueuedTurnReleaseScopeKeys.delete(composerScopeKey);
      }
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
    if (queued.scheduledActionId) {
      if (!props.desktopApi?.sendScheduledThreadActionNow) {
        setSendError("Sending scheduled actions now is unavailable.");
        return;
      }
      updateSending(true);
      void props.desktopApi.sendScheduledThreadActionNow({
        federationTarget: props.thread?.federation?.ref.target
          ?? rendererFederationTarget,
        id: queued.scheduledActionId,
      }).then(
        (response) => {
          const failureMessage = scheduledActionFailureMessage(response.action);
          if (failureMessage) {
            updateSending(false);
            setSendError(failureMessage);
            return;
          }
          if (
            response.action.status === "scheduled"
            || response.action.status === "dispatching"
            || response.action.status === "queued"
          ) {
            upsertScheduledProjectionInScope(composerScopeKey, {
              ...queued,
              backendQueuePending: response.action.status === "dispatching",
              queueEntryId:
                response.action.status === "queued"
                  ? response.action.queueEntryId
                  : undefined,
              scheduledSendAt:
                response.action.status === "scheduled"
                  ? response.action.scheduledFor
                  : undefined,
            });
          } else {
            removeQueuedTurn(queued);
          }
          updateSending(false);
        },
        (error) => {
          updateSending(false);
          setSendError(error instanceof Error ? error.message : String(error));
        },
      );
      return;
    }
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
      || pendingSteerAutoAdmissionAttemptIdRef.current === pendingSteer.id
    ) {
      return;
    }

    pendingSteerAutoAdmissionAttemptIdRef.current = pendingSteer.id;
    void submitPendingSteer(
      pendingSteer,
      pendingSteer.expectedTurnId,
      composerScopeKey,
    );
  }, [activeTurnId, pendingSteer, props.launchpad, queuedTurn]);

  const queueCurrentDraft = (
    options?: { scheduledSendAt?: number },
  ): Promise<void> | undefined => {
    if (
      queueCurrentDraftInFlightRef.current
      || (
        !hasComposerContent
        && imageAttachments.length === 0
        && fileAttachments.length === 0
      )
    ) {
      return;
    }

    queueCurrentDraftInFlightRef.current = true;
    const complete = async (payload: ComposerTurnPayload): Promise<void> => {
      try {
        if (payload.input.length === 0) {
          return;
        }

        if (props.thread) {
          if (!props.desktopApi?.createScheduledThreadAction) {
            setSendError("Backend-owned queuing is unavailable.");
            return;
          }
          const response = await props.desktopApi.createScheduledThreadAction({
            backend: props.thread.source,
            federationTarget: props.thread.federation?.ref.target
              ?? rendererFederationTarget,
            threadId: props.thread.id,
            kind: "turn",
            origin: "desktop",
            scheduledFor: options?.scheduledSendAt ?? Date.now(),
            displayText: payload.displayText,
            imageAttachments,
            fileAttachments,
            turn: {
              input: payload.input,
              executionMode: props.thread.executionMode,
              model: selectedModelOption?.id,
              reasoningEffort: supportsReasoning
                ? selectedReasoningEffort
                : undefined,
              serviceTier: selectedServiceTier,
              fastMode:
                props.thread.source === "codex" && supportsFast
                  ? Boolean(currentSettings?.fastMode)
                  : undefined,
            },
          });
          const failureMessage = scheduledActionFailureMessage(response.action);
          if (failureMessage) throw new Error(failureMessage);
          if (
            response.action.status === "scheduled"
            || response.action.status === "dispatching"
            || response.action.status === "queued"
          ) {
            upsertScheduledProjectionInScope(composerScopeKey, {
              id: `scheduled-projection:${response.action.id}`,
              scheduledActionId: response.action.id,
              input: payload.input,
              text: canonicalDraft,
              imageAttachments,
              fileAttachments,
              ...(response.action.status === "scheduled"
                ? { scheduledSendAt: response.action.scheduledFor }
                : {}),
              ...(response.action.status === "dispatching"
                ? { backendQueuePending: true }
                : {}),
              ...(response.action.status === "queued"
                && response.action.queueEntryId
                ? { queueEntryId: response.action.queueEntryId }
                : {}),
            });
          }
        } else {
          enqueueQueuedTurn({
            id: createQueuedTurnId(),
            input: payload.input,
            text: canonicalDraft,
            imageAttachments,
            fileAttachments,
          });
        }
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
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        queueCurrentDraftInFlightRef.current = false;
      }
    };
    const payload = buildTurnPayload(
      canonicalDraft,
      imageAttachments,
      fileAttachments,
      skillTokens,
    );
    if (isPromiseLike(payload)) {
      return payload.then(complete, () => {
        queueCurrentDraftInFlightRef.current = false;
      });
    }
    return complete(payload);
  };

  const queueReviewCommand = (
    reviewCommand: {
      cwd?: string;
      displayText: string;
      target: AppServerReviewTarget;
    },
    options?: { scheduledSendAt?: number },
  ): Promise<void> | undefined => {
    const enqueue = async (): Promise<void> => {
      const text = formatReviewCommand(reviewCommand.target);
      if (!props.thread || !props.desktopApi?.createScheduledThreadAction) {
        throw new Error("Backend-owned review queuing is unavailable.");
      }
      const response = await props.desktopApi.createScheduledThreadAction({
        backend: props.thread.source,
        federationTarget: props.thread.federation?.ref.target
          ?? rendererFederationTarget,
        threadId: props.thread.id,
        kind: "review",
        origin: "desktop",
        scheduledFor: options?.scheduledSendAt ?? Date.now(),
        displayText: reviewCommand.displayText,
        review: {
          target: reviewCommand.target,
          draftText: text,
          delivery: "inline",
          cwd: reviewCommand.cwd,
          // Carry the picked reviewer through the queue so releasing it later
          // does not silently fall back to the thread's own provider.
          ...(reviewConfig?.reviewer
            ? {
                reviewBackend: reviewConfig.reviewer.backend,
                model: reviewerSelection.model?.id,
                reasoningEffort: reviewerSelection.reasoningEffort,
              }
            : {
                model: props.thread.model,
                reasoningEffort: props.thread.reasoningEffort,
              }),
          serviceTier: props.thread.serviceTier,
          fastMode:
            props.thread.source === "codex"
              ? props.thread.fastMode
              : undefined,
        },
      });
      const failureMessage = scheduledActionFailureMessage(response.action);
      if (failureMessage) throw new Error(failureMessage);
      if (
        response.action.status === "scheduled"
        || response.action.status === "dispatching"
        || response.action.status === "queued"
      ) {
        upsertScheduledProjectionInScope(composerScopeKey, {
          id: `scheduled-projection:${response.action.id}`,
          scheduledActionId: response.action.id,
          text,
          imageAttachments: [],
          fileAttachments: [],
          ...(response.action.status === "scheduled"
            ? { scheduledSendAt: response.action.scheduledFor }
            : {}),
          ...(response.action.status === "dispatching"
            ? { backendQueuePending: true }
            : {}),
          ...(response.action.status === "queued" && response.action.queueEntryId
            ? { queueEntryId: response.action.queueEntryId }
            : {}),
          reviewCommand,
        });
      }
    };
    const queued = enqueue().then(
      () => {
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
      },
      (error) => {
        setSendError(error instanceof Error ? error.message : String(error));
      },
    );
    return queued;
  };

  const shouldQueueThreadSubmit = (): boolean =>
    !props.launchpad &&
    (Boolean(props.threadBusy) ||
      Boolean(activeTurnIdRef.current) ||
      queuedTurns.some((queued) =>
        Boolean(queued.backendQueuePending || queued.queueEntryId)
      ) ||
      sendingRef.current);

  const scheduleLaunchpadMaterialization = async (
    scheduledSendAt: number,
    reviewTarget?: AppServerReviewTarget,
  ): Promise<void> => {
    if (
      !props.launchpad
      || !props.onMaterializeLaunchpad
      || props.disabled
    ) {
      return;
    }

    let input: AppServerTurnInputItem[] | undefined;
    if (!reviewTarget) {
      const payloadOrPromise = buildTurnPayload(
        canonicalDraft,
        imageAttachments,
        fileAttachments,
        skillTokens,
      );
      const payload = isPromiseLike(payloadOrPromise)
        ? await payloadOrPromise
        : payloadOrPromise;
      if (payload.input.length === 0) {
        return;
      }
      input = payload.input;
    }

    const collaborationMode =
      !reviewTarget && planModeEnabled && supportsPlanMode
        ? ({
            mode: "plan",
            settings: {
              developerInstructions: null,
            },
          } satisfies AppServerCollaborationModeRequest)
        : undefined;
    const submittedScopeKey = composerScopeKey;
    markComposerDraftSubmitted(submittedScopeKey);
    setSendError(undefined);
    updateSending(true);
    props.onPendingStatusChange?.(
      props.launchpad.codexEnvironmentId && selectedCodexEnvironment?.setupScript
        ? "Running environment setup"
        : "Scheduling thread",
    );
    try {
      await props.onMaterializeLaunchpad(
        props.launchpad.directoryKey,
        input,
        collaborationMode,
        reviewTarget,
        listDraftReferencedDirectories(
          appendFileReferenceMarkdown(canonicalDraft, fileAttachments),
          skillTokens,
        )
          .map((directory) => directory.path)
          .filter((path): path is string => Boolean(path)),
        scheduledSendAt,
      );
      clearSubmittedComposerDraft(submittedScopeKey);
      setReviewConfig(undefined);
      setScheduledDraftSendAt(undefined);
      setScheduleArmed(true);
      if (collaborationMode) {
        setPlanModeEnabled(false);
      }
    } catch (error) {
      unmarkComposerDraftSubmitted(submittedScopeKey);
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
    }
  };

  const scheduleCurrentDraft = (scheduledSendAt: number): void => {
    if (props.disabled) {
      return;
    }

    const reviewCommand = parsedReviewCommand;
    if (props.launchpad) {
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
        void scheduleLaunchpadMaterialization(
          scheduledSendAt,
          reviewCommand.target,
        );
        return;
      }
      void scheduleLaunchpadMaterialization(scheduledSendAt);
      return;
    }

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

    void queueCurrentDraft({ scheduledSendAt });
  };

  const submitPendingSteer = async (
    pending: PendingSteerDraft,
    expectedTurnId = activeTurnIdRef.current,
    expectedScopeKey = composerScopeKey,
  ): Promise<void> => {
    const turnId = expectedTurnId;
    if (!props.thread || !turnId || !props.desktopApi?.steerTurn) {
      setSendError("Steering is not available for this backend.");
      return;
    }
    const payloadOrPromise = pending.input
      ? { input: pending.input }
      : buildQueuedTurnPayload(pending);
    const payload = isPromiseLike(payloadOrPromise)
      ? await payloadOrPromise
      : payloadOrPromise;
    if (
      activeComposerScopeKeyRef.current !== expectedScopeKey
    ) {
      return;
    }
    if (
      payload.input.length === 0 ||
      props.disabled ||
      steeringRequestIdRef.current !== undefined
    ) {
      return;
    }

    steeringRequestIdRef.current = pending.id;
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
      const responsePromise = props.desktopApi.steerTurn({
        backend: props.thread.source,
        federationTarget: props.thread.federation?.ref.target ??
          readRendererFederationTarget(),
        threadId: props.thread.id,
        expectedTurnId: turnId,
        input: payload.input,
        requestId: pending.id,
        fallback: {
          displayText: pending.text,
          imageAttachments: pending.imageAttachments,
          fileAttachments: pending.fileAttachments,
          turn: {
            input: payload.input,
            executionMode: props.thread.executionMode,
            model: selectedModelOption?.id,
            reasoningEffort: supportsReasoning
              ? selectedReasoningEffort
              : undefined,
            serviceTier: selectedServiceTier,
            fastMode:
              props.thread.source === "codex" && supportsFast
                ? Boolean(currentSettings?.fastMode)
                : undefined,
          },
        },
      });
      if (
        pending.clearComposerDraftOnAdmission
        && activeComposerScopeKeyRef.current === expectedScopeKey
      ) {
        recordComposerDraftHistory(
          expectedScopeKey,
          latestDraftSnapshotRef.current.snapshot,
          "unsent",
        );
        clearComposerDraftSnapshot(expectedScopeKey);
        clearComposerDraft();
        setImageAttachments([]);
        setFileAttachments([]);
        setReviewConfig(undefined);
      }
      const response = await responsePromise;
      // Steering is a reply too, and like the send path this only counts once
      // the backend has taken it — a throw below must leave the thread in the
      // Attention queue.
      props.onUserRepliedToThread?.(props.thread);
      if (response.disposition === "queued") {
        if (steeringRequestIdRef.current === pending.id) {
          steeringRequestIdRef.current = undefined;
        }
        updatePendingSteer((current) =>
          current?.id === pending.id
            ? { ...current, status: "queued" }
            : current
        );
        setSendError(undefined);
        props.onPendingStatusChange?.("Queued");
      }
      if (response.disposition === "scheduled" && response.scheduledAction) {
        const action = response.scheduledAction;
        const failureMessage = scheduledActionFailureMessage(action);
        if (failureMessage) throw new Error(failureMessage);
        upsertScheduledProjectionInScope(expectedScopeKey, {
          id: `scheduled-projection:${action.id}`,
          scheduledActionId: action.id,
          input: payload.input,
          text: pending.text,
          imageAttachments: pending.imageAttachments,
          fileAttachments: pending.fileAttachments,
          ...(action.status === "scheduled"
            ? { scheduledSendAt: action.scheduledFor }
            : {}),
          ...(action.status === "dispatching"
            ? { backendQueuePending: true }
            : {}),
          ...(action.status === "queued" && action.queueEntryId
            ? { queueEntryId: action.queueEntryId }
            : {}),
        });
        setPendingSteer(undefined);
        setSendError(undefined);
      }
    } catch (error) {
      if (steeringRequestIdRef.current === pending.id) {
        steeringRequestIdRef.current = undefined;
      }
      // Rescue ONLY failures that prove the steer never left this
      // machine (the synchronous "peer is not connected" pre-send
      // throw). A timeout is ambiguous — the steer may have been
      // delivered and applied, and scheduling a rescue then would send
      // the message twice; those stay renderer-parked with retry.
      const provenUndelivered =
        error instanceof Error && error.message.includes("is not connected");
      const rescued = await (async () => {
        if (
          !provenUndelivered
          || !props.thread
          || !props.desktopApi?.createScheduledThreadAction
        ) {
          return false;
        }
        try {
          const rescueResponse =
            await props.desktopApi.createScheduledThreadAction({
              backend: props.thread.source,
              federationTarget: props.thread.federation?.ref.target ??
                readRendererFederationTarget(),
              threadId: props.thread.id,
              kind: "turn",
              origin: "desktop",
              scheduledFor: Date.now(),
              displayText: pending.text,
              imageAttachments: pending.imageAttachments,
              fileAttachments: pending.fileAttachments,
              turn: {
                input: payload.input,
                executionMode: props.thread.executionMode,
                model: selectedModelOption?.id,
                reasoningEffort: supportsReasoning
                  ? selectedReasoningEffort
                  : undefined,
                serviceTier: selectedServiceTier,
                fastMode:
                  props.thread.source === "codex" && supportsFast
                    ? Boolean(currentSettings?.fastMode)
                    : undefined,
              },
            });
          const action = rescueResponse.action;
          if (scheduledActionFailureMessage(action)) {
            return false;
          }
          upsertScheduledProjectionInScope(expectedScopeKey, {
            id: `scheduled-projection:${action.id}`,
            scheduledActionId: action.id,
            input: payload.input,
            text: pending.text,
            imageAttachments: pending.imageAttachments,
            fileAttachments: pending.fileAttachments,
            ...(action.status === "dispatching"
              ? { backendQueuePending: true }
              : {}),
            ...(action.status === "queued" && action.queueEntryId
              ? { queueEntryId: action.queueEntryId }
              : {}),
          });
          setPendingSteer(undefined);
          return true;
        } catch {
          // Owner unreachable for the rescue too — fall through to the
          // renderer-parked pending state and its retry loop.
          return false;
        }
      })();
      if (!rescued) {
        updatePendingSteer((current) =>
          current?.text === pending.text &&
          current.imageAttachments === pending.imageAttachments
            ? { ...current, status: "pending" }
            : current
        );
        setSendError(error instanceof Error ? error.message : String(error));
      } else {
        setSendError(undefined);
      }
      props.onPendingStatusChange?.("Thinking");
    } finally {
      setSteering(false);
    }
  };

  const createPendingSteer = (
    pending: QueuedTurnDraft,
    expectedTurnId = activeTurnIdRef.current,
    expectedScopeKey = composerScopeKey,
    clearComposerDraftOnAdmission = false,
  ):
    | PendingSteerDraft
    | Promise<PendingSteerDraft | undefined>
    | undefined => {
    const turnId = expectedTurnId;
    if (pendingSteerCreationInFlightRef.current) {
      return undefined;
    }
    if (
      !props.thread
      || !turnId
      || activeTurnIdRef.current !== turnId
      || activeComposerScopeKeyRef.current !== expectedScopeKey
      || !props.desktopApi?.steerTurn
      || !supportsSteering
    ) {
      setSendError("Steering is not available for this model.");
      return undefined;
    }

    pendingSteerCreationInFlightRef.current = true;
    const inputOrPayload = buildQueuedTurnPayload(pending);
    const complete = (
      input: AppServerTurnInputItem[],
    ): PendingSteerDraft | undefined => {
      try {
        if (
          input.length === 0
          || props.disabled
          || pendingSteer
          || activeTurnIdRef.current !== turnId
          || activeComposerScopeKeyRef.current !== expectedScopeKey
        ) {
          return undefined;
        }

        const accepted: PendingSteerDraft = {
          ...pending,
          clearComposerDraftOnAdmission,
          expectedTurnId: turnId,
          input,
          status: "pending",
        };
        setSendError(undefined);
        setPendingSteer(accepted);
        return accepted;
      } finally {
        pendingSteerCreationInFlightRef.current = false;
      }
    };
    if (isPromiseLike(inputOrPayload)) {
      return inputOrPayload.then(
        (payload) => complete(payload.input),
        () => {
          pendingSteerCreationInFlightRef.current = false;
          return undefined;
        },
      );
    }
    return complete(inputOrPayload.input);
  };

  const steerCurrentDraft = (): Promise<void> | undefined => {
    if (!props.thread || !activeTurnIdRef.current || !props.desktopApi?.steerTurn) {
      void queueCurrentDraft();
      setSendError("Steering is not available for this backend.");
      return;
    }
    if (!supportsSteering) {
      void queueCurrentDraft();
      setSendError("Steering is not available for this model.");
      return;
    }

    const pending = {
      id: createQueuedTurnId(),
      text: canonicalDraft,
      imageAttachments,
      fileAttachments,
    };
    const expectedTurnId = activeTurnIdRef.current;
    const expectedScopeKey = composerScopeKey;
    const created = createPendingSteer(
      pending,
      expectedTurnId,
      expectedScopeKey,
      true,
    );
    const continueSteering = (accepted?: PendingSteerDraft): void => {
      if (accepted) {
        void submitPendingSteer(
          accepted,
          expectedTurnId,
          expectedScopeKey,
        );
      }
    };
    if (isPromiseLike(created)) {
      return created.then(continueSteering);
    }
    continueSteering(created);
  };

  const rescueCancelledQueuedTurn = async (
    scopeKey: string,
    queued: QueuedTurnDraft,
  ): Promise<void> => {
    // The owner-side FIFO entry was already cancelled on the way into a
    // steer; parking the message in this renderer would strand it if the
    // window closes (and hide it from every other window). Re-create it
    // in the owner's durable scheduled-action store, and only fall back
    // to the local park when the owner is unreachable.
    const thread = props.thread;
    if (
      thread
      && props.desktopApi?.createScheduledThreadAction
      && queued.input
      && !queued.reviewCommand
    ) {
      try {
        const response = await props.desktopApi.createScheduledThreadAction({
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          kind: "turn",
          origin: "desktop",
          scheduledFor: Date.now(),
          displayText: queued.text,
          imageAttachments: queued.imageAttachments,
          fileAttachments: queued.fileAttachments,
          turn: {
            input: queued.input,
            executionMode: thread.executionMode,
          },
        });
        const action = response.action;
        if (!scheduledActionFailureMessage(action)) {
          removeQueuedTurnInScope(scopeKey, queued);
          upsertScheduledProjectionInScope(scopeKey, {
            id: `scheduled-projection:${action.id}`,
            scheduledActionId: action.id,
            input: queued.input,
            text: queued.text,
            imageAttachments: queued.imageAttachments,
            fileAttachments: queued.fileAttachments,
            ...(action.status === "dispatching"
              ? { backendQueuePending: true }
              : {}),
            ...(action.status === "queued" && action.queueEntryId
              ? { queueEntryId: action.queueEntryId }
              : {}),
          });
          return;
        }
      } catch {
        // Owner unreachable — fall through to the local park below.
      }
    }
    preserveCancelledQueuedTurnInScope(scopeKey, queued);
  };

  const steerQueuedTurn = async (queued: QueuedTurnDraft): Promise<void> => {
    const expectedTurnId = activeTurnIdRef.current;
    const expectedScopeKey = composerScopeKey;
    if (!expectedTurnId) {
      return;
    }
    const cancellation = await cancelServerManagedQueuedTurn(
      queued,
      expectedScopeKey,
    );
    if (cancellation !== "cancelled") {
      return;
    }
    if (
      activeTurnIdRef.current !== expectedTurnId
      || activeComposerScopeKeyRef.current !== expectedScopeKey
    ) {
      void rescueCancelledQueuedTurn(expectedScopeKey, queued);
      return;
    }
    const continueSteering = (accepted?: PendingSteerDraft): void => {
      if (!accepted) {
        void rescueCancelledQueuedTurn(expectedScopeKey, queued);
        return;
      }
      removeQueuedTurnInScope(expectedScopeKey, queued);
      void submitPendingSteer(
        accepted,
        expectedTurnId,
        expectedScopeKey,
      );
    };
    const created = createPendingSteer(
      queued,
      expectedTurnId,
      expectedScopeKey,
    );
    if (isPromiseLike(created)) {
      await created.then(continueSteering);
    } else {
      continueSteering(created);
    }
  };

  const submitTurn = async (mode: "default" | "steer" = "default"): Promise<void> => {
    const reviewCommand = parsedReviewCommand;
    if (turnPayloadPreparationInFlightRef.current) {
      return;
    }
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
    if (mcpInventoryDetail) {
      showMcpInventory(mcpInventoryDetail);
      return;
    }

    if (shouldQueueThreadSubmit()) {
      if (activeTurnIdRef.current && mode === "steer") {
        const steering = steerCurrentDraft();
        if (steering) {
          await steering;
        }
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
      } else if (effectiveScheduledSendAt) {
        const queued = queueCurrentDraft(
          { scheduledSendAt: effectiveScheduledSendAt },
        );
        if (queued) {
          await queued;
        }
      } else {
        // Ordinary replies enter the main-process FIFO immediately. The
        // renderer reserves a presentation slot while startTurn hands the
        // request to that queue, then records the registry entry id.
        const submittedScopeKey = composerScopeKey;
        const submittedSnapshot = latestDraftSnapshotRef.current.snapshot;
        setScheduledDraftSendAt(undefined);
        setScheduleArmed(true);
        resetComposerDraftAndState(submittedScopeKey);
        const payloadOrPromise = buildTurnPayload(
          canonicalDraft,
          imageAttachments,
          fileAttachments,
          skillTokens,
        );
        let payload: ComposerTurnPayload;
        if (isPromiseLike(payloadOrPromise)) {
          turnPayloadPreparationInFlightRef.current = true;
          updateSending(true);
          try {
            payload = await payloadOrPromise;
          } catch (error) {
            restoreSubmittedComposerDraftInScope(
              submittedScopeKey,
              submittedSnapshot,
            );
            if (activeComposerScopeKeyRef.current === submittedScopeKey) {
              updateSending(false);
              setSendError(error instanceof Error ? error.message : String(error));
            }
            return;
          } finally {
            turnPayloadPreparationInFlightRef.current = false;
          }
        } else {
          payload = payloadOrPromise;
        }
        if (payload.input.length > 0 && !props.disabled) {
          if (activeComposerScopeKeyRef.current === submittedScopeKey) {
            setSendError(undefined);
            updateSending(true);
          }
          const queueEntryId = createQueuedTurnId();
          const backendQueueProjection: QueuedTurnDraft = {
            id: queueEntryId,
            backendQueuePending: true,
            queueEntryId,
            text: canonicalDraft,
            imageAttachments,
            fileAttachments,
            input: payload.input,
          };
          enqueueQueuedTurnInScope(
            submittedScopeKey,
            backendQueueProjection,
          );
          await sendThreadTurn(undefined, {
            backendQueueProjection: {
              queued: backendQueueProjection,
              scopeKey: submittedScopeKey,
              submittedSnapshot,
            },
            payload,
          });
        } else {
          restoreSubmittedComposerDraftInScope(
            submittedScopeKey,
            submittedSnapshot,
          );
        }
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
      const queued = queueCurrentDraft({
        scheduledSendAt: effectiveScheduledSendAt,
      });
      if (queued) {
        await queued;
      }
      return;
    }

    // Unarmed schedule ("send now" on an edited scheduled message) — clear the
    // pending time so the toggle doesn't reappear after the immediate send.
    setScheduledDraftSendAt(undefined);
    setScheduleArmed(true);
    const payloadOrPromise = buildTurnPayload(
      canonicalDraft,
      imageAttachments,
      fileAttachments,
      skillTokens,
    );
    let payload: ComposerTurnPayload;
    if (isPromiseLike(payloadOrPromise)) {
      turnPayloadPreparationInFlightRef.current = true;
      updateSending(true);
      try {
        payload = await payloadOrPromise;
      } catch (error) {
        updateSending(false);
        setSendError(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        turnPayloadPreparationInFlightRef.current = false;
      }
    } else {
      payload = payloadOrPromise;
    }
    const collaborationMode = planModeEnabled && supportsPlanMode
      ? ({
          mode: "plan",
          settings: {
            developerInstructions: null,
          },
        } satisfies AppServerCollaborationModeRequest)
      : undefined;

    if (payload.input.length === 0 || props.disabled) {
      updateSending(false);
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

    await sendThreadTurn(undefined, { payload });
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
        federationTarget: props.thread.federation?.ref.target ??
          readRendererFederationTarget(),
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
      void queueCurrentDraft();
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

  const applyThreadReference = (thread: ResolvedThreadLink): void => {
    if (!inputRef.current) {
      return;
    }
    inputRef.current.insertMentionToken(createComposerThreadToken(thread, 0));
  };

  const applyHashReference = (
    createToken: (index: number) => ComposerSkillToken,
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
    const referenceTrigger =
      findHashReferenceTrigger(draft, selectionStart)
      ?? findHashReferenceTrigger(draft, draft.length)
      ?? { start: selectionStart, end: selectionEnd };
    const before = draft.slice(0, referenceTrigger.start);
    const after = draft.slice(Math.max(referenceTrigger.end, selectionEnd));
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
      createToken(tokenIndex),
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
      setActiveHashReferenceIndex(0);
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
      ?.recordRecentFileReferences?.({
        federationTarget: filesystemFederationTarget,
        paths,
      })
      ?.catch(() => undefined);
  };

  /** "@ → Add file…" action: OS file picker → file-reference chips. */
  const applyPickedFileReferences = async (): Promise<void> => {
    if (filesystemFederationTarget) {
      return;
    }
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
    if (filesystemFederationTarget) {
      return;
    }
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
   * on every picker open. Recents are scoped to one filesystem authority;
   * switching owner or a failed read clears the list instead of retaining
   * paths sourced from another machine.
   */
  const refreshRecentFileReferences = async (): Promise<void> => {
    const requestedAuthorityKey = filesystemAuthorityKey;
    setRecentFileReferenceState({
      authorityKey: requestedAuthorityKey,
      files: [],
    });
    try {
      const response = await props.desktopApi?.listRecentFileReferences?.({
        federationTarget: filesystemFederationTarget,
      });
      if (recentFileAuthorityKeyRef.current === requestedAuthorityKey) {
        setRecentFileReferenceState({
          authorityKey: requestedAuthorityKey,
          files: response?.files ?? [],
        });
      }
    } catch {
      if (recentFileAuthorityKeyRef.current === requestedAuthorityKey) {
        setRecentFileReferenceState({
          authorityKey: requestedAuthorityKey,
          files: [],
        });
      }
    }
  };

  const removeImageAttachment = (id: string): void => {
    const nextAttachments = imageAttachments.filter(
      (attachment) => attachment.id !== id,
    );
    setImageAttachments(nextAttachments);
    saveComposerDraftSnapshot(composerScopeKey, {
      draft,
      editorDocument,
      imageAttachments: nextAttachments,
      fileAttachments,
      skillTokens,
    });
    persistLaunchpadImageAttachments(nextAttachments);
  };

  const removeFileAttachment = (id: string): void => {
    const nextAttachments = fileAttachments.filter(
      (attachment) => attachment.id !== id,
    );
    setFileAttachments(nextAttachments);
    saveComposerDraftSnapshot(composerScopeKey, {
      draft,
      editorDocument,
      imageAttachments,
      fileAttachments: nextAttachments,
      skillTokens,
    });
    persistLaunchpadImageAttachments(imageAttachments, nextAttachments);
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

  const showComposerNotice = (
    notice: Omit<AppNoticeToastNotice, "id" | "transientSlot">,
  ): void => {
    props.onShowNotice?.({
      id: `composer-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...notice,
      tone: notice.tone ?? "warning",
      transientSlot: "composer",
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
        federationTarget: filesystemFederationTarget,
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
    if (filesystemFederationTarget) {
      showComposerNotice({
        title: "Local files unavailable",
        message: REMOTE_NATIVE_PICKER_TOOLTIP,
      });
      return;
    }
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
    if (filesystemFederationTarget) {
      return;
    }
    const result = await props.desktopApi?.pickFileFromDisk?.();
    if (!result || result.canceled || result.paths.length === 0) {
      return;
    }
    attachFilePaths(result.paths);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>): void => {
    // Browser DataTransfer always exposes getData. A few renderer tests use a
    // deliberately file-only clipboard stub, so keep that path compatible too.
    const pastedText = typeof event.clipboardData.getData === "function"
      ? event.clipboardData.getData("text/plain").trim()
      : "";
    const pastedThread =
      resolveThreadHref(pastedText, threadLinks)
      ?? resolveThreadIdText(pastedText, threadLinks);
    if (pastedThread) {
      event.preventDefault();
      setSendError(undefined);
      applyThreadReference(pastedThread);
      return;
    }

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
      // sequential paste-the-same-image case — then re-check against the
      // freshest snapshot below for the rare paste race.
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

      // Re-run de-dup and the cap against the latest snapshot (not the one
      // captured when this paste began) so concurrent normalizations cannot
      // add a duplicate or exceed the limit. Update the ref synchronously so
      // the next completion sees this one before React commits the state.
      const latestSnapshot = latestDraftSnapshotRef.current.snapshot;
      const { unique: freshlyUnique } = partitionNewImageAttachments(
        latestSnapshot.imageAttachments,
        unique,
        getImageSignature,
      );
      const mergedAttachments = [
        ...latestSnapshot.imageAttachments,
        ...freshlyUnique,
      ].slice(0, MAX_COMPOSER_IMAGE_ATTACHMENTS);
      // Read file pills from the latest snapshot ref, not the paste-time
      // closure — a mixed drop attaches files synchronously before this
      // async image path lands, and the stale list would wipe them.
      const latestFileAttachments =
        latestSnapshot.fileAttachments ?? pasteFileAttachments;
      const nextSnapshot = {
        ...latestSnapshot,
        imageAttachments: mergedAttachments,
        fileAttachments: latestFileAttachments,
      };
      latestDraftSnapshotRef.current = {
        scopeKey: pasteScope.key,
        snapshot: nextSnapshot,
      };
      setImageAttachments(mergedAttachments);
      saveComposerDraftSnapshot(pasteScope.key, nextSnapshot);
      persistLaunchpadImageAttachments(mergedAttachments, latestFileAttachments);
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

  const changeAgentThread = async (agentThread: boolean): Promise<void> => {
    if (props.launchpad) {
      if (!props.onUpdateLaunchpad) {
        return;
      }
      setAgentThreadSaving(true);
      setAgentThreadError(undefined);
      try {
        await props.onUpdateLaunchpad(props.launchpad.directoryKey, {
          agent: agentThread ? createDesktopAgentThread() : undefined,
        });
      } catch (error) {
        setAgentThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setAgentThreadSaving(false);
      }
      return;
    }

    const thread = props.thread;
    if (
      !thread ||
      !canChangeExistingThreadAgentDesignation(thread) ||
      !props.desktopApi?.setThreadAgent
    ) {
      return;
    }

    setAgentThreadSaving(true);
    setAgentThreadError(undefined);
    try {
      await props.desktopApi.setThreadAgent({
        backend: thread.source,
        threadId: thread.id,
        agent: agentThread ? createDesktopAgentThread() : null,
      });
      await props.onRefreshNavigation?.();
    } catch (error) {
      setAgentThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentThreadSaving(false);
    }
  };

  // Per-thread Token Miser override. Written to the thread's overlay row and
  // read back through the navigation summary, so every window agrees.
  const changeTokenMiser = async (enabled: boolean): Promise<void> => {
    const thread = props.thread;
    if (!thread || !props.desktopApi?.setThreadTokenMiser) {
      return;
    }
    setAgentThreadSaving(true);
    setAgentThreadError(undefined);
    try {
      await props.desktopApi.setThreadTokenMiser({
        backend: thread.source,
        threadId: thread.id,
        enabled,
      });
      await props.onRefreshNavigation?.();
    } catch (error) {
      setAgentThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentThreadSaving(false);
    }
  };

  useEffect(() => {
    const launchpad = props.launchpad;
    const backend = launchpad?.backend;
    if (!launchpad || !backend?.startsWith("acp:")) {
      activeAcpLaunchpadRefreshKeyRef.current = undefined;
      return;
    }

    const refreshKey = `${launchpad.directoryKey}:${backend}`;
    if (activeAcpLaunchpadRefreshKeyRef.current === refreshKey) {
      return;
    }
    activeAcpLaunchpadRefreshKeyRef.current = refreshKey;
    const adoptRefreshedDefault =
      pendingProviderSelectionKeyRef.current === refreshKey;
    const automaticModel = launchpad.model;
    const automaticReasoningEffort = launchpad.reasoningEffort;
    if (adoptRefreshedDefault) {
      pendingProviderSelectionKeyRef.current = undefined;
    }

    let cancelled = false;
    void Promise.resolve(props.onProviderSelected?.(backend)).then(
      async (refreshedBackend) => {
        if (cancelled || !refreshedBackend || !props.onUpdateLaunchpad) {
          return;
        }
        const latestLaunchpad = latestLaunchpadRef.current;
        if (
          latestLaunchpad?.directoryKey !== launchpad.directoryKey ||
          latestLaunchpad.backend !== backend
        ) {
          return;
        }

        const shouldAdoptRefreshedDefault =
          adoptRefreshedDefault
          && latestLaunchpad.model === automaticModel
          && latestLaunchpad.reasoningEffort === automaticReasoningEffort;
        const refreshedModels = refreshedBackend.launchpadOptions?.models ?? [];
        const configuredDefaults = props.providerModelDefaults?.[backend];
        const configuredModelOption = refreshedModels.find(
          (model) => model.id === configuredDefaults?.model,
        );
        const nextModelOption =
          (shouldAdoptRefreshedDefault
            ? configuredModelOption
            : refreshedModels.find(
                (model) => model.id === latestLaunchpad.model,
              )) ??
          getDefaultModelOption(refreshedBackend);
        if (!nextModelOption) {
          return;
        }
        const configuredReasoningEffort =
          configuredDefaults?.reasoningEffortsByModel[nextModelOption.id];
        const refreshedReasoningEfforts = getReasoningEffortsForModel(
          refreshedBackend,
          nextModelOption,
        );
        const nextReasoningEffort = nextModelOption.supportsReasoning
          ? shouldAdoptRefreshedDefault
            ? configuredReasoningEffort
              && refreshedReasoningEfforts.includes(configuredReasoningEffort)
                ? configuredReasoningEffort
                : getDefaultReasoningEffort(refreshedBackend, nextModelOption)
            : getReasoningEffortValue(
                refreshedBackend,
                nextModelOption,
                latestLaunchpad.reasoningEffort,
              )
          : undefined;
        if (
          latestLaunchpad.model === nextModelOption.id &&
          latestLaunchpad.reasoningEffort === nextReasoningEffort
        ) {
          return;
        }

        await props.onUpdateLaunchpad(
          latestLaunchpad.directoryKey,
          {
            model: nextModelOption.id,
            reasoningEffort: nextReasoningEffort,
          },
          {
            stickySettingsChanged: true,
          },
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    props.launchpad?.backend,
    props.launchpad?.directoryKey,
    props.onProviderSelected,
    props.onUpdateLaunchpad,
    props.providerModelDefaults,
  ]);

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
        federationTarget: thread.federation?.ref.target ??
          readRendererFederationTarget(),
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
        federationTarget: props.thread.federation?.ref.target ??
          readRendererFederationTarget(),
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
  const backgroundPrPollingEnabled =
    props.backgroundPrPollingEnabled ?? true;
  const prAutoDispatchAllowed = props.prAutoDispatchAllowed ?? true;
  const prAutoDispatchAvailable =
    backgroundPrPollingEnabled && prAutoDispatchAllowed;
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
  const profileModelDefaults = backend
    ? props.providerModelDefaults?.[backend.kind]
    : undefined;
  const profileModelOption =
    modelOptions.find((option) => option.id === profileModelDefaults?.model)
    ?? getDefaultModelOption(backend);
  const profileReasoningOptions = getReasoningEffortsForModel(
    backend,
    profileModelOption,
  );
  const configuredProfileReasoning = profileModelOption
    ? profileModelDefaults?.reasoningEffortsByModel[profileModelOption.id]
    : undefined;
  const profileReasoningEffort =
    configuredProfileReasoning
    && profileReasoningOptions.includes(configuredProfileReasoning)
      ? configuredProfileReasoning
      : getDefaultReasoningEffort(backend, profileModelOption);
  const launchpadDiffersFromProfileDefaults =
    Boolean(props.launchpad && profileModelOption)
    && (
      props.launchpad?.model !== profileModelOption?.id
      || (
        profileReasoningOptions.length > 0
        && props.launchpad?.reasoningEffort !== profileReasoningEffort
      )
    );
  const supportsFast =
    backend?.kind === "codex"
    && props.codexFastAllowed !== false
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
  // Backends we can hand a review to. `reviewRunner` doubles as the feature
  // probe for reviewer overrides: an instance that predates them never sets
  // it, so a viewer federated to an older owner finds no eligible reviewers
  // and keeps the row read-only rather than sending a `reviewBackend` that
  // owner would silently ignore.
  const reviewerBackendOptions =
    props.backends?.filter(
      (candidate) =>
        candidate.available && candidate.capabilities.reviewRunner === true
    ) ?? [];
  // Gated on an existing thread: the launchpad's materialize path takes only
  // a review target (`onMaterializeLaunchpad`), so a reviewer picked there
  // would be accepted by the UI and then silently dropped on submit.
  const reviewerOverridesSupported =
    Boolean(props.thread) && reviewerBackendOptions.length > 0;
  const reviewerFederationTarget =
    props.thread?.federation?.ref.target ?? rendererFederationTarget;
  const reviewerAuthorityKey =
    reviewerFederationTarget?.scope === "remote"
      ? `remote:${reviewerFederationTarget.instanceId}`
      : "local";
  reviewerAuthorityKeyRef.current = reviewerAuthorityKey;
  const reviewerRecents =
    reviewerRecentsState.authorityKey === reviewerAuthorityKey
      ? reviewerRecentsState.recents
      : [];
  const reviewerSelection = resolveReviewerSelection({
    backends: props.backends,
    override: reviewConfig?.reviewer,
    threadBackend: props.thread?.source,
    threadModel: selectedModelOption?.id,
    threadReasoningEffort: supportsReasoning ? selectedReasoningEffort : undefined,
  });
  const reviewerModelOptions =
    reviewerSelection.summary?.launchpadOptions?.models ?? [];
  const reviewerReasoningOptions = getReasoningEffortsForModel(
    reviewerSelection.summary,
    reviewerSelection.model,
  );
  const reviewerOverridden = Boolean(reviewConfig?.reviewer);
  // A remembered combination is only offered while it still resolves against
  // the owner's current catalog. Recents are disposable, so a dead row is
  // noise rather than a preference worth preserving.
  const resolvableReviewerRecents = reviewerRecents.filter((recent) => {
    const summary = reviewerBackendOptions.find(
      (candidate) => candidate.kind === recent.backend,
    );
    if (!summary) {
      return false;
    }
    return (
      !recent.model
      || (summary.launchpadOptions?.models ?? []).some(
        (model) => model.id === recent.model,
      )
    );
  });
  // Identity is the list position, not the rendered label: the store dedupes
  // on a wider tuple than the label shows, so two distinct entries can format
  // identically.
  const activeReviewerRecentIndex = resolvableReviewerRecents.findIndex(
    (recent) =>
      recent.backend === reviewConfig?.reviewer?.backend
      && recent.model === reviewConfig?.reviewer?.model
      && recent.reasoningEffort === reviewConfig?.reviewer?.reasoningEffort,
  );

  const patchReviewer = (
    build: (current: ModelSettingsRecent | undefined) => ModelSettingsRecent | undefined,
  ): void => {
    setReviewConfig((current) => {
      const base =
        current
        ?? createReviewConfig({
          directory: props.directory,
          thread: props.thread,
        });
      return { ...base, reviewer: build(base.reviewer) };
    });
    setSendError(undefined);
  };
  const availableExecutionModes =
    backend?.executionModes.filter((mode) => mode.available) ?? [];
  const workspaceLabel = formatThreadWorkspaceLabel(props.thread);
  const supportsPlanMode =
    (props.launchpad?.backend ?? props.thread?.source) === "codex";
  const supportsSteering =
    Boolean(backend?.capabilities.steerTurn) &&
    selectedModelOption?.supportsSteering !== false;
  const launchpadSubmitting = isLaunchpad && sending;
  const fiveHourResetAt = getFiveHourRateLimitResetAt({
    backend,
    now: scheduleNow,
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
              scheduleNow,
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
    (!props.thread && !props.launchpad) ||
    Boolean(props.launchpad && !props.onMaterializeLaunchpad) ||
    isCompactCommand;
  // Only surface the schedule caret where scheduling actually applies. In the
  // compact command or a thread-less composer there is nothing to schedule,
  // so the split collapses to a plain Send pill instead of parking a
  // permanently-dimmed half-button next to it. A launchpad is schedulable:
  // choosing a time materializes its workspace/thread immediately and defers
  // only the first action.
  const scheduleAffordanceVisible =
    Boolean(
      props.thread
      || (props.launchpad && props.onMaterializeLaunchpad)
    ) && !isCompactCommand;
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
    activeTurnId ||
    queuedTurns.some((queued) =>
      Boolean(queued.backendQueuePending || queued.queueEntryId)
    ) ||
    props.threadBusy
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
  const launchpadBranchStatusError =
    props.launchpad?.directoryKind === "directory" &&
    !isSameWorktreeSubthreadLaunchpad(props.launchpad.directoryKey) &&
    props.directory?.gitStatus?.syncState === "status-unavailable"
      ? props.directory.gitStatus.statusUnavailableReason ??
        "Git did not return branch information."
      : undefined;
  const launchpadBranchStatusDirectoryKey = props.launchpad?.directoryKey;
  const launchpadBranchStatusDirectoryLabel = props.launchpad?.directoryLabel;
  const showLaunchpadBranchStatusNotice = props.onShowNotice;
  useEffect(() => {
    if (
      !launchpadBranchStatusError ||
      !launchpadBranchStatusDirectoryKey ||
      !launchpadBranchStatusDirectoryLabel ||
      !showLaunchpadBranchStatusNotice
    ) {
      return;
    }

    showLaunchpadBranchStatusNotice({
      autoDismiss: false,
      id: `launchpad-branches-unavailable:${launchpadBranchStatusDirectoryKey}:${launchpadBranchStatusError}`,
      title: "Branches unavailable",
      message: `PwrAgent couldn't load branches for ${launchpadBranchStatusDirectoryLabel}.`,
      detail: launchpadBranchStatusError,
      tone: "warning",
    });
  }, [
    launchpadBranchStatusError,
    launchpadBranchStatusDirectoryKey,
    launchpadBranchStatusDirectoryLabel,
    showLaunchpadBranchStatusNotice,
  ]);
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
  const showPrAutoDispatchToggle = Boolean(
    props.thread && getPrimaryWorkspaceRepository(props.thread),
  );
  const hasAttachedPullRequest = props.thread
    ? hasPrimaryWorkspacePullRequest(props.thread)
    : false;
  const prAutoDispatchTooltip = !backgroundPrPollingEnabled
    ? "Auto-fix PR paused — turn on background PR polling in Settings"
    : !prAutoDispatchAllowed
      ? "Auto-fix PR disabled globally — allow it in Git settings"
      : hasAttachedPullRequest
        ? "Auto-fix PR — handle new CI failures or merge conflicts"
        : "Auto-fix PR — starts when a PR for this workspace is linked";
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
  const leaveLocalBranchOptions = useMemo(
    () =>
      buildLeaveLocalBranchPickerOptions({
        currentBranch: sourceBranch,
        directory: props.directory,
      }),
    [sourceBranch, props.directory],
  );
  const branchOptions = leaveLocalBranchOptions.map((option) => option.name);
  const canHandoffThreadWorkspace = Boolean(
    props.thread &&
      threadWorkspace &&
      isThreadWorkspaceHandoffEligible({ sourceBranch, threadWorkspace }) &&
      props.onHandoffThreadWorkspace &&
      props.thread.workspaceHandoff?.available !== false &&
      !sending &&
      !activeTurnId &&
      !queuedTurns.some((queued) =>
        Boolean(queued.backendQueuePending || queued.queueEntryId)
      ) &&
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
        ...(props.thread?.federation?.ref.target || rendererFederationTarget
          ? {
              federationTarget:
                props.thread?.federation?.ref.target ?? rendererFederationTarget,
            }
          : {}),
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

    if (autocompleteKind === "hash-references") {
      const option =
        filteredHashReferenceOptions[activeHashReferenceIndex]
        ?? filteredHashReferenceOptions[0];
      if (option?.kind === "thread") {
        applyHashReference((index) =>
          createComposerThreadToken(
            resolveThreadSummaryReference(option.thread),
            index,
          ),
        );
        return;
      }
      if (option?.kind === "pull-request") {
        applyHashReference((index) =>
          createComposerPullRequestToken(option.pullRequest, index),
        );
      }
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

    if (command.id === "codex-mcp") {
      showMcpInventory("toolsAndAuthOnly");
      return true;
    }

    if (command.id === "codex-mcp-verbose") {
      showMcpInventory("full");
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

  const dismissAutocomplete = useCallback((restoreFocus = false): void => {
    if (!autocompleteKey) {
      return;
    }
    setDismissedAutocompleteKey(autocompleteKey);
    setActiveSkillIndex(0);
    setActiveSlashIndex(0);
    setActiveDirectoryRefIndex(0);
    setActiveHashReferenceIndex(0);
    if (restoreFocus) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [autocompleteKey]);

  const handleAutocompleteKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (!hasAutocompleteOptions && event.key !== "Escape") {
      return;
    }

    const updateActiveAutocompleteIndex = (
      updater: (current: number) => number,
    ): void => {
      if (autocompleteKind === "skills") {
        setActiveSkillIndex(updater);
      } else if (autocompleteKind === "directories") {
        setActiveDirectoryRefIndex(updater);
      } else if (autocompleteKind === "hash-references") {
        setActiveHashReferenceIndex(updater);
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
      dismissAutocomplete(true);
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

  // Autocomplete stays open when focus moves into the transcript, so Escape
  // must dismiss it at window scope instead of relying on the editor handler.
  useEffect(() => {
    if (!autocompleteKind) {
      return;
    }
    const dismissOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      dismissAutocomplete();
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [autocompleteKind, dismissAutocomplete]);

  // Backend availability gates submission and remote actions, not the draft.
  // Keeping the editor live lets an operator inspect, copy, revise, or remove
  // durable text and attachments while federation reconnects.
  const composerDisabled = launchpadSubmitting;
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

    if (!hasAutocompleteOptions) {
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
  const pdfPreviewPathSet = new Set(
    pdfPreviewReferences.map((reference) => reference.path),
  );
  const visibleFileAttachments = fileAttachments.filter(
    (attachment) => !pdfPreviewPathSet.has(attachment.path),
  );
  const hasVisibleAttachments =
    imageAttachments.length > 0
    || visibleFileAttachments.length > 0
    || pdfPreviewReferences.length > 0;
  const imageLightbox = lightboxAttachment ? (
    <ImageLightbox
      src={lightboxAttachment.url}
      alt={formatPastedImageAlt(lightboxAttachment, 0)}
      onClose={() => setLightboxAttachment(undefined)}
    />
  ) : null;
  const pdfPreviewLightboxNode = pdfPreviewLightbox ? (
    <ImageLightbox
      alt={`Page 1 preview of ${pdfPreviewLightbox.label}`}
      caption={`${pdfPreviewLightbox.label} · Page 1 of ${pdfPreviewLightbox.preview.pageCount}`}
      dialogLabel={`PDF preview: ${pdfPreviewLightbox.label}`}
      src={pdfPreviewLightbox.preview.dataUrl}
      onClose={() => setPdfPreviewLightbox(undefined)}
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
                    <div className="workspace-handoff-dialog__field">
                      <span aria-hidden="true">Leave current checkout on</span>
                      <BranchPicker
                        ariaLabel="Leave current checkout on"
                        className="branch-picker--dialog"
                        disabled={handoffSubmitting}
                        options={leaveLocalBranchOptions}
                        value={leaveLocalBranch}
                        onChange={setLeaveLocalBranch}
                      />
                    </div>
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

      {/* Topmost in the band: ambient agent work the operator did not just
          launch. Env action rows sit below it, nearer the input, because they
          carry the Stop the operator is most likely to reach for. */}
      <ActiveSubAgentsStrip
        desktopApi={props.desktopApi}
        onRefreshNavigation={props.onRefreshNavigation}
        thread={props.thread}
      />

      {/* Same band, same reasoning: automation runs fire without the operator
          asking, so only the in-flight and the broken get their eyeline. */}
      <ActiveAutomationRunsStrip
        desktopApi={props.desktopApi}
        thread={props.thread}
      />

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
              {pendingSteer.status === "steering"
                ? "Steering now"
                : pendingSteer.status === "queued"
                  ? "Queued by Grok"
                  : "Pending steer"}
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

      {prAutoDispatchPending ? (
        <div
          className="composer__queued composer__queued--scheduled"
          aria-label="Scheduled PR auto-fix"
        >
          <div className="composer__queued-copy">
            <span className="composer__queued-label">
              {!backgroundPrPollingEnabled
                ? "Auto-fix PR paused"
                : !prAutoDispatchAllowed
                  ? "Auto-fix PR disabled"
                  : `Auto-fix PR in ${formatScheduledSendCountdown(
                      prAutoDispatchPending.scheduledAt,
                      scheduleNow,
                    )}`}
            </span>
            <span className="composer__queued-text">
              #{prAutoDispatchPending.prNumber} · {prAutoDispatchPending.eventKinds
                .map((kind) =>
                  kind === "ci-failure" ? "CI failed" : "merge conflict",
                )
                .join(" + ")}
              {prAutoDispatchPending.prTitle
                ? ` · ${prAutoDispatchPending.prTitle}`
                : ""}
            </span>
          </div>
          <div className="composer__queued-actions">
            <button
              className="composer__secondary-action"
              type="button"
              disabled={
                !prAutoDispatchAvailable
                || !props.onSendThreadPrAutoDispatchNow
              }
              onClick={() => {
                void props.onSendThreadPrAutoDispatchNow?.(
                  prAutoDispatchPending.fingerprint,
                );
              }}
            >
              Send now
            </button>
            <button
              className="composer__secondary-action"
              type="button"
              disabled={!props.onCancelThreadPrAutoDispatch}
              onClick={() => {
                void props.onCancelThreadPrAutoDispatch?.(
                  prAutoDispatchPending.fingerprint,
                );
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {queuedTurns.map((queued, index) => {
        const queuedScopeKey = composerScopeKey;
        const backendOwned = Boolean(
          queued.backendQueuePending
          || queued.queueEntryId
          || queued.scheduledActionId,
        );
        const scheduledSendAt = getFutureScheduledSendAt(
          queued.scheduledSendAt,
          scheduleNow,
        );
        const queuedLabel = queued.errorMessage
          ? "Failed to send"
          : scheduledSendAt
          ? `Scheduled · sends in ${formatScheduledSendCountdown(scheduledSendAt, scheduleNow)}`
          : index === 0
            ? "Queued next"
            : `Queued #${index + 1}`;

        return (
          <div
            className={[
              "composer__queued",
              scheduledSendAt ? "composer__queued--scheduled" : "",
              queued.errorMessage ? "composer__queued--failed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={
              scheduledSendAt
                ? index === 0
                  ? "Scheduled message"
                  : `Scheduled message ${index + 1}`
                : index === 0
                  ? "Queued message"
                  : `Queued message ${index + 1}`
            }
            key={queued.id}
          >
            <div className="composer__queued-copy">
              <span className="composer__queued-label">
                {queuedLabel}
              </span>
              <span className="composer__queued-text">
                {formatDraftPreview(queued)}
              </span>
              {queued.errorMessage ? (
                <span className="composer__queued-error">
                  {queued.errorMessage}
                </span>
              ) : null}
            </div>
            <QueuedImageAttachments attachments={queued.imageAttachments} />
            <div className="composer__queued-actions">
              {queued.scheduledActionId && scheduledSendAt ? (
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
              ) : activeTurnId ? (
                supportsSteering && !queued.reviewCommand ? (
                  <button
                    className="composer__secondary-action"
                    disabled={
                      props.disabled || steering || queued.backendQueuePending
                    }
                    type="button"
                    onClick={() => {
                      void steerQueuedTurn(queued);
                    }}
                  >
                    {steering ? "Steering..." : "Steer"}
                  </button>
                ) : null
              ) : !backendOwned ? (
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
              ) : null}
              <button
                className="composer__secondary-action"
                disabled={queued.backendQueuePending}
                type="button"
                onClick={() => {
                  const editQueuedTurn = (): void => {
                    removeQueuedTurnInScope(queuedScopeKey, queued);
                    if (activeComposerScopeKeyRef.current !== queuedScopeKey) {
                      const currentDraft = draftStore.get(queuedScopeKey);
                      if (
                        currentDraft
                        && hasComposerDraftSnapshotContent(currentDraft)
                      ) {
                        draftStore.pushDraft(queuedScopeKey, currentDraft);
                      }
                      saveComposerDraftSnapshot(queuedScopeKey, {
                        draft: queued.text,
                        editorDocument: undefined,
                        imageAttachments: queued.imageAttachments,
                        fileAttachments: queued.fileAttachments,
                        skillTokens: [],
                      });
                      return;
                    }
                    setComposerDraftFromCanonical(queued.text);
                    setImageAttachments(queued.imageAttachments);
                    setFileAttachments(queued.fileAttachments);
                    setScheduledDraftSendAt(scheduledSendAt);
                    setScheduleArmed(true);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  };
                  if (!backendOwned) {
                    editQueuedTurn();
                    return;
                  }
                  void (async () => {
                    const cancellation = await cancelServerManagedQueuedTurn(
                      queued,
                      queuedScopeKey,
                    );
                    if (cancellation !== "cancelled") {
                      return;
                    }
                    editQueuedTurn();
                  })();
                }}
              >
                Edit
              </button>
              <button
                className="composer__secondary-action"
                disabled={queued.backendQueuePending}
                type="button"
                onClick={() => {
                  if (!backendOwned) {
                    removeQueuedTurnAt(index);
                    return;
                  }
                  void (async () => {
                    const cancellation = await cancelServerManagedQueuedTurn(
                      queued,
                      queuedScopeKey,
                    );
                    if (cancellation === "cancelled") {
                      removeQueuedTurnInScope(queuedScopeKey, queued);
                    }
                  })();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}

      {hasVisibleAttachments ? (
        <div
          className="composer__attachments"
          aria-label={
            visibleFileAttachments.length > 0 || pdfPreviewReferences.length > 0
              ? "Attachments"
              : "Pasted images"
          }
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
          {pdfPreviewReferences.map((reference) => {
            const previewState = composerPdfPreviewStates.get(reference.path);
            const preview =
              previewState?.status === "ready" ? previewState.preview : undefined;
            const previewActionLabel =
              previewState?.status === "error" ? "Retry preview" : "Preview";
            return (
              <div
                className="composer__attachment composer__attachment--pdf"
                key={reference.path}
              >
                <div className="composer__attachment-thumb">
                  {preview ? (
                    <button
                      aria-label={`Expand PDF preview for ${reference.label}`}
                      className="composer__attachment-open"
                      type="button"
                      onClick={() => {
                        setPdfPreviewLightbox({
                          label: reference.label,
                          path: reference.path,
                          preview,
                        });
                      }}
                    >
                      <img
                        className="composer__attachment-preview composer__attachment-preview--pdf"
                        src={preview.dataUrl}
                        alt={`Page 1 preview of ${reference.label}`}
                      />
                    </button>
                  ) : (
                    <div
                      aria-live="polite"
                      className={[
                        "composer__pdf-preview-placeholder",
                        previewState?.status !== "loading" ? "has-action" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="status"
                    >
                      {previewState?.status === "loading" ? (
                        <span
                          aria-hidden="true"
                          className="composer__pdf-preview-spinner"
                        />
                      ) : (
                        <FileCodeIcon size={22} aria-hidden="true" />
                      )}
                      <span className="composer__pdf-preview-placeholder-label">
                        {previewState?.status === "loading"
                          ? "Loading preview"
                          : previewState?.status === "error"
                            ? previewState.message
                            : "PDF"}
                      </span>
                      {previewState?.status !== "loading" ? (
                        <button
                          className="composer__pdf-preview-action"
                          type="button"
                          onClick={() => {
                            void requestComposerPdfPreview(reference.path);
                          }}
                        >
                          {previewActionLabel}
                        </button>
                      ) : null}
                    </div>
                  )}
                  {reference.attachmentId ? (
                    <button
                      aria-label={`Remove ${reference.label}`}
                      className="composer__attachment-remove"
                      type="button"
                      onClick={() => {
                        removeFileAttachment(reference.attachmentId!);
                      }}
                    >
                      <CloseIcon size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <div className="composer__attachment-chips">
                  {preview ? (
                    <>
                      <span className="composer__attachment-chip">
                        Page 1 of {preview.pageCount}
                      </span>
                      <span className="composer__attachment-chip">
                        {formatImageDimensions(preview.width, preview.height)}
                      </span>
                    </>
                  ) : (
                    <span className="composer__attachment-chip">PDF</span>
                  )}
                </div>
                <span
                  className="composer__pdf-preview-label tooltip-target"
                  data-tooltip={buildFileReferenceTooltip(reference.path)}
                >
                  {reference.label}
                </span>
              </div>
            );
          })}
          {visibleFileAttachments.map((attachment) => (
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

      {pdfReferencePaths.length > 0 ? (
        <p className="composer__meta" role="status">
          {props.pdfAnalysisEnabled !== false
            ? "PDF analysis is on. PwrAgent uses local PDF tools for supported Codex threads and renders bounded page images when needed, preserving visual layout with less input overhead. Turn it off in Settings > General to leave PDFs as normal local-file references."
            : "PDF analysis is off. This PDF will be sent as a normal local-file reference for the model to inspect with code or its own tools."}
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

            {reviewerOverridesSupported ? (
              <div className="composer__review-field composer__review-reviewer">
                <span>Reviewer</span>
                <div className="composer__review-reviewer-chips">
                  <ComposerDropdown
                    ariaLabel="Review provider"
                    id="composer-review-provider"
                    options={reviewerBackendOptions.map((candidate) => ({
                      label: formatBackendLabel(candidate.kind, props.backends),
                      value: candidate.kind,
                    }))}
                    value={reviewerSelection.backend ?? ""}
                    onChange={(value) => {
                      patchReviewer(() => ({
                        backend: value as AppServerBackendKind,
                      }));
                    }}
                  />
                  {reviewerModelOptions.length > 0 ? (
                    <ComposerDropdown
                      ariaLabel="Review model"
                      id="composer-review-model"
                      options={reviewerModelOptions.map((option) => ({
                        label: option.label ?? option.id,
                        value: option.id,
                      }))}
                      value={reviewerSelection.model?.id ?? ""}
                      onChange={(value) => {
                        patchReviewer((current) => {
                          const backend =
                            current?.backend ?? reviewerSelection.backend;
                          return backend ? { backend, model: value } : current;
                        });
                      }}
                    />
                  ) : null}
                  {reviewerReasoningOptions.length > 0 ? (
                    <ComposerDropdown
                      ariaLabel="Review reasoning"
                      id="composer-review-reasoning"
                      options={reviewerReasoningOptions.map((effort) => ({
                        label: effort,
                        value: effort,
                      }))}
                      value={reviewerSelection.reasoningEffort ?? ""}
                      onChange={(value) => {
                        patchReviewer((current) => {
                          const backend =
                            current?.backend ?? reviewerSelection.backend;
                          if (!backend) {
                            return current;
                          }
                          return {
                            backend,
                            ...(reviewerSelection.model?.id
                              ? { model: reviewerSelection.model.id }
                              : {}),
                            reasoningEffort: value,
                          };
                        });
                      }}
                    />
                  ) : null}
                  {resolvableReviewerRecents.length > 0 ? (
                    <ComposerDropdown
                      ariaLabel="Recent reviewer settings"
                      id="composer-review-recents"
                      options={[
                        // Sentinel so the trigger reads "Recent" until a
                        // remembered combination is actually applied; the
                        // dropdown falls back to the first option whenever the
                        // value matches nothing.
                        { label: "Recent", value: "" },
                        ...resolvableReviewerRecents.map((recent, index) => ({
                          label: formatReviewerRecentLabel(
                            recent,
                            props.backends,
                          ),
                          value: String(index),
                        })),
                      ]}
                      tooltip="Reuse a recent reviewer"
                      value={
                        activeReviewerRecentIndex >= 0
                          ? String(activeReviewerRecentIndex)
                          : ""
                      }
                      onChange={(value) => {
                        const picked = resolvableReviewerRecents[Number(value)];
                        if (picked) {
                          patchReviewer(() => picked);
                        }
                      }}
                    />
                  ) : null}
                  {reviewerOverridden ? (
                    <button
                      type="button"
                      aria-label="Reset reviewer to thread settings"
                      className="composer__toggle tooltip-target"
                      data-tooltip="Reset the reviewer to this thread's provider, model, and reasoning"
                      onClick={() => {
                        patchReviewer(() => undefined);
                      }}
                    >
                      ↺
                    </button>
                  ) : null}
                </div>
              </div>
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
                      scheduleNow,
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
            ariaExpanded={Boolean(autocompleteKind)}
            disabled={composerDisabled}
            label={isLaunchpad ? "New thread" : "Reply"}
            markdownConversion
            placeholder={composerPlaceholder}
            resolveThreadLink={(ref) => {
              const resolved = threadLinks?.resolve(ref);
              return resolved ? threadLinks?.getSnapshot(resolved) : undefined;
            }}
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
                role="option"
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
                role="option"
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
            className={`composer__autocomplete composer__autocomplete--directories composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            <div
              aria-label="Directories"
              id={directoryRefListboxId}
              role="listbox"
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
                  role="option"
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
            </div>
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
                data-tooltip={
                  filesystemFederationTarget
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
                disabled={Boolean(filesystemFederationTarget)}
                title={
                  filesystemFederationTarget
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
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
                data-tooltip={
                  filesystemFederationTarget
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
                disabled={Boolean(filesystemFederationTarget)}
                title={
                  filesystemFederationTarget
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
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
        ) : autocompleteKind === "hash-references" ? (
          <div
            className={`composer__autocomplete composer__autocomplete--hash-references composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            role="listbox"
            aria-label="Threads and pull requests"
            id={hashReferenceListboxId}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            {filteredHashReferenceOptions.map((option, index) => {
              const showRemoteDivider =
                option.remote
                && !filteredHashReferenceOptions[index - 1]?.remote;
              if (option.kind === "thread") {
                const thread = option.thread;
                const threadLabel = formatHashReferenceThreadLabel(thread);
                const threadTitle = formatHashReferenceThreadTooltip(thread);
                const threadMeta = describeHashReferenceThread(
                  thread,
                  hashReferenceTrigger?.query ?? "",
                );
                const key = thread.federation
                  ? federatedThreadIdentityKey(thread.federation.ref)
                  : buildThreadIdentityKey(thread.source, thread.id);
                return (
                  <Fragment key={key}>
                    {showRemoteDivider ? (
                      <div
                        aria-hidden="true"
                        className="composer__autocomplete-section-divider"
                        role="presentation"
                      >
                        Other instances
                      </div>
                    ) : null}
                    <button
                      id={`${hashReferenceListboxId}-option-${index}`}
                      ref={(node) => {
                        autocompleteOptionRefs.current[index] = node;
                      }}
                      aria-selected={index === activeHashReferenceIndex}
                      className={`composer__autocomplete-option${index === activeHashReferenceIndex ? " is-active" : ""}`}
                      role="option"
                      tabIndex={index === activeHashReferenceIndex ? 0 : -1}
                      // The visible label is one clamped line; hovering the
                      // row still gives the operator the whole title.
                      title={threadTitle}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyHashReference((tokenIndex) =>
                          createComposerThreadToken(
                            resolveThreadSummaryReference(thread),
                            tokenIndex,
                          ),
                        );
                      }}
                      onClick={() => {
                        applyHashReference((tokenIndex) =>
                          createComposerThreadToken(
                            resolveThreadSummaryReference(thread),
                            tokenIndex,
                          ),
                        );
                      }}
                      onFocus={() => {
                        setActiveHashReferenceIndex(index);
                      }}
                      onKeyDown={handleAutocompleteKeyDown}
                    >
                      <span className="composer__autocomplete-title">
                        <ThreadIcon size={13} aria-hidden="true" />
                        <span className="composer__autocomplete-label">
                          <HighlightedAutocompleteLabel
                            label={`#${threadLabel.replace(/^#/, "")}`}
                            matchAnywhere
                            query={hashReferenceTrigger?.query.trim() ?? ""}
                          />
                        </span>
                        <span className="composer__autocomplete-source">
                          Thread
                        </span>
                      </span>
                      <span className="composer__autocomplete-meta composer__autocomplete-meta--thread">
                        {thread.federation?.ref.target.scope === "remote" ? (
                          <InstanceChip
                            icon={thread.federation.celestialIcon}
                            instanceId={thread.federation.ref.target.instanceId}
                            label={thread.federation.instanceLabel}
                          />
                        ) : null}
                        {threadMeta ? (
                          <span className="composer__autocomplete-label">
                            {threadMeta}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </Fragment>
                );
              }

              const pullRequest = option.pullRequest;
              return (
                <Fragment key={pullRequest.url}>
                  {showRemoteDivider ? (
                    <div
                      aria-hidden="true"
                      className="composer__autocomplete-section-divider"
                      role="presentation"
                    >
                      Other instances
                    </div>
                  ) : null}
                  <button
                    id={`${hashReferenceListboxId}-option-${index}`}
                    ref={(node) => {
                      autocompleteOptionRefs.current[index] = node;
                    }}
                    aria-selected={index === activeHashReferenceIndex}
                    className={`composer__autocomplete-option${index === activeHashReferenceIndex ? " is-active" : ""}`}
                    role="option"
                    tabIndex={index === activeHashReferenceIndex ? 0 : -1}
                    title={pullRequest.title || pullRequest.url}
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyHashReference((tokenIndex) =>
                        createComposerPullRequestToken(pullRequest, tokenIndex),
                      );
                    }}
                    onClick={() => {
                      applyHashReference((tokenIndex) =>
                        createComposerPullRequestToken(pullRequest, tokenIndex),
                      );
                    }}
                    onFocus={() => {
                      setActiveHashReferenceIndex(index);
                    }}
                    onKeyDown={handleAutocompleteKeyDown}
                  >
                    <span className="composer__autocomplete-title">
                      <PullRequestIcon size={13} aria-hidden="true" />
                      <span className="composer__autocomplete-label">
                        {`${pullRequest.org}/${pullRequest.repo}#${pullRequest.number}`}
                      </span>
                      <span className="composer__autocomplete-source">
                        Pull request
                      </span>
                    </span>
                    <span className="composer__autocomplete-meta composer__autocomplete-meta--single-line">
                      {pullRequest.title || pullRequest.url}
                    </span>
                  </button>
                </Fragment>
              );
            })}
            {federatedHashSearchLoading ? (
              <div
                aria-hidden="true"
                className="composer__autocomplete-remote-loading"
                role="presentation"
              >
                Searching other instances…
              </div>
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
                if (!props.launchpad) {
                  return;
                }
                const nextBackend = value as NavigationLaunchpadDraft["backend"];
                const hasRememberedModel = Boolean(
                  props.launchpad.providerSettings?.[nextBackend]?.model,
                );
                if (nextBackend.startsWith("acp:") && !hasRememberedModel) {
                  pendingProviderSelectionKeyRef.current =
                    `${props.launchpad.directoryKey}:${nextBackend}`;
                } else {
                  pendingProviderSelectionKeyRef.current = undefined;
                }
                if (
                  !nextBackend.startsWith("acp:")
                  || !props.onProviderSelected
                ) {
                  void refreshProviderCatalogOnFirstSelection(
                    props.desktopApi,
                    nextBackend,
                  );
                }
                handleLaunchpadPatch({
                  backend: nextBackend,
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
              nativePickingDisabled={Boolean(filesystemFederationTarget)}
              pickError={props.pickDirectoryError}
              picking={props.pickingDirectory}
              onSelect={(directory) => {
                props.onClearPickDirectoryError?.();
                prepareDraftRetarget(directory.key);
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
              onPickFromDisk={
                props.onPickAndRegisterDirectory
                  ? () => {
                      props.onClearPickDirectoryError?.();
                      props.onPickAndRegisterDirectory?.();
                    }
                  : undefined
              }
            />
          ) : null}

          {props.thread && props.onPickAndAttachDirectoryToThread ? (
            <>
              <button
                className="composer__action-button composer__attach-directory-button"
                data-tooltip={
                  filesystemFederationTarget
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
                disabled={
                  props.pickingDirectory || Boolean(filesystemFederationTarget)
                }
                title={
                  filesystemFederationTarget
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
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
              tooltip={
                props.directory?.gitStatus?.worktreeCreationAvailable === false
                  ? props.directory.gitStatus.worktreeCreationUnavailableReason
                  : undefined
              }
              onPointerEnter={
                props.directory?.gitStatus?.worktreeCreationAvailable === false
                && props.desktopApi?.refreshDirectoryGitStatuses
                  ? () => {
                      void props.desktopApi?.refreshDirectoryGitStatuses?.({
                        directoryKeys: [props.launchpad!.directoryKey],
                        federationTarget: filesystemFederationTarget,
                        force: true,
                      });
                    }
                  : undefined
              }
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

          {props.launchpad &&
          profileModelOption &&
          launchpadDiffersFromProfileDefaults ? (
            <button
              aria-label="Reset model and reasoning to profile default"
              className="composer__toggle tooltip-target"
              data-tooltip="Reset model and reasoning to the AI Providers default"
              disabled={launchpadSubmitting}
              type="button"
              onClick={() => {
                handleLaunchpadPatch({
                  model: profileModelOption.id,
                  reasoningEffort:
                    profileReasoningOptions.length > 0
                      ? profileReasoningEffort
                      : undefined,
                });
              }}
            >
              <span aria-hidden="true">↺</span>
            </button>
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

          {props.thread && showPrAutoDispatchToggle ? (
            <button
              type="button"
              className={`composer__toggle tooltip-target${
                props.thread.prAutoDispatchEnabled ? " is-active" : ""
              }`}
              aria-label="Auto-fix PR"
              aria-pressed={Boolean(props.thread.prAutoDispatchEnabled)}
              data-tooltip={prAutoDispatchTooltip}
              disabled={!prAutoDispatchAvailable}
              onClick={() => {
                if (!prAutoDispatchAvailable) return;
                void props.onSetThreadPrAutoDispatch?.(
                  !props.thread?.prAutoDispatchEnabled,
                );
              }}
            >
              <PullRequestIcon size={15} aria-hidden="true" />
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
              nativePickingDisabled={Boolean(filesystemFederationTarget)}
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
          <ComposerThreadOptionsMenu
            agentThread={Boolean(props.launchpad?.agent ?? props.thread?.agent)}
            disabled={launchpadSubmitting || agentThreadSaving}
            existingCodexThread={
              props.thread !== undefined &&
              !canChangeExistingThreadAgentDesignation(props.thread)
            }
            onAgentThreadChange={
              props.launchpad
                ? props.onUpdateLaunchpad
                  ? (agentThread) => {
                      void changeAgentThread(agentThread);
                    }
                  : undefined
                : props.thread &&
                    canChangeExistingThreadAgentDesignation(props.thread) &&
                    props.desktopApi?.setThreadAgent
                  ? (agentThread) => {
                      void changeAgentThread(agentThread);
                    }
                  : undefined
            }
            onShowMcpInventory={
              supportsMcpInventory
                ? () => props.onShowMcpInventory?.("toolsAndAuthOnly")
                : undefined
            }
            {...(props.thread?.source === "codex" && props.desktopApi?.setThreadTokenMiser
              ? {
                  tokenMiser: props.thread.tokenMiserEnabled
                    ?? props.tokenMiserEnabled
                    ?? false,
                  tokenMiserOverridden: props.thread.tokenMiserEnabled !== undefined,
                  onTokenMiserChange: (enabled: boolean) => {
                    void changeTokenMiser(enabled);
                  },
                }
              : {})}
          />
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
      {agentThreadError ? (
        <p className="composer__meta composer__meta--error" role="alert">
          {agentThreadError}
        </p>
      ) : null}
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
      ) : !props.pendingRequestActive && props.pendingUserInputActive ? (
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
              data-testid="composer-stop-turn"
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
                // Cancel empties the launchpad without losing what was typed:
                // the message is parked in the ArrowUp recovery buffer and the
                // active draft is cleared. Leaving the draft in place instead
                // would rehydrate it into the next launchpad opened for this key
                // and keep the row's orange "has-draft" marker lit.
                abandonComposerDraftSnapshot(composerScopeKey);
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
                  aria-label={props.launchpad ? "Schedule thread" : "Schedule message"}
                  className="button composer__send-schedule-button"
                  disabled={scheduleButtonDisabled}
                  type="button"
                  onClick={() => {
                    setScheduleTick((current) => current + 1);
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
                          scheduleNow,
                        )}. Uncheck to send now.`
                      : `Send now. Check to send later, in ${formatScheduledSendCountdown(
                          futureScheduledDraftSendAt!,
                          scheduleNow,
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
                    setScheduleTick((current) => current + 1);
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
                      scheduleNow,
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
                    {props.launchpad
                      ? option.label.replace(/^Send /, "Start ")
                      : option.label}
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
      {pdfPreviewLightboxNode}
    </>
  );
}

function ContextWindowMoon({
  contextWindow,
}: {
  contextWindow?: ThreadContextWindowState;
}) {
  const { show, update, hide, visible, tooltipNode } = useViewportTooltip({
    className: "context-usage-card",
  });

  // Token-usage notifications keep streaming while a turn runs; push the
  // fresh numbers into an already-open card instead of freezing it at
  // hover-time values. If the context state disappears (thread switch),
  // drop the card so it can't reappear at stale coordinates.
  useEffect(() => {
    if (!contextWindow) {
      hide();
      return;
    }
    if (!visible) {
      return;
    }
    const phase = Math.min(
      CONTEXT_MOON_PHASES.length - 1,
      Math.max(0, contextWindow.phase),
    );
    update(
      <ContextWindowUsageCard
        contextWindow={contextWindow}
        phaseLabel={CONTEXT_MOON_PHASES[phase]}
      />,
    );
  }, [contextWindow, hide, update, visible]);

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
  const card = (
    <ContextWindowUsageCard contextWindow={contextWindow} phaseLabel={phaseLabel} />
  );

  return (
    <div
      aria-label={label}
      className="context-window-moon"
      role="img"
      tabIndex={0}
      onBlur={hide}
      onFocus={(event) => show(event.currentTarget, card)}
      onMouseEnter={(event) => show(event.currentTarget, card)}
      onMouseLeave={hide}
    >
      <span
        aria-hidden="true"
        className={`context-window-moon__sprite context-window-moon__sprite--phase-${phase}`}
      >
        <span className="context-window-moon__disc" />
      </span>
      <span className="context-window-moon__label">{percentLabel}</span>
      {tooltipNode}
    </div>
  );
}

function ContextWindowUsageCard({
  contextWindow,
  phaseLabel,
}: {
  contextWindow: ThreadContextWindowState;
  phaseLabel: string;
}) {
  const usedPercent = Math.max(0, Math.min(100, contextWindow.usedPercent));
  const critical = contextWindow.phase >= CONTEXT_MOON_PHASES.length - 1;
  const hasBreakdown =
    typeof contextWindow.inputTokens === "number"
    || typeof contextWindow.cachedInputTokens === "number"
    || typeof contextWindow.outputTokens === "number"
    || typeof contextWindow.reasoningOutputTokens === "number";

  return (
    <>
      <div className="context-usage-card__header">
        <span className="context-usage-card__eyebrow">Context window</span>
        <span className="context-usage-card__phase">{phaseLabel}</span>
      </div>
      <div className="context-usage-card__headline">
        <span className="context-usage-card__percent">
          {Math.round(usedPercent)}% full
        </span>
        {typeof contextWindow.remainingTokens === "number" ? (
          <span className="context-usage-card__remaining">
            {formatCompactNumber(contextWindow.remainingTokens)} left
          </span>
        ) : null}
      </div>
      <div aria-hidden="true" className="context-usage-card__meter">
        <span
          className={
            critical
              ? "context-usage-card__meter-fill context-usage-card__meter-fill--critical"
              : "context-usage-card__meter-fill"
          }
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div className="context-usage-card__caption">
        {`${formatCompactNumber(contextWindow.totalTokens)} of ${formatCompactNumber(
          contextWindow.modelContextWindow
        )} tokens`}
      </div>
      {hasBreakdown ? (
        <div className="context-usage-card__section">
          <span className="context-usage-card__section-title">Current request</span>
          {typeof contextWindow.inputTokens === "number" ? (
            <ContextUsageRow
              label="Input"
              value={formatCompactNumber(contextWindow.inputTokens)}
            />
          ) : null}
          {typeof contextWindow.cachedInputTokens === "number" ? (
            <ContextUsageCacheMeter
              cachedTokens={contextWindow.cachedInputTokens}
              inputTokens={contextWindow.inputTokens}
            />
          ) : null}
          {typeof contextWindow.outputTokens === "number" ? (
            <ContextUsageRow
              label="Output"
              value={formatCompactNumber(contextWindow.outputTokens)}
            />
          ) : null}
          {typeof contextWindow.reasoningOutputTokens === "number" ? (
            <ContextUsageRow
              label="Reasoning"
              value={formatCompactNumber(contextWindow.reasoningOutputTokens)}
            />
          ) : null}
        </div>
      ) : null}
      {typeof contextWindow.cumulativeTotalTokens === "number" ? (
        <div className="context-usage-card__section">
          <span className="context-usage-card__section-title">Session total</span>
          <ContextUsageRow
            label="Tokens"
            value={formatCompactNumber(contextWindow.cumulativeTotalTokens)}
          />
          {typeof contextWindow.cumulativeCachedInputTokens === "number" ? (
            <ContextUsageCacheMeter
              cachedTokens={contextWindow.cumulativeCachedInputTokens}
              inputTokens={contextWindow.cumulativeInputTokens}
            />
          ) : null}
          {typeof contextWindow.cumulativeOutputTokens === "number" ? (
            <ContextUsageRow
              label="Output"
              value={formatCompactNumber(contextWindow.cumulativeOutputTokens)}
            />
          ) : null}
          {typeof contextWindow.cumulativeReasoningOutputTokens === "number" ? (
            <ContextUsageRow
              label="Reasoning"
              value={formatCompactNumber(contextWindow.cumulativeReasoningOutputTokens)}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ContextUsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="context-usage-card__row">
      <span className="context-usage-card__row-label">{label}</span>
      <span className="context-usage-card__row-value">{value}</span>
    </div>
  );
}

function ContextUsageCacheMeter({
  cachedTokens,
  inputTokens,
}: {
  cachedTokens: number;
  inputTokens: number | undefined;
}) {
  if (typeof inputTokens !== "number" || inputTokens <= 0) {
    return <ContextUsageRow label="Cached" value={formatCompactNumber(cachedTokens)} />;
  }

  const percent = Math.max(0, Math.min(100, (cachedTokens / inputTokens) * 100));
  return (
    <div className="context-usage-card__cache">
      <span aria-hidden="true" className="context-usage-card__cache-meter">
        <span
          className="context-usage-card__cache-fill"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="context-usage-card__cache-label">
        {formatCompactNumber(cachedTokens)} cached ({formatPercent(percent)})
      </span>
    </div>
  );
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

    const type = isSupportedComposerImageMimeType(item.type)
      ? item.type
      : inferTransferImageType(file);
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
    if (
      isSupportedComposerImageMimeType(item.type)
      || inferTransferImageType(file)
    ) {
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
  if (isSupportedComposerImageMimeType(file.type)) {
    return file.type;
  }

  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "gif" ? "image/gif" : undefined;
}

// Keep this list aligned with formats the composer deliberately normalizes or
// preserves. An arbitrary `image/*` MIME (for example, a huge TIFF) is a local
// file reference, not authorization to read and upload its contents.
function isSupportedComposerImageMimeType(type: string): boolean {
  switch (type.trim().toLowerCase()) {
    case "image/gif":
    case "image/heic":
    case "image/heif":
    case "image/jpeg":
    case "image/jpg":
    case "image/png":
    case "image/svg+xml":
    case "image/webp":
      return true;
    default:
      return false;
  }
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
    directory?.gitStatus?.worktreeCreationAvailable !== false &&
      directory?.path &&
      directory.kind === "directory" &&
      (directory.gitStatus?.worktreeCreationAvailable === true ||
        directory.gitStatus?.currentBranch ||
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

function hasPrimaryWorkspacePullRequest(
  thread: NavigationThreadSummary,
): boolean {
  const primaryRepository = getPrimaryWorkspaceRepository(thread);
  if (!primaryRepository) return false;
  return (thread.prs ?? []).some((pr) =>
    normalizeGitOriginUrl(`${pr.provider}/${pr.org}/${pr.repo}`)
      === primaryRepository,
  );
}

function getPrimaryWorkspaceRepository(
  thread: NavigationThreadSummary,
): string | undefined {
  return (
    normalizeGitOriginUrl(thread.primaryGitRepository)
    ?? normalizeGitOriginUrl(thread.gitOriginUrl)
  );
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

/**
 * Options for the handoff dialog's "leave current checkout on" picker.
 *
 * `getLeaveLocalBranchOptions` decides *which* refs are offered — it already
 * drops the branch being moved and (via `handoffBranches`) anything another
 * worktree holds. This only enriches those names with the recency and
 * default-branch metadata the picker renders, so the two stay in sync.
 *
 * The leading `"HEAD"` sentinel is a checkout state rather than a branch, so
 * it carries a display label and stays pinned above the recency list.
 */
function buildLeaveLocalBranchPickerOptions(params: {
  currentBranch?: string;
  directory?: NavigationDirectorySummary;
}): LaunchpadBranchOption[] {
  const details = params.directory?.gitStatus?.branchDetails ?? [];
  const detailByName = new Map(details.map((detail) => [detail.name, detail]));
  const defaultBranch = params.directory?.gitStatus?.defaultBranch;
  return getLeaveLocalBranchOptions(params).map((name) => {
    if (name === "HEAD") {
      return { name, label: "Detached HEAD", pinned: true };
    }
    const detail = detailByName.get(name);
    return {
      name,
      lastCommitAt: detail?.lastCommitAt,
      // Only reachable on the `branches` fallback path — `handoffBranches`
      // has already filtered in-use branches out.
      inUse: detail?.inUse,
      isDefault: defaultBranch ? name === defaultBranch : false,
    };
  });
}
