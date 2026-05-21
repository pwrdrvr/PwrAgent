import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
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
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  HandoffThreadWorkspaceRequest,
  MessagingChannelKind,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { isBranchDrifted, readCodexEnvironmentActionRuns } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { Composer } from "../composer/Composer";
import type { ComposerDraftStore } from "../composer/useComposerDraftStore";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadPlaceholderHeader } from "./ThreadPlaceholderHeader";
import { TranscriptImageLightbox } from "./TranscriptImageLightbox";
import { TranscriptList } from "./TranscriptList";
import { LiveWorkRail, type LiveWorkRailDock } from "./LiveWorkRail";
import {
  buildQuestionnaireResponse,
  type PendingQuestionnaireState,
} from "./questionnaire";
import {
  buildMcpElicitationResponse,
  type PendingMcpInteractionState,
} from "./mcp-elicitation";
import {
  formatChangedFileSummary,
  getBasename,
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

function summarizeDiff(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (
      !line ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      removals += 1;
    }
  }

  return { additions, removals };
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

function normalizeDiffPath(path: string | undefined): string | undefined {
  if (!path || path === "/dev/null") {
    return undefined;
  }

  return path.replace(/^[ab]\//, "");
}

function inferDiffKind(lines: string[]): "add" | "delete" | "update" {
  const beforeLine = lines.find((line) => line.startsWith("--- "));
  const afterLine = lines.find((line) => line.startsWith("+++ "));

  if (beforeLine?.slice(4).trim() === "/dev/null") {
    return "add";
  }

  if (afterLine?.slice(4).trim() === "/dev/null") {
    return "delete";
  }

  return "update";
}

function buildDiffLabel(kind: "add" | "delete" | "update", path?: string): string {
  const verb = kind[0]?.toUpperCase() + kind.slice(1);
  return `${verb} ${path ? getBasename(path) : "file"}`;
}

function extractDiffDetails(
  diff: string,
  entryId: string
): AppServerThreadActivityDetail[] {
  const lines = diff.replace(/\r\n?/g, "\n").split("\n");
  const sections: Array<{ lines: string[] }> = [];
  let currentSection: { lines: string[] } | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentSection?.lines.length) {
        sections.push(currentSection);
      }
      currentSection = { lines: [line] };
      continue;
    }

    if (!currentSection) {
      currentSection = { lines: [] };
    }

    currentSection.lines.push(line);
  }

  if (currentSection?.lines.length) {
    sections.push(currentSection);
  }

  const normalizedSections = sections.length > 0 ? sections : [{ lines }];
  const details: AppServerThreadActivityDetail[] = [];

  for (const [index, section] of normalizedSections.entries()) {
    const rawBefore = section.lines.find((line) => line.startsWith("--- "))?.slice(4).trim();
    const rawAfter = section.lines.find((line) => line.startsWith("+++ "))?.slice(4).trim();
    const path = normalizeDiffPath(rawAfter) ?? normalizeDiffPath(rawBefore);
    const diffText = section.lines.join("\n").trim();

    if (!diffText) {
      continue;
    }

    const kind = inferDiffKind(section.lines);
    const diffSummary = summarizeDiff(diffText);

    details.push({
      id: `${entryId}-${index + 1}`,
      kind: "write",
      label: buildDiffLabel(kind, path),
      ...(path ? { path } : {}),
      fileDiff: {
        kind,
        diff: diffText,
        additions: diffSummary.additions,
        removals: diffSummary.removals,
      },
    });
  }

  return details;
}

function buildPendingDiffEntry(params: {
  diff: string;
  id: string;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const details = extractDiffDetails(params.diff, params.id);
  if (details.length === 0) {
    return undefined;
  }
  const additions = details.reduce(
    (total, detail) => total + (detail.fileDiff?.additions ?? 0),
    0
  );
  const removals = details.reduce(
    (total, detail) => total + (detail.fileDiff?.removals ?? 0),
    0
  );

  return {
    type: "activity",
    id: params.id,
    createdAt: Date.now(),
    summary: formatChangedFileSummary({
      count: details.length,
      prefix: "Edited",
      additions,
      removals,
    }),
    details,
    ...(params.turn ? { turn: params.turn } : {}),
  };
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
    const pendingDiff = pendingDetail.fileDiff?.diff;
    if (!pendingDiff) {
      return false;
    }

    return candidate.details.some((detail) => detail.fileDiff?.diff === pendingDiff);
  });
}

