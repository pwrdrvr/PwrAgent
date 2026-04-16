import type {
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  GetNavigationSnapshotRequest,
  ListBackendsRequest,
  ListBackendsResponse,
  MarkThreadSeenRequest,
  NavigationSnapshot
} from "@pwragnt/shared";

export type DesktopApi = {
  ping?: () => string;
  readThread?: (
    request: AppServerReadThreadRequest
  ) => Promise<AppServerReadThreadResponse>;
  getNavigationSnapshot?: (
    request?: GetNavigationSnapshotRequest
  ) => Promise<NavigationSnapshot>;
  listBackends?: (
    request?: ListBackendsRequest
  ) => Promise<ListBackendsResponse>;
  markThreadSeen?: (request: MarkThreadSeenRequest) => Promise<unknown>;
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
