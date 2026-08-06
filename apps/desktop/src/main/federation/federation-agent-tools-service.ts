import { randomUUID } from "node:crypto";
import type {
  CreateInstanceThreadResult,
  CreateInstanceThreadToolArgs,
  FederationHealthStatus,
  FederationHostInfo,
  FederationInstanceDescriptor,
  FederationInstanceId,
  FederationRemoteTarget,
  FederationThreadSearchResultSummary,
  ListFederationInstancesResult,
  ListFederationInstancesToolArgs,
  ListInstanceProjectsResult,
  ListInstanceProjectsToolArgs,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  PwrAgentFederationErrorCode,
  PwrAgentFederationResponse,
  SearchFederationThreadsResult,
  SearchFederationThreadsToolArgs,
} from "@pwragent/shared";
import {
  FEDERATION_CAPABILITIES,
  buildThreadMarkdownLink,
  buildThreadUrl,
  formatFederationPeerDisplayLabel,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { FederatedSearchService } from "./federated-search-service";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import { collectFederationHostInfo } from "./federation-host-info";
import {
  defaultInstanceLabel,
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

const DEFAULT_INSTANCE_PAGE_SIZE = 25;

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
 * model. No agent-specific capability or allowlist exists by design — see
 * docs/plans/2026-08-05-003-feat-federation-agent-tools-plan.md.
 */
export function createFederationAgentToolsHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    collectHostInfo?: () => Promise<FederationHostInfo>;
  } = {},
): PwrAgentFederationHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  const collectHostInfo = options.collectHostInfo ?? collectFederationHostInfo;
  const cursors = new Map<string, InstanceListCursorEntry>();
  return async (request) => {
    try {
      if (request.operation === "list_federation_instances") {
        return listFederationInstances(
          runtime(),
          request.args,
          cursors,
          collectHostInfo,
        );
      }
      if (request.operation === "list_instance_projects") {
        return await listInstanceProjects(runtime(), request.args, collectHostInfo);
      }
      if (request.operation === "create_instance_thread") {
        return await createInstanceThread(runtime(), request.args, collectHostInfo);
      }
      return await searchFederationThreads(
        runtime(),
        request.args,
        collectHostInfo,
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
  return ok(
    pageInstances({
      cursors,
      entry: {
        expiresAt: Date.now() + INSTANCE_CURSOR_TTL_MS,
        offset: 0,
        federationEnabled: health.enabled,
        instances,
      },
      limit,
    }),
  );
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
        backend: directory.launchpad?.backend,
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
  collectHostInfo: () => Promise<FederationHostInfo>,
): Promise<PwrAgentFederationResponse> {
  const resolved = await resolveInstance(runtime, args.instanceId, collectHostInfo);
  if (!resolved.ok) {
    return resolved.response;
  }
  const instance = resolved.instance;
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
  const draft = buildLaunchpadDraft({ snapshot, directory, args });
  const response = await backend.materializeDirectoryLaunchpad({
    directoryKey: args.projectKey,
    launchpad: draft,
    ...(args.input ? { input: [{ type: "text", text: args.input }] } : {}),
  });
  const result: CreateInstanceThreadResult = {
    instanceId: instance.instanceId,
    instanceLabel: instance.label,
    isLocal: instance.isLocal,
    backend: response.backend,
    threadId: response.threadId,
    executionMode: response.executionMode,
    workMode: response.workMode,
    turnId: response.turnId,
    ...(instance.isLocal
      ? {
          threadUrl: buildThreadUrl({
            threadId: response.threadId,
            backend: response.backend,
          }),
          threadLink: buildThreadMarkdownLink({
            threadId: response.threadId,
            backend: response.backend,
            title: directory.label,
          }),
        }
      : {}),
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
        projectKey: entry.thread.projectKey,
        gitBranch: entry.thread.gitBranch,
        score: entry.score,
        ...(isLocal
          ? {
              threadLink: buildThreadMarkdownLink({
                threadId: entry.thread.id,
                backend: entry.thread.source,
                title: entry.thread.title,
              }),
            }
          : {}),
      };
    },
  );
  const localResultCount = results.filter((entry) => entry.isLocal).length;
  const result: SearchFederationThreadsResult = {
    query: response.query,
    results,
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
  const settings = await getDesktopSettingsService().readSettings();
  let host: FederationHostInfo | undefined;
  try {
    host = await collectHostInfo();
  } catch {
    host = undefined;
  }
  return {
    instanceId: health.instanceId ?? "local",
    label:
      settings.federation.instanceLabel.value.trim() || defaultInstanceLabel(),
    isLocal: true,
    // Reachable by definition; health.status describes the federation
    // listener, not this instance's ability to take work.
    status: "connected",
    capabilities: [...FEDERATION_CAPABILITIES],
    role: health.role,
    notes: settings.federation.instanceNotes.value.trim() || undefined,
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
  const model = args.model ?? stored?.model ?? defaults.model;
  const reasoningEffort =
    args.reasoningEffort ?? stored?.reasoningEffort ?? defaults.reasoningEffort;
  const serviceTier = stored?.serviceTier ?? defaults.serviceTier;
  const fastMode = args.fastMode ?? stored?.fastMode ?? defaults.fastMode;
  const acpRuntime = stored?.acpRuntime ?? defaults.acpRuntime;
  const providerSettings = stored?.providerSettings ?? defaults.providerSettings;
  const branchName = args.branchName ?? stored?.branchName;
  const now = Date.now();
  return {
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
    backend: stored?.backend ?? defaults.backend,
    executionMode:
      args.executionMode ?? stored?.executionMode ?? defaults.executionMode,
    workMode: args.workMode ?? stored?.workMode ?? defaults.workMode ?? "worktree",
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(acpRuntime !== undefined ? { acpRuntime } : {}),
    ...(providerSettings !== undefined ? { providerSettings } : {}),
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
