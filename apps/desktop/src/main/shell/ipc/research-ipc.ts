import { ipcMain, shell } from "electron";
import type { ResearchThread, ResearchUpdateRequest, ResearchEvidenceRequest, PrepareResearchRequest, ResearchSearchRequest, ResearchItemReadRequest, ResearchWorkRequest } from "@pwragent/shared";
import { RESEARCH_SNAPSHOT_CHANNEL, RESEARCH_UPDATE_CHANNEL, RESEARCH_OPEN_EVIDENCE_CHANNEL, RESEARCH_PREPARE_CHANNEL, RESEARCH_SEARCH_CHANNEL, RESEARCH_ITEM_CHANNEL, RESEARCH_WORK_CHANNEL, RESEARCH_WITHDRAW_CHANNEL } from "../../../shared/ipc";
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
  ipcMain.handle(RESEARCH_SNAPSHOT_CHANNEL, (event, request: ResearchThread) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    return getResearchService().snapshot(request);
  });
  ipcMain.handle(RESEARCH_UPDATE_CHANNEL, async (event, request: ResearchUpdateRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (typeof request.runId !== "string" || typeof request.requestId !== "string" || !request.command || typeof request.command !== "object") throw new Error("Invalid research update");
    return await getResearchService().update(request.runId, `operator:${request.requestId}`, request.command, { backend: request.backend, threadId: request.threadId, kind: "operator" });
  });
  ipcMain.handle(RESEARCH_OPEN_EVIDENCE_CHANNEL, async (event, request: ResearchEvidenceRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    if (!Number.isSafeInteger(request.pathIndex) || request.pathIndex < 0) throw new Error("Invalid evidence reference");
    const run = getResearchService().read(request.runId, { ...request, kind: "operator" });
    const item = [...run.findings, ...run.submissions].find((entry) => entry.id === request.itemId);
    const relativePath = item?.paths[request.pathIndex];
    const source = run.events.find((entry) => (entry.data.type === "finding" && entry.data.finding.id === request.itemId)
      || (entry.data.type === "submission" && entry.data.submission.id === request.itemId))?.actor;
    if (!relativePath || !source) throw new Error("Evidence source is unavailable");
    const cwd = await getDesktopBackendRegistry().resolveThreadWorkspaceCwd(source.backend, source.threadId);
    if (!cwd) throw new Error("The worker workspace is unavailable");
    const resolved = await resolveResearchEvidencePath(cwd, relativePath);
    const error = await shell.openPath(resolved);
    return { opened: !error, ...(error ? { error } : {}) };
  });
}
export function disposeResearchIpcHandlers(): void {
  for (const channel of [RESEARCH_SNAPSHOT_CHANNEL, RESEARCH_UPDATE_CHANNEL, RESEARCH_OPEN_EVIDENCE_CHANNEL, RESEARCH_PREPARE_CHANNEL, RESEARCH_SEARCH_CHANNEL, RESEARCH_ITEM_CHANNEL, RESEARCH_WORK_CHANNEL, RESEARCH_WITHDRAW_CHANNEL]) ipcMain.removeHandler(channel);
}
function validateThread(request: ResearchThread): void {
  if (getDesktopSettingsService().resolveResearchEnabled?.() !== true) throw new Error("Research runs are disabled. Enable Research runs in Settings → Experimental with Codex Tool Discovery.");
  if (!request || request.backend !== "codex" || typeof request.threadId !== "string" || !request.threadId.trim()) throw new Error("Choose a local Codex thread");
}
