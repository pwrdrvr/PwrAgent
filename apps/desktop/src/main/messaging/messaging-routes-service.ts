import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  BackendSummary,
  DesktopMessagingAgentRouteTarget,
  DesktopMessagingBindingRoute,
  DesktopMessagingDefaultAgentScope,
  DesktopMessagingObservedSurface,
  ListMessagingRoutesResponse,
  SetMessagingDefaultAgentRequest,
  SetMessagingDefaultAgentResponse,
  ClearMessagingDefaultAgentRequest,
  ClearMessagingDefaultAgentResponse,
  ThreadAgentMetadata,
} from "@pwragent/shared";
import { normalizeMessagingBindingTargetKind } from "@pwragent/shared";
import type {
  MessagingDefaultAgentAssignmentRecord,
  MessagingDefaultAgentScope,
  MessagingObservedSurfaceRecord,
} from "@pwragent/messaging-interface";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { defaultAgentBackendSupport } from "./core/messaging-default-agent";
import { getDesktopMessagingStore } from "./desktop-messaging-store";

type MessagingRoutesStore = Pick<
  ReturnType<typeof getDesktopMessagingStore>,
  | "findActiveBindings"
  | "findActiveDefaultAgentAssignments"
  | "findObservedSurfaces"
  | "getDefaultAgentAssignment"
  | "revokeDefaultAgentAssignment"
  | "upsertDefaultAgentAssignment"
>;

