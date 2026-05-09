import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  HandoffThreadWorkspaceRequest,
  MessagingChannelKind,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { isBranchDrifted } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { Composer } from "../composer/Composer";
import type { ComposerDraftStore } from "../composer/useComposerDraftStore";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptImageLightbox } from "./TranscriptImageLightbox";
import { TranscriptList } from "./TranscriptList";
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
  summarizeActivityStatus,
} from "./live-transcript-activity";

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

function getBasename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
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

function formatChangedFileSummary(params: {
  count: number;
  prefix: "Changed" | "Edited";
  additions: number;
  removals: number;
}): string {
  const parts = [
    `${params.prefix} ${params.count} file${params.count === 1 ? "" : "s"}`,
  ];
  if (params.additions > 0 || params.removals > 0) {
    parts.push(
      `+${params.additions.toLocaleString()}, -${params.removals.toLocaleString()}`
    );
  }
  return parts.join(", ");
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

function parseFileChangeOutput(delta: string, entryId: string): AppServerThreadActivityDetail[] {
  const changes = new Map<string, Set<"add" | "delete" | "update">>();

  for (const line of delta.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.trim().match(/^([ADM])\s+(.+)$/);
    if (!match) {
      continue;
    }

    const kind =
      match[1] === "A" ? "add" : match[1] === "D" ? "delete" : "update";
    const path = match[2].trim();
    if (!path) {
      continue;
    }

    const existing = changes.get(path) ?? new Set<"add" | "delete" | "update">();
    existing.add(kind);
    changes.set(path, existing);
  }

  return [...changes.entries()].map(([path, kinds], index) => {
    const labelKind =
      kinds.has("add") && kinds.has("delete")
        ? "Recreated"
        : kinds.has("add")
          ? "Added"
          : kinds.has("delete")
            ? "Deleted"
            : "Modified";
    return {
      id: `${entryId}-${index + 1}`,
      kind: "write",
      label: `${labelKind} ${getBasename(path)}`,
      path,
    };
  });
}

function buildFileChangeOutputEntry(params: {
  delta: string;
  id: string;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const details = parseFileChangeOutput(params.delta, params.id);
  if (details.length === 0) {
    return undefined;
  }

  return {
    type: "activity",
    id: params.id,
    createdAt: Date.now(),
    summary: formatChangedFileSummary({
      count: details.length,
      prefix: "Changed",
      additions: 0,
      removals: 0,
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

type ThreadViewProps = {
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
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  contextWindow?: ThreadContextWindowState;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  platform?: string;
  selectedDirectory?: NavigationDirectorySummary;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
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
  /** Forwarded to ThreadHeader → MessagingStatusBar — opens the Activity screen. */
  onOpenMessagingActivity?: (platform: MessagingChannelKind) => void;
  onLoadOlder: () => Promise<void>;
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
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();
  const [contextRailPinned, setContextRailPinned] = useState(false);
  const [contextRailResizing, setContextRailResizing] = useState(false);
  const [transcriptReglueRequestKey, setTranscriptReglueRequestKey] = useState(0);
  const [contextRailWidth, setContextRailWidth] = useState(380);
  const [launchpadMaterializing, setLaunchpadMaterializing] = useState(false);

  useEffect(() => {
    setPendingActivityEntry(undefined);
    setPendingProtocolActivityEntry(undefined);
    setPendingPlanEntry(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setContextRailPinned(false);
    setContextRailResizing(false);
    setExpandedImage(undefined);
    setLaunchpadMaterializing(false);
  }, [
    props.selectedLaunchpad?.directoryKey,
    props.selectedThread?.id,
    props.selectedThread?.source,
  ]);

  const selectedThread = props.selectedThread;
  const selectedLaunchpad = props.selectedLaunchpad;
  const [branchDriftDialog, setBranchDriftDialog] =
    useState<BranchDriftDialogState>();
  const [branchDriftError, setBranchDriftError] = useState<string>();
  const [branchDriftBusy, setBranchDriftBusy] = useState(false);

  const selectedThreadKey = selectedThread
    ? `${selectedThread.source}:${selectedThread.id}`
    : undefined;

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
  }, [selectedThread, props.activeTurnId]);

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
          setPendingActivityEntry((current) => {
            const next = completeEntryTurn(current);
            if (next) {
              deferLiveTranscriptEntry(next);
            }
            return next;
          });
          setPendingProtocolActivityEntry((current) => {
            const next = completeEntryTurn(current);
            if (next) {
              deferLiveTranscriptEntry(next);
            }
            return next;
          });
          setPendingPlanEntry((current) => {
            const next = completeEntryTurn(current);
            if (next) {
              deferLiveTranscriptEntry(next);
            }
            return next;
          });
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

      if (event.notification.method === "item/fileChange/outputDelta") {
        if (typeof event.notification.params.delta !== "string") {
          return;
        }

        const turnId =
          liveNotificationTurnId(
            typeof event.notification.params.turnId === "string"
              ? event.notification.params.turnId
              : undefined
          ) ?? selectedThread.id;
        setPendingProtocolActivityEntry(
          buildFileChangeOutputEntry({
            delta: event.notification.params.delta,
            id: `live-file-change-${event.notification.params.itemId || turnId}`,
            turn: buildLiveTurnMetadata({
              turnId,
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
      <section className="thread-empty-state">
        <p className="eyebrow">Thread detail</p>
        <h2>Select a thread</h2>
        <p>
          Inbox stays above every other lens. Pick a thread to read the full
          transcript, or open a project launchpad from Directories.
        </p>
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
          <div>
            <div className="thread-header__eyebrow-row">
              <p className="eyebrow">New thread</p>
              <span className="thread-row__chip thread-row__chip--backend">
                {formatBackendLabel(selectedLaunchpad.backend)}
              </span>
              <span className="thread-row__chip thread-row__chip--mode">
                {formatExecutionModeLabel(selectedLaunchpad.executionMode)}
              </span>
            </div>
            <h2 className="thread-header__title">{launchpadTitle}</h2>
          </div>

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
              <dd>{props.selectedDirectory.gitStatus?.currentBranch ?? "Not a Git repo"}</dd>
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
          {launchpadMaterializing ? (
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
              onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
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
    <section className="thread-view">
      <ThreadHeader
        desktopApi={props.desktopApi}
        thread={selectedThread!}
        onOpenMessagingActivity={props.onOpenMessagingActivity}
      />

      <div
        className={`thread-view__layout${
          contextRailPinned ? " has-pinned-context-rail" : ""
        }${contextRailResizing ? " is-resizing-context-rail" : ""}`}
        style={
          {
            "--context-rail-width": `${contextRailWidth}px`,
          } as CSSProperties
        }
      >
        <div className="thread-view__primary">
          <section className="transcript-panel" aria-label="Transcript">
            <TranscriptList
              entries={props.transcriptEntries}
              permissionTransitions={selectedThread!.permissionTransitionLog}
              activeTurnId={props.activeTurnId}
              activeTurnStartedAt={props.activeTurnStartedAt}
              applications={props.applications}
              desktopApi={props.desktopApi}
              error={props.transcriptError}
              loading={props.loading}
              loadingMore={props.loadingMore}
              pagination={props.transcriptPagination}
              pendingActivityEntry={pendingActivityEntry}
              pendingAssistantMessage={props.pendingAssistantMessage}
              pendingPlanEntry={pendingPlanEntry}
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
            onActiveTurnIdChange={props.onActiveTurnIdChange}
            onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
            onPendingStatusChange={props.onPendingStatusChange}
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

        <ThreadContextPanel
          backendError={props.backendError}
          backends={props.backends}
          onPinnedChange={setContextRailPinned}
          onResizingChange={setContextRailResizing}
          onWidthChange={setContextRailWidth}
          pinned={contextRailPinned}
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
            <h2 id="branch-drift-title">Thread branch changed</h2>
            <p>
              This thread was working on branch{" "}
              <strong>{branchDriftDialog.expectedBranch}</strong> and now has moved to branch{" "}
              <strong>{branchDriftDialog.observedBranch}</strong>.
            </p>
            <p>
              Some context understood by the agent may have changed. Asking the agent to
              continue with a change that is no longer available on the current branch will not
              work.
            </p>
            <dl className="workspace-handoff-dialog__summary">
              <div>
                <dt>Expected branch</dt>
                <dd>{branchDriftDialog.expectedBranch}</dd>
              </div>
              <div>
                <dt>Current branch</dt>
                <dd>{branchDriftDialog.observedBranch}</dd>
              </div>
            </dl>
            {branchDriftError ? (
              <p className="workspace-handoff-dialog__error">{branchDriftError}</p>
            ) : null}
            <div className="workspace-handoff-dialog__actions">
              <button
                className="button-secondary"
                disabled={branchDriftBusy}
                title={
                  branchDriftDialog.reason === "turn"
                    ? "Cancel this send and leave the expected branch unchanged."
                    : "Keep the detected branch warning visible so you can switch back to the expected branch."
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
                {branchDriftDialog.reason === "turn"
                  ? "Cancel"
                  : "Retain Expected Branch"}
              </button>
              <button
                className="button-primary"
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
                Update Expected Branch
              </button>
            </div>
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
