import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
} from "react";
import type {
  AppServerAvailableCommandSummary,
  AppServerCollaborationModeRequest,
  AppServerPendingRequestNotification,
  AppServerReviewTarget,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadPlanStep,
  AppServerThreadTurnMetadata,
  AppServerTurnInputItem,
  AppServerThreadReplayPagination,
  AppServerSkillSummary,
  BackendSummary,
  CodexEnvironmentSetupProgressEvent,
  CodexEnvironmentActionRun,
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  HandoffThreadWorkspaceRequest,
  MarkdownFileViewerContext,
  MessagingChannelKind,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  PendingRequestAction,
  ThreadExecutionMode,
  ThreadPricingSummary,
  ThreadToolAccounting,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  buildPendingRequestResponse,
  buildThreadIdentityKey,
  isBranchDrifted,
  readCodexEnvironmentActionRuns,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { IntegratedTerminalsController } from "../../lib/useIntegratedTerminals";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import type { PendingForkEnvironmentSetup } from "../../lib/useThreadNavigation";
import { formatBackendLabel } from "../../lib/backend-label";
import { isSameWorktreeSubthreadLaunchpad } from "../../lib/subthread-launchpads";
import { resolvePreferredEditor } from "../../lib/preferred-application";
import { Composer } from "../composer/Composer";
import type { ComposerDraftStore } from "../composer/useComposerDraftStore";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { ThreadContextPanel } from "./ThreadContextPanel";
import {
  DEFAULT_CONTEXT_TAB,
  DEFAULT_ACTION_RUNS_DOCK,
  DEFAULT_EDITED_FILES_DOCK,
  type ActionRunsDock,
  type ContextTabId,
  type EditedFilesDock,
} from "./context-panels/context-tab";
import { collectEditedFileGroups } from "./edited-file-groups";
import { useEditCommitStates } from "./useEditCommitStates";
import type { HistoryNavControls } from "../chrome/HistoryNavButtons";
import type { MastheadActionsProps } from "../chrome/MastheadActions";
import { ThreadFindBar } from "./ThreadFindBar";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadPlaceholderHeader } from "./ThreadPlaceholderHeader";
import { ImageLightbox } from "./ImageLightbox";
import { TranscriptList } from "./TranscriptList";
import { LiveWorkRail } from "./LiveWorkRail";
import {
  buildQuestionnaireResponse,
  type PendingQuestionnaireState,
} from "./questionnaire";
import {
  buildMcpElicitationResponse,
  type PendingMcpInteractionState,
} from "./mcp-elicitation";
import {
  mergeActivityDetails,
  readRendererSequence,
  summarizeActivityStatus,
} from "./live-transcript-activity";

type LaunchpadEnvironmentSetupProgress = {
  command: string;
  cwd?: string;
  directoryKey: string;
  durationMs?: number;
  environmentId: string;
  environmentName: string;
  error?: string;
  exitCode?: number;
  output: string;
  status: "starting" | "running" | "completed" | "failed";
};

const LazyIntegratedTerminal = lazy(async () => {
  const module = await import("./IntegratedTerminal");
  return { default: module.IntegratedTerminal };
});

const noop = (): void => {};

function applyLaunchpadEnvironmentSetupProgress(
  current: LaunchpadEnvironmentSetupProgress | undefined,
  event: CodexEnvironmentSetupProgressEvent,
): LaunchpadEnvironmentSetupProgress {
  const base =
    current?.directoryKey === event.directoryKey &&
    current.environmentId === event.environmentId
      ? current
      : {
          command: event.command,
          cwd: event.cwd,
          directoryKey: event.directoryKey,
          environmentId: event.environmentId,
          environmentName: event.environmentName,
          output: "",
          status: "starting" as const,
        };

  if (event.phase === "stdout" || event.phase === "stderr") {
    return {
      ...base,
      output: `${base.output}${event.chunk ?? ""}`.slice(-32_000),
      status: "running",
    };
  }

  if (event.phase === "completed") {
    return {
      ...base,
      durationMs: event.durationMs,
      exitCode: event.exitCode,
      output: event.output ?? base.output,
      status: "completed",
    };
  }

  if (event.phase === "failed") {
    return {
      ...base,
      error: event.error,
      status: "failed",
    };
  }

  return {
    ...base,
    status: "running",
  };
}

function formatSetupStatus(progress?: LaunchpadEnvironmentSetupProgress): string {
  if (!progress || progress.status === "starting" || progress.status === "running") {
    return "running";
  }
  if (progress.status === "completed") {
    return progress.exitCode === undefined ? "completed" : `exit ${progress.exitCode}`;
  }
  return "failed";
}

function LaunchpadEnvironmentSetupPending(props: {
  command?: string;
  cwd?: string;
  directoryLabel: string;
  environmentName?: string;
  progress?: LaunchpadEnvironmentSetupProgress;
}) {
  const output = props.progress?.output ?? "";
  const error = props.progress?.error;
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const outputNode = outputRef.current;
    if (!outputNode) {
      return;
    }
    outputNode.scrollTop = outputNode.scrollHeight;
  }, [error, output]);

  return (
    <section
      className="transcript-panel transcript-panel--pending transcript-panel--setup"
      aria-label="Preparing transcript"
    >
      <div className="launchpad-pending launchpad-pending--setup">
        <div className="launchpad-pending__header">
          <div>
            <p className="eyebrow">Preparing transcript</p>
            <h3>Running environment setup</h3>
          </div>
          <span className="launchpad-pending__status">
            {formatSetupStatus(props.progress)}
          </span>
        </div>
        <dl className="launchpad-pending__meta">
          <div>
            <dt>Environment</dt>
            <dd>{props.environmentName ?? "Selected environment"}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{props.directoryLabel}</dd>
          </div>
          {props.cwd ? (
            <div>
              <dt>Path</dt>
              <dd>{props.cwd}</dd>
            </div>
          ) : null}
        </dl>
        <div className="launchpad-pending__command" aria-label="Setup command">
          <div className="launchpad-pending__command-label">Command</div>
          <pre>
            <code>{props.command ? `$ ${props.command}` : "$"}</code>
          </pre>
        </div>
        <div className="launchpad-pending__output" aria-label="Setup output">
          <div className="launchpad-pending__command-label">
            {error ? "Output and errors" : "Output"}
          </div>
          <pre ref={outputRef}>
            <code>{`${output}${error ? `\n${error}` : ""}` || "Waiting for output..."}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function LaunchpadMaterializeFailure(props: {
  directoryLabel: string;
  error: string;
  onClose: () => void;
}) {
  return (
    <section
      className="transcript-panel transcript-panel--pending"
      aria-label="Thread launch failed"
    >
      <div className="launchpad-pending">
        <div className="launchpad-pending__header">
          <div>
            <p className="eyebrow">Thread launch failed</p>
            <h3>Could not start {props.directoryLabel}</h3>
          </div>
          <button
            className="button button--ghost"
            type="button"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
        <div className="launchpad-pending__output" aria-label="Launch error">
          <div className="launchpad-pending__command-label">Error</div>
          <pre>
            <code>{props.error}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function EnvironmentSetupFailureChoice(props: {
  archiving: boolean;
  continuing: boolean;
  command?: string;
  cwd?: string;
  error?: string;
  environmentName: string;
  exitCode?: number;
  hasWorktree: boolean;
  output?: string;
  phase: "setup" | "action";
  onCleanup: () => void;
  onContinue: () => void | Promise<void>;
}) {
  const label =
    props.phase === "action" ? "Environment action failed" : "Environment setup failed";
  const commandLabel = props.phase === "action" ? "action command" : "setup command";
  const trimmedOutput = props.output?.trim();
  const hasDetails =
    Boolean(props.command?.trim()) ||
    Boolean(trimmedOutput) ||
    typeof props.exitCode === "number";
  return (
    <section className="environment-setup-choice" aria-label={label}>
      <div className="environment-setup-choice__body">
        <div className="environment-setup-choice__heading">
          <p className="eyebrow">{label}</p>
          <h3>{props.environmentName}</h3>
          <p>
            {props.hasWorktree
              ? `The ${commandLabel} exited with an error. You can delete the new worktree and close this thread, or keep the thread open and fix it yourself or with agent assistance.`
              : `The ${commandLabel} exited with an error. You can close this thread, or keep it open and fix it yourself or with agent assistance.`}
          </p>
          {props.error ? (
            <p className="environment-setup-choice__error">{props.error}</p>
          ) : null}
        </div>
        {hasDetails ? (
          <details className="environment-setup-choice__details" open>
            <summary>
              Show command output
              {typeof props.exitCode === "number" ? ` (exit ${props.exitCode})` : ""}
            </summary>
            {props.command?.trim() ? (
              <div className="environment-setup-choice__field">
                <div className="environment-setup-choice__field-label">Command</div>
                <pre className="environment-setup-choice__pre">
                  <code>{`$ ${props.command.trim()}`}</code>
                </pre>
              </div>
            ) : null}
            {props.cwd?.trim() ? (
              <div className="environment-setup-choice__field">
                <div className="environment-setup-choice__field-label">Path</div>
                <code className="environment-setup-choice__path">{props.cwd}</code>
              </div>
            ) : null}
            <div className="environment-setup-choice__field">
              <div className="environment-setup-choice__field-label">Output</div>
              <pre className="environment-setup-choice__pre environment-setup-choice__pre--output">
                <code>{trimmedOutput || "(no output captured)"}</code>
              </pre>
            </div>
          </details>
        ) : null}
      </div>
      <div className="environment-setup-choice__actions">
        <button
          className="composer__action-button composer__action-button--danger"
          disabled={props.archiving || props.continuing}
          type="button"
          onClick={props.onCleanup}
        >
          {props.hasWorktree ? "Delete worktree and close" : "Close thread"}
        </button>
        <button
          className="composer__action-button"
          disabled={props.archiving || props.continuing}
          type="button"
          onClick={() => {
            void props.onContinue();
          }}
        >
          {props.continuing ? "Continuing..." : "Continue anyway"}
        </button>
      </div>
    </section>
  );
}

function buildInputFromOptimisticUserMessage(
  optimisticUserMessage: NavigationThreadSummary["optimisticUserMessage"],
): AppServerTurnInputItem[] {
  if (!optimisticUserMessage) {
    return [];
  }

  const text = optimisticUserMessage.text.trim();
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...(optimisticUserMessage.imageParts ?? []).map((imagePart) => ({
      type: "image" as const,
      url: imagePart.url,
    })),
  ];
}

function arePlanEntriesEquivalent(
  left: AppServerThreadPlanEntry,
  right: AppServerThreadPlanEntry
): boolean {
  const leftMarkdown = (left.markdown ?? "").trim();
  const rightMarkdown = (right.markdown ?? "").trim();
  if (leftMarkdown || rightMarkdown) {
    return leftMarkdown === rightMarkdown;
  }

  if (left.steps.length !== right.steps.length) {
    return false;
  }

  if ((left.explanation ?? "").trim() !== (right.explanation ?? "").trim()) {
    return false;
  }

  return left.steps.every((step, index) => {
    const other = right.steps[index];
    return other?.status === step.status && other.step === step.step;
  });
}

function getPlanNotificationItemId(params: Record<string, unknown>): string | undefined {
  if (typeof params.itemId === "string") {
    return params.itemId;
  }

  if (
    typeof params.item === "object" &&
    params.item !== null &&
    "id" in params.item &&
    typeof params.item.id === "string"
  ) {
    return params.item.id;
  }

  return undefined;
}

function getPlanNotificationTurnId(params: Record<string, unknown>): string | undefined {
  return typeof params.turnId === "string"
    ? params.turnId
    : typeof params.turnId === "string"
      ? params.turnId
      : undefined;
}

function isCompletedPlanItem(params: Record<string, unknown>): params is {
  item: { type: string; text?: unknown; markdown?: unknown };
} {
  return (
    typeof params.item === "object" &&
    params.item !== null &&
    "type" in params.item &&
    typeof params.item.type === "string" &&
    params.item.type.trim().toLowerCase() === "plan"
  );
}

function readCompletedPlanMarkdown(params: Record<string, unknown>): string | undefined {
  if (!isCompletedPlanItem(params)) {
    return undefined;
  }

  const markdown =
    typeof params.item.markdown === "string"
      ? params.item.markdown
      : typeof params.item.text === "string"
        ? params.item.text
        : "";
  const trimmed = markdown.trim();
  return trimmed || undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildMcpProtocolActivityEntry(
  details: AppServerThreadActivityDetail[],
  createdAt = Date.now(),
): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: "live-mcp-protocol-status",
    createdAt,
    summary: summarizeMcpProtocolActivity(details),
    status: summarizeActivityStatus(details),
    details,
  };
}

function summarizeMcpProtocolActivity(details: AppServerThreadActivityDetail[]): string {
  if (details.length === 1 && details[0]) {
    return details[0].label;
  }

  return `MCP status updates (${details.length})`;
}

function mergeMcpProtocolActivityEntry(
  current: AppServerThreadActivityEntry | undefined,
  next: AppServerThreadActivityEntry,
): AppServerThreadActivityEntry {
  if (current?.id !== "live-mcp-protocol-status") {
    return next;
  }

  return buildMcpProtocolActivityEntry(
    mergeActivityDetails(current.details, next.details),
    current.createdAt ?? next.createdAt
  );
}

function buildMcpServerStatusActivityEntry(params: Record<string, unknown>): AppServerThreadActivityEntry | undefined {
  const serverName = readString(params, "name") ?? readString(params, "serverName");
  const status = readString(params, "status") ?? "updated";
  if (!serverName) {
    return undefined;
  }

  const error = readString(params, "error");
  const detailStatus: AppServerThreadActivityDetail["status"] =
    status === "failed" || error
      ? "failed"
      : status === "cancelled"
        ? "cancelled"
        : status === "ready"
          ? "completed"
          : "in_progress";
  const label = error
    ? `MCP ${serverName} ${status}: ${error}`
    : `MCP ${serverName} ${status}`;

  return buildMcpProtocolActivityEntry([
    {
      id: `live-mcp-status-${serverName}`,
      kind: "command",
      label,
      status: detailStatus,
    },
  ]);
}

function buildMcpOauthActivityEntry(params: Record<string, unknown>): AppServerThreadActivityEntry | undefined {
  const serverName = readString(params, "name") ?? readString(params, "serverName");
  if (!serverName) {
    return undefined;
  }

  const success = params.success === true;
  const error = readString(params, "error");
  const label = success
    ? `MCP ${serverName} login completed`
    : `MCP ${serverName} login failed${error ? `: ${error}` : ""}`;
  const status: AppServerThreadActivityDetail["status"] = success ? "completed" : "failed";

  return buildMcpProtocolActivityEntry([
    {
      id: `live-mcp-oauth-${serverName}`,
      kind: "command",
      label,
      status,
    },
  ]);
}

function normalizeLivePlanSteps(value: unknown): AppServerThreadPlanStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): AppServerThreadPlanStep[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const stepRecord = entry as Record<string, unknown>;
    const step = typeof stepRecord.step === "string" ? stepRecord.step.trim() : "";
    if (!step) {
      return [];
    }

    const rawStatus =
      typeof stepRecord.status === "string" ? stepRecord.status.trim().toLowerCase() : "";
    const status: AppServerThreadPlanStep["status"] =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "inprogress"
          ? "in_progress"
          : "pending";

    return [{ step, status }];
  });
}

