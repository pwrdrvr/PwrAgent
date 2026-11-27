import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { MAX_TEXT_FILE_PREVIEW_BYTES } from "@pwragent/shared/file-preview";
import {
  DECISIONS_RAIL_PAGE_MAX_ITEMS,
  type DecisionsRailBatchActionResult,
  type DecisionsRailBatchPage,
  type DecisionsRailOpenResultsResult,
} from "@pwragent/shared/decisions-rail";
import {
  RESEARCH_RUN_ATTENTION_ORDER,
  type PrepareResearchRequest,
  type ResearchChangesRequest,
  type ResearchDecisionBatchActionRequest,
  type ResearchDecisionBatchRequest,
  type ResearchDecisionOpenResultsRequest,
  type ResearchDecisionsRequest,
  type ResearchDecisionsSnapshot,
  type ResearchEventsRequest,
  type ResearchEvidenceRequest,
  type ResearchItemReadRequest,
  type ResearchProfileRunsPage,
  type ResearchProfileRunsQuery,
  type ResearchSearchRequest,
  type ResearchSnapshotRequest,
  type ResearchThreadRequest,
  type ResearchUpdateRequest,
  type ResearchWorkRequest,
} from "@pwragent/shared/research";
import type {
  ResearchHarnessReconcileRequest,
  ResearchHarnessRequest,
  ResearchMathosSwarmsRequest,
} from "@pwragent/shared/research-harness";
import {
  RESEARCH_CHANGES_CHANNEL,
  RESEARCH_DECISION_BATCH_ACTION_CHANNEL,
  RESEARCH_DECISION_BATCH_CHANNEL,
  RESEARCH_DECISION_OPEN_RESULTS_CHANNEL,
  RESEARCH_DECISIONS_CHANNEL,
  RESEARCH_DECISIONS_STATUS_CHANNEL,
  RESEARCH_EVENTS_CHANNEL,
  RESEARCH_HARNESS_CHECK_CHANNEL,
  RESEARCH_HARNESS_PICK_BRIDGE_CHANNEL,
  RESEARCH_HARNESS_RECONCILE_CHANNEL,
  RESEARCH_HARNESS_REVEAL_CONFIG_CHANNEL,
  RESEARCH_HARNESS_SETTINGS_CHECK_CHANNEL,
  RESEARCH_HARNESS_START_CHANNEL,
  RESEARCH_HARNESS_STATUS_CHANNEL,
  RESEARCH_ITEM_CHANNEL,
  RESEARCH_MATHOS_SWARMS_CHANNEL,
  RESEARCH_MATHOS_TEAMS_CHANNEL,
  RESEARCH_OPEN_EVIDENCE_CHANNEL,
  RESEARCH_OPEN_WINDOW_CHANNEL,
  RESEARCH_PREPARE_CHANNEL,
  RESEARCH_PROFILE_RUNS_CHANNEL,
  RESEARCH_SEARCH_CHANNEL,
  RESEARCH_SNAPSHOT_CHANNEL,
  RESEARCH_UPDATE_CHANNEL,
  RESEARCH_WITHDRAW_CHANNEL,
  RESEARCH_WORK_CHANNEL,
} from "../../../shared/ipc";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { FederatedResearchService, type ResearchOperation } from "../../federation/federation-research";
import { getDesktopFederationRuntime } from "../../federation/federation-runtime";
import { getMainLogger } from "../../log";
import { isDecisionBatchId } from "../../openai-decisions/decision-batch-files";
import { readDecisionProvidersReadiness } from "../../openai-decisions/decision-provider-targets";
import { getOpenAIDecisionsRail } from "../../openai-decisions/openai-decisions-runtime";
import { resolveHarnessEvidencePath, resolveResearchEvidencePath } from "../../research/research-evidence-path";
import { localResearchOperations, requireResearchEnabled, validateResearchThread } from "../../research/research-operations";
import { getResearchHarnessService, getResearchService, listResearchMathosTeams } from "../../research/research-runtime";
import { resolveDesktopConfigPath } from "../../settings/desktop-config";
import { getDesktopSettingsService } from "../../settings/desktop-settings-singleton";
import { showMarkdownFileViewerWindow } from "../markdown-files-window";
import { researchWindowRunId, showResearchWindow } from "../research-window";
import {
  federationTargetForChannelSubscriber,
  isLocalMainWindowWebContents,
  isLocalResearchWebContents,
  isMainWindowWebContents,
} from "../window-channels";