type MessagingRoutesBackendRegistry = {
  listBackends(params: { includeUnavailable: boolean }): Promise<{
    backends: BackendSummary[];
  }>;
  listThreads(params: {
    callerReason: string;
    enrichDirectories: boolean;
  }): Promise<AppServerThreadSummary[]>;
  getThreadAgentMetadata(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAgentMetadata | undefined>;
};

type MessagingRoutesServiceDependencies = {
  store?: MessagingRoutesStore;
  registry?: MessagingRoutesBackendRegistry;
  now?: () => number;
  newId?: () => string;
};

export async function listDesktopMessagingRoutes(
  dependencies: MessagingRoutesServiceDependencies = {},
): Promise<ListMessagingRoutesResponse> {
  const store = dependencies.store ?? getDesktopMessagingStore();
  const registry = dependencies.registry ?? getDesktopBackendRegistry();
  const [defaultAgents, bindings, observedSurfaces, backendResult, threadResult] =
    await Promise.all([
      store.findActiveDefaultAgentAssignments(),
      store.findActiveBindings(),
      store.findObservedSurfaces(),
      registry.listBackends({ includeUnavailable: true }).catch(() => ({
        backends: [],
      })),
      registry.listThreads({
        callerReason: "messaging-routes-settings",
        enrichDirectories: false,
      }).catch(() => []),
    ]);
  const backendLabels = new Map(
    backendResult.backends.map((backend) => [backend.kind, backend.label]),
  );
  const threadsByKey = new Map(
    threadResult.map((thread) => [threadKey(thread.source, thread.id), thread]),
  );
  const eligibleAgents = await resolveEligibleAgents({
    backends: backendResult.backends,
    backendLabels,
    registry,
    threads: threadResult,
  });
  const eligibleByKey = new Map(
    eligibleAgents.map((agent) => [
      threadKey(agent.backend, agent.threadId),
      agent,
    ]),
  );

  return {
    defaultAgents: defaultAgents.map((assignment) => {
      const key = threadKey(
        assignment.target.backend,
        assignment.target.threadId,
      );
      const eligible = eligibleByKey.get(key);
      const thread = threadsByKey.get(key);
      return {
        assignmentId: assignment.id,
        scope: toDesktopScope(assignment.scope),
        target: eligible ?? {
          backend: assignment.target.backend,
          threadId: assignment.target.threadId,
          label: thread?.title ?? assignment.target.threadId,
          backendLabel:
            backendLabels.get(assignment.target.backend)
            ?? formatBackendLabel(assignment.target.backend),
          backendAvailable:
            backendResult.backends.find(
              (candidate) => candidate.kind === assignment.target.backend,
            )?.available === true,
          available: false,
        },
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
      };
    }),
    bindings: bindings.map((binding): DesktopMessagingBindingRoute => {
      const thread = binding.backend
        ? threadsByKey.get(threadKey(binding.backend, binding.threadId))
        : threadResult.find((candidate) => candidate.id === binding.threadId);
      const backend = binding.backend ?? thread?.source;
      const backendSummary = backend
        ? backendResult.backends.find((candidate) => candidate.kind === backend)
        : undefined;
      return {
        bindingId: binding.id,
        platform: binding.channel.channel,
        conversation: {
          id: binding.channel.conversation.id,
          kind: binding.channel.conversation.kind,
          ...(binding.channel.conversation.title
            ? { title: binding.channel.conversation.title }
            : {}),
          ...(binding.channel.conversation.parentTitle
            ? { parentTitle: binding.channel.conversation.parentTitle }
            : {}),
          ...(binding.channel.conversation.ancestorTitle
            ? { ancestorTitle: binding.channel.conversation.ancestorTitle }
            : {}),
        },
        target: {
          ...(backend ? { backend } : {}),
          ...(backend
            ? {
                backendLabel:
                  backendLabels.get(backend) ?? formatBackendLabel(backend),
                backendAvailable: backendSummary?.available === true,
              }
            : {}),
          threadId: binding.threadId,
          label: thread?.title ?? binding.threadId,
          kind: normalizeMessagingBindingTargetKind(binding.targetKind),
        },
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      };
    }),
    eligibleAgents,
    observedSurfaces: mergeObservedSurfaces(observedSurfaces, bindings),
  };
}

function mergeObservedSurfaces(
  observed: MessagingObservedSurfaceRecord[],
  bindings: Awaited<ReturnType<MessagingRoutesStore["findActiveBindings"]>>,
): DesktopMessagingObservedSurface[] {
  const surfaces = new Map<string, DesktopMessagingObservedSurface>();
  const add = (
    channel: MessagingObservedSurfaceRecord["channel"],
    firstSeenAt: number,
    lastSeenAt: number,
  ) => {
    const conversation = channel.conversation;
    const key = [
      channel.channel,
      conversation.kind,
      conversation.parentId ?? "",
      conversation.id,
    ].join(":");
    const current = surfaces.get(key);
    surfaces.set(key, {
      platform: channel.channel,
      conversation: {
        ...current?.conversation,
        ...conversation,
      },
      firstSeenAt: Math.min(current?.firstSeenAt ?? firstSeenAt, firstSeenAt),
      lastSeenAt: Math.max(current?.lastSeenAt ?? lastSeenAt, lastSeenAt),
    });
  };
  for (const surface of observed) {
    add(surface.channel, surface.firstSeenAt, surface.lastSeenAt);
  }
  for (const binding of bindings) {
    add(binding.channel, binding.createdAt, binding.updatedAt);
  }
  return [...surfaces.values()].sort((left, right) =>
    right.lastSeenAt - left.lastSeenAt
    || left.platform.localeCompare(right.platform)
    || left.conversation.id.localeCompare(right.conversation.id));
}

export async function setDesktopMessagingDefaultAgent(
  request: SetMessagingDefaultAgentRequest,
  dependencies: MessagingRoutesServiceDependencies = {},
): Promise<SetMessagingDefaultAgentResponse> {
  const store = dependencies.store ?? getDesktopMessagingStore();
  const routes = await listDesktopMessagingRoutes(dependencies);
  const target = routes.eligibleAgents.find(
    (candidate) =>
      candidate.backend === request.target.backend
      && candidate.threadId === request.target.threadId,
  );
  if (!target) {
    throw new Error("The selected thread is not an eligible default Agent.");
  }
  const existing = request.assignmentId
    ? await store.getDefaultAgentAssignment(request.assignmentId)
    : undefined;
  if (request.assignmentId && (!existing || existing.revokedAt)) {
    throw new Error("The default Agent assignment no longer exists.");
  }
  const now = (dependencies.now ?? Date.now)();
  const assignment: MessagingDefaultAgentAssignmentRecord = {
    id:
      existing?.id
      ?? (dependencies.newId ?? (() => `default-agent-assignment:${randomUUID()}`))(),
    scope: toMessagingScope(request.scope),
    target: {
      kind: "agent",
      backend: request.target.backend,
      threadId: request.target.threadId,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await store.upsertDefaultAgentAssignment(assignment);
  return { assignmentId: assignment.id };
}

export async function clearDesktopMessagingDefaultAgent(
  request: ClearMessagingDefaultAgentRequest,
  dependencies: MessagingRoutesServiceDependencies = {},
): Promise<ClearMessagingDefaultAgentResponse> {
  const store = dependencies.store ?? getDesktopMessagingStore();
  const revoked = await store.revokeDefaultAgentAssignment({
    assignmentId: request.assignmentId,
    revokedAt: (dependencies.now ?? Date.now)(),
  });
  return {
    assignmentId: request.assignmentId,
    cleared: Boolean(revoked?.revokedAt),
  };
}

async function resolveEligibleAgents(params: {
  backends: BackendSummary[];
  backendLabels: Map<AppServerBackendKind, string>;
  registry: MessagingRoutesBackendRegistry;
  threads: AppServerThreadSummary[];
}): Promise<DesktopMessagingAgentRouteTarget[]> {
  const candidates = params.threads.filter(
    (thread) => {
      const backend = params.backends.find(
        (candidate) => candidate.kind === thread.source,
      );
      return (
        backend?.available === true
        && defaultAgentBackendSupport(thread.source, params.backends) === "supported"
      );
    },
  );
  const metadata = await Promise.all(
    candidates.map(async (thread) => ({
      thread,
      agent: await params.registry.getThreadAgentMetadata({
        backend: thread.source,
        threadId: thread.id,
      }).catch(() => undefined),
    })),
  );
  return metadata
    .filter(
      (entry): entry is typeof entry & { agent: ThreadAgentMetadata } =>
        Boolean(entry.agent),
    )
    .sort(
      (left, right) =>
        (right.thread.updatedAt ?? 0) - (left.thread.updatedAt ?? 0)
        || left.thread.title.localeCompare(right.thread.title),
    )
    .map(({ thread }) => ({
      backend: thread.source,
      threadId: thread.id,
      label: thread.title,
      backendLabel:
        params.backendLabels.get(thread.source)
        ?? formatBackendLabel(thread.source),
      backendAvailable: true,
      available: true,
    }));
}

function toDesktopScope(
  scope: MessagingDefaultAgentScope,
): DesktopMessagingDefaultAgentScope {
  switch (scope.kind) {
    case "profile":
      return { kind: "profile" };
    case "provider":
      return { kind: "provider", platform: scope.channel };
    case "workspace":
      return {
        kind: "workspace",
        platform: scope.channel,
        workspaceId: scope.workspaceId,
      };
    case "parent":
      return {
        kind: "parent",
        platform: scope.channel,
        conversationId: scope.conversationId,
      };
    case "conversation":
      return {
        kind: "conversation",
        platform: scope.channel.channel,
        conversation: { ...scope.channel.conversation },
      };
  }
}

function toMessagingScope(
  scope: DesktopMessagingDefaultAgentScope,
): MessagingDefaultAgentScope {
  switch (scope.kind) {
    case "profile":
      return { kind: "profile" };
    case "provider":
      requireText(scope.platform, "Messaging provider");
      return { kind: "provider", channel: scope.platform };
    case "workspace":
      requireText(scope.platform, "Messaging provider");
      return {
        kind: "workspace",
        channel: scope.platform,
        workspaceId: requireText(scope.workspaceId, "Workspace ID"),
      };
    case "parent":
      requireText(scope.platform, "Messaging provider");
      return {
        kind: "parent",
        channel: scope.platform,
        conversationId: requireText(scope.conversationId, "Parent ID"),
      };
    case "conversation":
      requireText(scope.platform, "Messaging provider");
      return {
        kind: "conversation",
        channel: {
          channel: scope.platform,
          conversation: {
            ...scope.conversation,
            id: requireText(scope.conversation.id, "Conversation ID"),
          },
        },
      };
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function threadKey(backend: AppServerBackendKind, threadId: string): string {
  return `${backend}:${threadId}`;
}

function formatBackendLabel(backend: AppServerBackendKind): string {
  return backend.startsWith("acp:")
    ? backend.slice("acp:".length)
    : backend;
}
