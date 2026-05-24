import { ipcMain } from "electron";
import type {
  AutomationIdRequest,
  GetAutomationRunArtifactRequest,
  GetAutomationRunArtifactResponse,
  ListAutomationCardsRequest,
  ListAutomationCardsResponse,
  AutomationMutationResponse,
  CreateAutomationRequest,
  ListAutomationRunsRequest,
  ListAutomationRunsResponse,
  ListAutomationsRequest,
  ListAutomationsResponse,
  RunAutomationNowResponse,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import {
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL,
  AUTOMATIONS_LIST_CARDS_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_LIST_RUNS_CHANNEL,
  AUTOMATIONS_PAUSE_CHANNEL,
  AUTOMATIONS_RESUME_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import {
  disposeDesktopAutomationService,
  getDesktopAutomationService,
} from "../automations/desktop-automation-service";

export function registerAutomationIpcHandlers(): void {
  getDesktopAutomationService();

  ipcMain.removeHandler(AUTOMATIONS_LIST_CHANNEL);
  ipcMain.handle(
    AUTOMATIONS_LIST_CHANNEL,
    (_event, request?: ListAutomationsRequest): ListAutomationsResponse =>
      getDesktopAutomationService().list(request),
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
}

export function disposeAutomationIpcHandlers(): void {
  ipcMain.removeHandler(AUTOMATIONS_LIST_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_CREATE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_UPDATE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_DELETE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_PAUSE_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_RESUME_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_RUN_NOW_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_LIST_RUNS_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_LIST_CARDS_CHANNEL);
  ipcMain.removeHandler(AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL);
  disposeDesktopAutomationService();
}