export type ThreadViewProps = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
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
  archiveThreadError?: string;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  contextWindow?: ThreadContextWindowState;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  pastedImageMaxPatches?: number;
  platform?: string;
  selectedDirectory?: NavigationDirectorySummary;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
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
  onPickAndRegisterDirectory?: () => void;
  onClearPickDirectoryError?: () => void;
  setExecutionModeError?: string;
  setThreadModelSettingsError?: string;
  worktreeArchiveError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  transcriptEntries: AppServerThreadEntry[];
  transcriptError?: string;
  transcriptPagination?: AppServerThreadReplayPagination;
  updatingExecutionMode?: ThreadExecutionMode;
  onActiveTurnIdChange?: (turnId?: string) => void;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  onDismissFullAccessRiskWarning?: () => Promise<void>;
  /** Forwarded to ThreadHeader → MessagingStatusBar — opens the Activity screen. */
  onOpenMessagingActivity?: (platform: MessagingChannelKind) => void;
  onRevealSelectedThreadInList?: () => void;
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
  const [pendingPlanEntry, setPendingPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  // Snapshots of the two rail-owned live entries at turn/completed
  // time. The LiveWorkRail uses these to keep showing what the last
  // turn produced even after the live state has cleared, until the
  // next turn starts. `pendingProtocolActivityEntry` (MCP status /
  // warnings) is not snapshotted because it doesn't belong in the
  // rail; the dupe-fix that clears it on turn/completed still applies.
  const [lastCompletedActivityEntry, setLastCompletedActivityEntry] =
    useState<AppServerThreadActivityEntry>();
  const [lastCompletedPlanEntry, setLastCompletedPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  const [liveWorkRailDock, setLiveWorkRailDock] =
    useState<LiveWorkRailDock>("above");
  // Refs mirror the pending state so the turn/completed handler can read
  // the latest values to snapshot, then clear via setState without
  // racing or queuing extra micro-renders.
  const pendingActivityEntryRef = useRef<AppServerThreadActivityEntry | undefined>(
    undefined,
  );
  const pendingProtocolActivityEntryRef = useRef<
    AppServerThreadActivityEntry | undefined
  >(undefined);
  const pendingPlanEntryRef = useRef<AppServerThreadPlanEntry | undefined>(undefined);
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();
  const [contextRailPinned, setContextRailPinned] = useState(false);
  const [contextRailResizing, setContextRailResizing] = useState(false);
  const [transcriptReglueRequestKey, setTranscriptReglueRequestKey] = useState(0);
  const [contextRailWidth, setContextRailWidth] = useState(380);
  const [launchpadMaterializing, setLaunchpadMaterializing] = useState(false);
  const [setupFailureDismissedThreadKeys, setSetupFailureDismissedThreadKeys] =
    useState<Set<string>>(() => new Set());
  const [setupFailureArchiving, setSetupFailureArchiving] = useState(false);
  const [setupFailureContinuing, setSetupFailureContinuing] = useState(false);
  const [setupFailureContinueError, setSetupFailureContinueError] =
    useState<string>();
  const [launchpadSetupProgress, setLaunchpadSetupProgress] =
    useState<LaunchpadEnvironmentSetupProgress>();
  // Auto-pin the context rail on wide displays (issue #240). Same
  // breakpoint as the CSS in `app.css` (`@media (min-width: 1700px)`)
  // so the React state and the visual styles agree about when the
  // rail is "always visible". Without this, the rail's React panel
  // content is conditionally rendered (`open = pinned || revealed`)
  // and the user sees an empty rail wrapper on wide displays because
  // CSS forced the wrapper visible without the panel content. The
  // userPinned-vs-effective split also means the user's manual
  // pin/unpin choice is preserved across resizes — when they shrink
  // the window back below 1700px the rail returns to whatever they
  // had it set to before.
  const contextRailWideMatch = useMediaQuery("(min-width: 1700px)");
  const contextRailEffectivePinned = contextRailPinned || contextRailWideMatch;

  useEffect(() => {
    setPendingActivityEntry(undefined);
    setPendingProtocolActivityEntry(undefined);
    setPendingPlanEntry(undefined);
    setLastCompletedActivityEntry(undefined);
    setLastCompletedPlanEntry(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setSetupFailureArchiving(false);
    setContextRailPinned(false);
    setContextRailResizing(false);
    setExpandedImage(undefined);
    setLaunchpadMaterializing(false);
    setLaunchpadSetupProgress(undefined);
    setSetupFailureContinuing(false);
    setSetupFailureContinueError(undefined);
  }, [
    props.selectedLaunchpad?.directoryKey,
    props.selectedThread?.id,
    props.selectedThread?.source,
  ]);

  useEffect(() => {
    pendingActivityEntryRef.current = pendingActivityEntry;
    pendingProtocolActivityEntryRef.current = pendingProtocolActivityEntry;
    pendingPlanEntryRef.current = pendingPlanEntry;
  }, [pendingActivityEntry, pendingProtocolActivityEntry, pendingPlanEntry]);

  // When a new turn begins, clear the pinned snapshots from the prior
  // turn so the LiveWorkRail reflects the in-flight turn's work, not
  // stale history. Triggered by activeTurnId transitioning to a new
  // non-empty value (turn/started fired upstream).
  const lastSeenActiveTurnIdRef = useRef<string | undefined>(props.activeTurnId);
  useEffect(() => {
    const previous = lastSeenActiveTurnIdRef.current;
    lastSeenActiveTurnIdRef.current = props.activeTurnId;
    if (props.activeTurnId && props.activeTurnId !== previous) {
      setLastCompletedActivityEntry(undefined);
      setLastCompletedPlanEntry(undefined);
    }
  }, [props.activeTurnId]);

  const selectedThread = props.selectedThread;
  const selectedLaunchpad = props.selectedLaunchpad;

  useEffect(() => {
    const directoryKey = selectedLaunchpad?.directoryKey;
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
  }, [props.desktopApi, selectedLaunchpad?.directoryKey]);

  const [branchDriftDialog, setBranchDriftDialog] =
    useState<BranchDriftDialogState>();
  const [branchDriftError, setBranchDriftError] = useState<string>();
  const [branchDriftBusy, setBranchDriftBusy] = useState(false);

  const selectedThreadKey = selectedThread
    ? `${selectedThread.source}:${selectedThread.id}`
    : undefined;
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
        setPendingActivityEntry(undefined);
        setPendingProtocolActivityEntry(undefined);
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
            setLastCompletedActivityEntry(completedActivity);
          }
          setPendingActivityEntry(undefined);

          const completedProtocolActivity = completeEntryTurn(
            pendingProtocolActivityEntryRef.current,
          );
          if (completedProtocolActivity) {
            deferLiveTranscriptEntry(completedProtocolActivity);
          }
          setPendingProtocolActivityEntry(undefined);

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
        if (typeof event.notification.params.diff !== "string") {
          return;
        }

        setPendingActivityEntry(
          buildPendingDiffEntry({
            diff: event.notification.params.diff,
            id: `live-diff-${
              typeof event.notification.params.turnId === "string"
                ? event.notification.params.turnId
                : typeof event.notification.params.turnId === "string"
                  ? event.notification.params.turnId
                  : selectedThread.id
            }`,
            turn: buildLiveTurnMetadata({
              turnId:
                liveNotificationTurnId(
                  typeof event.notification.params.turnId === "string"
                    ? event.notification.params.turnId
                    : undefined
                ),
              activeTurnStartedAt: props.activeTurnStartedAt,
            }),
          })
        );
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

  async function respondToPendingRequest(
    decision: "approve" | "decline" | "cancel"
  ): Promise<void> {
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
        response: buildPendingRequestResponse(props.pendingRequest, decision),
      });
      props.clearPendingRequest(
        props.pendingRequest.params.requestId,
        decision === "approve" ? "Thinking" : undefined
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

  if (!selectedThread && !selectedLaunchpad) {
    return (
      <section className="thread-view thread-view--empty">
        <ThreadPlaceholderHeader
          desktopApi={props.desktopApi}
          title="Pick a Thread"
          onOpenMessagingActivity={props.onOpenMessagingActivity}
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
    const workspaceLabel =
      props.selectedDirectory.kind === "workspace"
        ? "Workspace"
        : selectedLaunchpad.workMode === "worktree"
          ? "New worktree"
          : "Local checkout";
    const launchpadTitle =
      props.selectedDirectory.kind === "workspace"
        ? "New thread"
        : selectedLaunchpad.directoryLabel;
    const launchpadRunningCodexEnvironmentSetup = Boolean(
      selectedLaunchpad.codexEnvironmentId &&
        selectedLaunchpad.codexEnvironmentSetupEnabled,
    );
    const selectedLaunchpadCodexEnvironment =
      selectedLaunchpad.codexEnvironmentOptions?.find(
        (environment) => environment.id === selectedLaunchpad.codexEnvironmentId,
      );
    const handleMaterializeLaunchpad: NonNullable<
      ThreadViewProps["onMaterializeLaunchpad"]
    > = async (directoryKey, input, collaborationMode, reviewTarget) => {
      if (!props.onMaterializeLaunchpad) {
        return;
      }

      setLaunchpadMaterializing(true);
      try {
        await props.onMaterializeLaunchpad(
          directoryKey,
          input,
          collaborationMode,
          reviewTarget
        );
      } catch (error) {
        setLaunchpadMaterializing(false);
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
                {formatBackendLabel(selectedLaunchpad.backend)}
              </span>
              <span className="chip chip--mode">
                {formatExecutionModeLabel(selectedLaunchpad.executionMode)}
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
                <strong>
                  {selectedLaunchpad.workMode === "worktree"
                    ? selectedLaunchpad.branchName ??
                      props.selectedDirectory.gitStatus?.currentBranch ??
                      "Pick one"
                    : props.selectedDirectory.gitStatus?.currentBranch ?? "Not attached"}
                </strong>
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
            <div>
              <span className="launchpad-panel__label">Status</span>
              <strong>{syncLabel ?? "Directory context only"}</strong>
            </div>
          </div>

          <dl className="launchpad-grid">
            <div>
              <dt>Path</dt>
              <dd>{props.selectedDirectory.path ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Current branch</dt>
              <dd>
                {props.selectedDirectory.gitStatus?.currentBranch ??
                  (props.selectedDirectory.gitStatus?.syncState === "status-unavailable"
                    ? "Unavailable"
                    : "Not a Git repo")}
              </dd>
            </div>
            <div>
              <dt>Upstream</dt>
              <dd>{props.selectedDirectory.gitStatus?.upstreamBranch ?? "Not tracking"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{syncLabel ?? "Directory context only"}</dd>
            </div>
          </dl>
        </div>

        <div className="thread-view__launchpad-composer">
          {launchpadMaterializing && launchpadRunningCodexEnvironmentSetup ? (
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
              composerImplementation={props.composerImplementation}
              draftStore={props.composerDraftStore}
              directory={props.selectedDirectory}
              directories={props.directories}
              disabled={!launchpadBackend?.available}
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
              onUpdateLaunchpad={props.onUpdateLaunchpad}
              onSelectDirectoryFromPicker={props.onSelectDirectoryFromPicker}
              onPickAndRegisterDirectory={props.onPickAndRegisterDirectory}
              onClearPickDirectoryError={props.onClearPickDirectoryError}
              pickDirectoryError={props.pickDirectoryError}
              pickingDirectory={props.pickingDirectory}
              skillError={props.skillError}
              skillLoading={props.skillLoading}
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
        onOpenMessagingActivity={props.onOpenMessagingActivity}
        onRevealSelectedThreadInList={props.onRevealSelectedThreadInList}
      />

      <div
        className={`thread-view__layout${
          contextRailEffectivePinned ? " has-pinned-context-rail" : ""
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
                "Codex environment"
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

          <section className="transcript-panel" aria-label="Transcript">
            <TranscriptList
              entries={props.transcriptEntries}
              permissionTransitions={selectedThread!.permissionTransitionLog}
              messagingBindingTransitions={
                selectedThread!.messagingBindingTransitionLog
              }
              activeTurnId={props.activeTurnId}
              activeTurnStartedAt={props.activeTurnStartedAt}
              applications={props.applications}
              directoryPaths={threadDirectoryPaths(selectedThread!)}
              desktopApi={props.desktopApi}
              error={props.transcriptError}
              loading={props.loading}
              loadingMore={props.loadingMore}
              pagination={props.transcriptPagination}
              // pendingActivityEntry and pendingPlanEntry render in
              // the LiveWorkRail above the composer (issue #495); pass
              // undefined here so the transcript doesn't double-render
              // the same live state. The persisted/optimistic copies
              // that settle after `turn/completed` still flow through
              // `entries`, so the transcript history is unaffected.
              pendingActivityEntry={undefined}
              pendingAssistantMessage={props.pendingAssistantMessage}
              pendingPlanEntry={undefined}
              pendingMcpInteraction={props.pendingMcpInteraction}
              pendingRequest={props.pendingRequest}
              pendingRequestBusy={pendingRequestBusy}
              pendingUserInput={props.pendingUserInput}
              pendingStatusText={props.pendingStatusText}
              restoredViewport={props.transcriptViewport}
              reglueRequestKey={transcriptReglueRequestKey}
              skills={props.skills}
              pendingProtocolActivityEntry={pendingProtocolActivityEntry}
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

          {liveWorkRailDock === "above" ? (
            <LiveWorkRail
              applications={props.applications}
              changedFilesEntry={liveWorkRailChangedFilesEntry}
              desktopApi={props.desktopApi}
              dock="above"
              editedFilesEntry={
                pendingActivityEntry ??
                (props.activeTurnId ? undefined : lastCompletedActivityEntry)
              }
              pinned={!props.activeTurnId}
              planEntry={
                pendingPlanEntry ??
                (props.activeTurnId ? undefined : lastCompletedPlanEntry)
              }
              onDockChange={setLiveWorkRailDock}
            />
          ) : null}

          <Composer
            activeTurnId={props.activeTurnId}
            addOptimisticReviewEntry={props.addOptimisticReviewEntry}
            addOptimisticUserMessage={props.addOptimisticUserMessage}
            backends={props.backends}
            applications={props.applications}
            desktopApi={props.desktopApi}
            composerImplementation={props.composerImplementation}
            draftStore={props.composerDraftStore}
            directory={props.selectedDirectory}
            disabled={props.composerDisabled}
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
            onSetExecutionMode={props.onSetExecutionMode}
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
            skills={props.skills}
            thread={selectedThread!}
            updatingExecutionMode={props.updatingExecutionMode}
          />
        </div>

        {liveWorkRailDock === "sidebar" ? (
          <LiveWorkRail
            applications={props.applications}
            changedFilesEntry={liveWorkRailChangedFilesEntry}
            desktopApi={props.desktopApi}
            dock="sidebar"
            editedFilesEntry={
              pendingActivityEntry ??
              (props.activeTurnId ? undefined : lastCompletedActivityEntry)
            }
            pinned={!props.activeTurnId}
            planEntry={
              pendingPlanEntry ??
              (props.activeTurnId ? undefined : lastCompletedPlanEntry)
            }
            onDockChange={setLiveWorkRailDock}
          />
        ) : null}

        <ThreadContextPanel
          backendError={props.backendError}
          backends={props.backends}
          desktopApi={props.desktopApi}
          onPinnedChange={setContextRailPinned}
          onResizingChange={setContextRailResizing}
          onWidthChange={setContextRailWidth}
          // Auto-pinned when wide (issue #240) — the panel renders
          // `open = pinned || revealed` so passing the effective
          // value here makes sure the panel content is in the DOM
          // at wide widths, not just the empty rail wrapper. The
          // raw user state (`contextRailPinned`) still flows through
          // `onPinnedChange` so the user's narrow-width preference
          // is preserved across resizes.
          pinned={contextRailEffectivePinned}
          platform={props.platform}
          thread={selectedThread!}
          worktreeArchiveError={props.worktreeArchiveError}
          onRestoreWorktree={props.onRestoreWorktree}
        />
      </div>

      {expandedImage ? (
        <TranscriptImageLightbox
          image={expandedImage}
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

function executionModeLabel(mode: ThreadExecutionMode): string {
  if (mode === "full-access") return "Full Access";
  return "Default Access";
}

function buildPendingRequestResponse(
  request: AppServerPendingRequestNotification,
  decision: "approve" | "decline" | "cancel"
): { decision: string } {
  const availableDecision = selectAvailableDecision(request.params, decision);
  if (availableDecision) {
    return { decision: availableDecision };
  }

  if (request.method.includes("commandExecution/requestApproval")) {
    return {
      decision:
        decision === "approve"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel",
    };
  }

  if (request.method.includes("fileChange/requestApproval")) {
    return {
      decision:
        decision === "approve"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel",
    };
  }

  return { decision };
}

function selectAvailableDecision(
  params: AppServerPendingRequestNotification["params"],
  decision: "approve" | "decline" | "cancel"
): string | undefined {
  const rawDecisions =
    readDecisionStrings(params.availableDecisions) ?? readDecisionStrings(params.decisions);
  if (!rawDecisions?.length) {
    return undefined;
  }

  const acceptedAliases =
    decision === "approve"
      ? ["accept", "approve", "allow"]
      : decision === "decline"
        ? ["decline", "deny", "reject"]
        : ["cancel", "abort", "stop"];

  return rawDecisions.find((value) =>
    acceptedAliases.some((alias) => value.toLowerCase().includes(alias))
  );
}

function readDecisionStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      for (const key of ["decision", "value", "name", "id"]) {
        const raw = record[key];
        if (typeof raw === "string" && raw.trim()) {
          return raw.trim();
        }
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
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