function buildWarningActivityEntry(params: {
  id: string;
  message: string;
}): AppServerThreadActivityEntry | undefined {
  const message = params.message.replace(/^warning:\s*/i, "").trim();
  if (!message) {
    return undefined;
  }

  return {
    type: "activity",
    id: params.id,
    createdAt: Date.now(),
    tone: "warning",
    summary: `Warning: ${message}`,
    details: [],
  };
}

function buildLiveTurnMetadata(params: {
  turnId?: string;
  activeTurnStartedAt?: number;
  completedAt?: number;
  durationMs?: number;
  status?: AppServerThreadTurnMetadata["status"];
}): AppServerThreadTurnMetadata | undefined {
  if (!params.turnId) {
    return undefined;
  }

  return {
    id: params.turnId,
    status: params.status ?? "in_progress",
    ...(params.activeTurnStartedAt ? { startedAt: params.activeTurnStartedAt } : {}),
    ...(params.completedAt ? { completedAt: params.completedAt } : {}),
    ...(typeof params.durationMs === "number" ? { durationMs: params.durationMs } : {}),
  };
}

function normalizeNotificationTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function normalizeNotificationDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildCompletedLiveTurnMetadata(params: {
  activeTurnStartedAt?: number;
  fallbackTurnId?: string;
  turn?: {
    id?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    durationMs?: unknown;
  };
}): AppServerThreadTurnMetadata | undefined {
  const turnId =
    typeof params.turn?.id === "string" && params.turn.id.trim()
      ? params.turn.id
      : params.fallbackTurnId;

  return buildLiveTurnMetadata({
    turnId,
    activeTurnStartedAt:
      normalizeNotificationTimestamp(params.turn?.startedAt) ?? params.activeTurnStartedAt,
    completedAt: normalizeNotificationTimestamp(params.turn?.completedAt) ?? Date.now(),
    durationMs: normalizeNotificationDuration(params.turn?.durationMs),
    status: "completed",
  });
}

function activityContainsDiff(
  candidate: AppServerThreadActivityEntry,
  pendingEntry: AppServerThreadActivityEntry
): boolean {
  return pendingEntry.details.every((pendingDetail) => {
    const pendingFileDiff = pendingDetail.fileDiff;
    if (!pendingFileDiff) {
      return false;
    }

    return candidate.details.some((detail) => {
      const candidateFileDiff = detail.fileDiff;
      if (!candidateFileDiff) {
        return false;
      }

      if (pendingFileDiff.diff) {
        return candidateFileDiff.diff === pendingFileDiff.diff;
      }

      if (!pendingFileDiff.diffRef) {
        return false;
      }

      const sameFile =
        pendingDetail.path && detail.path
          ? pendingDetail.path === detail.path
          : pendingDetail.label === detail.label;
      return (
        sameFile &&
        candidateFileDiff.kind === pendingFileDiff.kind &&
        candidateFileDiff.additions === pendingFileDiff.additions &&
        candidateFileDiff.removals === pendingFileDiff.removals
      );
    });
  });
}

function activityHasFileDiff(entry: AppServerThreadActivityEntry | undefined): boolean {
  return Boolean(entry?.details.some((detail) => detail.fileDiff));
}

export type ThreadViewProps = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  /**
   * Live integrated-terminal state, owned by App so it survives this
   * component's unmounts. See `useIntegratedTerminals`.
   */
  terminals: IntegratedTerminalsController;
  addOptimisticReviewEntry?: (displayText: string) => string;
  addOptimisticUserMessage: (
    text: string,
    imageParts?: AppServerThreadImagePart[]
  ) => string;
  backendError?: string;
  backends: BackendSummary[];
  applications?: DesktopApplicationsSnapshot;
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  composerDisabled: boolean;
  composerDraftStore?: ComposerDraftStore;
  composerImplementation?: DesktopChatReplyComposer;
  desktopApi?: DesktopApi;
  launchpadError?: string;
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
  archiveThreadError?: string;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  contextWindow?: ThreadContextWindowState;
  pricing?: {
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
  toolAccounting?: ThreadToolAccounting;
  pricingDisplayOptions?: {
    codexCredits: boolean;
    usd: boolean;
  };
  threadPricingSummaryEnabled?: boolean;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  runningTurnUsageText?: string;
  threadBusy?: boolean;
  pastedImageMaxPatches?: number;
  platform?: string;
  selectedDirectory?: NavigationDirectorySummary;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  pendingForkEnvironmentSetup?: PendingForkEnvironmentSetup;
  suppressBranchDriftDialog?: boolean;
  fullAccessRiskWarningDismissed?: boolean;
  /**
   * Project-directory picker (issue #223) — surfaced in the launchpad
   * composer when no thread is selected yet. Rendering happens inside
   * `Composer.tsx`; we just plumb the data and callbacks through.
   */
  directories?: NavigationDirectorySummary[];
  pickDirectoryError?: string;
  pickingDirectory?: boolean;
  onSelectDirectoryFromPicker?: (directory: NavigationDirectorySummary) => void;
  onSelectNoDirectoryFromPicker?: () => void;
  onPickAndRegisterDirectory?: () => void;
  onPickAndAttachDirectoryToThread?: () => void;
  onClearPickDirectoryError?: () => void;
  setExecutionModeError?: string;
  setThreadModelSettingsError?: string;
  worktreeArchiveError?: string;
  skillError?: string;
  skillLoading?: boolean;
  providerCommands?: AppServerAvailableCommandSummary[];
  skills: AppServerSkillSummary[];
  transcriptEntries: AppServerThreadEntry[];
  transcriptError?: string;
  transcriptPagination?: AppServerThreadReplayPagination;
  updatingExecutionMode?: ThreadExecutionMode;
  onActiveTurnIdChange?: (turnId?: string) => void;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  onDismissFullAccessRiskWarning?: () => Promise<void>;
  /** Forwarded to ThreadHeader -> MessagingStatusBar - opens Messaging Activity. */
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  onRevealSelectedThreadInList?: () => void;
  /**
   * Window-level layout state (owned by App). The context rail pin +
   * active tab and the left-sidebar hide toggle are window preferences,
   * not per-thread, so they live above ThreadView and flow back through
   * these callbacks (persisted to config there). Optional with safe
   * defaults so the many existing render-only tests don't have to thread
   * window chrome; App always supplies them.
   */
  contextRailPinned?: boolean;
  onContextRailPinnedChange?: (pinned: boolean) => void;
  activeContextTab?: ContextTabId;
  onActiveContextTabChange?: (tab: ContextTabId) => void;
  /**
   * Where the accumulated edited-files list renders: above the
   * composer (default) or only in the context-rail Edits panel. A
   * window preference like the context-rail tab — owned and persisted
   * by App.
   */
  editedFilesDock?: EditedFilesDock;
  onEditedFilesDockChange?: (dock: EditedFilesDock) => void;
  actionRunsDock?: ActionRunsDock;
  onActionRunsDockChange?: (dock: ActionRunsDock) => void;
  sidebarHidden?: boolean;
  onToggleSidebar?: () => void;
  /**
   * The sidebar masthead's wordmark + action buttons, relocated into the
   * thread header when the sidebar is hidden (macOS/Linux).
   */
  mastheadActions?: MastheadActionsProps;
  /**
   * Browser-style Back/Forward across threads + search, rendered at the
   * leading edge of the thread header (and the empty-state placeholder).
   * Owned by App's useNavigationHistory.
   */
  historyNav?: HistoryNavControls;
  /** In-thread find bar (⌘F): open state + close callback, owned by App. */
  findOpen?: boolean;
  onFindOpenChange?: (open: boolean) => void;
  /** Seed query for the find bar when deep-linking from a search result. */
  findInitialQuery?: string;
  /** Turn id to load+scroll to when deep-linking a search match. */
  findTurnId?: string;
  /** Bumped on each ⌘F so an already-open bar pulls focus back to its field. */
  findFocusNonce?: number;
  onLoadOlder: () => Promise<void>;
  onArchiveThread?: (thread: NavigationThreadSummary) => Promise<void>;
  onRefreshNavigation?: () => Promise<void>;
  onLiveTranscriptEntry?: (entry: AppServerThreadEntry) => void;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest,
    reviewTarget?: AppServerReviewTarget
  ) => Promise<void>;
  onCancelLaunchpad?: (directoryKey: string) => void;
  onPendingStatusChange?: (status?: string) => void;
  onUpdatePendingUserInput?: (
    requestId: string,
    updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState
  ) => void;
  onUpdatePendingMcpInteraction?: (
    requestId: string,
    updater: (state: PendingMcpInteractionState) => PendingMcpInteractionState
  ) => void;
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
  onSetThreadModelSettings?: (
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  onArchiveWorktree?: (
    thread: NavigationThreadSummary,
    directory: NavigationThreadSummary["linkedDirectories"][number]
  ) => Promise<void>;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  onTranscriptViewportChange?: (viewport?: {
    distanceFromBottom: number;
    isGluedToBottom?: boolean;
    scrollTop: number;
  }) => void;
  onUpdateLaunchpad?: (
    directoryKey: string,
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "prompt"
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "workMode"
        | "branchName"
        | "directoryLabel"
        | "directoryPath"
        | "imageAttachments"
      >
    >,
    options?: { stickySettingsChanged?: boolean }
  ) => Promise<void>;
  removeOptimisticMessage: (id: string) => void;
  transcriptViewport?: {
    distanceFromBottom: number;
    isGluedToBottom?: boolean;
    scrollTop: number;
  };
};