const researchIpcLog = getMainLogger("pwragent:research");

const ROUTED_MAIN_CHANNELS = {
  harnessStatus: RESEARCH_HARNESS_STATUS_CHANNEL,
  harnessCheck: RESEARCH_HARNESS_CHECK_CHANNEL,
  harnessStart: RESEARCH_HARNESS_START_CHANNEL,
  prepare: RESEARCH_PREPARE_CHANNEL,
  withdraw: RESEARCH_WITHDRAW_CHANNEL,
  listMathosSwarms: RESEARCH_MATHOS_SWARMS_CHANNEL,
} as const satisfies Partial<Record<ResearchOperation, string>>;

const ROUTED_RESEARCH_CHANNELS = {
  snapshot: RESEARCH_SNAPSHOT_CHANNEL,
  changes: RESEARCH_CHANGES_CHANNEL,
  events: RESEARCH_EVENTS_CHANNEL,
  search: RESEARCH_SEARCH_CHANNEL,
  readItem: RESEARCH_ITEM_CHANNEL,
  work: RESEARCH_WORK_CHANNEL,
  update: RESEARCH_UPDATE_CHANNEL,
  harnessReconcile: RESEARCH_HARNESS_RECONCILE_CHANNEL,
} as const satisfies Partial<Record<ResearchOperation, string>>;

type RoutedRequest =
  | ResearchSnapshotRequest
  | ResearchChangesRequest
  | ResearchEventsRequest
  | ResearchSearchRequest
  | ResearchItemReadRequest
  | ResearchWorkRequest
  | PrepareResearchRequest
  | ResearchThreadRequest
  | ResearchUpdateRequest
  | ResearchHarnessRequest
  | ResearchHarnessReconcileRequest
  | ResearchMathosSwarmsRequest;

/**
 * Thread Research IPC. Thread-scoped reads and mutations route to the thread's
 * owning instance (local or connected Federation peer); Settings, local shell
 * evidence opens, and profile-wide Research window reads remain local-only.
 */
