import type {
  AgentEvent,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  GetNavigationSnapshotRequest,
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
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
} from "@pwragnt/shared";

export type DesktopApi = {
  copyText?: (text: string) => Promise<void>;
  ping?: () => string;
  listSkills?: (
    request?: AppServerListSkillsRequest
  ) => Promise<AppServerListSkillsResponse>;
  readThread?: (
    request: AppServerReadThreadRequest
  ) => Promise<AppServerReadThreadResponse>;
  startThread?: (request: StartThreadRequest) => Promise<StartThreadResponse>;
  startTurn?: (request: StartTurnRequest) => Promise<StartTurnResponse>;
  interruptTurn?: (
    request: InterruptTurnRequest
  ) => Promise<InterruptTurnResponse>;
  setThreadExecutionMode?: (
    request: SetThreadExecutionModeRequest
  ) => Promise<SetThreadExecutionModeResponse>;
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
