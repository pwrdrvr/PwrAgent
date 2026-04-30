import { useEffect, useState } from "react";
import type { RendererErrorReport } from "../../../shared/renderer-error";
import type { RendererDiagnosticLogRequest } from "../../../shared/renderer-diagnostic";
import type {
  ImageUploadFallbackRequest,
  ImageUploadFallbackResponse,
  ImageUploadNormalizationLogRequest,
} from "../../../shared/image-normalization";
import type {
  AgentEvent,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  MarkThreadSeenRequest,
  NavigationSnapshot,
  ResetDirectoryLaunchpadRequest,
  ResetDirectoryLaunchpadResponse,
  RetainThreadBranchDriftRequest,
  RetainThreadBranchDriftResponse,
  RenameThreadRequest,
  RenameThreadResponse,
  RestoreWorktreeRequest,
  RestoreWorktreeResponse,
  RestoreThreadRequest,
  RestoreThreadResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
  UpdateThreadExpectedBranchRequest,
  UpdateThreadExpectedBranchResponse,
} from "@pwragnt/shared";
import type { RuntimeIdentity } from "../../../shared/runtime-identity";

export type DesktopApi = {
  copyText?: (text: string) => Promise<void>;
  getRuntimeIdentity?: () => Promise<RuntimeIdentity>;
  ping?: () => string;
  listSkills?: (
    request?: AppServerListSkillsRequest
  ) => Promise<AppServerListSkillsResponse>;
  analyzeFocusedDiff?: (
    request: FocusedDiffAnalysisRequest
  ) => Promise<FocusedDiffAnalysisResponse>;
  readThread?: (
    request: AppServerReadThreadRequest
  ) => Promise<AppServerReadThreadResponse>;
  archiveThread?: (
    request: ArchiveThreadRequest
  ) => Promise<ArchiveThreadResponse>;
  restoreThread?: (
    request: RestoreThreadRequest
  ) => Promise<RestoreThreadResponse>;
  archiveWorktree?: (
    request: ArchiveWorktreeRequest
  ) => Promise<ArchiveWorktreeResponse>;
  restoreWorktree?: (
    request: RestoreWorktreeRequest
  ) => Promise<RestoreWorktreeResponse>;
  handoffThreadWorkspace?: (
    request: HandoffThreadWorkspaceRequest
  ) => Promise<HandoffThreadWorkspaceResponse>;
  renameThread?: (
    request: RenameThreadRequest
  ) => Promise<RenameThreadResponse>;
  startThread?: (request: StartThreadRequest) => Promise<StartThreadResponse>;
  startReview?: (request: StartReviewRequest) => Promise<StartReviewResponse>;
  startTurn?: (request: StartTurnRequest) => Promise<StartTurnResponse>;
  interruptTurn?: (
    request: InterruptTurnRequest
  ) => Promise<InterruptTurnResponse>;
  steerTurn?: (request: SteerTurnRequest) => Promise<SteerTurnResponse>;
  setThreadExecutionMode?: (
    request: SetThreadExecutionModeRequest
  ) => Promise<SetThreadExecutionModeResponse>;
  setThreadModelSettings?: (
    request: SetThreadModelSettingsRequest
  ) => Promise<SetThreadModelSettingsResponse>;
  checkThreadBranchDrift?: (
    request: CheckThreadBranchDriftRequest
  ) => Promise<CheckThreadBranchDriftResponse>;
  updateThreadExpectedBranch?: (
    request: UpdateThreadExpectedBranchRequest
  ) => Promise<UpdateThreadExpectedBranchResponse>;
  retainThreadBranchDrift?: (
    request: RetainThreadBranchDriftRequest
  ) => Promise<RetainThreadBranchDriftResponse>;
  materializeDirectoryLaunchpad?: (
    request: MaterializeDirectoryLaunchpadRequest
  ) => Promise<MaterializeDirectoryLaunchpadResponse>;
  submitServerRequest?: (
    request: SubmitServerRequestRequest
  ) => Promise<SubmitServerRequestResponse>;
  getNavigationSnapshot?: (
    request?: GetNavigationSnapshotRequest
  ) => Promise<NavigationSnapshot>;
  listBackends?: (
    request?: ListBackendsRequest
  ) => Promise<ListBackendsResponse>;
  listThreads?: (
    request?: AppServerListThreadsRequest
  ) => Promise<AppServerListThreadsResponse>;
  markThreadSeen?: (request: MarkThreadSeenRequest) => Promise<unknown>;
  ensureDirectoryLaunchpad?: (
    request: EnsureDirectoryLaunchpadRequest
  ) => Promise<EnsureDirectoryLaunchpadResponse>;
  updateDirectoryLaunchpad?: (
    request: UpdateDirectoryLaunchpadRequest
  ) => Promise<UpdateDirectoryLaunchpadResponse>;
  resetDirectoryLaunchpad?: (
    request: ResetDirectoryLaunchpadRequest
  ) => Promise<ResetDirectoryLaunchpadResponse>;
  normalizeImageForUpload?: (
    request: ImageUploadFallbackRequest
  ) => Promise<ImageUploadFallbackResponse>;
  recordImageUploadNormalization?: (
    request: ImageUploadNormalizationLogRequest
  ) => Promise<void>;
  logRendererDiagnostic?: (request: RendererDiagnosticLogRequest) => Promise<void>;
  reportRendererError?: (report: RendererErrorReport) => Promise<void>;
  onAgentEvent?: (callback: (event: AgentEvent) => void) => () => void;
  onWindowFocus?: (callback: () => void) => () => void;
  platform?: string;
  versions?: {
    chrome?: string;
    electron?: string;
    node?: string;
  };
};

export function getDesktopApi(): DesktopApi | undefined {
  return (window as Window & { pwragnt?: DesktopApi }).pwragnt;
}

export function useDesktopApi(): DesktopApi | undefined {
  const [desktopApi, setDesktopApi] = useState<DesktopApi | undefined>(() =>
    getDesktopApi()
  );

  useEffect(() => {
    if (desktopApi) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const refresh = (): void => {
      const nextDesktopApi = getDesktopApi();
      if (nextDesktopApi) {
        setDesktopApi(nextDesktopApi);
        return;
      }

      if (!cancelled) {
        timeoutId = setTimeout(refresh, 16);
      }
    };

    refresh();

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [desktopApi]);

  return desktopApi;
}
