import { ipcMain, shell } from "electron";
import { type ResearchThread, type ResearchSnapshotRequest, type ResearchChangesRequest, type ResearchUpdateReceipt, type ResearchEventsRequest, type ResearchUpdateRequest, type ResearchEvidenceRequest, type PrepareResearchRequest, type ResearchSearchRequest, type ResearchItemReadRequest, type ResearchWorkRequest } from "@pwragent/shared";
import { RESEARCH_SNAPSHOT_CHANNEL, RESEARCH_UPDATE_CHANNEL, RESEARCH_OPEN_EVIDENCE_CHANNEL, RESEARCH_PREPARE_CHANNEL, RESEARCH_SEARCH_CHANNEL, RESEARCH_ITEM_CHANNEL, RESEARCH_WORK_CHANNEL, RESEARCH_WITHDRAW_CHANNEL, RESEARCH_EVENTS_CHANNEL, RESEARCH_CHANGES_CHANNEL } from "../../../shared/ipc";
import { getResearchService } from "../../research/research-runtime";
import { resolveResearchEvidencePath } from "../../research/research-evidence-path";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { isLocalMainWindowWebContents } from "../window-channels";
import { getDesktopSettingsService } from "../../settings/desktop-settings-singleton";

/** Native research is local-owner only. A federation viewer cannot read or mutate this profile. */
export function registerResearchIpcHandlers(): void {
  disposeResearchIpcHandlers();
  ipcMain.handle(RESEARCH_SEARCH_CHANNEL, (event, request: ResearchSearchRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    return getResearchService().search(request.runId, request.query, { backend: request.backend, threadId: request.threadId, kind: "operator" });
  });
  ipcMain.handle(RESEARCH_ITEM_CHANNEL, (event, request: ResearchItemReadRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    return getResearchService().readItem(request.runId, request.itemId, { backend: request.backend, threadId: request.threadId, kind: "operator" });
  });
  ipcMain.handle(RESEARCH_WORK_CHANNEL, async (event, request: ResearchWorkRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (!request.command || request.command.action !== "work") throw new Error("Supply an item work command");
    const actor = { backend: request.backend, threadId: request.threadId, kind: "operator" } as const;
    await getResearchService().work(request.runId, `operator:${request.requestId}`, request.command, actor);
    return getResearchService().readItem(request.runId, request.command.itemId, actor);
  });
  ipcMain.handle(RESEARCH_PREPARE_CHANNEL, (event, request: PrepareResearchRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    return getResearchService().prepare(request);
  });
  ipcMain.handle(RESEARCH_WITHDRAW_CHANNEL, (event, request: ResearchThread) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    getResearchService().withdraw(request);
  });
  ipcMain.handle(RESEARCH_SNAPSHOT_CHANNEL, (event, request: ResearchSnapshotRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (request.runId !== undefined && (typeof request.runId !== "string" || request.runId.length > 300)) throw new Error("Invalid research run");
    return getResearchService().snapshot({ backend: request.backend, threadId: request.threadId, ...(request.runId ? { runId: request.runId } : {}) });
  });
  ipcMain.handle(RESEARCH_CHANGES_CHANNEL, (event, request: ResearchChangesRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (typeof request.runId !== "string" || request.runId.length > 300) throw new Error("Invalid research run");
    return getResearchService().changes(request.runId, request.sinceRevision, request.after, { backend: request.backend, threadId: request.threadId, kind: "operator" });
  });
  ipcMain.handle(RESEARCH_EVENTS_CHANNEL, (event, request: ResearchEventsRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (typeof request.runId !== "string" || !request.range || typeof request.range !== "object") throw new Error("Invalid research activity range");
    const { beforeSeq, afterSeq, limit } = request.range;
    return getResearchService().readEvents(request.runId, { beforeSeq, afterSeq, limit }, { backend: request.backend, threadId: request.threadId, kind: "operator" });
  });
  ipcMain.handle(RESEARCH_UPDATE_CHANNEL, async (event, request: ResearchUpdateRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (typeof request.runId !== "string" || typeof request.requestId !== "string" || !request.command || typeof request.command !== "object") throw new Error("Invalid research update");
    // A receipt only: the items the command changed reach the window by delta.
    const key = `operator:${request.requestId}`;
    const run = await getResearchService().update(request.runId, key, request.command, { backend: request.backend, threadId: request.threadId, kind: "operator" });
    const { delivery } = getResearchService().receipt(run.id, key, request.command);
    const receipt: ResearchUpdateReceipt = { runId: run.id, revision: run.revision, status: run.status, ...(delivery ? { delivery } : {}) };
    return receipt;
  });
  ipcMain.handle(RESEARCH_OPEN_EVIDENCE_CHANNEL, async (event, request: ResearchEvidenceRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (typeof request.runId !== "string" || typeof request.itemId !== "string" || !Number.isSafeInteger(request.pathIndex) || request.pathIndex < 0) throw new Error("Invalid evidence reference");
    const { relativePath, source } = getResearchService().readEvidence(request.runId, request.itemId, request.pathIndex, { backend: request.backend, threadId: request.threadId, kind: "operator" });
    const cwd = await getDesktopBackendRegistry().resolveThreadWorkspaceCwd(source.backend, source.threadId);
    if (!cwd) throw new Error("The worker workspace is unavailable");
    const resolved = await resolveResearchEvidencePath(cwd, relativePath);
    const error = await shell.openPath(resolved);
    return { opened: !error, ...(error ? { error } : {}) };
  });
}
export function disposeResearchIpcHandlers(): void {
  for (const channel of [RESEARCH_CHANGES_CHANNEL, RESEARCH_SNAPSHOT_CHANNEL, RESEARCH_UPDATE_CHANNEL, RESEARCH_OPEN_EVIDENCE_CHANNEL, RESEARCH_PREPARE_CHANNEL, RESEARCH_SEARCH_CHANNEL, RESEARCH_ITEM_CHANNEL, RESEARCH_WORK_CHANNEL, RESEARCH_WITHDRAW_CHANNEL, RESEARCH_EVENTS_CHANNEL]) ipcMain.removeHandler(channel);
}
function validateThread(request: ResearchThread): void {
  if (getDesktopSettingsService().resolveResearchEnabled?.() !== true) throw new Error("Research runs are disabled. Enable Research runs in Settings → Experimental with Codex Tool Discovery.");
  if (!request || request.backend !== "codex" || typeof request.threadId !== "string" || !request.threadId.trim()) throw new Error("Choose a local Codex thread");
}
