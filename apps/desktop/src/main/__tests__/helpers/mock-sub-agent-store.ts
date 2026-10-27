import {
  CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS,
  isThreadSubAgentVisibleInPanel,
  MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
  subAgentLens,
  totalTokenMiserGateAccountings,
  type AppServerBackendKind,
  type AppServerThreadActivityEntry,
  type SubAgentLens,
  type ThreadOverlayState,
  type ThreadSubAgentSummary,
} from "@pwragent/shared";
import type { OverlayStoreLike } from "../../state/overlay-store-sqlite";
import { TOKEN_MISER_MONITOR_ID_PREFIX } from "../../state/thread-sub-agents";

/**
 * The overlay record a mock store keeps. The real store holds sub-agent cards
 * in `thread_sub_agents` and usage activities in `thread_usage_activities`;
 * mocks keep both on the record so a test can seed and assert them in one
 * place. Production code never sees these fields.
 */
export type MockOverlayState = ThreadOverlayState & {
  subAgents?: ThreadSubAgentSummary[];
  immutableUsageActivities?: AppServerThreadActivityEntry[];
};

/** A mock store whose overlay reads expose the cards kept on the record. */
export type MockOverlayStore = Omit<OverlayStoreLike, "getThreadOverlayState"> & {
  getThreadOverlayState(
    params: Parameters<OverlayStoreLike["getThreadOverlayState"]>[0],
  ): Promise<MockOverlayState | undefined>;
};

type ReadOverlay = (
  backend: AppServerBackendKind,
  threadId: string,
) => MockOverlayState | undefined;

/**
 * The store's keyed sub-agent reads over a mock's overlay records, with the
 * same filters and order as `ThreadSubAgentTable`: newest first, Token Miser
 * gates by monitor id prefix, and "active" as unfinished or failed.
 */
export function mockSubAgentReads(read: ReadOverlay) {
  const cards = (backend: AppServerBackendKind, threadId: string) =>
    [...(read(backend, threadId)?.subAgents ?? [])].sort(
      (left, right) =>
        right.createdAt - left.createdAt
        // SQLite's BINARY collation, as `ORDER BY monitor_id` uses.
        || (left.monitorId < right.monitorId ? -1 : left.monitorId > right.monitorId ? 1 : 0),
    );
  // The panel's retention window, from its `visibleSince` cutoff.
  const visibleCards = (params: {
    backend: AppServerBackendKind;
    threadId: string;
    visibleSince: number;
    excludeMonitorIds?: readonly string[];
  }) =>
    cards(params.backend, params.threadId).filter((card) =>
      !params.excludeMonitorIds?.includes(card.monitorId)
      && isThreadSubAgentVisibleInPanel(card, params.visibleSince + CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS));
  return {
    getThreadSubAgent: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      monitorId: string;
    }) =>
      read(params.backend, params.threadId)?.subAgents?.find(
        (card) => card.monitorId === params.monitorId,
      ),
    listThreadSubAgents: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      excludeTokenMiser?: boolean;
    }) =>
      cards(params.backend, params.threadId).filter(
        (card) =>
          !params.excludeTokenMiser
          || !card.monitorId.startsWith(TOKEN_MISER_MONITOR_ID_PREFIX),
      ),
    listThreadSubAgentsByMonitorIdPrefix: async (params: {
      backend: AppServerBackendKind;
      threadIds: readonly string[];
      monitorIdPrefix: string;
    }) => {
      const result: Record<string, ThreadSubAgentSummary[]> = {};
      for (const threadId of new Set(params.threadIds)) {
        const found = cards(params.backend, threadId).filter((card) =>
          card.monitorId.startsWith(params.monitorIdPrefix));
        if (found.length > 0) result[threadId] = found;
      }
      return result;
    },
    listActiveThreadSubAgents: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
    }) =>
      cards(params.backend, params.threadId).filter(
        (card) =>
          card.completedAt === undefined
          || card.status === "failed"
          || card.status === "failure",
      ),
    getThreadSubAgents: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      monitorIds: readonly string[];
    }) =>
      cards(params.backend, params.threadId).filter((card) =>
        params.monitorIds.includes(card.monitorId)),
    readThreadSubAgentLensCounts: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      visibleSince: number;
      excludeMonitorIds?: readonly string[];
    }) => {
      const counts: Record<SubAgentLens, number> = { harness: 0, "token-miser": 0, pwragent: 0 };
      for (const card of visibleCards(params)) counts[subAgentLens(card)] += 1;
      return counts;
    },
    listThreadSubAgentLensPage: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      lens: SubAgentLens;
      visibleSince: number;
      excludeMonitorIds?: readonly string[];
      offset: number;
      limit: number;
    }) =>
      visibleCards(params)
        .filter((card) => subAgentLens(card) === params.lens)
        .slice(params.offset, params.offset + params.limit),
    listThreadSubAgentPage: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      excludeMonitorIds?: readonly string[];
      offset: number;
      limit: number;
    }) =>
      cards(params.backend, params.threadId)
        .filter((card) => !params.excludeMonitorIds?.includes(card.monitorId))
        .slice(params.offset, params.offset + params.limit),
    readThreadTokenMiserGateTotals: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
    }) =>
      totalTokenMiserGateAccountings(
        cards(params.backend, params.threadId)
          .filter((card) => card.monitorId.startsWith(TOKEN_MISER_MONITOR_ID_PREFIX))
          .map((card) => card.tokenMiserAccounting),
      ),
    readThreadSubAgentRevision: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
    }) => {
      const current = cards(params.backend, params.threadId);
      // Any content change moves it, as a write moves the real counter.
      let revision = 0;
      for (const char of JSON.stringify(current)) {
        revision = (revision * 31 + char.charCodeAt(0)) >>> 0;
      }
      return { count: current.length, revision };
    },
  };
}

/**
 * The store's usage-activity reads over a mock's overlay records, with the
 * same window as `ThreadUsageActivityTable`: the newest 100, oldest first.
 */
export function mockUsageActivityReads(read: ReadOverlay) {
  const retained = (backend: AppServerBackendKind, threadId: string) =>
    (read(backend, threadId)?.immutableUsageActivities ?? []).slice(-MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES);
  return {
    readThreadUsageActivities: async (params: {
      backend: AppServerBackendKind;
      threadIds: string[];
    }) => {
      const result: Record<string, AppServerThreadActivityEntry[]> = {};
      for (const threadId of new Set(params.threadIds)) {
        const activities = retained(params.backend, threadId);
        if (activities.length > 0) result[threadId] = activities;
      }
      return result;
    },
    readThreadUsageActivityForTurn: async (params: {
      backend: AppServerBackendKind;
      threadId: string;
      turnId: string;
    }) => retained(params.backend, params.threadId).find((activity) => activity.turn?.id === params.turnId),
  };
}
