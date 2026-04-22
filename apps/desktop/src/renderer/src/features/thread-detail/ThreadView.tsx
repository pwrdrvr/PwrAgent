import { useEffect, useState } from "react";
import type {
  AppServerCollaborationModeRequest,
  AppServerPendingRequestNotification,
  AppServerSource,
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
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { Composer } from "../composer/Composer";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptImageLightbox } from "./TranscriptImageLightbox";
import { TranscriptList } from "./TranscriptList";
import {
  buildQuestionnaireResponse,
  type PendingQuestionnaireState,
} from "./questionnaire";

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

function getNotificationItem(params: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof params.item === "object" && params.item !== null && !Array.isArray(params.item)
    ? params.item as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readToolArgument(
  item: Record<string, unknown>,
  key: string,
): string | undefined {
  const args =
    typeof item.arguments === "object" && item.arguments !== null && !Array.isArray(item.arguments)
      ? item.arguments as Record<string, unknown>
      : undefined;
  return readString(args, key);
}

function readToolOutputText(item: Record<string, unknown>): string | undefined {
  const toolName = readString(item, "toolName") ?? readString(item, "tool_name");
  const data =
    typeof item.data === "object" && item.data !== null && !Array.isArray(item.data)
      ? item.data as Record<string, unknown>
      : undefined;
  const output =
    readString(data, "output") ??
    readString(data, "text") ??
    readString(data, "result") ??
    readString(item, "text");
  return output && output !== toolName ? output : undefined;
}

function readElapsedMs(item: Record<string, unknown>): number | undefined {
  const data =
    typeof item.data === "object" && item.data !== null && !Array.isArray(item.data)
      ? item.data as Record<string, unknown>
      : undefined;
  return typeof data?.elapsedMs === "number" && Number.isFinite(data.elapsedMs)
    ? data.elapsedMs
    : undefined;
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`;
  }
  const seconds = elapsedMs / 1_000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

function readItemSources(item: Record<string, unknown>): AppServerSource[] {
  const data =
    typeof item.data === "object" && item.data !== null && !Array.isArray(item.data)
      ? item.data as Record<string, unknown>
      : undefined;
  const rawSources = Array.isArray(item.sources)
    ? item.sources
    : Array.isArray(data?.sources)
      ? data.sources
      : [];

  return rawSources.flatMap((source): AppServerSource[] => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      return [];
    }
    const record = source as Record<string, unknown>;
    const title = readString(record, "title");
    const url = readString(record, "url");
    if (!title && !url) {
      return [];
    }
    return [{ title, url }];
  });
}

function normalizeItemStatus(value: unknown): AppServerThreadActivityDetail["status"] {
  return value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "in_progress"
    ? value
    : "in_progress";
}

function summarizeToolOutput(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/[#*_`>[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function formatLiveToolName(
  toolName: string,
  status: AppServerThreadActivityDetail["status"],
): string {
  if (toolName === "search_web") {
    return status === "in_progress" ? "Searching Web" : "Searched Web";
  }
  if (toolName === "search_x") {
    return status === "in_progress" ? "Searching X" : "Searched X";
  }
  if (toolName === "shell_command") {
    return "Ran command";
  }
  return toolName.replace(/_/g, " ");
}

function buildLiveToolDetails(
  item: Record<string, unknown>,
): AppServerThreadActivityDetail[] {
  const itemType = readString(item, "type")?.replace(/[-_\s]/g, "").toLowerCase();
  if (itemType !== "dynamictoolcall" && itemType !== "commandexecution") {
    return [];
  }

  const itemId = readString(item, "id") ?? readString(item, "itemId") ?? "tool";
  const toolName =
    readString(item, "toolName") ??
    readString(item, "tool_name") ??
    readString(item, "name") ??
    "tool";
  const status = normalizeItemStatus(item.status);
  const query = readToolArgument(item, "query") ?? readToolArgument(item, "q");
  const preview = summarizeToolOutput(readToolOutputText(item));
  const elapsedMs = readElapsedMs(item);
  const details: AppServerThreadActivityDetail[] = [
    {
      id: itemId,
      kind: toolName.startsWith("search_") ? "read" : "command",
      label: [
        formatLiveToolName(toolName, status),
        elapsedMs ? ` (${formatElapsedMs(elapsedMs)})` : "",
        query ? `: ${query}` : "",
        preview ? ` - ${preview}` : "",
      ].join(""),
      status,
    },
  ];

  for (const [index, source] of readItemSources(item).slice(0, 5).entries()) {
    const label = source.title || source.url;
    if (!label) {
      continue;
    }
    details.push({
      id: `${itemId}-source-${index + 1}`,
      kind: "read",
      label,
      url: source.url,
      status,
    });
  }

  return details;
}

function summarizeActivityStatus(
  details: AppServerThreadActivityDetail[],
): AppServerThreadActivityEntry["status"] {
  if (details.some((detail) => detail.status === "failed")) {
    return "failed";
  }
  if (details.some((detail) => detail.status === "in_progress")) {
    return "in_progress";
  }
  if (details.some((detail) => detail.status === "cancelled")) {
    return "cancelled";
  }
  return details.some((detail) => detail.status === "completed") ? "completed" : undefined;
}

function summarizeLiveToolActivity(details: AppServerThreadActivityDetail[]): string {
  const toolLabels = [
    ...new Set(
      details
        .filter((detail) => !detail.id.includes("-source-"))
        .map((detail) => detail.label.split(":")[0]?.split(" - ")[0]?.trim())
        .filter(Boolean)
    ),
  ];
  if (toolLabels.length === 1 && toolLabels[0]) {
    return toolLabels[0];
  }
  if (toolLabels.length > 1) {
    return `Used ${toolLabels.length} tools`;
  }
  return "Tool activity";
}

function mergeActivityDetails(
  current: AppServerThreadActivityDetail[],
  next: AppServerThreadActivityDetail[],
): AppServerThreadActivityDetail[] {
  const merged = [...current];
  for (const detail of next) {
    const existingIndex = merged.findIndex((entry) => entry.id === detail.id);
    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...detail,
      };
    } else {
      merged.push(detail);
    }
  }
  return merged;
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

  return {
    type: "activity",
    id: params.id,
    createdAt: Date.now(),
    summary: `Edited ${details.length} file${details.length === 1 ? "" : "s"}`,
    details,
    ...(params.turn ? { turn: params.turn } : {}),
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
  addOptimisticUserMessage: (text: string) => string;
  backendError?: string;
  backends: BackendSummary[];
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  composerDisabled: boolean;
  desktopApi?: DesktopApi;
  launchpadError?: string;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  platform?: string;
  selectedDirectory?: NavigationDirectorySummary;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  setExecutionModeError?: string;
  setThreadModelSettingsError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  transcriptEntries: AppServerThreadEntry[];
  transcriptError?: string;
  transcriptPagination?: AppServerThreadReplayPagination;
  updatingExecutionMode?: ThreadExecutionMode;
  onActiveTurnIdChange?: (turnId?: string) => void;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  onLoadOlder: () => Promise<void>;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest
  ) => Promise<void>;
  onPendingStatusChange?: (status?: string) => void;
  onUpdatePendingUserInput?: (
    requestId: string,
    updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState
  ) => void;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
  onSetThreadModelSettings?: (
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  onTranscriptViewportChange?: (viewport?: {
    distanceFromBottom: number;
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
      >
    >
  ) => Promise<void>;
  removeOptimisticMessage: (id: string) => void;
  transcriptViewport?: {
    distanceFromBottom: number;
    scrollTop: number;
  };
};

export function ThreadView(props: ThreadViewProps) {
  const [pendingActivityEntry, setPendingActivityEntry] =
    useState<AppServerThreadActivityEntry>();
  const [pendingToolActivityEntry, setPendingToolActivityEntry] =
    useState<AppServerThreadActivityEntry>();
  const [pendingPlanEntry, setPendingPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();

  useEffect(() => {
    setPendingActivityEntry(undefined);
    setPendingToolActivityEntry(undefined);
    setPendingPlanEntry(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setExpandedImage(undefined);
  }, [
    props.selectedLaunchpad?.directoryKey,
    props.selectedThread?.id,
    props.selectedThread?.source,
  ]);

  const selectedThread = props.selectedThread;
  const selectedLaunchpad = props.selectedLaunchpad;

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
    if (!pendingToolActivityEntry) {
      return;
    }

    const persistedActivity = props.transcriptEntries.find(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" &&
        pendingToolActivityEntry.details.every((detail) =>
          entry.details.some((candidate) => candidate.id === detail.id)
        )
    );
    if (persistedActivity) {
      setPendingToolActivityEntry(undefined);
    }
  }, [pendingToolActivityEntry, props.transcriptEntries]);

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

      if (
        event.backend !== selectedThread.source ||
        notificationThreadId !== selectedThread.id
      ) {
        return;
      }

      if (
        event.notification.method === "turn/failed" ||
        event.notification.method === "turn/cancelled"
      ) {
        setPendingActivityEntry(undefined);
        setPendingToolActivityEntry(undefined);
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
            typeof event.notification.params.turnId === "string"
              ? event.notification.params.turnId
              : props.activeTurnId,
          turn: completedTurnRecord,
        });
        if (turn) {
          const completeEntryTurn = <T extends { turn?: AppServerThreadTurnMetadata }>(
            entry: T | undefined
          ): T | undefined => (entry ? { ...entry, turn } : undefined);
          setPendingActivityEntry((current) => completeEntryTurn(current));
          setPendingToolActivityEntry((current) => completeEntryTurn(current));
          setPendingPlanEntry((current) => completeEntryTurn(current));
        }
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
                typeof event.notification.params.turnId === "string"
                  ? event.notification.params.turnId
                  : props.activeTurnId,
              activeTurnStartedAt: props.activeTurnStartedAt,
            }),
          })
        );
        return;
      }

      if (event.notification.method === "item/started") {
        const params = event.notification.params as Record<string, unknown>;
        const item = getNotificationItem(params);
        const details = item ? buildLiveToolDetails(item) : [];
        if (details.length > 0) {
          const turnId =
            typeof params.turnId === "string"
              ? params.turnId
              : props.activeTurnId ?? selectedThread.id;
          const turn = buildLiveTurnMetadata({
            turnId,
            activeTurnStartedAt: props.activeTurnStartedAt,
          });
          setPendingToolActivityEntry((current) => {
            const mergedDetails = mergeActivityDetails(current?.details ?? [], details);
            return {
              type: "activity",
              id: current?.id ?? `live-tools-${turnId}`,
              createdAt: current?.createdAt ?? Date.now(),
              summary: summarizeLiveToolActivity(mergedDetails),
              status: summarizeActivityStatus(mergedDetails),
              details: mergedDetails,
              ...(current?.turn ?? turn ? { turn: current?.turn ?? turn } : {}),
            };
          });
        }
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
          getPlanNotificationTurnId(params) ?? props.activeTurnId ?? itemId ?? selectedThread.id;
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
            getPlanNotificationTurnId(params) ??
            props.activeTurnId ??
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

        const item = getNotificationItem(params);
        const details = item ? buildLiveToolDetails(item) : [];
        if (details.length > 0) {
          const turnId =
            typeof params.turnId === "string"
              ? params.turnId
              : props.activeTurnId ?? selectedThread.id;
          const turn = buildLiveTurnMetadata({
            turnId,
            activeTurnStartedAt: props.activeTurnStartedAt,
          });
          setPendingToolActivityEntry((current) => {
            const mergedDetails = mergeActivityDetails(current?.details ?? [], details);
            return {
              type: "activity",
              id: current?.id ?? `live-tools-${turnId}`,
              createdAt: current?.createdAt ?? Date.now(),
              summary: summarizeLiveToolActivity(mergedDetails),
              status: summarizeActivityStatus(mergedDetails),
              details: mergedDetails,
              ...(current?.turn ?? turn ? { turn: current?.turn ?? turn } : {}),
            };
          });
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
        typeof event.notification.params.turnId === "string"
          ? event.notification.params.turnId
          : props.activeTurnId ?? selectedThread.id;
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

    return (
      <section className="thread-view">
        <header className="thread-header">
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
            <h2 className="thread-header__title">{selectedLaunchpad.directoryLabel}</h2>
            <p className="thread-header__summary">
              Start a thread in this directory. Unsent prompt and setup changes stay attached to this launchpad until the first send.
            </p>
          </div>

          <div className="thread-header__stats">
            <div>
              <span className="thread-header__stat-label">Workspace</span>
              <strong>
                {selectedLaunchpad.workMode === "worktree" ? "New worktree" : "Local checkout"}
              </strong>
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

        <div className="launchpad-panel">
          <div className="launchpad-panel__header">
            <div>
              <h3>Directory</h3>
              <p>
                {props.selectedDirectory.threadKeys.length} thread
                {props.selectedDirectory.threadKeys.length === 1 ? "" : "s"}
                {syncLabel ? ` • ${syncLabel}` : ""}
              </p>
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

        <Composer
          backends={props.backends}
          desktopApi={props.desktopApi}
          directory={props.selectedDirectory}
          disabled={!launchpadBackend?.available}
          launchpad={selectedLaunchpad}
          launchpadError={props.launchpadError}
          onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
          onMaterializeLaunchpad={props.onMaterializeLaunchpad}
          onUpdateLaunchpad={props.onUpdateLaunchpad}
          skillError={props.skillError}
          skillLoading={props.skillLoading}
          skills={props.skills}
        />
      </section>
    );
  }

  return (
    <section className="thread-view">
      <ThreadHeader thread={selectedThread!} />

      <div className="thread-view__layout">
        <section className="transcript-panel" aria-label="Transcript">
          <TranscriptList
            entries={props.transcriptEntries}
            activeTurnId={props.activeTurnId}
            activeTurnStartedAt={props.activeTurnStartedAt}
            error={props.transcriptError}
            loading={props.loading}
            loadingMore={props.loadingMore}
            pagination={props.transcriptPagination}
            pendingActivityEntry={pendingToolActivityEntry ?? pendingActivityEntry}
            pendingAssistantMessage={props.pendingAssistantMessage}
            pendingPlanEntry={pendingPlanEntry}
            pendingRequest={props.pendingRequest}
            pendingRequestBusy={pendingRequestBusy}
            pendingUserInput={props.pendingUserInput}
            pendingStatusText={props.pendingStatusText}
            restoredViewport={props.transcriptViewport}
            skills={props.skills}
            threadId={`${selectedThread!.source}:${selectedThread!.id}`}
            onLoadOlder={props.onLoadOlder}
            onOpenImage={setExpandedImage}
            onRespondToPendingRequest={respondToPendingRequest}
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

        <ThreadContextPanel
          backendError={props.backendError}
          backends={props.backends}
          platform={props.platform}
          thread={selectedThread!}
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

      <Composer
        activeTurnId={props.activeTurnId}
        addOptimisticUserMessage={props.addOptimisticUserMessage}
        backends={props.backends}
        desktopApi={props.desktopApi}
        disabled={props.composerDisabled}
        onActiveTurnIdChange={props.onActiveTurnIdChange}
        onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
        onPendingStatusChange={props.onPendingStatusChange}
        onSetExecutionMode={props.onSetExecutionMode}
        onSetThreadModelSettings={props.onSetThreadModelSettings}
        pendingRequestActive={Boolean(props.pendingRequest)}
        pendingUserInputActive={Boolean(props.pendingUserInput)}
        removeOptimisticMessage={props.removeOptimisticMessage}
        setExecutionModeError={props.setExecutionModeError}
        threadModelSettingsError={props.setThreadModelSettingsError}
        skillError={props.skillError}
        skillLoading={props.skillLoading}
        skills={props.skills}
        thread={selectedThread!}
        updatingExecutionMode={props.updatingExecutionMode}
      />
    </section>
  );
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
