import { BrowserWindow, ipcMain } from "electron";
import type {
  AutomationIdRequest,
  DraftAutomationPromptRequest,
  DraftAutomationPromptResponse,
  GetAutomationRunArtifactRequest,
  GetAutomationRunArtifactResponse,
  ListAutomationCardsRequest,
  ListAutomationCardsResponse,
  ListAutomationLoadIssuesResponse,
  AutomationMutationResponse,
  CreateAutomationRequest,
  ListAutomationRunsRequest,
  ListAutomationRunsResponse,
  ListAutomationsRequest,
  ListAutomationsResponse,
  ListAutomationReplayCandidatesRequest,
  ListAutomationReplayCandidatesResponse,
  OpenAutomationRunWindowRequest,
  ReplayAutomationInboundRequest,
  RunAutomationNowResponse,
  SearchMessagingSendersRequest,
  SearchMessagingSendersResponse,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import {
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_DRAFT_PROMPT_CHANNEL,
  AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL,
  AUTOMATIONS_LIST_CARDS_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_LIST_RUNS_CHANNEL,
  AUTOMATIONS_LOAD_ISSUES_CHANNEL,
  AUTOMATIONS_ALLOCATE_WORKSPACE_CHANNEL,
  AUTOMATIONS_LIST_REPLAY_CANDIDATES_CHANNEL,
  AUTOMATIONS_REPLAY_INBOUND_CHANNEL,
  AUTOMATION_RUN_WINDOW_OPEN_CHANNEL,
  AUTOMATIONS_SEARCH_SENDERS_CHANNEL,
  AUTOMATIONS_PAUSE_CHANNEL,
  AUTOMATIONS_RESUME_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import {
  disposeDesktopAutomationService,
  getDesktopAutomationService,
} from "../automations/desktop-automation-service";
import { generateAutomationPromptDraft } from "../app-server/automation-prompt-draft-service";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { createScratchProjectDirectory } from "../app-server/scratch-projects";
import { showAutomationRunWindow } from "../automation-run-window";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";

export function registerAutomationIpcHandlers(): void {
  getDesktopAutomationService();

  ipcMain.removeHandler(AUTOMATIONS_LIST_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_LIST_CHANNEL,
    (_event, request?: ListAutomationsRequest): ListAutomationsResponse =>
      getDesktopAutomationService().list(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_LOAD_ISSUES_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_LOAD_ISSUES_CHANNEL,
    (): ListAutomationLoadIssuesResponse => ({
      issues: getDesktopAutomationService().getLoadIssues(),
    }),
  );

  ipcMain.removeHandler(AUTOMATIONS_CREATE_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_CREATE_CHANNEL,
    async (
      _event,
      request: CreateAutomationRequest,
    ): Promise<AutomationMutationResponse> =>
      await getDesktopAutomationService().create(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_UPDATE_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_UPDATE_CHANNEL,
    async (
      _event,
      request: UpdateAutomationRequest,
    ): Promise<AutomationMutationResponse> =>
      await getDesktopAutomationService().update(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_DELETE_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_DELETE_CHANNEL,
    async (
      _event,
      request: AutomationIdRequest,
    ): Promise<AutomationMutationResponse> =>
      await getDesktopAutomationService().delete(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_PAUSE_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_PAUSE_CHANNEL,
    async (
      _event,
      request: AutomationIdRequest,
    ): Promise<AutomationMutationResponse> =>
      await getDesktopAutomationService().pause(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_RESUME_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_RESUME_CHANNEL,
    async (
      _event,
      request: AutomationIdRequest,
    ): Promise<AutomationMutationResponse> =>
      await getDesktopAutomationService().resume(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_RUN_NOW_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_RUN_NOW_CHANNEL,
    async (
      _event,
      request: AutomationIdRequest,
    ): Promise<RunAutomationNowResponse> =>
      await getDesktopAutomationService().runNow(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_ALLOCATE_WORKSPACE_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_ALLOCATE_WORKSPACE_CHANNEL,
    // Allocates a fresh sandbox under the profile's Workspaces root
    // (~/.pwragent/profiles/<name>/projects) — the same allocator directory-less
    // threads use — so an automation gets a real cwd without touching a repo.
    async (): Promise<{ path: string }> => ({
      path: await createScratchProjectDirectory(),
    }),
  );

  ipcMain.removeHandler(AUTOMATIONS_LIST_REPLAY_CANDIDATES_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_LIST_REPLAY_CANDIDATES_CHANNEL,
    async (
      _event,
      request: ListAutomationReplayCandidatesRequest,
    ): Promise<ListAutomationReplayCandidatesResponse> =>
      getDesktopAutomationService().listReplayCandidates(request, {
        fetchRecent: (params) =>
          getDesktopMessagingRuntime().fetchRecentPreviewMessages(params),
        supportsHistory: (provider) =>
          getDesktopMessagingRuntime().supportsPreviewHistory(provider),
      }),
  );

  ipcMain.removeHandler(AUTOMATION_RUN_WINDOW_OPEN_CHANNEL);
  ipcMain.handle(
    AUTOMATION_RUN_WINDOW_OPEN_CHANNEL,
    async (
      event,
      request: OpenAutomationRunWindowRequest,
    ): Promise<{ opened: true }> => {
      showAutomationRunWindow(request, {
        sourceWindow: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      });
      return { opened: true };
    },
  );

  ipcMain.removeHandler(AUTOMATIONS_REPLAY_INBOUND_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_REPLAY_INBOUND_CHANNEL,
    async (
      _event,
      request: ReplayAutomationInboundRequest,
    ): Promise<RunAutomationNowResponse> =>
      getDesktopAutomationService().replayInbound(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_SEARCH_SENDERS_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_SEARCH_SENDERS_CHANNEL,
    async (
      _event,
      request: SearchMessagingSendersRequest,
    ): Promise<SearchMessagingSendersResponse> =>
      getDesktopAutomationService().searchSenders(request, {
        searchDirectory: (params) =>
          getDesktopMessagingRuntime().searchDirectoryActors(params),
      }),
  );

  ipcMain.removeHandler(AUTOMATIONS_LIST_RUNS_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_LIST_RUNS_CHANNEL,
    (_event, request: ListAutomationRunsRequest): ListAutomationRunsResponse =>
      getDesktopAutomationService().listRuns(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_LIST_CARDS_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_LIST_CARDS_CHANNEL,
    (_event, request: ListAutomationCardsRequest): ListAutomationCardsResponse =>
      getDesktopAutomationService().listCards(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL,
    async (
      _event,
      request: GetAutomationRunArtifactRequest,
    ): Promise<GetAutomationRunArtifactResponse> =>
      await getDesktopAutomationService().getRunArtifact(request),
  );

  ipcMain.removeHandler(AUTOMATIONS_DRAFT_PROMPT_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_DRAFT_PROMPT_CHANNEL,
    async (
      _event,
      request: DraftAutomationPromptRequest,
    ): Promise<DraftAutomationPromptResponse> => {
      const registry = getDesktopBackendRegistry();
      return await generateAutomationPromptDraft({
        description: request.description,
        generate: (req) => registry.generateStructuredObject(req),
      });
    },
  );
}

export function disposeAutomationIpcHandlers(): void {
  ipcMain.removeHandler(AUTOMATIONS_LIST_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_LOAD_ISSUES_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_CREATE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_UPDATE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_DELETE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_PAUSE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_RESUME_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_RUN_NOW_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_LIST_RUNS_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_LIST_CARDS_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_DRAFT_PROMPT_CHANNEL);
  disposeDesktopAutomationService();
}