export function registerResearchIpcHandlers(): void {
  disposeResearchIpcHandlers();
  const service = new FederatedResearchService({
    local: localResearchOperations,
    remote: (target, operation, request) =>
      getDesktopFederationRuntime().requestResearchOperation(target, operation, request),
  });

  for (const operation of Object.keys(ROUTED_MAIN_CHANNELS) as Array<keyof typeof ROUTED_MAIN_CHANNELS>) {
    ipcMain.handle(ROUTED_MAIN_CHANNELS[operation], async (event, request?: RoutedRequest) => {
      if (!isMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
      return await service.request(operation, request as never, federationTargetForChannelSubscriber(event.sender));
    });
  }

  for (const operation of Object.keys(ROUTED_RESEARCH_CHANNELS) as Array<keyof typeof ROUTED_RESEARCH_CHANNELS>) {
    ipcMain.handle(ROUTED_RESEARCH_CHANNELS[operation], async (event, request?: RoutedRequest) => {
      const mainWindow = isMainWindowWebContents(event.sender);
      if (!mainWindow && !isLocalResearchWebContents(event.sender)) {
        throw new Error("Open research on its owning instance");
      }
      if (!mainWindow && request && typeof request === "object" && "federationTarget" in request && request.federationTarget !== undefined) {
        throw new Error("Open research on its owning instance");
      }
      return await service.request(operation, request as never, federationTargetForChannelSubscriber(event.sender));
    });
  }

  // Every run on this profile, for the Research window. It names runs across threads, so only this
  // instance's own windows may read it; each run's contents are still read as its coordinating thread.
  ipcMain.handle(RESEARCH_PROFILE_RUNS_CHANNEL, (event, request: ResearchProfileRunsQuery | undefined): ResearchProfileRunsPage => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    requireResearchEnabled();
    const page = getResearchService().profileRuns(profileRunsQuery(request));
    const registry = getDesktopBackendRegistry();
    return {
      ...page,
      runs: page.runs.map((run) => {
        // Last-observed listing state: a label for the row, never proof the thread still exists.
        const thread = registry.getCachedThreadSummary({ backend: run.coordinator.backend, threadId: run.coordinator.threadId });
        const project = thread?.linkedDirectories[0]?.label;
        return thread?.title ? { ...run, thread: { title: thread.title, ...(project ? { project } : {}) } } : run;
      }),
    };
  });
  ipcMain.handle(RESEARCH_OPEN_WINDOW_CHANNEL, (event, request: { runId?: string } | undefined) => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    requireResearchEnabled();
    showResearchWindow({ sourceWindow: BrowserWindow.fromWebContents(event.sender) ?? undefined }, { runId: researchWindowRunId(request?.runId) });
  });
  // Settings checks the saved bridge with no thread: a check binds no evidence, so it runs from the temporary directory.
  ipcMain.handle(RESEARCH_HARNESS_SETTINGS_CHECK_CHANNEL, async (event) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Check the bridge on its owning instance");
    const result = await getResearchHarnessService().check(await realpath(tmpdir()));
    // The window shows the reason; the log keeps it for a later look. Neither carries a credential.
    if (!result.ok) researchIpcLog.warn("Harness connection check failed", { error: result.error });
    return result;
  });
  // The operator chooses the bridge program in the system file picker; Settings saves it like any other field.
  ipcMain.handle(RESEARCH_HARNESS_PICK_BRIDGE_CHANNEL, async (event): Promise<{ path?: string }> => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Choose the bridge on its owning instance");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { title: "Choose the Harness bridge", properties: ["openFile"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? {} : { path: result.filePaths[0] };
  });
  // Settings lists the teams the stored key can open, on the saved origin. The window supplies no address or key.
  ipcMain.handle(RESEARCH_MATHOS_TEAMS_CHANNEL, async (event) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("List MathOS teams on the owning instance");
    return await listResearchMathosTeams();
  });
  // Reveals this profile's own config file. The window supplies no path.
  ipcMain.handle(RESEARCH_HARNESS_REVEAL_CONFIG_CHANNEL, (event) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    shell.showItemInFolder(resolveDesktopConfigPath());
  });
  // Evidence paths are resolved on the owning machine's disk; never open a remote path locally.
  ipcMain.handle(RESEARCH_OPEN_EVIDENCE_CHANNEL, async (event, request: ResearchEvidenceRequest & { federationTarget?: unknown }) => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    if (request && typeof request === "object" && request.federationTarget !== undefined) {
      throw new Error("Open evidence on the thread's owning instance");
    }
    validateResearchThread(request);
    if (typeof request.runId !== "string" || typeof request.itemId !== "string" || !Number.isSafeInteger(request.pathIndex) || request.pathIndex < 0) {
      throw new Error("Invalid evidence reference");
    }
    const { relativePath, source, harnessWorkspace } = getResearchService().readEvidence(
      request.runId,
      request.itemId,
      request.pathIndex,
      { backend: request.backend, threadId: request.threadId, kind: "operator" },
    );
    const cwd = harnessWorkspace ?? await getDesktopBackendRegistry().resolveThreadWorkspaceCwd(source.backend, source.threadId);
    if (!cwd) throw new Error("The worker workspace is unavailable");
    const resolved = harnessWorkspace ? await resolveHarnessEvidencePath(cwd, relativePath) : await resolveResearchEvidencePath(cwd, relativePath);
    const error = await shell.openPath(resolved);
    return { opened: !error, ...(error ? { error } : {}) };
  });
  ipcMain.handle(RESEARCH_DECISIONS_STATUS_CHANNEL, async (event) => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    requireResearchEnabled();
    return await readDecisionProvidersReadiness(getDesktopSettingsService());
  });
  ipcMain.handle(RESEARCH_DECISIONS_CHANNEL, async (event, request: ResearchDecisionsRequest): Promise<ResearchDecisionsSnapshot> => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateResearchThread(request);
    if (typeof request.runId !== "string" || request.runId.length === 0 || request.runId.length > 300) throw new Error("Invalid research run");
    const ctx = getResearchService().runParticipants(request.runId, { backend: request.backend, threadId: request.threadId });
    if (!ctx) throw new Error("Research run not found");
    const readiness = await readDecisionProvidersReadiness(getDesktopSettingsService());
    const rail = getOpenAIDecisionsRail();
    if (!rail) return { runId: ctx.runId, readiness, decisions: [], batches: [], now: Date.now() };
    return await rail.researchRunDecisionsSnapshot(ctx, readiness);
  });
  ipcMain.handle(RESEARCH_DECISION_BATCH_CHANNEL, async (event, request: ResearchDecisionBatchRequest): Promise<DecisionsRailBatchPage> => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateResearchThread(request);
    if (typeof request.runId !== "string" || request.runId.length === 0 || request.runId.length > 300) throw new Error("Invalid research run");
    if (typeof request.batchId !== "string" || !isDecisionBatchId(request.batchId)) throw new Error("Invalid batch id");
    if (request.status !== "all" && request.status !== "succeeded" && request.status !== "failed" && request.status !== "skipped") {
      throw new Error("Invalid item filter");
    }
    if (!Number.isSafeInteger(request.from) || request.from < 0) throw new Error("Invalid item index");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > DECISIONS_RAIL_PAGE_MAX_ITEMS) {
      throw new Error("Invalid page size");
    }
    const ctx = getResearchService().runParticipants(request.runId, { backend: request.backend, threadId: request.threadId });
    if (!ctx) throw new Error("Research run not found");
    const rail = getOpenAIDecisionsRail();
    if (!rail) throw new Error("Decisions are unavailable in this PwrAgent runtime");
    return await rail.researchRunBatchPage(ctx, { batchId: request.batchId, status: request.status, from: request.from, limit: request.limit });
  });
  ipcMain.handle(RESEARCH_DECISION_BATCH_ACTION_CHANNEL, async (event, request: ResearchDecisionBatchActionRequest): Promise<DecisionsRailBatchActionResult> => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateResearchThread(request);
    if (typeof request.runId !== "string" || request.runId.length === 0 || request.runId.length > 300) throw new Error("Invalid research run");
    if (typeof request.batchId !== "string" || !isDecisionBatchId(request.batchId)) throw new Error("Invalid batch id");
    if (request.action !== "stop" && request.action !== "cancel") throw new Error("Invalid batch action");
    const ctx = getResearchService().runParticipants(request.runId, { backend: request.backend, threadId: request.threadId });
    if (!ctx) throw new Error("Research run not found");
    const rail = getOpenAIDecisionsRail();
    if (!rail) throw new Error("Decisions are unavailable in this PwrAgent runtime");
    return await rail.researchRunBatchAction(ctx, request.batchId, request.action);
  });
  ipcMain.handle(RESEARCH_DECISION_OPEN_RESULTS_CHANNEL, async (event, request: ResearchDecisionOpenResultsRequest): Promise<DecisionsRailOpenResultsResult> => {
    if (!isLocalResearchWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateResearchThread(request);
    if (typeof request.runId !== "string" || request.runId.length === 0 || request.runId.length > 300) throw new Error("Invalid research run");
    if (typeof request.batchId !== "string" || !isDecisionBatchId(request.batchId)) throw new Error("Invalid batch id");
    const ctx = getResearchService().runParticipants(request.runId, { backend: request.backend, threadId: request.threadId });
    if (!ctx) throw new Error("Research run not found");
    const rail = getOpenAIDecisionsRail();
    if (!rail) return { opened: false, error: "Decisions are unavailable in this PwrAgent runtime." };
    const file = await rail.researchRunResultsFile(ctx, request.batchId);
    const resultStat = file ? await stat(file).catch(() => undefined) : undefined;
    if (!file || !resultStat?.isFile()) return { opened: false, error: "This batch has no results file." };
    if (resultStat.size > MAX_TEXT_FILE_PREVIEW_BYTES) {
      shell.showItemInFolder(file);
      return { opened: true };
    }
    showMarkdownFileViewerWindow({
      context: {
        key: `decision-results:${path.dirname(file)}`,
        title: "Decision batch results",
      },
      file: { path: file, label: path.basename(file) },
    }, { sourceWindow: BrowserWindow.fromWebContents(event.sender) });
    return { opened: true };
  });
}

