import { ipcMain, shell } from "electron";
import type { ResearchThread, ResearchUpdateRequest, ResearchEvidenceRequest, PrepareResearchRequest } from "@pwragent/shared";
import { RESEARCH_SNAPSHOT_CHANNEL, RESEARCH_UPDATE_CHANNEL, RESEARCH_OPEN_EVIDENCE_CHANNEL, RESEARCH_PREPARE_CHANNEL } from "../../../shared/ipc";
import { getResearchService } from "../../research/research-runtime";
import { resolveResearchEvidencePath } from "../../research/research-evidence-path";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { isLocalMainWindowWebContents } from "../window-channels";

/** Native research is local-owner only. A federation viewer cannot read or mutate this profile. */
export function registerResearchIpcHandlers(): void {
  disposeResearchIpcHandlers();
  ipcMain.handle(RESEARCH_PREPARE_CHANNEL, (event, request: PrepareResearchRequest) => {
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open research on its owning instance");
    validateThread(request);
    return getResearchService().prepare(request);
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
  for (const channel of [RESEARCH_SNAPSHOT_CHANNEL, RESEARCH_UPDATE_CHANNEL, RESEARCH_OPEN_EVIDENCE_CHANNEL, RESEARCH_PREPARE_CHANNEL]) ipcMain.removeHandler(channel);
}
function validateThread(request: ResearchThread): void {
  if (!request || request.backend !== "codex" || typeof request.threadId !== "string" || !request.threadId.trim()) throw new Error("Choose a local Codex thread");
}
