import type {
  CreateInstanceThreadResult,
  CreateInstanceThreadToolArgs,
  FederationHealthStatus,
  FederationInstanceDescriptor,
  FederationInstanceId,
  FederationRemoteTarget,
  FederationThreadSearchResultSummary,
  ListFederationInstancesResult,
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
import {
  defaultInstanceLabel,
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

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
  } = {},
): PwrAgentFederationHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    try {
      if (request.operation === "list_federation_instances") {
        return ok(await listFederationInstances(runtime()));
      }
      if (request.operation === "list_instance_projects") {
        return await listInstanceProjects(runtime(), request.args);
      }
      if (request.operation === "create_instance_thread") {
        return await createInstanceThread(runtime(), request.args);
      }
      return await searchFederationThreads(runtime(), request.args);
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
): Promise<ListFederationInstancesResult> {
  const health = await runtime.health();
  const local = await localInstanceDescriptor(health);
  const peers = health.peers.map((peer): FederationInstanceDescriptor => ({
    instanceId: peer.id,
    label: formatFederationPeerDisplayLabel(peer, health.peers),
    isLocal: false,
    status: peer.status,
    capabilities: [...peer.capabilities],
    role: peer.role,
    notes: peer.notes,
    icon: peer.icon,
    profileName: peer.profileName,
    unavailableReason: peer.unavailableReason,
  }));
  return {
    federationEnabled: health.enabled,
    instances: [local, ...peers],
  };
}

async function listInstanceProjects(
  runtime: DesktopFederationRuntime,
  args: ListInstanceProjectsToolArgs,
): Promise<PwrAgentFederationResponse> {
  const resolved = await resolveInstance(runtime, args.instanceId);
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
): Promise<PwrAgentFederationResponse> {
  const resolved = await resolveInstance(runtime, args.instanceId);
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
): Promise<PwrAgentFederationResponse> {
  const health = await runtime.health();
  const localId = health.instanceId;
  const local = await localInstanceDescriptor(health);
  if (args.instanceId && args.instanceId !== localId) {
    const resolved = await resolveInstance(runtime, args.instanceId);
    if (!resolved.ok) {
      return resolved.response;
    }
  }
  const includeLocal = !args.instanceId || args.instanceId === localId;
  const service = new FederatedSearchService({
    includeLocal,
    local: runtime.localBackend(),
    peers: () =>
      runtime
        .connectedPeerTargets()
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
): Promise<FederationInstanceDescriptor> {
  const settings = await getDesktopSettingsService().readSettings();
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
    profileName: undefined,
  };
}

type ResolveInstanceOutcome =
  | { ok: true; instance: ResolvedInstance }
  | { ok: false; response: PwrAgentFederationResponse };

async function resolveInstance(
  runtime: DesktopFederationRuntime,
  instanceId: FederationInstanceId,
): Promise<ResolveInstanceOutcome> {
  const health = await runtime.health();
  if (instanceId === health.instanceId) {
    const local = await localInstanceDescriptor(health);
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
