import { vi } from "vitest";
import type { FederationTarget, NavigationSnapshot } from "@pwragent/shared";
import { NavigationQueryStore } from "../../app-server/navigation-query-store";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";

/** Private fixture population; production callers receive only typed V2 resources. */
export function boundedMessagingNavigation(load: (target?: FederationTarget) => NavigationSnapshot | Promise<NavigationSnapshot>) {
  const store = new NavigationQueryStore();
  const ownerOf = (thread: NavigationSnapshot["threads"][number]) => thread.federation?.ref.target.scope === "remote"
    ? thread.federation.ref.target.instanceId : undefined;
  return {
    getNavigationQueryPage: vi.fn<NonNullable<MessagingBackendBridge["getNavigationQueryPage"]>>(async (request) => {
      const population = await load(request.federationTarget);
      const owner = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : undefined;
      return await store.readPage({ request, scopeKey: `messaging-fixture:${owner ?? "local"}`, loadIndex: async () => ({
        threads: population.threads.filter((thread) => ownerOf(thread) === owner), directories: population.directories,
      }) });
    }),
    getNavigationSelectedDetail: vi.fn<NonNullable<MessagingBackendBridge["getNavigationSelectedDetail"]>>(async (request) => {
      const population = await load(request.federationTarget);
      const thread = population.threads.find((candidate) => candidate.source === request.ref.backend
        && candidate.id === request.ref.threadId && ownerOf(candidate) === request.ref.ownerInstanceId);
      return { protocol: 2, ref: request.ref, revision: "fixture", readiness: "ready", identity: thread ? "present" : "unresolved", thread,
        ...(request.includeWorkspaceConfiguration ? { workspaceDirectories: population.directories.filter((directory) =>
          thread?.linkedDirectories.some((linked) => linked.path === directory.path)) } : {}) };
    }),
    getNavigationLaunchpadConfig: vi.fn<NonNullable<MessagingBackendBridge["getNavigationLaunchpadConfig"]>>(async (request) => {
      const population = await load(request.federationTarget);
      const directory = population.directories.find((candidate) => candidate.key === request.directoryKey);
      return { protocol: 2, revision: "fixture", directoryKey: request.directoryKey,
        defaults: population.launchpadDefaults, launchpad: directory?.launchpad, directoryGitStatus: directory?.gitStatus };
    }),
  };
}
