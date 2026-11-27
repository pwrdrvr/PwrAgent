import { vi } from "vitest";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import { NavigationDirectoryScope } from "@pwragent/owner-core/navigation-directory-scope";
import * as navigation from "../app-server/navigation-query-source";

const mocks = vi.hoisted(() => ({
  profileStore: undefined,
  store: {
    readNavigationPullRequests: vi.fn(() => []),
    readNavigationSourceVersion: vi.fn(() => "unchanged"),
    getThreadPrAutoDispatchPending: vi.fn(async () => undefined),
    readNavigationQueryIndex: vi.fn(),
    readNavigationQueryThreads: vi.fn(),
    readNavigationQueryDirectories: (threads) => ({ directories: buildDirectorySummaries({ threads }) }),
    readDirectoryGitStatusCache: vi.fn(async () => ({})),
    listAllActivePrStatusWatches: vi.fn(async () => []),
  },
}));

vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.profileStore ?? mocks.store }));
vi.mock("../messaging/desktop-messaging-store", () => ({
  getDesktopMessagingStore: () => ({
    findActiveBindings: async () => [],
    findActiveBindingsForThread: async () => [],
  }),
}));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));

export function fixtureStores() {
  return mocks;
}

export function createSource(threads) {
  const listeners = new Set();
  const discovered = Promise.withResolvers<void>();
  const listThreads = vi.fn(async () => threads);
  const registry = {
    listThreads,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async publishLocalEvent(event) {
      if (event.notification.method === "navigation/invalidated") discovered.resolve();
    },
    withNavigationPrimaryGitRepositories: (rows) => rows,
    hydrateThreadGitWorkingStates: async (rows) => rows,
    withNavigationSubAgentActivity: (rows) => rows,
    getNavigationInputRequestThreadKeys: () => new Set(),
    rememberNavigationVisibilityIndex: vi.fn(),
    navigationDirectoryScope: new NavigationDirectoryScope(),
    getStartupProviderRefreshStatus: () => ({ state: "ready" }),
    isIncompleteThreadList: () => false,
    canonicalizeNavigationPullRequests: async (prs) => prs,
    getCachedNavigationThread: ({ backend, threadId }) =>
      threads.find((row) => row.source === backend && row.id === threadId),
  };
  // The 1.5 releases predate the sidebar-specific owner entry point.
  const load = process.env.AUDIT_LEGACY_OWNER === "1"
    ? navigation.loadLocalNavigationQueryIndex : navigation.loadSidebarNavigationQueryIndex;
  return {
    listThreads,
    loadIndex: () => load({ registry, callerReason: "renderer-navigation-query", includeStacks: true }),
    emit(backend, method, params) {
      for (const listener of listeners) listener({ backend, notification: { method, params } });
    },
    async waitForDiscovery() {
      if (process.env.AUDIT_LIVE_INDEX === "1") await discovered.promise;
    },
  };
}