type BranchDriftDialogState = {
  checkedAt?: number;
  expectedBranch: string;
  observedBranch: string;
  reason: "focus" | "turn";
  threadKey: string;
};

export function ThreadView(props: ThreadViewProps) {
  const [pendingActivityEntry, setPendingActivityEntry] =
    useState<AppServerThreadActivityEntry>();
  const [pendingProtocolActivityEntry, setPendingProtocolActivityEntry] =
    useState<AppServerThreadActivityEntry>();
  const [pendingUsageActivityEntry, setPendingUsageActivityEntry] =
    useState<AppServerThreadActivityEntry>();
  const [pendingPlanEntry, setPendingPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  // Snapshot of the rail-owned live plan entry at turn/completed time.
  // The LiveWorkRail uses it to keep showing the last turn's plan even
  // after the live state has cleared, until the next turn starts.
  // Edited files no longer need a snapshot — turn/completed defers the
  // cumulative diff entry into the transcript, where
  // `collectEditedFileGroups` accumulates it (and survives reloads via
  // the persisted replay). `pendingProtocolActivityEntry` (MCP status /
  // warnings) is not snapshotted because it doesn't belong in the
  // rail; the dupe-fix that clears it on turn/completed still applies.
  const [lastCompletedPlanEntry, setLastCompletedPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  // Refs mirror the pending state so the turn/completed handler can read
  // the latest values to snapshot, then clear via setState without
  // racing or queuing extra micro-renders.
  const pendingActivityEntryRef = useRef<AppServerThreadActivityEntry | undefined>(
    undefined,
  );
  const pendingProtocolActivityEntryRef = useRef<
    AppServerThreadActivityEntry | undefined
  >(undefined);
  const pendingUsageActivityEntryRef = useRef<AppServerThreadActivityEntry | undefined>(
    undefined,
  );
  const pendingPlanEntryRef = useRef<AppServerThreadPlanEntry | undefined>(undefined);
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();
  const [contextRailResizing, setContextRailResizing] = useState(false);
  const [transcriptReglueRequestKey, setTranscriptReglueRequestKey] = useState(0);
  const [contextRailWidth, setContextRailWidth] = useState(380);
  const [launchpadMaterializing, setLaunchpadMaterializing] = useState(false);
  // Terminal state is owned by `useIntegratedTerminals` up in App, mirroring
  // the main process's registry. It cannot live here: ThreadView unmounts on
  // search and on any refresh that flips `threadDetailPending`, which used to
  // orphan every running PTY.
  const terminals = props.terminals;
  const [launchpadMaterializeError, setLaunchpadMaterializeError] =
    useState<string>();
  const [setupFailureDismissedThreadKeys, setSetupFailureDismissedThreadKeys] =
    useState<Set<string>>(() => new Set());
  const [setupFailureArchiving, setSetupFailureArchiving] = useState(false);
  const [setupFailureContinuing, setSetupFailureContinuing] = useState(false);
  const [setupFailureContinueError, setSetupFailureContinueError] =
    useState<string>();
  const [launchpadSetupProgress, setLaunchpadSetupProgress] =
    useState<LaunchpadEnvironmentSetupProgress>();
  const [dismissedEnvActionRunIds, setDismissedEnvActionRunIds] = useState<
    Set<string>
  >(() => new Set());
  // The context-rail pin is a window-level preference owned by App and
  // toggled from the header chips (no more wide-display force-pin — the
  // user controls it explicitly).
  // Defaults to pinned-open (matches the persisted default) when App hasn't
  // threaded a value through yet, so the rail is discoverable.
  const contextRailPinned = props.contextRailPinned ?? true;
  const threadPricingSummaryEnabled = props.threadPricingSummaryEnabled ?? true;
  const activeContextTab =
    !threadPricingSummaryEnabled && props.activeContextTab === "pricing"
      ? DEFAULT_CONTEXT_TAB
      : props.activeContextTab ?? DEFAULT_CONTEXT_TAB;
  const editedFilesDock = props.editedFilesDock ?? DEFAULT_EDITED_FILES_DOCK;
  const actionRunsDock = props.actionRunsDock ?? DEFAULT_ACTION_RUNS_DOCK;
  const sidebarHidden = props.sidebarHidden ?? false;
  const onContextRailPinnedChange = props.onContextRailPinnedChange ?? noop;
  const onActiveContextTabChange = props.onActiveContextTabChange ?? noop;
  const onEditedFilesDockChange = props.onEditedFilesDockChange ?? noop;
  const onActionRunsDockChange = props.onActionRunsDockChange ?? noop;
  const onToggleSidebar = props.onToggleSidebar ?? noop;
  // Transcript element the in-thread find bar (⌘F) searches + highlights.
  const transcriptPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setPendingActivityEntry(undefined);
    setPendingProtocolActivityEntry(undefined);
    setPendingUsageActivityEntry(undefined);
    setPendingPlanEntry(undefined);
    setLastCompletedPlanEntry(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setSetupFailureArchiving(false);
    setContextRailResizing(false);
    setExpandedImage(undefined);
    setLaunchpadMaterializing(false);
    setLaunchpadMaterializeError(undefined);
    setLaunchpadSetupProgress(undefined);
    setSetupFailureContinuing(false);
    setSetupFailureContinueError(undefined);
  }, [
    props.selectedLaunchpad?.directoryKey,
    props.pendingForkEnvironmentSetup?.directoryKey,
    props.selectedThread?.id,
    props.selectedThread?.source,
  ]);

  useEffect(() => {
    pendingActivityEntryRef.current = pendingActivityEntry;
    pendingProtocolActivityEntryRef.current = pendingProtocolActivityEntry;
    pendingUsageActivityEntryRef.current = pendingUsageActivityEntry;
    pendingPlanEntryRef.current = pendingPlanEntry;
  }, [
    pendingActivityEntry,
    pendingProtocolActivityEntry,
    pendingUsageActivityEntry,
    pendingPlanEntry,
  ]);

  // When a new turn begins, clear the pinned snapshots from the prior
  // turn so the LiveWorkRail reflects the in-flight turn's work, not
  // stale history. Triggered by activeTurnId transitioning to a new
  // non-empty value (turn/started fired upstream).
  const lastSeenActiveTurnIdRef = useRef<string | undefined>(props.activeTurnId);
  useEffect(() => {
    const previous = lastSeenActiveTurnIdRef.current;
    lastSeenActiveTurnIdRef.current = props.activeTurnId;
    if (props.activeTurnId && props.activeTurnId !== previous) {
      setLastCompletedPlanEntry(undefined);
    }
  }, [props.activeTurnId]);

  const selectedThread = props.selectedThread;
  const envActionRuns = readCodexEnvironmentActionRuns(
    selectedThread?.codexEnvironmentRuntime,
  );
  const visibleEnvActionRuns = envActionRuns.filter(
    (run) => !dismissedEnvActionRunIds.has(run.runId),
  );
  const selectedThreadBackend = useMemo(
    () =>
      selectedThread
        ? props.backends.find((backend) => backend.kind === selectedThread.source)
        : undefined,
    [props.backends, selectedThread],
  );
  const selectedLaunchpad = props.selectedLaunchpad;
  const pendingForkEnvironmentSetup = props.pendingForkEnvironmentSetup;

  useEffect(() => {
    const directoryKey =
      selectedLaunchpad?.directoryKey ?? pendingForkEnvironmentSetup?.directoryKey;
    if (!directoryKey || !props.desktopApi?.onCodexEnvironmentSetupProgress) {
      return;
    }

    return props.desktopApi.onCodexEnvironmentSetupProgress((event) => {
      if (event.directoryKey !== directoryKey) {
        return;
      }

      setLaunchpadSetupProgress((current) =>
        applyLaunchpadEnvironmentSetupProgress(current, event),
      );
    });
  }, [
    props.desktopApi,
    pendingForkEnvironmentSetup?.directoryKey,
    selectedLaunchpad?.directoryKey,
  ]);

  const [branchDriftDialog, setBranchDriftDialog] =
    useState<BranchDriftDialogState>();
  const [branchDriftError, setBranchDriftError] = useState<string>();
  const [branchDriftBusy, setBranchDriftBusy] = useState(false);

  // Canonical thread identity — the same key the sidebar rows and the quit
  // blockers use. A hand-rolled `${source}:${id}` is ambiguous for ACP
  // backends, whose kind ("acp:grok") already contains a colon.
  const selectedThreadKey = selectedThread
    ? buildThreadIdentityKey(selectedThread.source, selectedThread.id)
    : undefined;
  const fileViewerContext = useMemo<MarkdownFileViewerContext | undefined>(() => {
    if (!selectedThread || !selectedThreadKey) {
      return undefined;
    }

    const projectPath =
      selectedThread.projectKey ??
      selectedThread.linkedDirectories[0]?.worktreePath ??
      selectedThread.linkedDirectories[0]?.path;

    return {
      key: selectedThreadKey,
      title: `Files - ${selectedThread.title}`,
      threadTitle: selectedThread.title,
      ...(projectPath ? { projectPath } : {}),
    };
  }, [selectedThread, selectedThreadKey]);
  const selectedThreadTerminalOpen = selectedThreadKey
    ? terminals.isPanelOpen(selectedThreadKey)
    : false;
  const selectedThreadTerminalRunning = selectedThreadKey
    ? terminals.liveThreadKeys.has(selectedThreadKey)
    : false;
  const selectedThreadTerminalCwd = selectedThread
    ? resolveThreadTerminalCwd(selectedThread)
    : undefined;
  const toggleSelectedThreadTerminal = useCallback(() => {
    if (!selectedThreadKey) return;
    terminals.togglePanel(selectedThreadKey, selectedThreadTerminalCwd);
  }, [selectedThreadKey, selectedThreadTerminalCwd, terminals]);
  const suppressBranchDriftDialogRef = useRef(
    props.suppressBranchDriftDialog ?? false
  );

  useEffect(() => {
    suppressBranchDriftDialogRef.current = props.suppressBranchDriftDialog ?? false;
    if (props.suppressBranchDriftDialog) {
      setBranchDriftDialog(undefined);
      setBranchDriftError(undefined);
    }
  }, [props.suppressBranchDriftDialog]);
  const selectedThreadSetupFailed =
    selectedThread?.codexEnvironmentRuntime?.setupStatus === "failed";
  // The setup-failure dialog only surfaces during launchpad materialise
  // (messageCount === 0), where at most one auto-action runs. Look for
  // the most recent failed run in actionRuns to drive the action-phase
  // branch of the dialog.
  const selectedThreadActionRuns = readCodexEnvironmentActionRuns(
    selectedThread?.codexEnvironmentRuntime,
  );
  const selectedThreadLatestFailedActionRun = [...selectedThreadActionRuns]
    .reverse()
    .find((run) => run.status === "failed");
  const selectedThreadActionFailed = Boolean(selectedThreadLatestFailedActionRun);
  const selectedThreadWorktree = selectedThread?.linkedDirectories.find(
    (directory) =>
      directory.kind === "worktree" || Boolean(directory.worktreePath?.trim()),
  );
  const selectedThreadOptimisticLaunchpadInput =
    buildInputFromOptimisticUserMessage(selectedThread?.optimisticUserMessage);
  const hasOnlyOptimisticLaunchpadMessage =
    props.messageCount === 1 && selectedThreadOptimisticLaunchpadInput.length > 0;
  const showSetupFailureChoice = Boolean(
    selectedThread &&
      selectedThreadKey &&
      (props.messageCount === 0 || hasOnlyOptimisticLaunchpadMessage) &&
      !props.activeTurnId &&
      (selectedThreadSetupFailed || selectedThreadActionFailed) &&
      !setupFailureDismissedThreadKeys.has(selectedThreadKey),
  );
  const selectedThreadEnvironmentFailurePhase = selectedThreadActionFailed
    ? "action"
    : "setup";
  const continueAfterSetupFailure = async (): Promise<void> => {
    if (!selectedThread || !selectedThreadKey) {
      return;
    }

    const input = buildInputFromOptimisticUserMessage(
      selectedThread.optimisticUserMessage,
    );
    if (input.length === 0 || !props.desktopApi?.startTurn) {
      setSetupFailureDismissedThreadKeys((current) => {
        const next = new Set(current);
        next.add(selectedThreadKey);
        return next;
      });
      return;
    }

    setSetupFailureContinueError(undefined);
    setSetupFailureContinuing(true);
    props.onPendingStatusChange?.("Thinking");
    try {
      const response = await props.desktopApi.startTurn({
        backend: selectedThread.source,
        threadId: selectedThread.id,
        input,
        executionMode: selectedThread.executionMode,
        model: selectedThread.model,
        reasoningEffort: selectedThread.reasoningEffort,
        serviceTier: selectedThread.serviceTier,
        fastMode: selectedThread.source === "codex"
          ? selectedThread.fastMode
          : undefined,
      });
      props.onActiveTurnIdChange?.(response.turnId);
      setSetupFailureDismissedThreadKeys((current) => {
        const next = new Set(current);
        next.add(selectedThreadKey);
        return next;
      });
      await props.onRefreshNavigation?.();
    } catch (error) {
      props.onPendingStatusChange?.(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setSetupFailureContinueError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setSetupFailureContinuing(false);
    }
  };

  useEffect(() => {
    if (!branchDriftDialog) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !branchDriftBusy) {
        setBranchDriftDialog(undefined);
      }
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [branchDriftBusy, branchDriftDialog]);

  const branchDriftRetained = (
    thread: NavigationThreadSummary,
    expectedBranch: string,
    observedBranch: string,
  ): boolean => {
    // R14: ignore retained pairs where expected is HEAD even if persisted
    // by an older client — a transition out of detached HEAD is always a
    // meaningful event the user should re-evaluate.
    if (expectedBranch === "HEAD") return false;
    return (thread.retainedBranchDriftPairs ?? []).some(
      (pair) =>
        pair.expectedBranch === expectedBranch &&
        pair.observedBranch === observedBranch,
    );
  };

  const canWarnForBranchDrift = (expectedBranch?: string, observedBranch?: string): boolean =>
    isBranchDrifted(expectedBranch, observedBranch);

  const showBranchDriftDialog = (
    thread: NavigationThreadSummary,
    expectedBranch: string,
    observedBranch: string,
    reason: BranchDriftDialogState["reason"],
    checkedAt?: number,
  ): boolean => {
    if (!canWarnForBranchDrift(expectedBranch, observedBranch)) {
      return false;
    }

    if (branchDriftRetained(thread, expectedBranch, observedBranch)) {
      return false;
    }

    setBranchDriftError(undefined);
    setBranchDriftDialog({
      checkedAt,
      expectedBranch,
      observedBranch,
      reason,
      threadKey: `${thread.source}:${thread.id}`,
    });
    return true;
  };

  // Single dialog-open gate. Suppresses while a turn is active on the
  // focused thread; the end-of-turn falling-edge useEffect re-runs the
  // drift check once activeTurnId clears, so deferral is implicit.
  const tryOpenBranchDriftDialog = (
    thread: NavigationThreadSummary,
    expectedBranch: string,
    observedBranch: string,
    reason: BranchDriftDialogState["reason"],
    checkedAt?: number,
  ): boolean => {
    if (props.activeTurnId !== undefined) {
      return false;
    }
    if (suppressBranchDriftDialogRef.current) {
      return false;
    }
    return showBranchDriftDialog(thread, expectedBranch, observedBranch, reason, checkedAt);
  };

  const checkSelectedThreadBranchDrift = async (
    reason: BranchDriftDialogState["reason"],
  ): Promise<boolean> => {
    const thread = selectedThread;
    if (!thread?.gitBranch || !props.desktopApi?.checkThreadBranchDrift) {
      return false;
    }
    const startedThreadKey = `${thread.source}:${thread.id}`;

    try {
      const result = await props.desktopApi.checkThreadBranchDrift({
        backend: thread.source,
        expectedBranch: thread.gitBranch,
        threadId: thread.id,
      });
      // Stale-closure guard: user navigated away mid-IPC.
      if (selectedThreadKeyRef.current !== startedThreadKey) {
        return false;
      }
      if (result.observedBranch !== thread.observedGitBranch) {
        await props.onRefreshNavigation?.();
        if (selectedThreadKeyRef.current !== startedThreadKey) {
          return false;
        }
      }
      if (
        !result.drifted ||
        !result.expectedBranch ||
        !result.observedBranch ||
        !canWarnForBranchDrift(result.expectedBranch, result.observedBranch)
      ) {
        setBranchDriftDialog((current) =>
          current?.threadKey === startedThreadKey ? undefined : current,
        );
        return false;
      }

      return tryOpenBranchDriftDialog(
        thread,
        result.expectedBranch,
        result.observedBranch,
        reason,
        result.checkedAt,
      );
    } catch {
      return false;
    }
  };

  useEffect(() => {
    setBranchDriftDialog(undefined);
    setBranchDriftError(undefined);
  }, [selectedThreadKey]);

  // Live mirror of selectedThreadKey for async stale-closure guards.
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  useEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
  }, [selectedThreadKey]);

  useEffect(() => {
    const thread = selectedThread;
    const expectedBranch = thread?.gitBranch;
    const observedBranch = thread?.observedGitBranch;
    if (
      !thread ||
      !expectedBranch ||
      !observedBranch ||
      !canWarnForBranchDrift(expectedBranch, observedBranch)
    ) {
      if (thread) {
        setBranchDriftDialog((current) =>
          current?.threadKey === `${thread.source}:${thread.id}` ? undefined : current,
        );
      }
      return;
    }

    tryOpenBranchDriftDialog(thread, expectedBranch, observedBranch, "focus");
  }, [selectedThread, props.activeTurnId, props.suppressBranchDriftDialog]);

  // End-of-turn falling-edge: re-run drift check when an active turn
  // settles on the focused thread. Combined ref guards against
  // same-render thread switches firing a spurious recheck.
  const previousTurnRef = useRef<{
    threadKey: string | undefined;
    activeTurnId: string | undefined;
  }>({ threadKey: selectedThreadKey, activeTurnId: props.activeTurnId });
  useEffect(() => {
    const previous = previousTurnRef.current;
    const current = {
      threadKey: selectedThreadKey,
      activeTurnId: props.activeTurnId,
    };
    previousTurnRef.current = current;

    if (
      previous.threadKey === current.threadKey &&
      previous.threadKey !== undefined &&
      previous.activeTurnId !== undefined &&
      current.activeTurnId === undefined
    ) {
      void checkSelectedThreadBranchDrift("focus");
    }
  }, [props.activeTurnId, selectedThreadKey]);

  useEffect(() => {
    if (!selectedThread || selectedLaunchpad) {
      return;
    }

    void checkSelectedThreadBranchDrift("focus");
    const unsubscribeFocus = props.desktopApi?.onWindowFocus?.(() => {
      void checkSelectedThreadBranchDrift("focus");
    });

    return () => {
      unsubscribeFocus?.();
    };
  }, [props.desktopApi, selectedLaunchpad, selectedThreadKey]);

  const deferLiveTranscriptEntry = useCallback(<T extends AppServerThreadEntry,>(entry: T): T => {
    queueMicrotask(() => {
      props.onLiveTranscriptEntry?.(entry);
    });
    return entry;
  }, [props.onLiveTranscriptEntry]);

  const liveNotificationTurnId = useCallback(
    (notificationTurnId?: string): string | undefined =>
      props.activeTurnId ?? notificationTurnId,
    [props.activeTurnId]
  );

  // The latest `item/fileChange/outputDelta` activity entry (after #493
  // these live in optimisticEntries → props.transcriptEntries, not in
  // a separate pending state slot). We find the most recently created
  // one tagged by id prefix so the LiveWorkRail can display it as the
  // current Changed Files section. Re-uses the persisted entry as-is
  // for the pinned-after-turn case — file-change entries already stay
  // in optimisticEntries after the turn ends.
  const liveWorkRailChangedFilesEntry = useMemo(() => {
    let latest: AppServerThreadActivityEntry | undefined;
    for (const entry of props.transcriptEntries) {
      if (
        entry.type !== "activity" ||
        !entry.id.startsWith("live-file-change-")
      ) {
        continue;
      }
      if (!latest) {
        latest = entry;
        continue;
      }
      // Pick by createdAt, tiebreak by rendererSequence — same order
      // mergeTranscriptEntries uses so the rail's pick stays
      // consistent with where the entry sits in the transcript when
      // wall-clock timestamps collide under fast-CI batching (the
      // PR #493 scenario).
      const entryCreatedAt =
        typeof entry.createdAt === "number" ? entry.createdAt : undefined;
      const latestCreatedAt =
        typeof latest.createdAt === "number" ? latest.createdAt : undefined;
      if (
        typeof entryCreatedAt === "number" &&
        typeof latestCreatedAt === "number"
      ) {
        if (entryCreatedAt > latestCreatedAt) {
          latest = entry;
          continue;
        }
        if (entryCreatedAt < latestCreatedAt) {
          continue;
        }
      } else if (typeof entryCreatedAt === "number") {
        latest = entry;
        continue;
      } else if (typeof latestCreatedAt === "number") {
        continue;
      }
      const entrySequence = readRendererSequence(entry);
      const latestSequence = readRendererSequence(latest);
      if (
        typeof entrySequence === "number" &&
        typeof latestSequence === "number" &&
        entrySequence > latestSequence
      ) {
        latest = entry;
      }
    }
    return latest;
  }, [props.transcriptEntries]);

  const pendingTranscriptActivityEntry =
    pendingActivityEntry && !activityHasFileDiff(pendingActivityEntry)
      ? pendingActivityEntry
      : undefined;
  const pendingRailActivityEntry =
    pendingActivityEntry && activityHasFileDiff(pendingActivityEntry)
      ? pendingActivityEntry
      : undefined;

  // Accumulated edited files: persisted replay entries + deferred live
  // entries grouped per turn, cleared past a committed turn once the
  // next turn starts. Rehydrates on thread load because the replay
  // already carries per-file diffs and command exit codes.
  const editedFileGroups = useMemo(
    () =>
      collectEditedFileGroups({
        entries: props.transcriptEntries,
        activeTurnId: props.activeTurnId,
        forkCreatedAt: selectedThread?.forkSourceThreadId
          ? selectedThread.createdAt
          : undefined,
        livePendingEntry: pendingRailActivityEntry,
      }),
    [
      props.transcriptEntries,
      props.activeTurnId,
      selectedThread?.createdAt,
      selectedThread?.forkSourceThreadId,
      pendingRailActivityEntry,
    ],
  );

  // Git commit lifecycle per group, resolved against the live worktree.
  // Re-resolves when the thread's working state shifts (a commit/push), so the
  // per-group badges stay accurate without re-reading the transcript.
  // Only resolve commit state when an edits surface is actually on screen —
  // the above-composer rail (dock "above") or the context-rail Edits tab.
  // Otherwise the badges aren't rendered and the git probes are pure waste.
  const editsSurfaceVisible =
    editedFilesDock === "above" || activeContextTab === "edits";
  const editedFileCommitStates = useEditCommitStates({
    desktopApi: props.desktopApi,
    worktreePath: selectedThread?.projectKey,
    groups: editsSurfaceVisible ? editedFileGroups : [],
    refreshKey: JSON.stringify(selectedThread?.gitWorkingState ?? null),
  });

  // Open an edited file: the configured/first-available editor (same
  // resolution as transcript file links), falling back to the OS default
  // handler when no editor is available. Shared by both edited-file surfaces.
  const editedFilesWorktreeRoot = selectedThread?.projectKey;
  const applications = props.applications;
  const desktopApi = props.desktopApi;
  const preferredEditor = useMemo(
    () => resolvePreferredEditor(applications),
    [applications],
  );
  const handleOpenEditedFile = useCallback(
    (absolutePath: string) => {
      const editor = resolvePreferredEditor(applications);
      if (editor && desktopApi?.openApplication) {
        void desktopApi
          .openApplication({
            applicationId: editor.id,
            kind: "editor",
            targetPath: absolutePath,
          })
          .catch((error: unknown) => {
            console.error("Failed to open edited file in editor", error);
          });
        return;
      }
      void desktopApi
        ?.openPath?.({ path: absolutePath })
        .then((response) => {
          if (response && !response.opened) {
            console.error("Failed to open edited file", response.error);
          }
        })
        .catch((error: unknown) => {
          console.error("Failed to open edited file", error);
        });
    },
    [applications, desktopApi],
  );

  // Scroll the transcript to a turn's position — backs the clickable
  // edited-file group timestamps. Transcript items are anchored with
  // `data-turn-id`; but a turn's id isn't always on a rendered item (work-phase
  // grouping renders only the group's first entry, members are folded in), so
  // fall back to the rendered turn whose time is closest to the group's
  // timestamp. No-op if neither resolves.
  const handleScrollToTurn = useCallback(
    (turnId: string, turnTimeMs?: number) => {
      const container = transcriptPanelRef.current;
      if (!container) {
        return;
      }
      // Land on the turn's LAST anchored entry, not its first: the clicked
      // timestamp is the turn-END time, and the edited-file activity sits near
      // the turn's tail. Scrolling to the first entry drops the user at the
      // turn's start (an earlier time than the label, which reads as wrong).
      let target: Element | null = null;
      if (turnId) {
        const matches = container.querySelectorAll(
          `[data-turn-id="${CSS.escape(turnId)}"]`,
        );
        target = matches.length > 0 ? matches[matches.length - 1] : null;
      }
      if (!target && typeof turnTimeMs === "number") {
        let bestDelta = Infinity;
        for (const candidate of container.querySelectorAll("[data-turn-time]")) {
          const time = Number((candidate as HTMLElement).dataset.turnTime);
          if (!Number.isFinite(time)) {
            continue;
          }
          const delta = Math.abs(time - turnTimeMs);
          // `<=` so the LAST entry of the nearest turn wins (its tail), to
          // match the turn-end semantics of the primary path.
          if (delta <= bestDelta) {
            bestDelta = delta;
            target = candidate;
          }
        }
      }
      if (!target) {
        return;
      }
      // The `.transcript-list__item` wrapper is `display: contents` (no box),
      // so scrolling IT is a no-op and its rect is empty. Scroll a real child
      // element into view instead — the same approach the find bar uses.
      const anchor = target.querySelector("*") ?? target;
      anchor.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [],
  );

  const moveEditedFilesToSidebar = useCallback(() => {
    onEditedFilesDockChange("sidebar");
    onActiveContextTabChange("edits");
    // Reveal the destination: an unpinned rail would leave the moved
    // list invisible, which reads as "my edits vanished".
    if (!contextRailPinned) {
      onContextRailPinnedChange(true);
    }
  }, [
    contextRailPinned,
    onActiveContextTabChange,
    onContextRailPinnedChange,
    onEditedFilesDockChange,
  ]);

  const moveActionRunsToSidebar = useCallback(() => {
    onActionRunsDockChange("sidebar");
    onActiveContextTabChange("actions");
    if (!contextRailPinned) {
      onContextRailPinnedChange(true);
    }
  }, [
    contextRailPinned,
    onActionRunsDockChange,
    onActiveContextTabChange,
    onContextRailPinnedChange,
  ]);

  const showActionRunsAboveComposer = useCallback(() => {
    onActionRunsDockChange("above");
  }, [onActionRunsDockChange]);

  const stopEnvActionRun = useCallback(
    (run: CodexEnvironmentActionRun, mode: "stop" | "terminate") => {
      if (!selectedThread || !props.desktopApi?.stopCodexEnvironmentAction) {
        return;
      }
      void props.desktopApi
        .stopCodexEnvironmentAction({
          backend: selectedThread.source,
          threadId: selectedThread.id,
          runId: run.runId,
          mode,
        })
        .catch((error: unknown) => {
          console.error("Failed to stop environment action run", error);
        });
    },
    [props.desktopApi, selectedThread],
  );

  const dismissEnvActionRun = useCallback((run: CodexEnvironmentActionRun) => {
    setDismissedEnvActionRunIds((current) => {
      if (current.has(run.runId)) {
        return current;
      }
      const next = new Set(current);
      next.add(run.runId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!pendingActivityEntry) {
      return;
    }

    const persistedActivity = props.transcriptEntries.find(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" && activityContainsDiff(entry, pendingActivityEntry)
    );
    if (persistedActivity) {
      setPendingActivityEntry(undefined);
    }
  }, [pendingActivityEntry, props.transcriptEntries]);

  useEffect(() => {
    if (!pendingPlanEntry) {
      return;
    }

    const persistedPlan = props.transcriptEntries.find(
      (entry): entry is AppServerThreadPlanEntry =>
        entry.type === "plan" && arePlanEntriesEquivalent(entry, pendingPlanEntry)
    );
    if (persistedPlan) {
      setPendingPlanEntry(undefined);
    }
  }, [pendingPlanEntry, props.transcriptEntries]);

  useEffect(() => {
    if (!props.desktopApi?.onAgentEvent || !selectedThread) {
      return;
    }

    return props.desktopApi.onAgentEvent((event) => {
      const notificationThreadId =
        "threadId" in event.notification.params &&
        typeof event.notification.params.threadId === "string"
          ? event.notification.params.threadId
          : undefined;

      // Threadless MCP status is ambient session state. Until the protocol gives
      // it a thread owner, show it where the user is looking without treating it
      // as persisted thread history.
      const isGlobalMcpStatus =
        notificationThreadId == null &&
        (event.notification.method === "mcpServer/startupStatus/updated" ||
          event.notification.method === "mcpServer/oauthLogin/completed");

      if (
        event.backend !== selectedThread.source ||
        (notificationThreadId !== selectedThread.id && !isGlobalMcpStatus)
      ) {
        return;
      }

      if (event.notification.method === "mcpServer/startupStatus/updated") {
        const entry = buildMcpServerStatusActivityEntry(
          event.notification.params as Record<string, unknown>
        );
        if (entry) {
          setPendingProtocolActivityEntry((current) =>
            mergeMcpProtocolActivityEntry(current, entry)
          );
        }
        return;
      }

      if (event.notification.method === "mcpServer/oauthLogin/completed") {
        const entry = buildMcpOauthActivityEntry(
          event.notification.params as Record<string, unknown>
        );
        if (entry) {
          setPendingProtocolActivityEntry((current) =>
            mergeMcpProtocolActivityEntry(current, entry)
          );
        }
        return;
      }

      if (
        event.notification.method === "turn/failed" ||
        event.notification.method === "turn/cancelled"
      ) {
        // A failed/cancelled turn still made real file edits before it
        // stopped (turn/diff/updated only carries actual changes). Defer
        // the pending diff entry into the transcript — same path as
        // turn/completed — so the accumulated Edited Files groups retain
        // that turn's work instead of dropping it until a replay refresh
        // happens to re-fetch it. Protocol/usage entries are status/cost,
        // not edits, so they're still cleared.
        const interruptedActivity = pendingActivityEntryRef.current;
        if (interruptedActivity && activityHasFileDiff(interruptedActivity)) {
          deferLiveTranscriptEntry(interruptedActivity);
        }
        setPendingActivityEntry(undefined);
        setPendingProtocolActivityEntry(undefined);
        setPendingUsageActivityEntry(undefined);
        return;
      }

      if (event.notification.method === "turn/completed") {
        const completedTurnRecord =
          typeof event.notification.params.turn === "object" &&
          event.notification.params.turn !== null
            ? event.notification.params.turn
            : undefined;
        const turn = buildCompletedLiveTurnMetadata({
          activeTurnStartedAt: props.activeTurnStartedAt,
          fallbackTurnId:
            props.activeTurnId ??
            (typeof event.notification.params.turnId === "string"
              ? event.notification.params.turnId
              : undefined),
          turn: completedTurnRecord,
        });
        const liveTurn =
          turn && props.activeTurnId && turn.id !== props.activeTurnId
            ? { ...turn, id: props.activeTurnId }
            : turn;
        if (liveTurn) {
          const completeEntryTurn = <T extends { turn?: AppServerThreadTurnMetadata }>(
            entry: T | undefined
          ): T | undefined => (entry ? { ...entry, turn: liveTurn } : undefined);
          // Defer each live entry into the persistent transcript via
          // optimisticEntries, snapshot the rail-owned ones (Edited
          // Files, Plan) for the LiveWorkRail's "pinned to last turn"
          // display, then clear every pending slot so the transcript
          // doesn't render the same entry twice (the dupe-row bug
          // from issue #495). pendingProtocolActivityEntry holds MCP
          // status / warnings, which the rail doesn't own — we still
          // clear it to fix the duplicate, but don't snapshot.
          const completedActivity = completeEntryTurn(pendingActivityEntryRef.current);
          if (completedActivity) {
            deferLiveTranscriptEntry(completedActivity);
          }
          setPendingActivityEntry(undefined);

          const completedProtocolActivity = completeEntryTurn(
            pendingProtocolActivityEntryRef.current,
          );
          if (completedProtocolActivity) {
            deferLiveTranscriptEntry(completedProtocolActivity);
          }
          setPendingProtocolActivityEntry(undefined);

          const completedUsageActivity = completeEntryTurn(
            pendingUsageActivityEntryRef.current,
          );
          if (completedUsageActivity) {
            deferLiveTranscriptEntry(completedUsageActivity);
          }
          setPendingUsageActivityEntry(undefined);

          const completedPlan = completeEntryTurn(pendingPlanEntryRef.current);
          if (completedPlan) {
            deferLiveTranscriptEntry(completedPlan);
            setLastCompletedPlanEntry(completedPlan);
          }
          setPendingPlanEntry(undefined);
        }
        return;
      }

      if (event.notification.method === "warning") {
        const message =
          typeof event.notification.params.message === "string"
            ? event.notification.params.message
            : "";
        setPendingProtocolActivityEntry(
          buildWarningActivityEntry({
            id: `live-warning-${selectedThread.id}`,
            message,
          })
        );
        return;
      }

      if (event.notification.method === "turn/diff/updated") {
        if (!event.rendererActivityEntry) {
          return;
        }

        const turn = buildLiveTurnMetadata({
          turnId:
            liveNotificationTurnId(
              typeof event.notification.params.turnId === "string"
                ? event.notification.params.turnId
                : undefined
            ),
          activeTurnStartedAt: props.activeTurnStartedAt,
        });
        setPendingActivityEntry({
          ...event.rendererActivityEntry,
          ...(turn ? { turn } : {}),
        });
        return;
      }

      if (event.notification.method === "item/plan/delta") {
        const params = event.notification.params as Record<string, unknown>;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!delta) {
          return;
        }

        const itemId = getPlanNotificationItemId(params);
        const turnId =
          liveNotificationTurnId(getPlanNotificationTurnId(params)) ??
          itemId ??
          selectedThread.id;
        const turn = buildLiveTurnMetadata({
          turnId,
          activeTurnStartedAt: props.activeTurnStartedAt,
        });
        setPendingPlanEntry((current) => ({
          type: "plan",
          id: `live-plan-${turnId}`,
          createdAt: current?.createdAt ?? Date.now(),
          ...(current?.turn ?? turn ? { turn: current?.turn ?? turn } : {}),
          ...(current?.explanation ? { explanation: current.explanation } : {}),
          markdown: `${current?.markdown ?? ""}${delta}`,
          steps: current?.steps ?? [],
        }));
        return;
      }

      if (event.notification.method === "item/completed") {
        const params = event.notification.params as Record<string, unknown>;
        const markdown = readCompletedPlanMarkdown(params);
        if (markdown) {
          const itemId = getPlanNotificationItemId(params);
          const turnId =
            liveNotificationTurnId(getPlanNotificationTurnId(params)) ??
            itemId ??
            selectedThread.id;
          const turn = buildLiveTurnMetadata({
            turnId,
            activeTurnStartedAt: props.activeTurnStartedAt,
          });
          setPendingPlanEntry((current) => ({
            type: "plan",
            id: `live-plan-${turnId}`,
            createdAt: current?.createdAt ?? Date.now(),
            ...(current?.turn ?? turn ? { turn: current?.turn ?? turn } : {}),
            ...(current?.explanation ? { explanation: current.explanation } : {}),
            markdown,
            steps: current?.steps ?? [],
          }));
          return;
        }
        return;
      }

      if (event.notification.method !== "turn/plan/updated") {
        return;
      }

      const planRecord =
        typeof event.notification.params.plan === "object" &&
        event.notification.params.plan !== null
          ? (event.notification.params.plan as {
              explanation?: unknown;
              steps?: unknown;
            })
          : undefined;

      if (!Array.isArray(planRecord?.steps)) {
        return;
      }

      const explanation =
        typeof planRecord.explanation === "string" && planRecord.explanation.trim()
          ? planRecord.explanation.trim()
          : undefined;
      const steps = normalizeLivePlanSteps(planRecord.steps);

      const turnId =
        liveNotificationTurnId(
          typeof event.notification.params.turnId === "string"
            ? event.notification.params.turnId
            : undefined
        ) ?? selectedThread.id;
      const turn = buildLiveTurnMetadata({
        turnId,
        activeTurnStartedAt: props.activeTurnStartedAt,
      });
      setPendingPlanEntry((current) => ({
        type: "plan",
        id: `live-plan-${turnId}`,
        createdAt: current?.createdAt ?? Date.now(),
        ...(current?.turn ?? turn ? { turn: current?.turn ?? turn } : {}),
        ...(explanation ? { explanation } : {}),
        ...(current?.markdown ? { markdown: current.markdown } : {}),
        steps,
      }));
    });
  }, [
    props.activeTurnId,
    props.activeTurnStartedAt,
    props.desktopApi,
    deferLiveTranscriptEntry,
    liveNotificationTurnId,
    selectedThread,
  ]);

  async function respondToPendingRequest(action: PendingRequestAction): Promise<void> {
    if (!props.desktopApi?.submitServerRequest || !selectedThread || !props.pendingRequest) {
      setPendingRequestError("Desktop bridge is missing submitServerRequest().");
      return;
    }

    setPendingRequestBusy(true);
    setPendingRequestError(undefined);

    try {
      await props.desktopApi.submitServerRequest({
        backend: selectedThread.source,
        threadId: selectedThread.id,
        turnId:
          typeof props.pendingRequest.params.turnId === "string"
            ? props.pendingRequest.params.turnId
            : undefined,
        requestId: props.pendingRequest.params.requestId,
        response: buildPendingRequestResponse(props.pendingRequest, action),
      });
      props.clearPendingRequest(
        props.pendingRequest.params.requestId,
        (
          action.decision === "accept" ||
          action.decision === "accept_for_session" ||
          action.decision === "accept_with_execpolicy_amendment" ||
          action.decision === "apply_network_policy_amendment"
        )
          ? "Thinking"
          : undefined,
      );
    } catch (error) {
      setPendingRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRequestBusy(false);
    }
  }

  async function submitPendingUserInput(
    pendingUserInput: PendingQuestionnaireState
  ): Promise<void> {
    if (!props.desktopApi?.submitServerRequest || !selectedThread) {
      setPendingRequestError("Desktop bridge is missing submitServerRequest().");
      return;
    }

    setPendingRequestBusy(true);
    setPendingRequestError(undefined);

    try {
      await props.desktopApi.submitServerRequest({
        backend: selectedThread.source,
        threadId: selectedThread.id,
        turnId: pendingUserInput.turnId,
        requestId: pendingUserInput.requestId,
        response: buildQuestionnaireResponse(pendingUserInput),
      });
      props.clearPendingRequest(pendingUserInput.requestId, "Thinking");
    } catch (error) {
      setPendingRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRequestBusy(false);
    }
  }

  async function submitPendingMcpInteraction(
    pendingMcpInteraction: PendingMcpInteractionState,
    action: "accept" | "decline" | "cancel"
  ): Promise<void> {
    if (!props.desktopApi?.submitServerRequest || !selectedThread) {
      setPendingRequestError("Desktop bridge is missing submitServerRequest().");
      return;
    }

    setPendingRequestBusy(true);
    setPendingRequestError(undefined);

    try {
      await props.desktopApi.submitServerRequest({
        backend: selectedThread.source,
        threadId: selectedThread.id,
        turnId:
          typeof pendingMcpInteraction.turnId === "string"
            ? pendingMcpInteraction.turnId
            : undefined,
        requestId: pendingMcpInteraction.requestId,
        response: buildMcpElicitationResponse(pendingMcpInteraction, action),
      });
      props.clearPendingRequest(
        pendingMcpInteraction.requestId,
        action === "accept" ? "Thinking" : undefined
      );
    } catch (error) {
      setPendingRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRequestBusy(false);
    }
  }

  if (pendingForkEnvironmentSetup) {
    return (
      <section className="thread-view thread-view--launchpad">
        <header className="thread-header thread-header--launchpad">
          <div className="thread-header__main thread-header__main--launchpad">
            <div className="thread-header__eyebrow-row">
              <p className="eyebrow">Forking thread</p>
              <span className="chip chip--backend">
                {formatBackendLabel(pendingForkEnvironmentSetup.backend, props.backends)}
              </span>
            </div>
            <h2 className="thread-header__title">
              {pendingForkEnvironmentSetup.directoryLabel}
            </h2>
          </div>

          <div className="thread-header__launchpad-aside">
            <div className="thread-header__stats">
              <div>
                <span className="thread-header__stat-label">Workspace</span>
                <strong>New worktree</strong>
              </div>
              <div>
                <span className="thread-header__stat-label">Environment</span>
                <strong>{pendingForkEnvironmentSetup.environmentName}</strong>
              </div>
            </div>
            <MessagingStatusBar
              desktopApi={props.desktopApi}
              onOpenActivity={props.onOpenMessagingActivity}
            />
          </div>
        </header>

        <div className="thread-view__launchpad-composer">
          <LaunchpadEnvironmentSetupPending
            command={launchpadSetupProgress?.command ?? pendingForkEnvironmentSetup.command}
            cwd={launchpadSetupProgress?.cwd ?? pendingForkEnvironmentSetup.cwd}
            directoryLabel={pendingForkEnvironmentSetup.directoryLabel}
            environmentName={
              launchpadSetupProgress?.environmentName ??
              pendingForkEnvironmentSetup.environmentName
            }
            progress={launchpadSetupProgress}
          />
        </div>
      </section>
    );
  }

  if (!selectedThread && !selectedLaunchpad) {
    return (
      <section className="thread-view thread-view--empty">
        <ThreadPlaceholderHeader
          desktopApi={props.desktopApi}
          title="Pick a Thread"
          onOpenMessagingActivity={props.onOpenMessagingActivity}
          layout={{
            sidebarOpen: !sidebarHidden,
            railOpen: contextRailPinned,
            onToggleSidebar,
            onToggleRail: () => onContextRailPinnedChange(!contextRailPinned),
          }}
          masthead={props.mastheadActions}
          history={props.historyNav}
        />
        <div className="thread-empty-state">
          <div className="thread-empty-state__content">
            <p className="eyebrow">Thread detail</p>
            <h2>Select a thread</h2>
            <p>
              Inbox stays above every other lens. Pick a thread to read the full
              transcript, or open a project launchpad from Directories.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (selectedLaunchpad && props.selectedDirectory) {
    const launchpadBackend = props.backends.find(
      (backend) => backend.kind === selectedLaunchpad.backend
    );
    const syncLabel = formatDirectorySync(props.selectedDirectory);
    const sameWorktreeSubthread = isSameWorktreeSubthreadLaunchpad(
      selectedLaunchpad.directoryKey,
    );
    const launchpadIsSubthread = Boolean(selectedLaunchpad.parentThreadId);
    const launchpadCurrentBranch =
      props.selectedDirectory.gitStatus?.currentBranch ?? selectedLaunchpad.branchName;
    const workspaceLabel =
      props.selectedDirectory.kind === "workspace"
        ? "Workspace"
        : sameWorktreeSubthread
          ? "Same worktree"
          : selectedLaunchpad.workMode === "worktree"
            ? "New worktree"
            : "Local checkout";
    const launchpadTitle =
      props.selectedDirectory.kind === "workspace"
        ? "New thread"
        : selectedLaunchpad.directoryLabel;
    const launchpadBranchLabel =
      selectedLaunchpad.workMode === "worktree"
        ? selectedLaunchpad.branchName ??
          props.selectedDirectory.gitStatus?.currentBranch ??
          "Pick one"
        : launchpadCurrentBranch ?? "Not attached";
    const launchpadBranchDetailLabel =
      selectedLaunchpad.workMode === "worktree" ? "Base branch" : "Current branch";
    const launchpadBranchDetailValue =
      selectedLaunchpad.workMode === "worktree"
        ? launchpadBranchLabel
        : launchpadCurrentBranch ??
          (props.selectedDirectory.gitStatus?.syncState === "status-unavailable"
            ? "Unavailable"
            : "Not a Git repo");
    const launchpadStatusValue =
      launchpadIsSubthread
        ? "Starts empty"
        : syncLabel ?? "Directory context only";
    const launchpadDirectoryStatusValue =
      syncLabel ??
      (sameWorktreeSubthread && selectedLaunchpad.branchName
        ? "Git worktree"
        : "Directory context only");
    const selectedLaunchpadCodexEnvironment =
      selectedLaunchpad.codexEnvironmentOptions?.find(
        (environment) => environment.id === selectedLaunchpad.codexEnvironmentId,
      );
    const launchpadRunningCodexEnvironmentSetup = Boolean(
      selectedLaunchpadCodexEnvironment?.setupScript,
    );
    const handleMaterializeLaunchpad: NonNullable<
      ThreadViewProps["onMaterializeLaunchpad"]
    > = async (directoryKey, input, collaborationMode, reviewTarget) => {
      if (!props.onMaterializeLaunchpad) {
        return;
      }

      setLaunchpadMaterializing(true);
      setLaunchpadMaterializeError(undefined);
      try {
        await props.onMaterializeLaunchpad(
          directoryKey,
          input,
          collaborationMode,
          reviewTarget
        );
      } catch (error) {
        setLaunchpadMaterializeError(
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    };

    return (
      <section className="thread-view thread-view--launchpad">
        <header className="thread-header thread-header--launchpad">
          <div className="thread-header__main thread-header__main--launchpad">
            <div className="thread-header__eyebrow-row">
              <p className="eyebrow">New thread</p>
              <span className="chip chip--backend">
                {formatBackendLabel(selectedLaunchpad.backend, props.backends)}
              </span>
            </div>
            <h2 className="thread-header__title">{launchpadTitle}</h2>
          </div>

          <div className="thread-header__launchpad-aside">
            <div className="thread-header__stats">
              <div>
                <span className="thread-header__stat-label">Workspace</span>
                <strong>{workspaceLabel}</strong>
              </div>
              <div>
                <span className="thread-header__stat-label">Branch</span>
                <strong>{launchpadBranchLabel}</strong>
              </div>
            </div>
            <MessagingStatusBar
              desktopApi={props.desktopApi}
              onOpenActivity={props.onOpenMessagingActivity}
            />
          </div>
        </header>

        <div className="launchpad-panel launchpad-panel--compact">
          <div className="launchpad-panel__summary">
            <div>
              <span className="launchpad-panel__label">Project</span>
              <strong>{selectedLaunchpad.directoryLabel}</strong>
            </div>
            <div>
              <span className="launchpad-panel__label">Threads</span>
              <strong>
                {props.selectedDirectory.threadKeys.length} thread
                {props.selectedDirectory.threadKeys.length === 1 ? "" : "s"}
              </strong>
            </div>
            {launchpadIsSubthread ? (
              <div>
                <span className="launchpad-panel__label">Grouped under</span>
                <strong
                  title={selectedLaunchpad.parentThreadTitle ?? selectedLaunchpad.parentThreadId}
                >
                  {selectedLaunchpad.parentThreadTitle ?? selectedLaunchpad.parentThreadId}
                </strong>
              </div>
            ) : null}
            <div>
              <span className="launchpad-panel__label">
                {launchpadIsSubthread ? "History" : "Status"}
              </span>
              <strong>{launchpadStatusValue}</strong>
            </div>
          </div>

          <dl className="launchpad-grid">
            <div>
              <dt>Path</dt>
              <dd>{props.selectedDirectory.path ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>{launchpadBranchDetailLabel}</dt>
              <dd>{launchpadBranchDetailValue}</dd>
            </div>
            <div>
              <dt>Upstream</dt>
              <dd>{props.selectedDirectory.gitStatus?.upstreamBranch ?? "Not tracking"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{launchpadDirectoryStatusValue}</dd>
            </div>
          </dl>
        </div>

        <div className="thread-view__launchpad-composer">
          {launchpadMaterializing && launchpadMaterializeError ? (
            <LaunchpadMaterializeFailure
              directoryLabel={selectedLaunchpad.directoryLabel}
              error={launchpadMaterializeError}
              onClose={() => {
                setLaunchpadMaterializing(false);
                setLaunchpadMaterializeError(undefined);
              }}
            />
          ) : launchpadMaterializing && launchpadRunningCodexEnvironmentSetup ? (
            <LaunchpadEnvironmentSetupPending
              command={
                launchpadSetupProgress?.command ??
                selectedLaunchpadCodexEnvironment?.setupScript
              }
              cwd={launchpadSetupProgress?.cwd ?? selectedLaunchpad.directoryPath}
              directoryLabel={selectedLaunchpad.directoryLabel}
              environmentName={
                launchpadSetupProgress?.environmentName ??
                selectedLaunchpadCodexEnvironment?.name
              }
              progress={launchpadSetupProgress}
            />
          ) : launchpadMaterializing ? (
            <section
              className="transcript-panel transcript-panel--pending"
              aria-label="Preparing transcript"
            >
              <div className="launchpad-pending">
                <p className="eyebrow">Preparing transcript</p>
                <h3>Starting {selectedLaunchpad.directoryLabel}</h3>
                <p>Your prompt was sent. The transcript will appear here when the thread is ready.</p>
              </div>
            </section>
          ) : (
            <Composer
              backends={props.backends}
              applications={props.applications}
              desktopApi={props.desktopApi}
              onShowNotice={props.onShowNotice}
              composerImplementation={props.composerImplementation}
              draftStore={props.composerDraftStore}
              directory={props.selectedDirectory}
              directories={props.directories}
              disabled={launchpadBackend ? !launchpadBackend.available : false}
              unavailableReason={launchpadBackend?.unavailableReason}
              launchpad={selectedLaunchpad}
              launchpadError={props.launchpadError}
              pastedImageMaxPatches={props.pastedImageMaxPatches}
              fullAccessRiskWarningDismissed={
                props.fullAccessRiskWarningDismissed
              }
              onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
              onDismissFullAccessRiskWarning={
                props.onDismissFullAccessRiskWarning
              }
              onMaterializeLaunchpad={handleMaterializeLaunchpad}
              onCancelLaunchpad={props.onCancelLaunchpad}
              onUpdateLaunchpad={props.onUpdateLaunchpad}
              onSelectDirectoryFromPicker={props.onSelectDirectoryFromPicker}
              onSelectNoDirectoryFromPicker={props.onSelectNoDirectoryFromPicker}
              onPickAndRegisterDirectory={props.onPickAndRegisterDirectory}
              onPickAndAttachDirectoryToThread={
                props.onPickAndAttachDirectoryToThread
              }
              onClearPickDirectoryError={props.onClearPickDirectoryError}
              pickDirectoryError={props.pickDirectoryError}
              pickingDirectory={props.pickingDirectory}
              skillError={props.skillError}
              skillLoading={props.skillLoading}
              providerCommands={props.providerCommands ?? []}
              skills={props.skills}
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className="thread-view"
      style={
        {
          "--context-rail-width": `${contextRailWidth}px`,
        } as CSSProperties
      }
    >
      <ThreadHeader
        desktopApi={props.desktopApi}
        projectLabel={props.selectedDirectory?.label}
        thread={selectedThread!}
        backends={props.backends}
        onOpenMessagingActivity={props.onOpenMessagingActivity}
        onRevealSelectedThreadInList={props.onRevealSelectedThreadInList}
        layout={{
          sidebarOpen: !sidebarHidden,
          railOpen: contextRailPinned,
          terminalOpen: selectedThreadTerminalOpen,
          terminalRunning: selectedThreadTerminalRunning,
          onToggleSidebar,
          onToggleRail: () => onContextRailPinnedChange(!contextRailPinned),
          onToggleTerminal: toggleSelectedThreadTerminal,
        }}
        masthead={props.mastheadActions}
        history={props.historyNav}
      />

      <div
        className={`thread-view__layout${
          contextRailPinned ? " has-pinned-context-rail" : ""
        }${contextRailResizing ? " is-resizing-context-rail" : ""}`}
      >
        <div className="thread-view__primary">
          {showSetupFailureChoice && selectedThread && selectedThreadKey ? (
            <EnvironmentSetupFailureChoice
              archiving={setupFailureArchiving}
              continuing={setupFailureContinuing}
              command={
                selectedThreadEnvironmentFailurePhase === "action"
                  ? selectedThreadLatestFailedActionRun?.command
                  : selectedThread.codexEnvironmentRuntime?.setupCommand ??
                    launchpadSetupProgress?.command
              }
              cwd={
                selectedThread.codexEnvironmentRuntime?.cwd ??
                launchpadSetupProgress?.cwd
              }
              environmentName={
                selectedThread.codexEnvironmentRuntime?.environmentName ??
                "Environment"
              }
              error={props.archiveThreadError ?? setupFailureContinueError}
              exitCode={
                selectedThreadEnvironmentFailurePhase === "setup"
                  ? selectedThread.codexEnvironmentRuntime?.setupExitCode ??
                    launchpadSetupProgress?.exitCode
                  : undefined
              }
              hasWorktree={Boolean(selectedThreadWorktree)}
              output={
                selectedThreadEnvironmentFailurePhase === "setup"
                  ? selectedThread.codexEnvironmentRuntime?.setupOutput ??
                    launchpadSetupProgress?.output
                  : undefined
              }
              phase={selectedThreadEnvironmentFailurePhase}
              onCleanup={() => {
                if (!props.onArchiveThread) {
                  return;
                }
                setSetupFailureArchiving(true);
                void props.onArchiveThread(selectedThread).finally(() => {
                  setSetupFailureArchiving(false);
                });
              }}
              onContinue={continueAfterSetupFailure}
            />
          ) : null}

          {props.findOpen ? (
            <ThreadFindBar
              containerRef={transcriptPanelRef}
              refreshKey={`${selectedThread!.source}:${selectedThread!.id}:${props.transcriptEntries.length}`}
              initialQuery={props.findInitialQuery}
              turnId={props.findTurnId}
              focusNonce={props.findFocusNonce}
              hasMoreHistory={Boolean(
                props.transcriptPagination?.supportsPagination &&
                  props.transcriptPagination.hasPreviousPage,
              )}
              loadingMore={props.loadingMore}
              onLoadOlder={props.onLoadOlder}
              onClose={() => props.onFindOpenChange?.(false)}
            />
          ) : null}

          <section
            className="transcript-panel"
            aria-label="Transcript"
            ref={transcriptPanelRef}
          >
            <TranscriptList
              entries={props.transcriptEntries}
              permissionTransitions={selectedThread!.permissionTransitionLog}
              messagingBindingTransitions={
                selectedThread!.messagingBindingTransitionLog
              }
              turnFailures={selectedThread!.turnFailureLog}
              activeTurnId={props.activeTurnId}
              activeTurnStartedAt={props.activeTurnStartedAt}
              applications={props.applications}
              directoryPaths={threadDirectoryPaths(selectedThread!)}
              desktopApi={props.desktopApi}
              error={props.transcriptError}
              fileViewerContext={fileViewerContext}
              loading={props.loading}
              loadingMore={props.loadingMore}
              pagination={props.transcriptPagination}
              // File-diff activity renders in the LiveWorkRail above
              // the composer (issue #495). Generic tool activity has no
              // rail body, so keep it in the transcript while the turn
              // is live instead of collapsing the UI to a bare
              // "Thinking" indicator.
              pendingActivityEntry={pendingTranscriptActivityEntry}
              pendingAssistantMessage={props.pendingAssistantMessage}
              pendingPlanEntry={undefined}
              pendingMcpInteraction={props.pendingMcpInteraction}
              pendingRequest={props.pendingRequest}
              pendingRequestBusy={pendingRequestBusy}
              pendingUserInput={props.pendingUserInput}
              pendingStatusText={props.pendingStatusText}
              runningTurnUsageText={props.runningTurnUsageText}
              restoredViewport={props.transcriptViewport}
              reglueRequestKey={transcriptReglueRequestKey}
              skills={props.skills}
              pendingProtocolActivityEntry={pendingProtocolActivityEntry}
              pendingUsageActivityEntry={pendingUsageActivityEntry}
              threadId={`${selectedThread!.source}:${selectedThread!.id}`}
              onLoadOlder={props.onLoadOlder}
              onOpenImage={setExpandedImage}
              onRespondToPendingRequest={respondToPendingRequest}
              onPendingMcpInteractionChange={(state) => {
                props.onUpdatePendingMcpInteraction?.(state.requestId, () => state);
              }}
              onSubmitPendingMcpInteraction={submitPendingMcpInteraction}
              onPendingUserInputChange={(state) => {
                props.onUpdatePendingUserInput?.(state.requestId, () => state);
              }}
              onSubmitPendingUserInput={submitPendingUserInput}
              onViewportChange={props.onTranscriptViewportChange}
            />
            {pendingRequestError ? (
              <p className="transcript-error">{pendingRequestError}</p>
            ) : null}
          </section>

          <LiveWorkRail
            applications={props.applications}
            changedFilesEntry={liveWorkRailChangedFilesEntry}
            desktopApi={props.desktopApi}
            editedFileGroups={
              editedFilesDock === "above" ? editedFileGroups : undefined
            }
            editedFileCommitStates={editedFileCommitStates}
            editedFilesWorktreeRoot={editedFilesWorktreeRoot}
            onOpenEditedFile={handleOpenEditedFile}
            onScrollToTurn={handleScrollToTurn}
            pinned={!props.activeTurnId}
            planEntry={
              pendingPlanEntry ??
              (props.activeTurnId ? undefined : lastCompletedPlanEntry)
            }
            onMoveEditedFilesToSidebar={
              editedFilesDock === "above" ? moveEditedFilesToSidebar : undefined
            }
          />


          <Composer
            activeTurnId={props.activeTurnId}
            addOptimisticReviewEntry={props.addOptimisticReviewEntry}
            addOptimisticUserMessage={props.addOptimisticUserMessage}
            backends={props.backends}
            applications={props.applications}
            desktopApi={props.desktopApi}
            onShowNotice={props.onShowNotice}
            composerImplementation={props.composerImplementation}
            draftStore={props.composerDraftStore}
            directory={props.selectedDirectory}
            directories={props.directories}
            disabled={props.composerDisabled}
            unavailableReason={selectedThreadBackend?.unavailableReason}
            contextWindow={props.contextWindow}
            fullAccessRiskWarningDismissed={
              props.fullAccessRiskWarningDismissed
            }
            onActiveTurnIdChange={props.onActiveTurnIdChange}
            onDismissFullAccessRiskWarning={
              props.onDismissFullAccessRiskWarning
            }
            onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
            onPendingStatusChange={props.onPendingStatusChange}
            onRefreshNavigation={props.onRefreshNavigation}
            onHandoffThreadWorkspace={props.onHandoffThreadWorkspace}
            onBeforeStartTurn={
              selectedThread?.gitBranch && props.desktopApi?.checkThreadBranchDrift
                ? async () => !(await checkSelectedThreadBranchDrift("turn"))
                : undefined
            }
            onBeforeSendTurn={() => {
              setTranscriptReglueRequestKey((current) => current + 1);
            }}
            onMoveEnvActionsToSidebar={
              actionRunsDock === "above" && envActionRuns.length > 0
                ? moveActionRunsToSidebar
                : undefined
            }
            onDismissEnvActionRun={dismissEnvActionRun}
            onStopEnvActionRun={stopEnvActionRun}
            hiddenEnvActionRunIds={dismissedEnvActionRunIds}
            showEnvActionAnchors={actionRunsDock === "above"}
            onSetExecutionMode={props.onSetExecutionMode}
            onSetAcpRuntimeOption={props.onSetAcpRuntimeOption}
            onCancelExecutionModeQueue={props.onCancelExecutionModeQueue}
            onSetThreadModelSettings={props.onSetThreadModelSettings}
            pendingRequestActive={Boolean(props.pendingRequest)}
            pendingUserInputActive={Boolean(
              props.pendingUserInput || props.pendingMcpInteraction
            )}
            pastedImageMaxPatches={props.pastedImageMaxPatches}
            removeOptimisticMessage={props.removeOptimisticMessage}
            setExecutionModeError={props.setExecutionModeError}
            threadModelSettingsError={props.setThreadModelSettingsError}
            skillError={props.skillError}
            skillLoading={props.skillLoading}
            providerCommands={props.providerCommands ?? []}
            skills={props.skills}
            thread={selectedThread!}
            threadBusy={props.threadBusy}
            updatingExecutionMode={props.updatingExecutionMode}
          />

          {terminals.panes.map((terminal) => {
            const terminalVisible =
              terminal.threadKey === selectedThreadKey &&
              terminals.isPanelOpen(terminal.threadKey);
            return (
              <Suspense key={terminal.threadKey} fallback={null}>
                <LazyIntegratedTerminal
                  desktopApi={props.desktopApi}
                  threadKey={terminal.threadKey}
                  cwd={terminal.cwd}
                  height={terminals.heightByThread[terminal.threadKey] ?? 260}
                  visible={terminalVisible}
                  onHeightChange={(height) => {
                    terminals.setHeight(terminal.threadKey, height);
                  }}
                  onClose={() => {
                    terminals.closeTerminal(terminal.threadKey);
                  }}
                  onExit={() => {
                    terminals.handleExit(terminal.threadKey);
                  }}
                />
              </Suspense>
            );
          })}
        </div>

        <ThreadContextPanel
          activeTab={activeContextTab}
          activeTurnId={props.activeTurnId}
          backendError={props.backendError}
          backends={props.backends}
          desktopApi={props.desktopApi}
          editedFileGroups={editedFileGroups}
          editedFileCommitStates={editedFileCommitStates}
          editedFilesWorktreeRoot={editedFilesWorktreeRoot}
          onOpenEditedFile={handleOpenEditedFile}
          preferredEditor={preferredEditor}
          onScrollToTurn={handleScrollToTurn}
          editedFilesDock={editedFilesDock}
          onEditedFilesDockChange={onEditedFilesDockChange}
          actionRuns={visibleEnvActionRuns}
          actionRunsDock={actionRunsDock}
          actionRunsEnvironmentName={
            selectedThread?.codexEnvironmentRuntime?.environmentName
          }
          onActionRunsDockChange={onActionRunsDockChange}
          onShowActionRunsAboveComposer={showActionRunsAboveComposer}
          onDismissEnvActionRun={dismissEnvActionRun}
          onStopEnvActionRun={stopEnvActionRun}
          onActiveTabChange={onActiveContextTabChange}
          onRefreshNavigation={props.onRefreshNavigation}
          onResizingChange={setContextRailResizing}
          onWidthChange={setContextRailWidth}
          width={contextRailWidth}
          pinned={contextRailPinned}
          platform={props.platform}
          thread={selectedThread!}
          pricing={props.pricing}
          toolAccounting={props.toolAccounting}
          pricingDisplayOptions={props.pricingDisplayOptions}
          threadPricingSummaryEnabled={threadPricingSummaryEnabled}
          worktreeArchiveError={props.worktreeArchiveError}
          onRestoreWorktree={props.onRestoreWorktree}
        />
      </div>

      {expandedImage ? (
        <ImageLightbox
          src={expandedImage.url}
          alt={expandedImage.alt ?? "Expanded image"}
          onClose={() => {
            setExpandedImage(undefined);
          }}
        />
      ) : null}

      {branchDriftDialog && selectedThread ? (
        <div className="workspace-handoff-modal">
          <div
            aria-labelledby="branch-drift-title"
            aria-modal="true"
            className="workspace-handoff-dialog"
            role="dialog"
          >
            <div className="workspace-handoff-dialog__header">
              <h2 id="branch-drift-title">Thread branch changed</h2>
              <button
                aria-label="Close branch warning"
                className="workspace-handoff-dialog__close"
                disabled={branchDriftBusy}
                type="button"
                onClick={() => {
                  setBranchDriftDialog(undefined);
                }}
              >
                x
              </button>
            </div>
            <p>
              The worktree is already on a different branch. PwrAgent will not change git state
              for you.
            </p>
            <dl className="workspace-handoff-dialog__branch-path">
              <div>
                <dt>Thread expects</dt>
                <dd>
                  <code className="workspace-handoff-dialog__branch-code">
                    {branchDriftDialog.expectedBranch}
                  </code>
                </dd>
              </div>
              <span aria-hidden="true" className="workspace-handoff-dialog__branch-arrow">
                -&gt;
              </span>
              <div>
                <dt>Worktree is on</dt>
                <dd>
                  <code className="workspace-handoff-dialog__branch-code">
                    {branchDriftDialog.observedBranch}
                  </code>
                </dd>
              </div>
            </dl>
            <p>
              If earlier turns made commits on{" "}
              <code>{branchDriftDialog.expectedBranch}</code>, those commits may not be visible
              on <code>{branchDriftDialog.observedBranch}</code>.
            </p>
            <div className="workspace-handoff-dialog__comparison" aria-label="Branch choices">
              <div className="workspace-handoff-dialog__choice">
                <section className="workspace-handoff-dialog__choice-copy">
                  <h3>I'll switch back</h3>
                  <p>
                    Keep the warning. This thread will continue to expect{" "}
                    <code>{branchDriftDialog.expectedBranch}</code>.
                  </p>
                  <p>
                    Next: switch the worktree back yourself.
                  </p>
                </section>
                <button
                  aria-label={
                    branchDriftDialog.reason === "turn"
                      ? `Cancel turn. I'll switch back to ${branchDriftDialog.expectedBranch}`
                      : `Keep warning. I'll switch back to ${branchDriftDialog.expectedBranch}`
                  }
                  className="button button--secondary workspace-handoff-dialog__action"
                  disabled={branchDriftBusy}
                  title={
                    branchDriftDialog.reason === "turn"
                      ? `Cancel this send and keep the warning for ${branchDriftDialog.expectedBranch}.`
                      : `Keep the warning so you can switch back to ${branchDriftDialog.expectedBranch}.`
                  }
                  type="button"
                  onClick={async () => {
                    if (branchDriftDialog.reason === "turn") {
                      setBranchDriftDialog(undefined);
                      return;
                    }

                    if (!props.desktopApi?.retainThreadBranchDrift || !selectedThread) {
                      setBranchDriftDialog(undefined);
                      return;
                    }

                    setBranchDriftBusy(true);
                    setBranchDriftError(undefined);
                    try {
                      await props.desktopApi.retainThreadBranchDrift({
                        backend: selectedThread.source,
                        threadId: selectedThread.id,
                        expectedBranch: branchDriftDialog.expectedBranch,
                        observedBranch: branchDriftDialog.observedBranch,
                      });
                      await props.onRefreshNavigation?.();
                      setBranchDriftDialog(undefined);
                    } catch (error) {
                      setBranchDriftError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setBranchDriftBusy(false);
                    }
                  }}
                >
                  <span>
                    {branchDriftDialog.reason === "turn" ? "Cancel Turn" : "Keep Warning"}
                  </span>
                  <small>I'll switch back to {branchDriftDialog.expectedBranch}</small>
                </button>
              </div>
              <div className="workspace-handoff-dialog__choice">
                <section className="workspace-handoff-dialog__choice-copy">
                  <h3>Keep current branch</h3>
                  <p>
                    Update this thread so it expects{" "}
                    <code>{branchDriftDialog.observedBranch}</code> from now on.
                  </p>
                  <p>
                    Next: start the next turn with no warning.
                  </p>
                </section>
                <button
                  aria-label={`Accept current branch as correct. Continue working on ${branchDriftDialog.observedBranch} without further warnings`}
                  className="button button--primary workspace-handoff-dialog__action"
                  disabled={branchDriftBusy}
                  type="button"
                  onClick={async () => {
                    if (!props.desktopApi?.updateThreadExpectedBranch || !selectedThread) {
                      return;
                    }

                    setBranchDriftBusy(true);
                    setBranchDriftError(undefined);
                    try {
                      await props.desktopApi.updateThreadExpectedBranch({
                        backend: selectedThread.source,
                        threadId: selectedThread.id,
                        branch: branchDriftDialog.observedBranch,
                      });
                      await props.onRefreshNavigation?.();
                      setBranchDriftDialog(undefined);
                    } catch (error) {
                      setBranchDriftError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setBranchDriftBusy(false);
                    }
                  }}
                >
                  <span>Accept Current Branch as Correct</span>
                  <small>
                    Continue working on {branchDriftDialog.observedBranch} without further
                    warnings
                  </small>
                </button>
              </div>
            </div>
            {branchDriftError ? (
              <p className="workspace-handoff-dialog__error">{branchDriftError}</p>
            ) : null}
          </div>
        </div>
      ) : null}


    </section>
  );
}

function formatDirectorySync(directory: NavigationDirectorySummary): string | undefined {
  const status = directory.gitStatus;
  if (!status) {
    return undefined;
  }

  if (status.syncState === "in-sync") {
    return "Up to date";
  }
  if (status.syncState === "ahead") {
    return `${status.ahead ?? 0} ahead`;
  }
  if (status.syncState === "behind") {
    return `${status.behind ?? 0} behind`;
  }
  if (status.syncState === "diverged") {
    return `${status.ahead ?? 0} ahead · ${status.behind ?? 0} behind`;
  }
  if (status.syncState === "untracked") {
    return "No upstream";
  }
  if (status.syncState === "status-unavailable") {
    return "Status unavailable";
  }

  return undefined;
}

function threadDirectoryPaths(thread: NavigationThreadSummary): string[] {
  const linkedDirectoryPaths = thread.linkedDirectories.flatMap((directory) => {
    const paths = [directory.path];
    if (directory.worktreePath && directory.worktreePath !== directory.path) {
      paths.push(directory.worktreePath);
    }
    return paths;
  });
  return thread.projectKey ? [thread.projectKey, ...linkedDirectoryPaths] : linkedDirectoryPaths;
}

function resolveThreadTerminalCwd(
  thread: NavigationThreadSummary,
): string | undefined {
  const directory =
    thread.linkedDirectories.find((candidate) => candidate.kind === "worktree") ??
    thread.linkedDirectories.find((candidate) => candidate.kind === "local") ??
    thread.linkedDirectories[0];

  return directory?.worktreePath ?? directory?.path ?? thread.projectKey;
}
