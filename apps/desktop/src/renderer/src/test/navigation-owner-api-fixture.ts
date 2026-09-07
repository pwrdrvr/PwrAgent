import { threadSummaryIdentityKey, federationTargetsEqual } from "../lib/federated-thread-events";
import { federatedThreadIdentityKey } from "@pwragent/shared";
import { applyNavigationSnapshotTransportResponse, buildThreadIdentityKey,
  type AgentEvent, type NavigationLaunchpadDraft, type NavigationSnapshot, type NavigationSnapshotTransportState } from "@pwragent/shared";
import type { DesktopApi } from "../lib/desktop-api";
import { navigationQueryFixture } from "./navigation-query-fixture";

/** Complete test data readers; these are never exposed as renderer transport endpoints. */
export type NavigationOwnerFixtureApi = DesktopApi & {
  readPopulation?: DesktopApi["getNavigationSnapshot"];
  readPopulationTransport?: DesktopApi["getNavigationSnapshotTransport"];
};

/** Reuses historical complete test populations while presenting only the V2 owner API to the hook. */
export function navigationOwnerApiFixture(source: NavigationOwnerFixtureApi, onLocalLaunchpads?: (launchpads: NavigationLaunchpadDraft[]) => void): DesktopApi {
  let population: NavigationSnapshot | undefined;
  let pending: Promise<NavigationSnapshot> | undefined;
  let transport: NavigationSnapshotTransportState | undefined;
  const seen = new Map<string, number | undefined>();
  const listeners = new Set<(event: AgentEvent) => void>();
  let unsubscribeSource: (() => void) | undefined;
  const read = (refresh = false): Promise<NavigationSnapshot> => {
    if (pending) return pending;
    if (population && !refresh) return Promise.resolve(population);
    pending = (async () => {
      if (source.readPopulationTransport) {
        const value = await source.readPopulationTransport({ transport: { protocol: 1, baseRevision: transport?.revision } });
        transport = applyNavigationSnapshotTransportResponse(transport, value);
        population = transport?.snapshot;
      } else if (source.readPopulation) population = await source.readPopulation({});
      if (!population) throw new Error("Owner fixture has no complete population.");
      // Local fixture data also represents the viewer's historical draft store.
      // Remote owner populations must never seed the viewer's unsent input.
      if (!population.federationTarget || population.federationTarget.scope === "local") {
        onLocalLaunchpads?.(population.directories.flatMap((directory) => directory.launchpad ? [directory.launchpad] : []));
      }
      return population;
    })();
    const active = pending;
    void active.then(() => { if (pending === active) pending = undefined; }, () => { if (pending === active) pending = undefined; });
    return active;
  };
  const withSeen = (value: NavigationSnapshot): NavigationSnapshot => ({ ...value, threads: value.threads.map((thread) => {
    const key = threadSummaryIdentityKey(thread);
    if (!seen.has(key)) return thread;
    const watermark = seen.get(key);
    return { ...thread, inbox: { ...thread.inbox, inInbox: watermark !== undefined && (thread.updatedAt ?? 0) > watermark,
      lastSeenUpdatedAt: watermark } };
  }) });
  const { readPopulation: _read, readPopulationTransport: _transport, ...api } = source;
  return {
    ...api,
    onAgentEvent: (listener) => {
      listeners.add(listener);
      if (!unsubscribeSource) unsubscribeSource = api.onAgentEvent?.((event) => {
        for (const subscriber of listeners) subscriber(event);
      });
      return () => { listeners.delete(listener); if (!listeners.size) { unsubscribeSource?.(); unsubscribeSource = undefined; } };
    },
    getNavigationSnapshot: async () => { throw new Error("Legacy snapshot reads are forbidden in this fixture."); },
    getNavigationSnapshotTransport: async () => { throw new Error("Legacy snapshot transport is forbidden in this fixture."); },
    getNavigationQueryPage: api.getNavigationQueryPage ?? (async (request) => {
      const value = withSeen(await read(request.query.kind === "directory-index" && !request.query.keys && !request.cursor));
      const page = navigationQueryFixture(request, value);
      return { ...page, coverage: value.providerRefresh?.state === "checking" ? { state: "checking" }
        : value.providerRefresh?.state === "degraded" ? { state: "degraded" } : { state: "complete" } };
    }),
    releaseNavigationQuery: api.releaseNavigationQuery ?? (async () => undefined),
    releaseNavigationAttentionView: api.releaseNavigationAttentionView ?? (async () => undefined),
    getNavigationSelectedDetail: api.getNavigationSelectedDetail ?? (async (request) => {
      const value = withSeen(await read());
      const thread = value.threads.find((thread) => thread.source === request.ref.backend && thread.id === request.ref.threadId
        && federationTargetsEqual(thread.federation?.ref.target, request.federationTarget));
      return { protocol: 2, ref: request.ref, revision: "fixture-detail", readiness: "ready", identity: thread ? "present" : "unresolved", thread,
        ...(request.includeWorkspaceConfiguration ? { workspaceDirectories: value.directories.filter((directory) =>
          thread?.linkedDirectories.some((linked) => linked.path === directory.path || linked.worktreePath === directory.path)) } : {}) };
    }),
    getNavigationLaunchpadConfig: api.getNavigationLaunchpadConfig ?? (async (request) => {
      const value = await read();
      const directory = value.directories.find((directory) => directory.key === request.directoryKey);
      const draft = directory?.launchpad;
      return { protocol: 2, revision: "fixture-config", directoryKey: request.directoryKey, defaults: value.launchpadDefaults, directoryGitStatus: directory?.gitStatus,
        launchpad: draft ? { backend: draft.backend, executionMode: draft.executionMode, workMode: draft.workMode,
          directoryKey: draft.directoryKey, directoryKind: draft.directoryKind, directoryLabel: draft.directoryLabel,
          directoryPath: draft.directoryPath, model: draft.model, reasoningEffort: draft.reasoningEffort,
          serviceTier: draft.serviceTier, fastMode: draft.fastMode, branchName: draft.branchName,
          parentThreadId: draft.parentThreadId, parentThreadBackend: draft.parentThreadBackend,
          parentThreadInstanceId: draft.parentThreadInstanceId, parentThreadTitle: draft.parentThreadTitle,
          sourceThreadId: draft.sourceThreadId, federationTarget: draft.federationTarget,
          registeredAt: draft.registeredAt, settingsTouchedAt: draft.settingsTouchedAt,
          acpRuntime: draft.acpRuntime, providerSettings: draft.providerSettings, agent: draft.agent,
          mcpConnectionIds: draft.mcpConnectionIds, messagingToolUpdateMode: draft.messagingToolUpdateMode,
          prAutoDispatchEnabled: draft.prAutoDispatchEnabled, tokenMiserEnabled: draft.tokenMiserEnabled,
          codexEnvironmentOptions: draft.codexEnvironmentOptions,
          codexEnvironmentId: draft.codexEnvironmentId, codexEnvironmentExecutionTarget: draft.codexEnvironmentExecutionTarget,
          codexEnvironmentActionId: draft.codexEnvironmentActionId,
          createdAt: draft.createdAt, updatedAt: draft.updatedAt } : undefined };
    }),
    ...(api.markThreadSeen ? { markThreadSeen: async (request) => {
      const result = await api.markThreadSeen!(request);
      seen.set(request.federationTarget?.scope === "remote"
        ? federatedThreadIdentityKey({ backend: request.backend ?? "codex", threadId: request.threadId, target: request.federationTarget })
        : buildThreadIdentityKey(request.backend ?? "codex", request.threadId), request.seenUpdatedAt);
      for (const listener of listeners) listener({ backend: request.backend ?? "codex", federationTarget: request.federationTarget,
        notification: { method: "navigation/thread/seen", params: { threadId: request.threadId, seenUpdatedAt: request.seenUpdatedAt } } });
      return result;
    } } : {}),
  };
}