export function disposeResearchIpcHandlers(): void {
  ipcMain.removeHandler(RESEARCH_HARNESS_STATUS_CHANNEL);
  ipcMain.removeHandler(RESEARCH_HARNESS_START_CHANNEL);
  ipcMain.removeHandler(RESEARCH_HARNESS_CHECK_CHANNEL);
  ipcMain.removeHandler(RESEARCH_HARNESS_RECONCILE_CHANNEL);
  ipcMain.removeHandler(RESEARCH_HARNESS_REVEAL_CONFIG_CHANNEL);
  ipcMain.removeHandler(RESEARCH_HARNESS_SETTINGS_CHECK_CHANNEL);
  ipcMain.removeHandler(RESEARCH_HARNESS_PICK_BRIDGE_CHANNEL);
  ipcMain.removeHandler(RESEARCH_MATHOS_TEAMS_CHANNEL);
  ipcMain.removeHandler(RESEARCH_MATHOS_SWARMS_CHANNEL);
  ipcMain.removeHandler(RESEARCH_PROFILE_RUNS_CHANNEL);
  ipcMain.removeHandler(RESEARCH_OPEN_WINDOW_CHANNEL);
  for (const channel of [
    RESEARCH_CHANGES_CHANNEL,
    RESEARCH_SNAPSHOT_CHANNEL,
    RESEARCH_UPDATE_CHANNEL,
    RESEARCH_OPEN_EVIDENCE_CHANNEL,
    RESEARCH_PREPARE_CHANNEL,
    RESEARCH_SEARCH_CHANNEL,
    RESEARCH_ITEM_CHANNEL,
    RESEARCH_WORK_CHANNEL,
    RESEARCH_WITHDRAW_CHANNEL,
    RESEARCH_EVENTS_CHANNEL,
    RESEARCH_DECISIONS_STATUS_CHANNEL,
    RESEARCH_DECISIONS_CHANNEL,
    RESEARCH_DECISION_BATCH_CHANNEL,
    RESEARCH_DECISION_BATCH_ACTION_CHANNEL,
    RESEARCH_DECISION_OPEN_RESULTS_CHANNEL,
  ]) ipcMain.removeHandler(channel);
}

/** Bounded, typed filters only: the window's request is not trusted to be well formed. */
function profileRunsQuery(request: ResearchProfileRunsQuery | undefined): ResearchProfileRunsQuery {
  const after = request?.after;
  return {
    ...(request?.source === "native" || request?.source === "harness" ? { source: request.source } : {}),
    ...(typeof request?.text === "string" && request.text.trim() ? { text: request.text.trim().slice(0, 200) } : {}),
    ...(after && RESEARCH_RUN_ATTENTION_ORDER.includes(after.attention) && Number.isSafeInteger(after.createdAt) && typeof after.id === "string" && after.id.length <= 300
      ? { after: { attention: after.attention, createdAt: after.createdAt, id: after.id } } : {}),
  };
}
