import type { NavigationDetailCollectionSource } from "./navigation-detail-projection";
import type {
  AppServerBackendScope, AppServerThreadSummary, MarkThreadSeenRequest, MarkThreadSeenResponse,
  NavigationDirectorySummary, NavigationThreadSummary, NavigationDetailCollectionName, NavigationSelectedDetailRequest, ThreadUsageLineRecord, ThreadPricingSummary, ThreadToolAccounting,
} from "@pwragent/shared";

/** Owner read/seen operations over canonical profile metadata. */
export interface OwnerNavigationStorage {
  initializeUnreadBaseline(threads: readonly NavigationThreadSummary[]): boolean;
  readIndex(params: { backend: AppServerBackendScope; threads: AppServerThreadSummary[]; workspaceRoots?: string[] }): {
    threads: NavigationThreadSummary[]; directories: NavigationDirectorySummary[];
  };
  projectSummary(params: { thread: AppServerThreadSummary }): NavigationThreadSummary;
  projectDetail(params: { thread: AppServerThreadSummary }): Promise<NavigationThreadSummary>;
  readCollectionSource(params: { ref: NavigationSelectedDetailRequest["ref"]; name: NavigationDetailCollectionName; thread: AppServerThreadSummary }): Promise<NavigationDetailCollectionSource>;
  readPricing(identity: { backend: "codex"; threadId: string }): Promise<{ lines: ThreadUsageLineRecord[]; summaries: ThreadPricingSummary[] }>;
  readToolAccounting(identity: { backend: "codex"; threadId: string }): Promise<ThreadToolAccounting>;
  markThreadSeen(params: MarkThreadSeenRequest): Promise<MarkThreadSeenResponse>;
}
