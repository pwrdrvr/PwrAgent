import type {
  AgentEvent,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  GetNavigationSnapshotRequest,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MarkThreadSeenRequest,
  NavigationSnapshot,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse
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
  getNavigationSnapshot?: (
    request?: GetNavigationSnapshotRequest
  ) => Promise<NavigationSnapshot>;
  listBackends?: (
    request?: ListBackendsRequest
  ) => Promise<ListBackendsResponse>;
  markThreadSeen?: (request: MarkThreadSeenRequest) => Promise<unknown>;
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
