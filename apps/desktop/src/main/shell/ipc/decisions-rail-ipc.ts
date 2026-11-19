import { ipcMain, shell, type WebContents } from "electron";
import {
  DECISIONS_RAIL_PAGE_MAX_ITEMS,
  isAppServerBackendKind,
  type DecisionsRailBatchActionRequest,
  type DecisionsRailBatchActionResult,
  type DecisionsRailBatchPage,
  type DecisionsRailBatchRequest,
  type DecisionsRailOpenResultsRequest,
  type DecisionsRailOpenResultsResult,
  type DecisionsRailSnapshot,
  type DecisionsRailThreadRequest,
} from "@pwragent/shared";
import {
  DECISIONS_RAIL_BATCH_ACTION_CHANNEL,
  DECISIONS_RAIL_BATCH_CHANNEL,
  DECISIONS_RAIL_OPEN_RESULTS_CHANNEL,
  DECISIONS_RAIL_SNAPSHOT_CHANNEL,
} from "../../../shared/ipc";
import { isDecisionBatchId } from "../../openai-decisions/decision-batch-files";
import { getOpenAIDecisionsRail, type OpenAIDecisionsRail } from "../../openai-decisions/openai-decisions-runtime";
import { isLocalMainWindowWebContents } from "../window-channels";

const CHANNELS = [
  DECISIONS_RAIL_SNAPSHOT_CHANNEL,
  DECISIONS_RAIL_BATCH_CHANNEL,
  DECISIONS_RAIL_BATCH_ACTION_CHANNEL,
  DECISIONS_RAIL_OPEN_RESULTS_CHANNEL,
];

/**
 * The thread's Decisions tab. Decisions run in the owner's decisions
 * service, so only a local main window reads them; a federation viewer
 * sees the tab on the owning instance. The window names a thread and a
 * batch id, never a path: the results file is resolved here.
 */
export function registerDecisionsRailIpcHandlers(): void {
  disposeDecisionsRailIpcHandlers();
  ipcMain.handle(DECISIONS_RAIL_SNAPSHOT_CHANNEL, async (event, request: DecisionsRailThreadRequest): Promise<DecisionsRailSnapshot> => {
    const rail = localRail(event.sender);
    return await rail.railSnapshot(threadCaller(request));
  });
  ipcMain.handle(DECISIONS_RAIL_BATCH_CHANNEL, async (event, request: DecisionsRailBatchRequest): Promise<DecisionsRailBatchPage> => {
    const rail = localRail(event.sender);
    const caller = threadCaller(request);
    const batchId = validBatchId(request.batchId);
    if (request.status !== "all" && request.status !== "succeeded" && request.status !== "failed" && request.status !== "skipped") {
      throw new Error("Invalid item filter");
    }
    if (!Number.isSafeInteger(request.from) || request.from < 0) throw new Error("Invalid item index");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > DECISIONS_RAIL_PAGE_MAX_ITEMS) {
      throw new Error("Invalid page size");
    }
    return await rail.railBatchPage(caller, { batchId, status: request.status, from: request.from, limit: request.limit });
  });
  ipcMain.handle(DECISIONS_RAIL_BATCH_ACTION_CHANNEL, async (event, request: DecisionsRailBatchActionRequest): Promise<DecisionsRailBatchActionResult> => {
    const rail = localRail(event.sender);
    const caller = threadCaller(request);
    const batchId = validBatchId(request.batchId);
    if (request.action !== "stop" && request.action !== "cancel") throw new Error("Invalid batch action");
    return await rail.operatorBatchAction(caller, batchId, request.action);
  });
  ipcMain.handle(DECISIONS_RAIL_OPEN_RESULTS_CHANNEL, async (event, request: DecisionsRailOpenResultsRequest): Promise<DecisionsRailOpenResultsResult> => {
    const rail = localRail(event.sender);
    const file = await rail.railResultsFile(threadCaller(request), validBatchId(request.batchId));
    if (!file) return { opened: false, error: "This batch has no results file." };
    // A .jsonl file often has no app registered for it; show it in its folder instead.
    if (await shell.openPath(file)) shell.showItemInFolder(file);
    return { opened: true };
  });
}

export function disposeDecisionsRailIpcHandlers(): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);
}

function localRail(sender: WebContents): OpenAIDecisionsRail {
  if (!isLocalMainWindowWebContents(sender)) throw new Error("Open decisions on the instance that owns this thread");
  const rail = getOpenAIDecisionsRail();
  if (!rail) throw new Error("Decisions are unavailable in this PwrAgent runtime");
  return rail;
}

function threadCaller(request: DecisionsRailThreadRequest | undefined): { backend: string; threadId: string } {
  if (
    !request
    || typeof request.backend !== "string"
    || !isAppServerBackendKind(request.backend)
    || typeof request.threadId !== "string"
    || request.threadId.trim().length === 0
    || request.threadId.length > 300
  ) {
    throw new Error("Choose a local thread");
  }
  return { backend: request.backend, threadId: request.threadId };
}

function validBatchId(value: unknown): string {
  if (typeof value !== "string" || !isDecisionBatchId(value)) throw new Error("Invalid batch id");
  return value;
}
