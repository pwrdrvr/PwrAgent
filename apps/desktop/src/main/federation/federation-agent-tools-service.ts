import { randomUUID } from "node:crypto";
import type {
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  CreateInstanceThreadResult,
  CreateInstanceThreadToolArgs,
  FederationHealthStatus,
  FederationHostInfo,
  FederationInstanceDescriptor,
  FederationInstanceId,
  FederationLoadStatus,
  FederatedThreadRef,
  FederationRemoteTarget,
  FederationThreadSearchResultSummary,
  ListFederationInstancesResult,
  ListFederationInstancesToolArgs,
  ListInstanceProjectsResult,
  ListInstanceProjectsToolArgs,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  NavigationThreadSummary,
  PwrAgentFederationErrorCode,
  PwrAgentFederationContext,
  PwrAgentFederationResponse,
  SearchFederationThreadsResult,
  SearchFederationThreadsToolArgs,
} from "@pwragent/shared";
import {
  FEDERATION_CAPABILITIES,
  buildFederatedThreadRef,
  buildThreadMarkdownLink,
  buildThreadUrl,
  formatFederationPeerDisplayLabel,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import { FederatedSearchService } from "./federated-search-service";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import {
  collectFederationHostInfo,
  collectFederationLoadStatus,
} from "./federation-host-info";
import {
  defaultInstanceLabel,
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

const DEFAULT_INSTANCE_PAGE_SIZE = 25;
const log = getMainLogger("pwragent:federation-agent-tools");

/**
 * Continuation tokens deliberately live for about a minute: they exist so an
 * agent can page through one oversized listing in a single reasoning step,
 * not to serve as a durable snapshot of the fleet.
 */
const INSTANCE_CURSOR_TTL_MS = 60_000;

type InstanceListCursorEntry = {
  expiresAt: number;
  offset: number;
  federationEnabled: boolean;
  instances: FederationInstanceDescriptor[];
};

type ResolvedInstance = {
  instanceId: FederationInstanceId;
  label: string;
  isLocal: boolean;
  target?: FederationRemoteTarget;
};

type GroupingParent = {
  threadId: string;
  backend: PwrAgentFederationContext["backend"];
  instanceId: FederationInstanceId;
};

type FederationAgentThreadStore = RemoteThreadTargetStore & {
  addRemoteThreadPin?: (params: {
    ref: FederatedThreadRef;
    instanceLabel: string;
    pinnedVia?: "child";
    summary?: NavigationThreadSummary;
  }) => Promise<unknown>;
};

/**
 * Dispatches the `federation` agent-tool catalog. Lives in federation-land
 * (not `BackendRegistry`) because the runtime already imports the registry —
 * the registry only ever sees the injected handler, wired from
 * `main/index.ts`.
 *
 * Everything remote rides the existing capability-gated federation RPCs
 * (`thread_navigation`, `environment_actions`, `federated_search`), so
 * agent-originated control is authorized exactly like operator-originated
 * control: enrollment is the trust boundary, per the PR #1202 capability
 * model. No agent-specific capability or allowlist exists by design. See the
 * agent tool catalog in docs/federation.md.
 */
export function createFederationAgentToolsHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    collectHostInfo?: () => Promise<FederationHostInfo>;
    collectLoadStatus?: () => Promise<FederationLoadStatus>;
    targetStore?: FederationAgentThreadStore;
    onRemoteChildMounted?: (params: {
      instanceId: string;
      backend: CreateInstanceThreadResult["backend"];
      threadId: string;
    }) => Promise<void> | void;
    resolveSourceTurnAttachments?: (
      context: PwrAgentFederationContext,
    ) => AppServerTurnInputItem[] | Promise<AppServerTurnInputItem[]>;
  } = {},
): PwrAgentFederationHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  const collectHostInfo = options.collectHostInfo ?? collectFederationHostInfo;
  const collectLoadStatus =
    options.collectLoadStatus ?? collectFederationLoadStatus;
  const cursors = new Map<string, InstanceListCursorEntry>();
  return async (request) => {
    try {
      if (request.operation === "list_federation_instances") {
        return await listFederationInstances(
          runtime(),
          request.args,
          cursors,
          collectHostInfo,
          collectLoadStatus,
        );
      }
      if (request.operation === "list_instance_projects") {
        return await listInstanceProjects(runtime(), request.args, collectHostInfo);
      }
      if (request.operation === "create_instance_thread") {
        return await createInstanceThread(
          runtime(),
          request.args,
          request.context,
          collectHostInfo,
          options.targetStore,
          options.onRemoteChildMounted,
          options.resolveSourceTurnAttachments,
        );
      }
      return await searchFederationThreads(
        runtime(),
        request.args,
        collectHostInfo,
        options.targetStore,
      );
    } catch (error) {
      return failure(
        classifyFederationToolError(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

async function listFederationInstances(
  runtime: DesktopFederationRuntime,
  args: ListFederationInstancesToolArgs,
  cursors: Map<string, InstanceListCursorEntry>,
  collectHostInfo: () => Promise<FederationHostInfo>,
  collectLoadStatus: () => Promise<FederationLoadStatus>,
): Promise<PwrAgentFederationResponse> {
  const limit = args.limit ?? DEFAULT_INSTANCE_PAGE_SIZE;
  pruneExpiredCursors(cursors);

  if (args.cursor) {
    const entry = cursors.get(args.cursor);
    if (!entry) {
      return failure(
        "invalid_arguments",
        "The cursor is unknown or expired. Call list_federation_instances again without a cursor (tokens last about a minute).",
      );
    }
    return ok(
      pageInstances({
        cursors,
        entry,
        cursorId: args.cursor,
        limit,
      }),
    );
  }

  const health = await runtime.health();
  const local = await localInstanceDescriptor(health, collectHostInfo);
  const peers = health.peers.map((peer): FederationInstanceDescriptor => ({
    instanceId: peer.id,
    label: formatFederationPeerDisplayLabel(peer, health.peers),
    isLocal: false,
    status: peer.status,
    capabilities: [...peer.capabilities],
    role: peer.role,
    notes: peer.notes,
    icon: peer.celestialIcon,
    profileName: peer.profileName,
    host: peer.host,
    unavailableReason: peer.unavailableReason,
  }));
  const instances = [local, ...peers].filter((instance) =>
    matchesInstanceQuery(instance, args.query),
  );
  // Loads are sampled once for the whole listing, so continuation pages
  // serve readings at most one cursor TTL (~60s) old — the staleness a
  // token-paged listing already accepts.
  const listed = args.includeLoad
    ? await attachInstanceLoads({ runtime, instances, collectLoadStatus })
    : instances;
  return ok(
    pageInstances({
      cursors,
      entry: {
        expiresAt: Date.now() + INSTANCE_CURSOR_TTL_MS,
        offset: 0,
        federationEnabled: health.enabled,
        instances: listed,
      },
      limit,
    }),
  );
}

/**
 * Fan the on-demand load query out concurrently: the local instance (a
 * gateway answers for itself) samples directly, connected peers ride the
 * short-timeout `backend.getLoadStatus` RPC — relayed peers included,
 * through the same envelope relay as every backend RPC. Any instance
 * that fails or times out just omits `load`; a slow peer must never
 * fail the listing.
 */
async function attachInstanceLoads(params: {
  runtime: DesktopFederationRuntime;
  instances: FederationInstanceDescriptor[];
  collectLoadStatus: () => Promise<FederationLoadStatus>;
}): Promise<FederationInstanceDescriptor[]> {
  return await Promise.all(
    params.instances.map(async (instance) => {
      const load = await queryInstanceLoad(params, instance);
      return load ? { ...instance, load } : instance;
    }),
  );
}

async function queryInstanceLoad(
  params: {
    runtime: DesktopFederationRuntime;
    collectLoadStatus: () => Promise<FederationLoadStatus>;
  },
  instance: FederationInstanceDescriptor,
): Promise<FederationLoadStatus | undefined> {
  if (
    !instance.isLocal
    && (
      instance.status !== "connected"
      || !instance.capabilities.includes("thread_navigation")
    )
  ) {
    return undefined;
  }
  try {
    return instance.isLocal
      ? await params.collectLoadStatus()
      : await params.runtime
          .remoteBackend({ scope: "remote", instanceId: instance.instanceId })
          .getLoadStatus();
  } catch (error) {
    log.debug("instance load query failed", {
      instanceId: instance.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function pageInstances(params: {
  cursors: Map<string, InstanceListCursorEntry>;
  entry: InstanceListCursorEntry;
  cursorId?: string;
  limit: number;
}): ListFederationInstancesResult {
  const { cursors, entry, limit } = params;
  const page = entry.instances.slice(entry.offset, entry.offset + limit);
  const nextOffset = entry.offset + page.length;
  const exhausted = nextOffset >= entry.instances.length;
  if (params.cursorId) {
    cursors.delete(params.cursorId);
  }
  let nextCursor: string | undefined;
  if (!exhausted) {
    nextCursor = randomUUID();
    cursors.set(nextCursor, { ...entry, offset: nextOffset });
  }
  return {
    federationEnabled: entry.federationEnabled,
    instances: page,
    totalCount: entry.instances.length,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function pruneExpiredCursors(
  cursors: Map<string, InstanceListCursorEntry>,
): void {
  const now = Date.now();
  for (const [id, entry] of cursors) {
    if (entry.expiresAt <= now) {
      cursors.delete(id);
    }
  }
}

function matchesInstanceQuery(
  instance: FederationInstanceDescriptor,
  query: string | undefined,
): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  const haystack = [
    instance.label,
    instance.notes,
    instance.profileName,
    instance.instanceId,
    instance.host?.hostname,
    instance.host?.platform,
    instance.host?.osVersion,
    instance.host?.arch,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

async function listInstanceProjects(
  runtime: DesktopFederationRuntime,
  args: ListInstanceProjectsToolArgs,
  collectHostInfo: () => Promise<FederationHostInfo>,
): Promise<PwrAgentFederationResponse> {
  const resolved = await resolveInstance(runtime, args.instanceId, collectHostInfo);
  if (!resolved.ok) {
    return resolved.response;
  }
  const instance = resolved.instance;
  const snapshot = await backendFor(runtime, instance).getNavigationSnapshot({});
  const result: ListInstanceProjectsResult = {
    instanceId: instance.instanceId,
    instanceLabel: instance.label,
    isLocal: instance.isLocal,
    projects: snapshot.directories
      .filter((directory) => directory.kind !== "unlinked")
      .map((directory) => ({
        key: directory.key,
        label: directory.label,
        kind: directory.kind,
        path: directory.path,
        hasLaunchpad: Boolean(directory.launchpad),
        backend:
          directory.launchpad?.backend ?? snapshot.launchpadDefaults.backend,
        workMode: directory.launchpad?.workMode,
        model: directory.launchpad?.model,
        executionMode: directory.launchpad?.executionMode,
      })),
  };
  return ok(result);
}

async function createInstanceThread(
  runtime: DesktopFederationRuntime,
  args: CreateInstanceThreadToolArgs,
  context: PwrAgentFederationContext,
  collectHostInfo: () => Promise<FederationHostInfo>,
  targetStore: FederationAgentThreadStore | undefined,
  onRemoteChildMounted: ((params: {
    instanceId: string;
    backend: CreateInstanceThreadResult["backend"];
    threadId: string;
  }) => Promise<void> | void) | undefined,
  resolveSourceTurnAttachments: ((
    context: PwrAgentFederationContext,
  ) => AppServerTurnInputItem[] | Promise<AppServerTurnInputItem[]>) | undefined,
): Promise<PwrAgentFederationResponse> {
  const resolved = await resolveInstance(runtime, args.instanceId, collectHostInfo);
  if (!resolved.ok) {
    return resolved.response;
  }
  const instance = resolved.instance;
  const groupingMode = args.groupingMode ?? "none";
  const backend = backendFor(runtime, instance);
  const snapshot = await backend.getNavigationSnapshot({});
  const directory = snapshot.directories.find(
    (candidate) => candidate.key === args.projectKey,
  );
  if (!directory) {
    return failure(
      "not_found",
      `No project with key ${args.projectKey} on ${instance.label}. Use list_instance_projects for the current project list.`,
    );
  }
  const projectBackend =
    directory.launchpad?.backend ?? snapshot.launchpadDefaults.backend;
  if (args.tokenMiserEnabled !== undefined && projectBackend !== "codex") {
    return failure(
      "invalid_arguments",
      `tokenMiserEnabled is supported only for Codex projects; ${args.projectKey} uses ${projectBackend}.`,
    );
  }
  let localInstanceId: FederationInstanceId | undefined;
  let groupingParent: GroupingParent | undefined;
  if (groupingMode === "subthread") {
    localInstanceId = (await runtime.health()).instanceId;
    if (!localInstanceId) {
      return failure(
        "internal_error",
        "The local federation instance identity is unavailable, so the cross-instance parent relationship cannot be recorded.",
      );
    }
    const localSnapshot = instance.isLocal
      ? snapshot
      : await runtime.localBackend().getNavigationSnapshot({});
    groupingParent = resolveGroupingParent(
      localSnapshot,
      context,
      localInstanceId,
    );
  }
  const parentThreadInstanceId = groupingParent
    && groupingParent.instanceId !== instance.instanceId
    ? groupingParent.instanceId
    : undefined;
  const draft = buildLaunchpadDraft({ snapshot, directory, args });
  const messageOrigin: AppServerThreadMessageOrigin = {
    kind: "agent",
    sourceThread: {
      backend: context.backend,
      threadId: context.threadId,
    },
  };
  const attachmentInput = resolveSourceTurnAttachments
    ? await resolveSourceTurnAttachments(context)
    : [];
  const input = [
    ...(args.input ? [{ type: "text" as const, text: args.input }] : []),
    ...attachmentInput,
  ];
  const response = await backend.materializeDirectoryLaunchpad(
    {
      directoryKey: args.projectKey,
      launchpad: draft,
      ...(groupingParent
        ? {
            parentThreadId: groupingParent.threadId,
            parentThreadBackend: groupingParent.backend,
            ...(parentThreadInstanceId
              ? { parentThreadInstanceId }
              : {}),
          }
        : {}),
      ...(input.length > 0 ? { input } : {}),
    },
    { messageOrigin },
  );
  const mountDisposition = groupingParent && localInstanceId
    ? await mountRemoteChildAtGroupingRoot(
        runtime,
        targetStore,
        onRemoteChildMounted,
        {
          childBackend: response.backend,
          childInstanceId: instance.instanceId,
          childInstanceLabel: instance.label,
          childThreadId: response.threadId,
          localInstanceId,
          parent: groupingParent,
          title: directory.label,
        },
      )
    : "none";
  if (!instance.isLocal) {
    const remoteTarget = {
      instanceId: instance.instanceId,
      instanceLabel: instance.label,
      backend: response.backend,
      threadId: response.threadId,
    };
    if (mountDisposition !== "local") {
      await rememberTarget(targetStore, remoteTarget);
    }
  }
  const threadLinkRef = {
    threadId: response.threadId,
    backend: response.backend,
    ...(!instance.isLocal ? { instanceId: instance.instanceId } : {}),
  };
  const result: CreateInstanceThreadResult = {
    instanceId: instance.instanceId,
    instanceLabel: instance.label,
    isLocal: instance.isLocal,
    backend: response.backend,
    threadId: response.threadId,
    executionMode: response.executionMode,
    workMode: response.workMode,
    turnId: response.turnId,
    groupingMode,
    ...(groupingParent
      ? { groupedUnderThreadId: groupingParent.threadId }
      : {}),
    threadUrl: buildThreadUrl(threadLinkRef),
    threadLink: buildThreadMarkdownLink({
      ...threadLinkRef,
      title: directory.label,
    }),
    message: instance.isLocal
      ? `Created thread in ${directory.label}.`
      : `Created thread in ${directory.label} on ${instance.label}.`,
    turnStartFailure: response.turnStartFailure,
    codexEnvironmentStartupFailure: response.codexEnvironmentStartupFailure,
  };
  return ok(result);
}

async function searchFederationThreads(
  runtime: DesktopFederationRuntime,
  args: SearchFederationThreadsToolArgs,
  collectHostInfo: () => Promise<FederationHostInfo>,
  targetStore: RemoteThreadTargetStore | undefined,
): Promise<PwrAgentFederationResponse> {
  const scope = args.scope ?? "all";
  const health = await runtime.health();
  const localId = health.instanceId;
  const local = await localInstanceDescriptor(health, collectHostInfo);
  if (args.instanceId && args.instanceId !== localId) {
    const resolved = await resolveInstance(runtime, args.instanceId, collectHostInfo);
    if (!resolved.ok) {
      return resolved.response;
    }
  }
  // scope and instanceId intersect: each masks the surface independently.
  const includeLocal =
    scope !== "remote" && (!args.instanceId || args.instanceId === localId);
  const includePeers = scope !== "local";
  const service = new FederatedSearchService({
    includeLocal,
    local: runtime.localBackend(),
    peers: () =>
      (includePeers ? runtime.connectedPeerTargets() : [])
        .filter((peer) => peer.capabilities.includes("federated_search"))
        .filter(
          (peer) =>
            !args.instanceId || peer.target.instanceId === args.instanceId,
        )
        .map((peer) => ({
          instanceId: peer.target.instanceId,
          label: peer.label,
          status: "connected" as const,
          backend: runtime.remoteBackend(peer.target),
        })),
  });
  const response = await service.search({
    query: args.query,
    limit: args.limit,
    backend: args.backend,
    includeArchived: args.includeArchived,
    projectKeys: args.projectKeys,
    updatedAfter: args.updatedAfter,
    updatedBefore: args.updatedBefore,
  });
  const results = response.results.map(
    (entry): FederationThreadSearchResultSummary => {
      const target = entry.ref.target;
      const isLocal = !isRemoteFederationTarget(target);
      return {
        instanceId: isRemoteFederationTarget(target)
          ? target.instanceId
          : localId ?? "local",
        instanceLabel: isLocal ? local.label : entry.instanceLabel,
        isLocal,
        backend: entry.thread.source,
        threadId: entry.thread.id,
        title: entry.thread.title,
        updatedAt: entry.thread.updatedAt,
        archivedAt: entry.thread.archivedAt,
        projectKey: entry.thread.projectKey,
        gitBranch: entry.thread.gitBranch,
        score: entry.score,
        threadLink: buildThreadMarkdownLink({
          threadId: entry.thread.id,
          backend: entry.thread.source,
          ...(isRemoteFederationTarget(target)
            ? { instanceId: target.instanceId }
            : {}),
          title: entry.thread.title,
        }),
      };
    },
  );
  await Promise.all(
    results
      .filter((entry) => !entry.isLocal)
      .map(async (entry) => await rememberTarget(targetStore, {
        instanceId: entry.instanceId,
        instanceLabel: entry.instanceLabel,
        backend: entry.backend,
        threadId: entry.threadId,
      })),
  );
  const localResultCount = results.filter((entry) => entry.isLocal).length;
  const result: SearchFederationThreadsResult = {
    query: response.query,
    results,
    totalCount: response.totalCount,
    truncated: response.truncated,
    searchedInstances: [
      ...(includeLocal && localId
        ? [
            {
              instanceId: localId,
              instanceLabel: local.label,
              resultCount: localResultCount,
            },
          ]
        : []),
      ...response.searchedInstances ?? [],
    ],
    failures: response.failures,
  };
  return ok(result);
}

async function localInstanceDescriptor(
  health: FederationHealthStatus,
  collectHostInfo: () => Promise<FederationHostInfo>,
): Promise<FederationInstanceDescriptor> {
  const federation = getDesktopSettingsService().readFederationConfig();
  let host: FederationHostInfo | undefined;
  try {
    host = await collectHostInfo();
  } catch {
    host = undefined;
  }
  return {
    instanceId: health.instanceId ?? "local",
    label:
      federation.instanceLabel?.trim() || defaultInstanceLabel(),
    isLocal: true,
    // Reachable by definition; health.status describes the federation
    // listener, not this instance's ability to take work.
    status: "connected",
    capabilities: [...FEDERATION_CAPABILITIES],
    role: health.role,
    notes: federation.instanceNotes?.trim() || undefined,
    icon: health.localCelestialIcon,
    ...(host ? { host } : {}),
  };
}

type ResolveInstanceOutcome =
  | { ok: true; instance: ResolvedInstance }
  | { ok: false; response: PwrAgentFederationResponse };

async function resolveInstance(
  runtime: DesktopFederationRuntime,
  instanceId: FederationInstanceId,
  collectHostInfo: () => Promise<FederationHostInfo>,
): Promise<ResolveInstanceOutcome> {
  const health = await runtime.health();
  if (instanceId === health.instanceId) {
    const local = await localInstanceDescriptor(health, collectHostInfo);
    return {
      ok: true,
      instance: {
        instanceId,
        label: local.label,
        isLocal: true,
      },
    };
  }
  const peer = health.peers.find((candidate) => candidate.id === instanceId);
  if (!peer) {
    return {
      ok: false,
      response: failure(
        "not_found",
        `No federation instance with id ${instanceId}. Use list_federation_instances for the current instance list.`,
      ),
    };
  }
  if (peer.status !== "connected") {
    return {
      ok: false,
      response: failure(
        "peer_unavailable",
        `Federation instance ${formatFederationPeerDisplayLabel(peer, health.peers)} is ${peer.status}.`,
      ),
    };
  }
  return {
    ok: true,
    instance: {
      instanceId,
      label: formatFederationPeerDisplayLabel(peer, health.peers),
      isLocal: false,
      target: { scope: "remote", instanceId },
    },
  };
}

function backendFor(
  runtime: DesktopFederationRuntime,
  instance: ResolvedInstance,
): FederationBackendOperations {
  return instance.isLocal || !instance.target
    ? runtime.localBackend()
    : runtime.remoteBackend(instance.target);
}

/**
 * Navigation groups are one level deep. If the calling thread is already a
 * child, delegate beneath its existing root so the new thread renders as a
 * sibling instead of becoming an invisible grandchild. A missing caller row
 * falls back to the caller itself, matching the renderer when a root is gone.
 */
function resolveGroupingParent(
  snapshot: NavigationSnapshot,
  context: PwrAgentFederationContext,
  localInstanceId: FederationInstanceId,
): GroupingParent {
  const caller = snapshot.threads.find(
    (thread) =>
      thread.source === context.backend
      && thread.id === context.threadId,
  );
  const parentThreadId = caller?.parentThreadId?.trim();
  if (!caller || !parentThreadId) {
    return {
      threadId: context.threadId,
      backend: context.backend,
      instanceId: localInstanceId,
    };
  }
  return {
    threadId: parentThreadId,
    backend: caller.parentThreadBackend ?? caller.source,
    instanceId: caller.parentThreadInstanceId ?? localInstanceId,
  };
}

function buildLaunchpadDraft(params: {
  snapshot: NavigationSnapshot;
  directory: NavigationSnapshot["directories"][number];
  args: CreateInstanceThreadToolArgs;
}): NavigationLaunchpadDraft {
  const { snapshot, directory, args } = params;
  const defaults = snapshot.launchpadDefaults;
  const stored = directory.launchpad;
  // Inherit only the project's *settings* presets from a stored launchpad.
  // The stored prompt/editor document/attachments are the operator's unsent
  // draft — sending them from an agent tool would fire composer text the
  // operator never submitted.
  const backend = stored?.backend ?? defaults.backend;
  const model = args.model ?? stored?.model ?? defaults.model;
  const reasoningEffort =
    args.reasoningEffort ?? stored?.reasoningEffort ?? defaults.reasoningEffort;
  const serviceTier = stored?.serviceTier ?? defaults.serviceTier;
  const fastMode = args.fastMode ?? stored?.fastMode ?? defaults.fastMode;
  const acpRuntime = stored?.acpRuntime ?? defaults.acpRuntime;
  const providerSettings = stored?.providerSettings ?? defaults.providerSettings;
  const branchName = args.branchName ?? stored?.branchName;
  const tokenMiserEnabled = backend === "codex"
    ? args.tokenMiserEnabled ?? stored?.tokenMiserEnabled
    : undefined;
  const now = Date.now();
  return {
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
    backend,
    executionMode:
      args.executionMode ?? stored?.executionMode ?? defaults.executionMode,
    workMode: args.workMode ?? stored?.workMode ?? defaults.workMode ?? "worktree",
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(acpRuntime !== undefined ? { acpRuntime } : {}),
    ...(providerSettings !== undefined ? { providerSettings } : {}),
    ...(tokenMiserEnabled !== undefined ? { tokenMiserEnabled } : {}),
    ...(stored?.mcpConnectionIds
      ? { mcpConnectionIds: stored.mcpConnectionIds }
      : {}),
    directoryKey: directory.key,
    directoryKind: directory.kind,
    directoryLabel: directory.label,
    ...(directory.path ? { directoryPath: directory.path } : {}),
    prompt: "",
    ...(branchName !== undefined ? { branchName } : {}),
  };
}

function ok(
  data: Extract<PwrAgentFederationResponse, { ok: true }>["data"],
): PwrAgentFederationResponse {
  return { ok: true, data };
}

function failure(
  code: PwrAgentFederationErrorCode,
  message: string,
): PwrAgentFederationResponse {
  return { ok: false, error: { code, message } };
}

function classifyFederationToolError(error: unknown): PwrAgentFederationErrorCode {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  if (message.includes("capability_denied") || message.includes("forbidden")) {
    return "forbidden";
  }
  if (
    message.includes("not connected")
    || message.includes("timed out")
    || message.includes("timeout")
  ) {
    return "peer_unavailable";
  }
  return "internal_error";
}

async function rememberTarget(
  targetStore: RemoteThreadTargetStore | undefined,
  target: Parameters<RemoteThreadTargetStore["rememberRemoteThreadTarget"]>[0],
): Promise<void> {
  if (!targetStore) {
    return;
  }
  try {
    await targetStore.rememberRemoteThreadTarget(target);
  } catch (error) {
    log.warn("failed to remember remote thread target", {
      backend: target.backend,
      error: error instanceof Error ? error.message : String(error),
      instanceId: target.instanceId,
      threadId: target.threadId,
    });
  }
}

async function mountRemoteChildAtGroupingRoot(
  runtime: DesktopFederationRuntime,
  targetStore: FederationAgentThreadStore | undefined,
  onRemoteChildMounted: ((params: {
    instanceId: string;
    backend: CreateInstanceThreadResult["backend"];
    threadId: string;
  }) => Promise<void> | void) | undefined,
  params: {
    childBackend: CreateInstanceThreadResult["backend"];
    childInstanceId: FederationInstanceId;
    childInstanceLabel: string;
    childThreadId: string;
    localInstanceId: FederationInstanceId;
    parent: GroupingParent;
    title: string;
  },
): Promise<"inherent" | "local" | "none" | "remote"> {
  if (params.parent.instanceId === params.childInstanceId) {
    return "inherent";
  }
  const pinParams = {
    instanceId: params.childInstanceId,
    instanceLabel: params.childInstanceLabel,
    backend: params.childBackend,
    threadId: params.childThreadId,
    parentThreadId: params.parent.threadId,
    parentThreadBackend: params.parent.backend,
    parentThreadInstanceId: params.parent.instanceId,
    title: params.title,
  };
  if (params.parent.instanceId === params.localInstanceId) {
    const mounted = await rememberRemoteChildPin(targetStore, pinParams);
    if (!mounted) {
      return "none";
    }
    try {
      await onRemoteChildMounted?.({
        instanceId: params.childInstanceId,
        backend: params.childBackend,
        threadId: params.childThreadId,
      });
    } catch (error) {
      log.warn("failed to announce remotely created child mount", {
        backend: params.childBackend,
        error: error instanceof Error ? error.message : String(error),
        instanceId: params.childInstanceId,
        threadId: params.childThreadId,
      });
    }
    return "local";
  }

  try {
    await runtime.remoteBackend({
      scope: "remote",
      instanceId: params.parent.instanceId,
    }).mountRemoteChild({
      ref: buildFederatedThreadRef(pinParams),
      instanceLabel: params.childInstanceLabel,
      summary: buildRemoteChildSummary(pinParams),
    });
    return "remote";
  } catch (error) {
    log.warn("failed to mount child on remote group root", {
      childInstanceId: params.childInstanceId,
      childThreadId: params.childThreadId,
      error: error instanceof Error ? error.message : String(error),
      parentInstanceId: params.parent.instanceId,
      parentThreadId: params.parent.threadId,
    });
    return "none";
  }
}

type RemoteChildPinParams = {
  instanceId: string;
  instanceLabel: string;
  backend: CreateInstanceThreadResult["backend"];
  threadId: string;
  parentThreadId: string;
  parentThreadBackend: PwrAgentFederationContext["backend"];
  parentThreadInstanceId?: string;
  title: string;
};

function buildRemoteChildSummary(
  params: RemoteChildPinParams,
): NavigationThreadSummary {
  return {
    source: params.backend,
    id: params.threadId,
    title: params.title,
    titleSource: "fallback",
    linkedDirectories: [],
    inbox: { inInbox: false },
    parentThreadId: params.parentThreadId,
    parentThreadBackend: params.parentThreadBackend,
    ...(params.parentThreadInstanceId
      ? { parentThreadInstanceId: params.parentThreadInstanceId }
      : {}),
  };
}

async function rememberRemoteChildPin(
  targetStore: FederationAgentThreadStore | undefined,
  params: RemoteChildPinParams,
): Promise<boolean> {
  if (!targetStore?.addRemoteThreadPin) {
    return false;
  }
  try {
    await targetStore.addRemoteThreadPin({
      ref: buildFederatedThreadRef(params),
      instanceLabel: params.instanceLabel,
      pinnedVia: "child",
      summary: buildRemoteChildSummary(params),
    });
    return true;
  } catch (error) {
    log.warn("failed to mount remotely created child thread", {
      backend: params.backend,
      error: error instanceof Error ? error.message : String(error),
      instanceId: params.instanceId,
      threadId: params.threadId,
    });
    return false;
  }
}
