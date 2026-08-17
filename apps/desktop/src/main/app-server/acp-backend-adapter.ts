import path from "node:path";
import { app } from "electron";
import {
  type AcpBackendId,
  type AcpThreadRewindPoint,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerNotification,
  type AppServerPendingRequestNotification,
  type AppServerThreadMessagePart,
  type AppServerThreadReplay,
  type AppServerThreadStatus,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type BackendAcpSessionRuntimeState,
  type AcpAgentPreference,
  type BackendAcpRuntimeCapabilities,
  type BackendCapabilities,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendSummary,
  type GrokWorkflowBudgetPolicy,
  type ThreadExecutionMode,
  isAcpBackendId,
} from "@pwragent/shared";
import {
  AcpAgentStore,
  type AcpAgentStore as AcpAgentStoreLike,
} from "../acp/acp-agent-store";
import { isBannedAcpRegistryId } from "../acp/acp-agent-allowlist";
import {
  acpAgentCapabilitiesForRegistryId,
  type AcpAgentCapabilities,
} from "../acp/acp-agent-capabilities";
import {
  AcpAgentClient,
  mergeMcpServerRegistrations,
  type AcpJsonRpcTransport,
  type AcpMcpServerRegistration,
  type AcpPromptContentBlock,
} from "../acp/acp-client";
import type { AcpProviderStatus } from "../acp/acp-provider-status";
import {
  acpRuntimeSupportsHttpMcp,
  buildAutomationInspectionAcpMcpServers,
} from "../automations/automation-inspection-cli.js";
import type {
  AgentToolMcpServerLike,
} from "../agent-tools/agent-tool-mcp-server.js";
import { discoverLocalAcpAgentRecords } from "../acp/acp-instance-discovery";
import {
  acpAgentEnabledFor,
  acpCliPathOverrideFor,
  managedGrokBuildsEnabledForRuntime,
  readDesktopSettingsConfigSafe,
} from "../settings/desktop-config";
import {
  AcpLiveToolUpdateResolver,
  acpToolUpdateNotifications,
  acpUsageNotification,
} from "../acp/acp-live-notifications";
import {
  foldAcpTurnUsage,
  readAcpSelectedModel,
  readAcpUsageEnvelope,
  type AcpTokenUsage,
} from "../acp/acp-usage.js";
import {
  AcpRolloutStore,
  isPwrAgentSyntheticAcpUpdate,
} from "../acp/acp-rollout-store";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import {
  acpRuntimeSupportsSessionHistoryReplay,
  acpRuntimeSupportsSessionLoad,
} from "../acp/acp-runtime-capabilities";
import {
  AcpSessionStore,
  type AcpSessionMetadata,
  type AcpSessionStore as AcpSessionStoreContract,
} from "../acp/acp-session-store";
import {
  AcpSessionReplayNormalizer,
  inferAcpReplayTurns,
  readAcpContentText,
  shouldSurfaceAcpThoughtsAsMessages,
} from "../acp/acp-session-normalizer";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
import {
  checkGrokCliUpdate,
  preserveGrokUpdateAcknowledgement,
  shouldCheckGrokCliUpdate,
} from "../acp/grok-cli-update";
import { getMainLogger } from "../log";
import {
  getAppStateDb,
  getAppStateMode,
  isAppStateInitialized,
} from "../state/app-state";
import {
  resolveActiveProfilePath,
  resolveBootstrapProfilePath,
} from "../profile";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import {
  createCompositeJsonRpcObserver,
  createProtocolLogObserverFromEnv,
} from "./protocol-log-observer";

export type { AcpSessionMetadata };

export const ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR =
  "This ACP agent cannot hand off a workspace after the first message in a thread. Start a new thread in the target workspace instead.";

const acpBackendAdapterLog = getMainLogger("pwragent:acp-backend-adapter");
const ACP_PROVIDER_STATUS_CACHE_TTL_MS = 60_000;
const ACP_CLOSE_TIMEOUT_MS = 5_000;

export type AcpRuntimeClient = Pick<
  AcpAgentClient,
  | "cancelSession"
  | "dispose"
  | "ensureSession"
  | "initialize"
  | "loadSession"
  | "readReplay"
  | "refreshSession"
  | "startPrompt"
  | "startSession"
> &
  Partial<
    Pick<
      AcpAgentClient,
      | "didSessionLoadReplayHistory"
      | "configureWorkflowBudget"
      | "hasActiveOperations"
      | "hasActiveTurns"
      | "hasRetainableSessions"
      | "listRewindPoints"
      | "ownsSession"
      | "readProviderStatus"
      | "sendControlPrompt"
      | "setRuntimeOption"
      | "steerSession"
      | "supportsSessionLoad"
      | "rewindSession"
    >
  >;

export type AcpClientFactory = (agent: AcpInstalledAgentRecord) => AcpRuntimeClient;
export type AcpTransportFactory = (
  agent: AcpInstalledAgentRecord,
) => AcpJsonRpcTransport;
export type LocalAcpDiscovery = () => Promise<AcpInstalledAgentRecord[]>;

/**
 * Real local ACP discovery, and the only discovery that reaches outside this
 * process: it reads the operator's PwrAgent config, scans their machine for
 * installed CLIs, and may fetch a release listing from GitHub and install a
 * managed Grok build under the PwrAgent root before probing it.
 *
 * `AcpBackendAdapter` never reaches for this on its own — `discoverLocalAcpAgents`
 * is a required option, so the caller always says which discovery it wants. That
 * is deliberate: while the adapter defaulted to this factory, any test that
 * forgot to pass one silently inherited whatever the developer had installed,
 * and a plain `pnpm test` would download a Grok runtime into `~/.pwragent`
 * and then spend 5-16s per lookup probing it. Tests inject their own.
 */
export function createLocalAcpAgentDiscovery(params?: {
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
}): LocalAcpDiscovery {
  return async () => {
    // Chat-launch discovery runs through the kit's multi-install discovery
    // (same as the settings path), so the binary that launches is the
    // resolved active install (override → picked → first) and every agent's
    // cliPath override is honored — consistent with what Settings shows.
    // Read + parse the config once for all four agents (override + enabled),
    // not once per lookup.
    const config = readDesktopSettingsConfigSafe();
    const preferences: Record<string, AcpAgentPreference> = {};
    const enabledRegistryIds = ["gemini", "grok", "kimi", "qwen"].filter(
      (registryId) => acpAgentEnabledFor(config, registryId),
    );
    for (const registryId of enabledRegistryIds) {
      const override = acpCliPathOverrideFor(config, registryId);
      if (override) {
        preferences[registryId] = { overridePath: override };
      }
    }
    const env = await params?.resolveEnv?.();
    const records = await discoverLocalAcpAgentRecords({
      enabledRegistryIds,
      managedGrok: {
        enabled:
          acpAgentEnabledFor(config, "grok")
          && managedGrokBuildsEnabledForRuntime(
            config,
            {
              env: env ?? process.env,
              isPackaged: app?.isPackaged === true,
            },
          ),
        checkMode: app?.isPackaged === true ? "ttl" : "once-per-process",
        requirePlatformSignature: app?.isPackaged === true,
      },
      ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
      ...(env ? { env } : {}),
    });
    return records;
  };
}

/**
 * Inert discovery: reports no installed ACP agents and touches nothing outside
 * this process. This is what a `DesktopBackendRegistry` gets unless its caller
 * opts in to machine discovery, so a registry test that injects no stub fails
 * by finding no agents rather than by installing a Grok runtime.
 */
export const noLocalAcpAgentDiscovery: LocalAcpDiscovery = async () => [];

export type AcpSessionStoreLike =
  Pick<AcpSessionStoreContract, "getSession" | "listSessions"> &
  Partial<Pick<AcpSessionStoreContract, "upsertSession">>;

type AcpClientEntry = {
  client: AcpRuntimeClient;
  launchIdentity: string;
  promise: Promise<AcpRuntimeClient>;
  supportsSessionLoad: boolean;
  disposePromise?: Promise<void>;
};

type AcpLiveTurnUsage = {
  model?: string;
  tokenUsage: AcpTokenUsage;
};

export type AcpPromptPayload = {
  prompt: string;
  promptContent: AcpPromptContentBlock[];
  parts: AppServerThreadMessagePart[];
};

export type AcpBackendAdapterOptions = {
  acpAgentStore?: Pick<
    AcpAgentStoreLike,
    "getInstalledAgent" | "listInstalledAgents" | "upsertInstalledAgent"
  > | null;
  acpRolloutStore?: Pick<AcpRolloutStore, "appendUpdate" | "readReplay" | "readUpdates"> | null;
  acpSessionStore?: AcpSessionStoreLike | null;
  captureStores: ProtocolCaptureStore[];
  agentToolMcpServer?: AgentToolMcpServerLike;
  automationInspectionMcpCommand?: string;
  createAcpClient?: AcpClientFactory;
  createAcpTransport?: AcpTransportFactory;
  /**
   * Required so no caller can silently inherit machine-wide discovery.
   * Production passes `createLocalAcpAgentDiscovery(...)`; tests pass a stub.
   */
  discoverLocalAcpAgents: LocalAcpDiscovery;
  isAcpAgentEnabled?: (registryId: string) => boolean;
  checkGrokCliUpdate?: typeof checkGrokCliUpdate | null;
  resolveMcpConnectionServers?: (context: {
    backendId: AcpBackendId;
    sessionId?: string;
  }) => Promise<AcpMcpServerRegistration | undefined>;
  closeTimeoutMs?: number;
  emit: (event: AgentEvent) => Promise<void>;
  handleServerRequest: (
    backend: AcpBackendId,
    request: AppServerPendingRequestNotification,
  ) => Promise<unknown>;
};

export function readAcpUpdateKind(
  update: Record<string, unknown>,
): string | undefined {
  const kind =
    update.sessionUpdate ?? update.session_update ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

export function readAcpUpdateText(
  update: Record<string, unknown>,
): string | undefined {
  if (typeof update.text === "string") {
    return update.text;
  }
  if (typeof update.outputText === "string") {
    return update.outputText;
  }
  if (typeof update.output_text === "string") {
    return update.output_text;
  }
  return readAcpContentText(update.content);
}

function observedAcpSessionHistoryReplay(
  client: AcpRuntimeClient,
  sessionId: string,
): boolean | undefined {
  return client.didSessionLoadReplayHistory?.(sessionId);
}

export function readKimiYoloExecutionModeFromText(
  text: string,
): ThreadExecutionMode | undefined {
  const normalized = text.toLowerCase();
  if (normalized.includes("all actions will be auto-approved")) {
    return "full-access";
  }
  if (normalized.includes("tool calls remain auto-approved")) {
    return "full-access";
  }
  if (normalized.includes("actions will require approval")) {
    return "default";
  }
  return undefined;
}

function liveToolNotificationKey(
  backend: AcpBackendId,
  notification: AppServerNotification,
): string | undefined {
  const params = asPlainRecord(notification.params);
  const item = asPlainRecord(params?.item);
  const threadId = readNonEmptyString(params, "threadId");
  const turnId = readNonEmptyString(params, "turnId") ?? "no-turn";
  const itemId = readNonEmptyString(item, "id");
  return threadId && itemId
    ? `${backend}:${threadId}:${turnId}:${itemId}`
    : undefined;
}

function liveToolNotificationFingerprint(
  notification: AppServerNotification,
): string | undefined {
  const params = asPlainRecord(notification.params);
  const item = asPlainRecord(params?.item);
  if (!item) {
    return undefined;
  }
  const data = asPlainRecord(item.data);
  const output = readNonEmptyString(data, "output") ?? "";
  return JSON.stringify({
    method: notification.method,
    type: item.type,
    toolName: item.toolName,
    status: item.status,
    command: item.command,
    commandActions: item.commandActions,
    outputHash: hashString(output),
    outputLength: output.length,
  });
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash.toString(16);
}

export function buildAcpCapabilities(
  agentCapabilities?: AcpAgentCapabilities,
): BackendCapabilities {
  return {
    listThreads: true,
    createThread: true,
    resumeThread: true,
    archiveThread: true,
    restoreThread: true,
    archiveWorktree: false,
    restoreWorktree: false,
    renameThread: true,
    readThread: true,
    startTurn: true,
    startReview: agentCapabilities?.managedReview === true,
    reviewRunner: agentCapabilities?.managedReview === true,
    interruptTurn: true,
    steerTurn: agentCapabilities?.steerTurn === true,
    transcriptPagination: false,
    toolUse: true,
    approvalRequests: true,
    multiDirectoryThreads: true,
  };
}

export function describeInstalledAcpBackend(
  agent: AcpInstalledAgentRecord,
): BackendSummary {
  const runtimeCapabilities = acpRuntimeCapabilitiesForAgent(agent);
  const available =
    agent.installStatus === "installed" &&
    (agent.authStatus === "not-required" || agent.authStatus === "authenticated");
  const unavailableReason =
    available
      ? undefined
      : agent.lastError ??
        (agent.authStatus === "required"
          ? "ACP agent authentication required"
          : "ACP agent unavailable");

  return {
    kind: agent.backendId,
    source: "acp",
    label: formatAcpAgentDisplayName(agent),
    available,
    acp: {
      registryId: agent.registryId,
      version: agent.version,
      distributionKinds: [agent.distributionKind],
      installStatus: agent.installStatus,
      authStatus: agent.authStatus,
      verificationStatus: agent.verificationStatus,
      installedAt: agent.installedAt,
      updatedAt: agent.updatedAt,
      repositoryUrl: agent.registryAgent?.repositoryUrl,
      websiteUrl: agent.registryAgent?.websiteUrl,
      allowlistRuleId: agent.allowlistRuleId,
      license: agent.registryAgent?.license,
      runtime: runtimeCapabilities,
    },
    methods: [
      "session/new",
      ...(acpRuntimeSupportsSessionLoad(runtimeCapabilities)
        ? ["session/load"]
        : []),
      "session/prompt",
      "session/cancel",
    ],
    capabilities: buildAcpCapabilities(effectiveAcpAgentCapabilities(agent)),
    executionModes: buildAcpExecutionModes(agent, available, unavailableReason),
    launchpadOptions: buildAcpLaunchpadOptions(
      runtimeCapabilities,
      agent.registryId,
    ),
    unavailableReason,
  };
}

function formatAcpAgentDisplayName(agent: AcpInstalledAgentRecord): string {
  if (agent.registryId === "gemini") {
    return "Gemini";
  }
  if (agent.registryId === "kimi") {
    return "Kimi";
  }
  if (agent.registryId === "qwen") {
    return "Qwen";
  }
  return agent.name;
}

function acpRuntimeCapabilitiesForAgent(
  agent: AcpInstalledAgentRecord,
): BackendAcpRuntimeCapabilities | undefined {
  return agent.runtimeCapabilities;
}

function normalizeInstalledAcpAgent(
  agent: AcpInstalledAgentRecord,
): AcpInstalledAgentRecord {
  const runtimeCapabilities = acpRuntimeCapabilitiesForAgent(agent);
  return runtimeCapabilities === agent.runtimeCapabilities
    ? agent
    : { ...agent, runtimeCapabilities };
}

function acpAgentLaunchIdentity(agent: AcpInstalledAgentRecord): string {
  const descriptor = agent.launchDescriptor;
  return JSON.stringify({
    activeCommand: agent.activeCommand,
    launchDescriptor: descriptor
      ? {
          backendId: descriptor.backendId,
          registryId: descriptor.registryId,
          distributionKind: descriptor.distributionKind,
          command: descriptor.command,
          args: descriptor.args,
          env: Object.fromEntries(Object.entries(descriptor.env).sort()),
          cwd: descriptor.cwd,
          installPath: descriptor.installPath,
        }
      : undefined,
  });
}
function effectiveAcpAgentCapabilities(
  agent: AcpInstalledAgentRecord,
): AcpAgentCapabilities {
  const configured = {
    ...acpAgentCapabilitiesForRegistryId(agent.registryId),
    ...agent.capabilities,
  };
  return {
    ...configured,
    liveWorkspaceHandoff:
      configured.liveWorkspaceHandoff ||
      agent.runtimeCapabilities?.agentCapabilities?.loadSession === true,
  };
}

function resolveDefaultAcpRolloutRoot(): string {
  return getAppStateMode() === "bootstrap"
    ? resolveBootstrapProfilePath("state/acp-rollouts")
    : resolveActiveProfilePath("state/acp-rollouts");
}

/**
 * Whether the agent advertises its OWN runtime mode selector that the renderer
 * will surface as a dropdown. Mirrors the renderer's `getAcpRuntimeModeControl`
 * gating EXACTLY so the two never disagree (which is what produced the #658
 * double-dropdown): a `configOptions` entry of category "mode" with ≥2 values,
 * or an ACP `SessionModeState` (`modes.availableModes`) with ≥2 modes. Kimi's
 * Default/Plan/Auto/Yolo arrive via the latter, so checking only configOptions
 * would miss it.
 */
export function acpAdvertisesRuntimeModeSelector(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
): boolean {
  const modeConfigOption = runtimeCapabilities?.configOptions?.find(
    (option) => option.category === "mode" && option.values.length > 0,
  );
  if (modeConfigOption) {
    return modeConfigOption.values.length >= 2;
  }
  return (runtimeCapabilities?.modes?.availableModes?.length ?? 0) >= 2;
}

function buildAcpExecutionModes(
  agent: AcpInstalledAgentRecord,
  available: boolean,
  unavailableReason: string | undefined,
): BackendSummary["executionModes"] {
  // Kimi exposes /yolo, Grok exposes /always-approve on|off. Both flip the
  // session-wide approval policy via slash command; the registry treats them
  // identically at this layer (the per-agent slash command text + response
  // parsing lives in backend-registry.ts).
  if (agent.registryId !== "kimi" && agent.registryId !== "grok") {
    return [];
  }
  // If the agent advertises its OWN runtime "mode" selector (kimi surfaces
  // Default/Plan/Auto/Yolo via session capabilities), that is the single
  // source of truth for approval policy. Surfacing these hardcoded
  // Default/Full Access modes on top produced TWO overlapping mode dropdowns
  // (#658) that mirror each other — and the legacy slash-command path they
  // drive (kimi `/yolo`) is rejected by current kimi, failing the launch.
  // Defer entirely to the runtime modes whenever the agent advertises a
  // selector; only fall back to these hardcoded modes for agents (e.g. grok)
  // that expose no runtime mode selector of their own.
  if (acpAdvertisesRuntimeModeSelector(agent.runtimeCapabilities)) {
    return [];
  }
  return [
    {
      mode: "default",
      label: "Default Access",
      available,
      isDefault: true,
      unavailableReason,
    },
    {
      mode: "full-access",
      label: "Full Access",
      available,
      unavailableReason,
    },
  ];
}

export function buildAcpLaunchpadOptions(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
  registryId?: string,
): BackendLaunchpadOptions | undefined {
  const modelOptions =
    runtimeCapabilities?.models?.availableModels.map(
      (model): BackendModelOption => {
        const isGrok45 = registryId === "grok" && model.id === "grok-4.5";
        return {
          id: model.id,
          label: model.label,
          current: runtimeCapabilities.models?.currentModelId === model.id,
          defaultReasoningEffort:
            model.defaultReasoningEffort ?? (isGrok45 ? "high" : undefined),
          reasoningEfforts:
            model.reasoningEfforts ??
            (isGrok45 ? ["low", "medium", "high"] : undefined),
          supportsReasoning:
            model.supportsReasoning ?? (isGrok45 ? true : undefined),
        };
      },
    ) ?? [];
  const configModelOption =
    runtimeCapabilities?.configOptions
      ?.find((option) => option.category === "model")
      ?.values.map(
        (value): BackendModelOption => ({
          id: value.value,
          label: value.label,
          current: runtimeCapabilities.configOptions?.some(
            (option) =>
              option.category === "model" &&
              option.currentValue === value.value,
          ),
        }),
      ) ?? [];
  const models = modelOptions.length > 0 ? modelOptions : configModelOption;
  return models.length > 0 ? { models } : undefined;
}

export function findAcpModelConfigOption(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
) {
  return runtimeCapabilities?.configOptions?.find(
    (option) => option.category === "model",
  );
}

export function findAcpThoughtLevelConfigOption(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
) {
  return runtimeCapabilities?.configOptions?.find(
    (option) => option.category === "thought_level",
  );
}

export function withAcpModelRuntimeSelection(params: {
  runtime: BackendAcpSessionRuntimeState | undefined;
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined;
  model: string | undefined;
  reasoningEffort?: string;
  now: number;
}): BackendAcpSessionRuntimeState | undefined {
  const model = params.model?.trim();
  if (!model) {
    return params.runtime;
  }

  const modelConfigOption = findAcpModelConfigOption(params.runtimeCapabilities);
  const hasModelList = Array.isArray(params.runtimeCapabilities?.models?.availableModels);
  const hasAdvertisedModel =
    params.runtimeCapabilities?.models?.availableModels.some(
      (option) => option.id === model,
    ) ?? false;
  const shouldSetCurrentModelId =
    !modelConfigOption && (hasAdvertisedModel || !hasModelList);
  const configValues = modelConfigOption
    ? {
        ...(params.runtime?.configValues ?? {}),
        [modelConfigOption.id]: model,
      }
    : params.runtime?.configValues;
  const thoughtLevelConfigOption = findAcpThoughtLevelConfigOption(
    params.runtimeCapabilities,
  );
  const configValuesWithReasoning =
    params.reasoningEffort && thoughtLevelConfigOption
      ? {
          ...(configValues ?? {}),
          [thoughtLevelConfigOption.id]: params.reasoningEffort,
        }
      : configValues;

  return {
    ...params.runtime,
    ...(shouldSetCurrentModelId ? { currentModelId: model } : {}),
    ...(params.reasoningEffort
      ? { reasoningEffort: params.reasoningEffort }
      : {}),
    ...(configValuesWithReasoning
      ? { configValues: configValuesWithReasoning }
      : {}),
    updatedAt: Math.max(params.runtime?.updatedAt ?? 0, params.now),
  };
}

export function mergeAcpRuntimeState(
  current: BackendAcpSessionRuntimeState | undefined,
  patch: BackendAcpSessionRuntimeState | undefined,
): BackendAcpSessionRuntimeState | undefined {
  if (!current && !patch) {
    return undefined;
  }
  return {
    ...current,
    ...patch,
    configValues: {
      ...(current?.configValues ?? {}),
      ...(patch?.configValues ?? {}),
    },
  };
}

export function acpRuntimeValueLooksPrivileged(value: string | undefined): boolean {
  // ACP agents such as Qwen implement Auto/Auto-Edit internally; only Yolo
  // means the client should bypass every permission request.
  return value === "yolo";
}

export function formatAcpRuntimeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.toLowerCase() === "yolo") {
    return "Yolo";
  }
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function acpSessionToThreadSummary(
  session: AcpSessionMetadata,
  capabilities?: AcpAgentCapabilities,
): AppServerThreadSummary {
  const workspaceHandoffAvailable =
    !acpSessionHasConversationHistory(session) ||
    capabilities?.liveWorkspaceHandoff === true;
  return {
    id: session.sessionId,
    title: session.title,
    titleSource:
      session.titleSource ??
      (session.title === "ACP session" ? "fallback" : "derived"),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    linkedDirectories: session.cwd
      ? [
          {
            id: session.cwd,
            label: path.basename(session.cwd) || session.cwd,
            path: session.cwd,
            kind: "local",
          },
        ]
      : [],
    source: session.backendId,
    executionMode: session.executionMode,
    acpRuntime: session.acpRuntime,
    workspaceHandoff: workspaceHandoffAvailable
      ? { available: true }
      : {
          available: false,
          unavailableReason: ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR,
        },
  };
}

export function acpSessionLoadFallbackReplay(
  session: AcpSessionMetadata,
  error: unknown,
): AppServerThreadReplay {
  const message = error instanceof Error ? error.message : String(error);
  return {
    entries: [
      {
        type: "activity",
        id: `acp-load-failed:${session.sessionId}`,
        createdAt: Date.now(),
        summary: "ACP transcript unavailable",
        status: "failed",
        details: [
          {
            id: `acp-load-failed:${session.sessionId}:detail`,
            kind: "read",
            label: message,
          },
        ],
      },
    ],
    messages: [],
    pagination: {
      supportsPagination: false,
      hasPreviousPage: false,
    },
    threadStatus: acpSessionThreadStatus(session.status),
  };
}

export function acpSessionThreadStatus(
  status: AcpSessionMetadata["status"],
): AppServerThreadStatus {
  return status === "active" || status === "idle" || status === "unknown"
    ? status
    : "unknown";
}

function mergeAcpReplayWithSyntheticHistory(
  replay: AppServerThreadReplay,
  syntheticReplay: AppServerThreadReplay,
): AppServerThreadReplay {
  const entryIds = new Set(replay.entries.map((entry) => entry.id));
  const messageIds = new Set(replay.messages.map((message) => message.id));
  const entries = [
    ...replay.entries,
    ...syntheticReplay.entries.filter((entry) => !entryIds.has(entry.id)),
  ].sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
  const messages = [
    ...replay.messages,
    ...syntheticReplay.messages.filter((message) => !messageIds.has(message.id)),
  ].sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
  return {
    ...replay,
    entries,
    messages,
    lastUserMessage:
      [...messages]
        .reverse()
        .find((message) => message.role === "user")?.text
      ?? replay.lastUserMessage,
    lastAssistantMessage:
      [...messages]
        .reverse()
        .find((message) => message.role === "assistant")?.text
      ?? replay.lastAssistantMessage,
  };
}

function selectedAcpModel(
  agent: AcpInstalledAgentRecord,
  session: AcpSessionMetadata | undefined,
): string | undefined {
  return (
    readAcpSelectedModel(session?.acpRuntime) ??
    agent.runtimeCapabilities?.models?.currentModelId ??
    agent.runtimeCapabilities?.configOptions?.find(
      (option) => option.category === "model",
    )?.currentValue
  );
}

export function isAcpSessionMissingForProjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No previous sessions found for this project") ||
    message.includes("Unknown sessionId")
  );
}

export function acpSessionHasConversationHistory(
  session: AcpSessionMetadata,
): boolean {
  return session.hasConversationHistory === true;
}

export function inputToAcpPrompt(
  input: AppServerTurnInputItem[],
): AcpPromptPayload | undefined {
  const promptContent: AcpPromptContentBlock[] = [];
  const parts: AppServerThreadMessagePart[] = [];

  for (const item of input) {
    if (item.type === "text") {
      const text = item.text.trim();
      if (text) {
        promptContent.push({ type: "text", text });
        parts.push({ type: "text", text });
      }
      continue;
    }

    if (item.type === "image") {
      const name = item.name?.trim();
      if (name) {
        promptContent.push({ type: "text", text: `Attached image filename: ${name}` });
      }
      parts.push({ type: "image", ...(name ? { alt: name } : {}), url: item.url });
      const image = parseImageDataUrl(item.url);
      if (image) {
        promptContent.push({
          type: "image",
          mimeType: image.mimeType,
          data: image.data,
        });
      } else {
        promptContent.push({ type: "text", text: "[Image attachment]" });
      }
      continue;
    }

    if (item.type === "file") {
      const text = `[File attachment: ${item.name}]`;
      promptContent.push({ type: "text", text });
      parts.push({
        type: "file",
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
      });
      continue;
    }

    if (item.type === "localFile") {
      const text = formatAcpLocalFileReference(item);
      promptContent.push({ type: "text", text });
      parts.push({ type: "text", text });
      continue;
    }

    const fileName = item.name?.trim() || path.basename(item.path);
    const text = `[Local image: ${fileName}]`;
    promptContent.push({ type: "text", text });
    parts.push({ type: "text", text });
  }

  if (promptContent.length === 0 && parts.length === 0) {
    return undefined;
  }

  return {
    prompt: parts
      .filter((part): part is Extract<AppServerThreadMessagePart, { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => part.text)
      .join("\n"),
    promptContent,
    parts,
  };
}

function formatAcpLocalFileReference(
  item: Extract<AppServerTurnInputItem, { type: "localFile" }>,
): string {
  const fileName = item.name?.trim() || path.basename(item.path);
  const metadata = [
    item.mimeType ? `Type: ${item.mimeType}` : undefined,
    typeof item.sizeBytes === "number"
      ? `Size: ${formatAcpByteSize(item.sizeBytes)}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const reference = metadata.length > 0
    ? `[Local file reference: ${fileName} (${item.path}) | ${metadata.join(" | ")}]`
    : `[Local file reference: ${fileName} (${item.path})]`;
  if (!item.textPreview) {
    return reference;
  }
  return [
    reference,
    item.textPreviewTruncated
      ? "Validated text preview (truncated):"
      : "Validated text preview:",
    "<pwragent-local-file-preview>",
    item.textPreview,
    "</pwragent-local-file-preview>",
  ].join("\n");
}

function formatAcpByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function parseImageDataUrl(
  url: string,
): { mimeType: string; data: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/iu.exec(
    url,
  );
  if (!match) {
    return undefined;
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

export class AcpBackendAdapter {
  private readonly acpAgentStore?: Pick<
    AcpAgentStoreLike,
    "getInstalledAgent" | "listInstalledAgents" | "upsertInstalledAgent"
  >;
  private readonly acpRolloutStore?: Pick<
    AcpRolloutStore,
    "appendUpdate" | "readReplay" | "readUpdates"
  >;
  private readonly acpSessionStore?: AcpSessionStoreLike;
  private readonly captureStores: ProtocolCaptureStore[];
  private readonly agentToolMcpServer?: AgentToolMcpServerLike;
  private readonly automationInspectionMcpCommand?: string;
  private readonly createAcpClient: AcpClientFactory;
  private readonly createAcpTransport?: AcpTransportFactory;
  private readonly discoverLocalAcpAgents: LocalAcpDiscovery;
  private readonly isAcpAgentEnabled?: (registryId: string) => boolean;
  private readonly resolveMcpConnectionServers?: AcpBackendAdapterOptions["resolveMcpConnectionServers"];
  private readonly emit: (event: AgentEvent) => Promise<void>;
  private readonly handleServerRequest: (
    backend: AcpBackendId,
    request: AppServerPendingRequestNotification,
  ) => Promise<unknown>;
  private readonly acpClients = new Map<AcpBackendId, AcpClientEntry>();
  // A non-loadable ACP session belongs to the process that created it. Launch
  // selection may replace the current client, but these owners must remain
  // addressable until adapter shutdown so later turns keep using that process.
  private readonly retainedAcpClients = new Map<
    AcpBackendId,
    Set<AcpClientEntry>
  >();
  private readonly acpClientResolutions = new Map<
    AcpBackendId,
    Promise<AcpRuntimeClient>
  >();
  private readonly liveToolUpdateResolver = new AcpLiveToolUpdateResolver();
  private readonly liveNotificationFingerprints = new Map<string, string>();
  private readonly providerStatuses = new Map<AcpBackendId, AcpProviderStatus>();
  private readonly providerStatusRefreshAttempts = new Map<AcpBackendId, number>();
  private readonly providerStatusRefreshes = new Map<AcpBackendId, Promise<void>>();
  private readonly grokUpdateChecker?: typeof checkGrokCliUpdate;
  private readonly grokUpdateRefreshes = new Map<AcpBackendId, Promise<void>>();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly closeTimeoutMs: number;
  private readonly liveTurnUsage = new Map<string, AcpLiveTurnUsage>();
  private localAcpAgentsRevision = 0;
  private localAcpAgentsPromise?: Promise<AcpInstalledAgentRecord[]>;

  constructor(options: AcpBackendAdapterOptions) {
    this.captureStores = options.captureStores;
    this.agentToolMcpServer = options.agentToolMcpServer;
    this.automationInspectionMcpCommand = options.automationInspectionMcpCommand;
    this.emit = options.emit;
    this.handleServerRequest = options.handleServerRequest;
    this.resolveMcpConnectionServers = options.resolveMcpConnectionServers;
    this.closeTimeoutMs = options.closeTimeoutMs ?? ACP_CLOSE_TIMEOUT_MS;
    this.grokUpdateChecker = options.checkGrokCliUpdate === null
      ? undefined
      : options.checkGrokCliUpdate
        ?? (isAppStateInitialized() ? checkGrokCliUpdate : undefined);
    this.acpAgentStore =
      options.acpAgentStore === null
        ? undefined
        : options.acpAgentStore ??
          (isAppStateInitialized()
            ? new AcpAgentStore(getAppStateDb())
            : undefined);
    this.acpSessionStore =
      options.acpSessionStore === null
        ? undefined
        : options.acpSessionStore ??
          (isAppStateInitialized()
            ? new AcpSessionStore(getAppStateDb())
            : undefined);
    this.acpRolloutStore =
      options.acpRolloutStore === null
        ? undefined
        : options.acpRolloutStore ??
          (isAppStateInitialized()
            ? new AcpRolloutStore(resolveDefaultAcpRolloutRoot())
            : undefined);
    this.discoverLocalAcpAgents = options.discoverLocalAcpAgents;
    this.isAcpAgentEnabled = options.isAcpAgentEnabled;
    this.createAcpTransport = options.createAcpTransport;
    this.createAcpClient =
      options.createAcpClient ?? ((agent) => this.createDefaultClient(agent));
  }

  async describeInstalledBackends(): Promise<BackendSummary[]> {
    const config = readDesktopSettingsConfigSafe();
    const installedAgents = await this.listAvailableAgents();
    const enabledAgents = installedAgents
      .filter((agent) =>
        this.isAcpAgentEnabled
          ? this.isAcpAgentEnabled(agent.registryId)
          : acpAgentEnabledFor(config, agent.registryId),
      );
    return enabledAgents.map((agent) => {
      const summary = describeInstalledAcpBackend(agent);
      if (agent.registryId !== "grok" || !summary.available) {
        return summary;
      }
      this.refreshGrokUpdateStatusInBackground(agent);
      // Backend discovery is also used by launchpad and messaging flows.
      // Merge only cached decoration here; vendor billing must never delay it.
      const providerStatus = this.providerStatuses.get(agent.backendId);
      this.refreshProviderStatusInBackground(agent.backendId);
      return providerStatus
        ? {
            ...summary,
            account: providerStatus.account,
            rateLimits: providerStatus.rateLimits,
          }
        : summary;
    });
  }

  private refreshGrokUpdateStatusInBackground(
    agent: AcpInstalledAgentRecord,
  ): void {
    if (agent.launchDescriptor?.env?.GROK_INSTALLER === "pwragent") {
      // Managed and bundled PwrAgent builds follow the verified GitHub release
      // feed. The vendor updater follows a different channel and must not
      // decorate these runtimes with an unrelated update notice.
      return;
    }
    const checker = this.grokUpdateChecker;
    const command = agent.activeCommand ?? agent.launchDescriptor?.command;
    const previous =
      agent.updateCommand === command
      && agent.version === agent.update?.currentVersion
        ? agent.update
        : undefined;
    if (
      !checker
      || !command
      || this.closed
      || this.grokUpdateRefreshes.has(agent.backendId)
      || !shouldCheckGrokCliUpdate({
        command,
        installedVersion: agent.version,
        now: Date.now(),
        previous,
        previousCommand: agent.updateCommand,
      })
    ) {
      return;
    }

    const refresh = checker(command, {
      installedVersion: agent.version,
      previous,
    })
      .then(async (update) => {
        if (this.closed) return;
        const current = this.acpAgentStore?.getInstalledAgent(agent.backendId)
          ?? agent;
        const currentCommand =
          current.activeCommand ?? current.launchDescriptor?.command;
        if (
          currentCommand !== command
          || current.version !== agent.version
        ) {
          return;
        }
        const mergedUpdate = preserveGrokUpdateAcknowledgement(
          current.update,
          update,
        );
        this.acpAgentStore?.upsertInstalledAgent({
          ...current,
          ...(mergedUpdate.status !== "failed"
            && mergedUpdate.currentVersion !== "unknown"
            ? { version: mergedUpdate.currentVersion }
            : {}),
          update: mergedUpdate,
          updateCommand: command,
        });
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "backend/acpUpdateStatus/updated",
            params: { backend: agent.backendId },
          },
        });
      })
      .catch((error) => {
        acpBackendAdapterLog.debug("grok_update_check_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.grokUpdateRefreshes.get(agent.backendId) === refresh) {
          this.grokUpdateRefreshes.delete(agent.backendId);
        }
      });
    this.grokUpdateRefreshes.set(agent.backendId, refresh);
  }

  private refreshProviderStatusInBackground(backend: AcpBackendId): void {
    const clientPromise = this.acpClients.get(backend)?.promise;
    if (
      this.closed
      || !clientPromise
      || this.providerStatusRefreshes.has(backend)
    ) {
      return;
    }
    const now = Date.now();
    const lastAttempt = this.providerStatusRefreshAttempts.get(backend);
    if (
      lastAttempt !== undefined
      && now - lastAttempt < ACP_PROVIDER_STATUS_CACHE_TTL_MS
    ) {
      return;
    }
    this.providerStatusRefreshAttempts.set(backend, now);
    const refreshPromise = this.refreshProviderStatus(backend, clientPromise);
    this.providerStatusRefreshes.set(backend, refreshPromise);
    void refreshPromise.finally(() => {
      if (this.providerStatusRefreshes.get(backend) === refreshPromise) {
        this.providerStatusRefreshes.delete(backend);
      }
    });
  }

  private async refreshProviderStatus(
    backend: AcpBackendId,
    clientPromise: Promise<AcpRuntimeClient>,
  ): Promise<void> {
    try {
      const client = await clientPromise;
      const providerStatus = await client.readProviderStatus?.();
      if (!providerStatus || this.closed) {
        return;
      }
      this.providerStatuses.set(backend, providerStatus);
      await this.emit({
        backend,
        notification: {
          method: "backend/providerStatus/updated",
          params: { backend },
        },
      });
    } catch (error) {
      acpBackendAdapterLog.debug("acp_provider_status_unavailable", {
        backend,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  invalidateLocalAgentDiscovery(): void {
    this.localAcpAgentsRevision += 1;
    this.localAcpAgentsPromise = undefined;
  }

  listSessions(
    backendId: AcpBackendId,
    options?: { archived?: boolean },
  ): AcpSessionMetadata[] {
    return this.acpSessionStore?.listSessions(backendId, options) ?? [];
  }

  getSession(
    backendId: AcpBackendId,
    sessionId: string,
  ): AcpSessionMetadata | undefined {
    return this.acpSessionStore?.getSession(backendId, sessionId);
  }

  upsertSession(session: AcpSessionMetadata): void {
    this.acpSessionStore?.upsertSession?.(session);
  }

  persistSyntheticAssistantMessage(params: {
    backend: AcpBackendId;
    messageId: string;
    receivedAt: number;
    sessionId: string;
    source: string;
    text: string;
  }): boolean {
    if (!this.acpRolloutStore) {
      return false;
    }
    this.acpRolloutStore.appendUpdate({
      backendId: params.backend,
      sessionId: params.sessionId,
      receivedAt: params.receivedAt,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: params.text,
        },
        messageId: params.messageId,
        _meta: {
          pwragentSynthetic: true,
          source: params.source,
        },
      },
    });
    const session = this.getSession(params.backend, params.sessionId);
    if (session) {
      this.upsertSession({
        ...session,
        hasConversationHistory: true,
        updatedAt: Math.max(session.updatedAt, params.receivedAt),
      });
    }
    return true;
  }

  getInstalledAgent(backendId: AcpBackendId): AcpInstalledAgentRecord | undefined {
    const agent = this.acpAgentStore?.getInstalledAgent(backendId);
    return agent ? normalizeInstalledAcpAgent(agent) : undefined;
  }

  sessionToThreadSummary(session: AcpSessionMetadata): AppServerThreadSummary {
    const agent = this.getInstalledAgent(session.backendId);
    const capabilities = agent
      ? effectiveAcpAgentCapabilities(agent)
      : undefined;
    return acpSessionToThreadSummary(session, capabilities);
  }

  getLaunchpadOptions(
    backend: AppServerBackendKind,
  ): BackendLaunchpadOptions | undefined {
    if (!isAcpBackendId(backend)) {
      return undefined;
    }
    const agent = this.acpAgentStore?.getInstalledAgent(backend);
    return buildAcpLaunchpadOptions(
      agent?.runtimeCapabilities,
      agent?.registryId,
    );
  }

  async readReplay(
    backend: AcpBackendId,
    sessionId: string,
  ): Promise<AppServerThreadReplay> {
    const session = this.getSession(backend, sessionId);
    const cachedClient = await (
      this.findSessionOwner(backend, sessionId) ?? this.acpClients.get(backend)
    )
      ?.promise.catch(() => undefined);
    if (cachedClient) {
      const replay = cachedClient.readReplay(sessionId);
      if (
        session &&
        acpSessionHasConversationHistory(session) &&
        replay.entries.length === 0 &&
        acpRuntimeSupportsSessionLoad(
          this.getInstalledAgent(backend)?.runtimeCapabilities,
        )
      ) {
        try {
          const replay = await cachedClient.loadSession(session);
          return this.providerReplayOrRolloutFallback({
            backend,
            observedSessionHistoryReplay:
              observedAcpSessionHistoryReplay(cachedClient, session.sessionId),
            replay,
            session,
          });
        } catch (error) {
          acpBackendAdapterLog.warn("acp_session_load_failed", {
            backend,
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
          return this.loadFailureReplayOrRolloutFallback({
            backend,
            error,
            session,
          });
        }
      }
      if (
        session &&
        replay.entries.length === 0 &&
        !acpRuntimeSupportsSessionLoad(
          this.getInstalledAgent(backend)?.runtimeCapabilities,
        )
      ) {
        return this.readRolloutReplay(session, "rollout-session-load-unsupported");
      }
      const replayWithSyntheticHistory = session
        ? this.mergeReplayWithSyntheticHistory(session, replay)
        : replay;
      this.logSessionReplaySource({
        backend,
        entries: replayWithSyntheticHistory.entries.length,
        messages: replayWithSyntheticHistory.messages.length,
        sessionId,
        source: "memory",
      });
      return replayWithSyntheticHistory;
    }

    if (!session) {
      const replay = new AcpSessionReplayNormalizer().replay();
      this.logSessionReplaySource({
        backend,
        entries: 0,
        messages: 0,
        sessionId,
        source: "empty-no-session",
      });
      return replay;
    }

    if (
      !acpRuntimeSupportsSessionLoad(
        this.getInstalledAgent(backend)?.runtimeCapabilities,
      )
    ) {
      return this.readRolloutReplay(session, "rollout-session-load-unsupported");
    }
    const client = await this.getClient(backend);
    try {
      const replay = await client.loadSession(session);
      void client.refreshSession(session).catch((error) => {
        acpBackendAdapterLog.warn("acp_session_load_failed", {
          backend,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
      return this.providerReplayOrRolloutFallback({
        backend,
        observedSessionHistoryReplay:
          observedAcpSessionHistoryReplay(client, session.sessionId),
        replay,
        session,
      });
    } catch (error) {
      acpBackendAdapterLog.warn("acp_session_load_failed", {
        backend,
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
      return this.loadFailureReplayOrRolloutFallback({
        backend,
        error,
        session,
      });
    }
  }

  async listRewindPoints(
    backend: AcpBackendId,
    sessionId: string,
  ): Promise<AcpThreadRewindPoint[]> {
    const session = this.requireIdleGrokRewindSession(backend, sessionId);
    const client = await this.getClientForSession(backend, sessionId);
    if (!client.listRewindPoints) {
      throw new Error("Installed Grok Build does not support conversation rewind");
    }
    await client.ensureSession(session);
    return await client.listRewindPoints(sessionId);
  }

  async rewindSession(params: {
    backend: AcpBackendId;
    sessionId: string;
    targetPromptIndex: number;
  }): Promise<{ promptText?: string; updatedAt: number }> {
    const session = this.requireIdleGrokRewindSession(
      params.backend,
      params.sessionId,
    );
    const client = await this.getClientForSession(
      params.backend,
      params.sessionId,
    );
    if (!client.rewindSession) {
      throw new Error("Installed Grok Build does not support conversation rewind");
    }
    await client.ensureSession(session);
    return await client.rewindSession({
      sessionId: params.sessionId,
      targetPromptIndex: params.targetPromptIndex,
    });
  }

  async steerSession(params: {
    backend: AcpBackendId;
    content: AcpPromptContentBlock[];
    interjectionId: string;
    sessionId: string;
    text: string;
  }): Promise<{ delivery: "currentTurn" | "nextTurn" }> {
    if (params.backend !== "acp:grok") {
      throw new Error(`ACP backend ${params.backend} does not support turn steering`);
    }
    const session = this.getSession(params.backend, params.sessionId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("The Grok turn finished before steering was accepted");
    }
    const client = await this.getClientForSession(
      params.backend,
      params.sessionId,
    );
    if (!client.steerSession) {
      throw new Error("Installed Grok Build does not support turn steering over ACP");
    }
    return await client.steerSession({
      sessionId: params.sessionId,
      text: params.text,
      content: params.content,
      interjectionId: params.interjectionId,
    });
  }

  async configureWorkflowBudget(params: {
    backend: "acp:grok";
    sessionId: string;
    defaultAgentBudget?: number;
    maxAgentBudget?: number;
  }): Promise<GrokWorkflowBudgetPolicy> {
    const session = this.getSession(params.backend, params.sessionId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.sessionId}`);
    }
    if (session.status === "active") {
      throw new Error("Wait for the active Grok turn to finish before changing budgets");
    }
    const client = await this.getClientForSession(
      params.backend,
      params.sessionId,
    );
    if (!client.configureWorkflowBudget) {
      throw new Error("Installed Grok Build does not support workflow budget controls");
    }
    await client.ensureSession(session);
    return await client.configureWorkflowBudget({
      sessionId: params.sessionId,
      defaultAgentBudget: params.defaultAgentBudget,
      maxAgentBudget: params.maxAgentBudget,
    });
  }

  private requireIdleGrokRewindSession(
    backend: AcpBackendId,
    sessionId: string,
  ): AcpSessionMetadata {
    if (backend !== "acp:grok") {
      throw new Error("Conversation rewind is only available for Grok Build threads");
    }
    const session = this.getSession(backend, sessionId);
    if (!session) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    if (session.status === "active") {
      throw new Error("Wait for the active Grok turn to finish before rewinding");
    }
    return session;
  }

  async getClient(backend: AcpBackendId): Promise<AcpRuntimeClient> {
    if (this.closed) {
      throw new Error("ACP backend adapter is closed");
    }
    const resolving = this.acpClientResolutions.get(backend);
    if (resolving) {
      return await resolving;
    }

    const resolution = this.resolveClient(backend);
    this.acpClientResolutions.set(backend, resolution);
    try {
      return await resolution;
    } finally {
      if (this.acpClientResolutions.get(backend) === resolution) {
        this.acpClientResolutions.delete(backend);
      }
    }
  }

  async getClientForSession(
    backend: AcpBackendId,
    sessionId: string,
  ): Promise<AcpRuntimeClient> {
    let current: AcpRuntimeClient;
    try {
      current = await this.getClient(backend);
    } catch (error) {
      // A broken replacement path must not strand a session whose original
      // process is still alive. New sessions still observe the launch failure.
      const owner = this.findSessionOwner(backend, sessionId);
      if (owner) {
        return await owner.promise;
      }
      throw error;
    }
    if (current.ownsSession?.(sessionId) === true) {
      return current;
    }
    const owner = this.findSessionOwner(backend, sessionId);
    return owner ? await owner.promise : current;
  }

  private async resolveClient(backend: AcpBackendId): Promise<AcpRuntimeClient> {
    const agent = await this.resolveInstalledAgent(backend);
    if (this.closed) {
      throw new Error("ACP backend adapter is closed");
    }
    const launchIdentity = acpAgentLaunchIdentity(agent);
    const cached = this.acpClients.get(backend);
    if (cached?.launchIdentity === launchIdentity) {
      return await cached.promise;
    }
    if (cached) {
      // One ACP client owns every live turn and RPC for this backend. Keep
      // routing to that process until its last operation reaches a terminal
      // state; the next idle lookup adopts the new path.
      if (
        cached.client.hasActiveTurns?.() === true
        || cached.client.hasActiveOperations?.() === true
      ) {
        return await cached.promise;
      }
      this.acpClients.delete(backend);
      const supportsSessionLoad =
        cached.client.supportsSessionLoad?.() ?? cached.supportsSessionLoad;
      if (
        !supportsSessionLoad
        && cached.client.hasRetainableSessions?.() === true
      ) {
        // Replace the launch target without replacing ownership of sessions
        // that the new process has no protocol method to recover.
        this.retainAcpClient(backend, cached);
      } else {
        await this.disposeAcpClient(cached);
      }
      if (this.closed) {
        throw new Error("ACP backend adapter is closed");
      }
    }

    const client = this.createAcpClient(agent);
    const entry: AcpClientEntry = {
      client,
      launchIdentity,
      promise: Promise.resolve(client),
      supportsSessionLoad: acpRuntimeSupportsSessionLoad(
        agent.runtimeCapabilities,
      ),
    };
    entry.promise = (async () => {
      await client.initialize();
      if (this.closed) {
        await this.disposeAcpClient(entry);
        throw new Error("ACP backend adapter is closed");
      }
      return client;
    })();
    this.acpClients.set(backend, entry);
    entry.promise.catch(() => {
      if (this.acpClients.get(backend) === entry) {
        this.acpClients.delete(backend);
      }
    });
    return await entry.promise;
  }

  private readRolloutReplay(
    session: AcpSessionMetadata,
    source: string,
  ): AppServerThreadReplay {
    const replay =
      this.acpRolloutStore?.readReplay({
        backendId: session.backendId,
        sessionId: session.sessionId,
      }) ?? new AcpSessionReplayNormalizer().replay();
    this.logSessionReplaySource({
      backend: session.backendId,
      entries: replay.entries.length,
      messages: replay.messages.length,
      sessionId: session.sessionId,
      source,
    });
    return {
      ...replay,
      threadStatus: acpSessionThreadStatus(session.status),
    };
  }

  private mergeReplayWithSyntheticHistory(
    session: AcpSessionMetadata,
    replay: AppServerThreadReplay,
  ): AppServerThreadReplay {
    if (!this.acpRolloutStore) {
      return inferAcpReplayTurns(replay);
    }
    const normalizer = new AcpSessionReplayNormalizer({
      surfaceThoughtsAsMessages: shouldSurfaceAcpThoughtsAsMessages(
        session.backendId,
      ),
    });
    let syntheticUpdateCount = 0;
    for (const record of this.acpRolloutStore.readUpdates({
      backendId: session.backendId,
      sessionId: session.sessionId,
    })) {
      if (!isPwrAgentSyntheticAcpUpdate(record.update)) {
        continue;
      }
      syntheticUpdateCount += 1;
      normalizer.apply({
        sessionId: session.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    return inferAcpReplayTurns(
      syntheticUpdateCount > 0
        ? mergeAcpReplayWithSyntheticHistory(replay, normalizer.replay())
        : replay,
    );
  }

  private providerReplayOrRolloutFallback(params: {
    backend: AcpBackendId;
    observedSessionHistoryReplay?: boolean;
    replay: AppServerThreadReplay;
    session: AcpSessionMetadata;
  }): AppServerThreadReplay {
    const { backend, replay, session } = params;

    // ACP agents commonly replay the transcript as session/update
    // notifications during session/load rather than advertising
    // sessionHistoryReplay. Prefer a replay that the client observed, but
    // retain the advertised flag and rollout fallback for older providers and
    // Gemini's non-transcript session_context bootstrap.
    const supportsHistoryReplay =
      params.observedSessionHistoryReplay === true ||
      acpRuntimeSupportsSessionHistoryReplay(
        this.getInstalledAgent(backend)?.runtimeCapabilities,
      );
    if (!supportsHistoryReplay) {
      const rolloutReplay =
        this.acpRolloutStore?.readReplay({
          backendId: session.backendId,
          sessionId: session.sessionId,
        }) ?? new AcpSessionReplayNormalizer().replay();
      if (rolloutReplay.entries.length > 0) {
        this.logSessionReplaySource({
          backend,
          entries: rolloutReplay.entries.length,
          messages: rolloutReplay.messages.length,
          providerEntries: replay.entries.length,
          providerMessages: replay.messages.length,
          sessionId: session.sessionId,
          source: "rollout-preferred-no-history-replay",
        });
        return {
          ...rolloutReplay,
          threadStatus: acpSessionThreadStatus(session.status),
        };
      }
      // No rollout yet (e.g. a brand-new session opened before any turn
      // persisted) — fall back to whatever the provider gave us.
      this.logSessionReplaySource({
        backend,
        entries: replay.entries.length,
        messages: replay.messages.length,
        sessionId: session.sessionId,
        source: "provider-no-rollout-no-history-replay",
      });
      return replay;
    }

    if (replay.entries.length > 0 || !acpSessionHasConversationHistory(session)) {
      this.logSessionReplaySource({
        backend,
        entries: replay.entries.length,
        messages: replay.messages.length,
        sessionId: session.sessionId,
        source:
          replay.entries.length > 0
            ? "provider-session-load"
            : "provider-session-load-empty",
      });
      return this.mergeReplayWithSyntheticHistory(session, replay);
    }

    const rolloutReplay =
      this.acpRolloutStore?.readReplay({
        backendId: session.backendId,
        sessionId: session.sessionId,
      }) ?? new AcpSessionReplayNormalizer().replay();
    if (rolloutReplay.entries.length === 0) {
      this.logSessionReplaySource({
        backend,
        entries: replay.entries.length,
        messages: replay.messages.length,
        sessionId: session.sessionId,
        source: "provider-session-load-empty-no-rollout",
      });
      return this.mergeReplayWithSyntheticHistory(session, replay);
    }

    this.logSessionReplaySource({
      backend,
      entries: rolloutReplay.entries.length,
      messages: rolloutReplay.messages.length,
      providerEntries: replay.entries.length,
      providerMessages: replay.messages.length,
      sessionId: session.sessionId,
      source: "rollout-provider-empty",
    });
    return {
      ...rolloutReplay,
      threadStatus: acpSessionThreadStatus(session.status),
    };
  }

  private loadFailureReplayOrRolloutFallback(params: {
    backend: AcpBackendId;
    error: unknown;
    session: AcpSessionMetadata;
  }): AppServerThreadReplay {
    const rolloutReplay =
      this.acpRolloutStore?.readReplay({
        backendId: params.session.backendId,
        sessionId: params.session.sessionId,
      }) ?? new AcpSessionReplayNormalizer().replay();
    if (rolloutReplay.entries.length > 0) {
      this.logSessionReplaySource({
        backend: params.backend,
        entries: rolloutReplay.entries.length,
        messages: rolloutReplay.messages.length,
        sessionId: params.session.sessionId,
        source: "rollout-session-load-failed",
      });
      return {
        ...rolloutReplay,
        threadStatus: acpSessionThreadStatus(params.session.status),
      };
    }

    const replay = acpSessionLoadFallbackReplay(params.session, params.error);
    this.logSessionReplaySource({
      backend: params.backend,
      entries: replay.entries.length,
      messages: replay.messages.length,
      sessionId: params.session.sessionId,
      source: "session-load-failed",
    });
    return replay;
  }

  private logSessionReplaySource(params: {
    backend: AcpBackendId;
    entries: number;
    messages: number;
    providerEntries?: number;
    providerMessages?: number;
    sessionId: string;
    source: string;
  }): void {
    acpBackendAdapterLog.info("acp_session_replay_source", params);
  }

  async resolveInstalledAgent(
    backend: AcpBackendId,
  ): Promise<AcpInstalledAgentRecord> {
    const agent = (await this.listAvailableAgents()).find(
      (candidate) => candidate.backendId === backend,
    );
    if (!agent) {
      throw new Error(`ACP backend is not installed: ${backend}`);
    }
    if (agent.installStatus !== "installed") {
      throw new Error(`ACP backend is not installed: ${backend}`);
    }
    if (agent.authStatus !== "not-required" && agent.authStatus !== "authenticated") {
      throw new Error(`ACP backend authentication required: ${backend}`);
    }
    return agent;
  }

  async supportsLiveWorkspaceHandoff(backend: AcpBackendId): Promise<boolean> {
    const agent = await this.resolveInstalledAgent(backend);
    return effectiveAcpAgentCapabilities(agent).liveWorkspaceHandoff;
  }

  supportsManagedReview(backend: AcpBackendId): boolean {
    const agent = this.getInstalledAgent(backend);
    return Boolean(agent && effectiveAcpAgentCapabilities(agent).managedReview);
  }

  async listAvailableAgents(): Promise<AcpInstalledAgentRecord[]> {
    while (true) {
      const discovery = await this.readLocalAgentsOnce();
      if (discovery.revision !== this.localAcpAgentsRevision) {
        continue;
      }
      // Keep the revision check and all consumption synchronous. An
      // invalidation queued after discovery settles must run before this
      // point or after stale results have been fully merged and persisted.
      return this.mergeAndPersistDiscoveredAgents(discovery.agents);
    }
  }

  private mergeAndPersistDiscoveredAgents(
    agents: AcpInstalledAgentRecord[],
  ): AcpInstalledAgentRecord[] {
    const discoveredAgents = agents
      .map(normalizeInstalledAcpAgent)
      .filter((agent) => !isBannedAcpRegistryId(agent.registryId));
    // Discovery probes are asynchronous and can overlap runtime-capability or
    // update-check writes. Read the durable cache only after discovery, then
    // merge and persist synchronously so those newer fields cannot be rolled
    // back by a snapshot captured before the probe started.
    const installedAgents = (this.acpAgentStore?.listInstalledAgents() ?? [])
      .map(normalizeInstalledAcpAgent)
      .filter((agent) => !isBannedAcpRegistryId(agent.registryId));
    const installedByBackendId = new Map(
      installedAgents.map((agent) => [agent.backendId, agent]),
    );
    const effectiveDiscoveredAgents = discoveredAgents.map((agent) => {
      const cached = installedByBackendId.get(agent.backendId);
      const sameRuntime =
        agent.installStatus === "installed"
        && cached?.installStatus === "installed"
        && cached.version === agent.version
        && acpAgentLaunchIdentity(cached) === acpAgentLaunchIdentity(agent);
      return {
        ...agent,
        installedAt: cached?.installedAt ?? agent.installedAt,
        updatedAt:
          sameRuntime && cached
            ? Math.max(agent.updatedAt, cached.updatedAt)
            : agent.updatedAt,
        ...(sameRuntime && cached?.runtimeCapabilities
          ? { runtimeCapabilities: cached.runtimeCapabilities }
          : {}),
        ...(sameRuntime && cached?.lastDiscoveredAt !== undefined
          ? { lastDiscoveredAt: cached.lastDiscoveredAt }
          : {}),
        ...(sameRuntime && cached?.lastDiscoveryError !== undefined
          ? { lastDiscoveryError: cached.lastDiscoveryError }
          : {}),
        ...(sameRuntime && cached?.update !== undefined
          ? { update: cached.update }
          : {}),
        ...(sameRuntime && cached?.updateCommand !== undefined
          ? { updateCommand: cached.updateCommand }
          : {}),
      };
    });
    for (const agent of effectiveDiscoveredAgents) {
      const cached = installedByBackendId.get(agent.backendId);
      if (!cached || JSON.stringify(cached) !== JSON.stringify(agent)) {
        // Fresh discovery owns launch selection. The durable record is a cache
        // of that result, never an authority that can suppress a new override.
        this.acpAgentStore?.upsertInstalledAgent(agent);
      }
    }
    const discoveredBackendIds = new Set(
      effectiveDiscoveredAgents.map((agent) => agent.backendId),
    );
    return [
      ...effectiveDiscoveredAgents,
      ...installedAgents.filter(
        (agent) => !discoveredBackendIds.has(agent.backendId),
      ),
    ];
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closed = true;
    const acpClients = [
      ...this.acpClients.entries(),
      ...[...this.retainedAcpClients.entries()].flatMap(([backend, entries]) =>
        [...entries].map(
          (entry): [AcpBackendId, AcpClientEntry] => [backend, entry],
        ),
      ),
    ];
    this.acpClients.clear();
    this.retainedAcpClients.clear();
    this.acpClientResolutions.clear();
    this.liveToolUpdateResolver.clear();
    this.liveNotificationFingerprints.clear();
    this.providerStatuses.clear();
    this.providerStatusRefreshAttempts.clear();
    this.providerStatusRefreshes.clear();
    this.grokUpdateRefreshes.clear();
    this.liveTurnUsage.clear();
    this.closePromise = this.closeResources(acpClients);
    return await this.closePromise;
  }

  private async closeResources(
    acpClients: Array<[AcpBackendId, AcpClientEntry]>,
  ): Promise<void> {
    const resources = [
      ...acpClients.map(async ([backend, entry]) => {
        const dispose = this.disposeAcpClient(entry);
        const [, disposeResult] = await Promise.allSettled([
          entry.promise,
          dispose,
        ]);
        if (disposeResult.status === "rejected") {
          throw disposeResult.reason;
        }
        acpBackendAdapterLog.info("acp_client_closed", { backend });
      }),
      Promise.resolve().then(() => this.agentToolMcpServer?.close()),
    ];
    const cleanup = Promise.allSettled(resources).then((results) => {
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          acpBackendAdapterLog.warn("acp_resource_close_failed", {
            resource:
              index < acpClients.length
                ? acpClients[index]?.[0]
                : "agent-tool-mcp",
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      }
    });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      cleanup.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), this.closeTimeoutMs);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      acpBackendAdapterLog.warn("acp_close_timed_out", {
        clientCount: acpClients.length,
        timeoutMs: this.closeTimeoutMs,
      });
    }
  }

  private disposeAcpClient(entry: AcpClientEntry): Promise<void> {
    entry.disposePromise ??= Promise.resolve().then(() => entry.client.dispose());
    return entry.disposePromise;
  }

  private retainAcpClient(
    backend: AcpBackendId,
    entry: AcpClientEntry,
  ): void {
    const retained = this.retainedAcpClients.get(backend) ?? new Set();
    retained.add(entry);
    this.retainedAcpClients.set(backend, retained);
  }

  private findSessionOwner(
    backend: AcpBackendId,
    sessionId: string,
  ): AcpClientEntry | undefined {
    const current = this.acpClients.get(backend);
    if (current?.client.ownsSession?.(sessionId) === true) {
      return current;
    }
    return [...(this.retainedAcpClients.get(backend) ?? [])].find(
      (entry) => entry.client.ownsSession?.(sessionId) === true,
    );
  }

  private shouldEmitLiveToolNotification(
    backend: AcpBackendId,
    notification: AppServerNotification,
  ): boolean {
    const key = liveToolNotificationKey(backend, notification);
    const fingerprint = liveToolNotificationFingerprint(notification);
    if (!key || !fingerprint) {
      return true;
    }
    const previous = this.liveNotificationFingerprints.get(key);
    if (previous === fingerprint) {
      return false;
    }
    this.liveNotificationFingerprints.set(key, fingerprint);
    return true;
  }

  private clearLiveToolNotificationFingerprints(params: {
    backend: AcpBackendId;
    threadId: string;
    turnId: string;
  }): void {
    const prefix = `${params.backend}:${params.threadId}:${params.turnId}:`;
    for (const key of this.liveNotificationFingerprints.keys()) {
      if (key.startsWith(prefix)) {
        this.liveNotificationFingerprints.delete(key);
      }
    }
  }

  private async readLocalAgentsOnce(): Promise<{
    agents: AcpInstalledAgentRecord[];
    revision: number;
  }> {
    const revision = this.localAcpAgentsRevision;
    this.localAcpAgentsPromise ??= this.discoverLocalAcpAgents().catch((error) => {
      acpBackendAdapterLog.debug("local_acp_discovery_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    return {
      agents: await this.localAcpAgentsPromise,
      revision,
    };
  }

  private createDefaultClient(agent: AcpInstalledAgentRecord): AcpRuntimeClient {
    if (!agent.launchDescriptor) {
      throw new Error(`ACP backend ${agent.backendId} has no launch descriptor`);
    }
    if (!this.acpSessionStore?.upsertSession) {
      throw new Error("ACP session store is unavailable");
    }
    const acpCapture = createProtocolCaptureFromEnv({
      backend: agent.backendId,
      backendInstance: "default",
    });
    if (acpCapture) {
      this.captureStores.push(acpCapture.store);
    }
    return new AcpAgentClient({
      backendId: agent.backendId,
      agentDisplayName: agent.name,
      initialRuntimeCapabilities: acpRuntimeCapabilitiesForAgent(agent),
      rolloutStore: this.acpRolloutStore,
      store: this.acpSessionStore as AcpSessionStoreContract,
      transport:
        this.createAcpTransport?.(agent) ??
        new AcpStdioJsonRpcTransport({
          launchDescriptor: agent.launchDescriptor,
          observer: createCompositeJsonRpcObserver([
            acpCapture?.observer,
            createProtocolLogObserverFromEnv({
              backend: agent.backendId,
            }),
          ]),
        }),
      onSessionUpdate: async ({
        assistantMessageItemId,
        fromSessionLoad,
        sessionId,
        replay,
        title,
        turnId,
        update,
      }) => {
        const updateKind = readAcpUpdateKind(update);
        const usageEnvelope = readAcpUsageEnvelope(update);
        let liveUsageNotification: AppServerNotification | undefined;
        if (usageEnvelope && turnId) {
          const usageKey = [agent.backendId, sessionId, turnId].join(":");
          const previousUsage = this.liveTurnUsage.get(usageKey);
          const model =
            usageEnvelope.model ??
            previousUsage?.model ??
            selectedAcpModel(
              agent,
              this.getSession(agent.backendId, sessionId),
            );
          const tokenUsage = foldAcpTurnUsage(
            previousUsage?.tokenUsage,
            usageEnvelope,
          );
          this.liveTurnUsage.set(usageKey, { model, tokenUsage });
          // Publish each model call as it lands rather than banking the whole
          // turn until `turn_finished`. A long turn — a managed review runs
          // for minutes across a dozen calls — otherwise reports no usage at
          // all while it runs, which is what leaves the review sub-agent card
          // blank next to Codex's live one. Session-load replay is excluded:
          // those envelopes are history, not new spend.
          //
          // `totalTokenUsage` here is the running total for THIS TURN, since
          // `liveTurnUsage` is keyed by turn and dropped at `turn_finished`.
          // That is the ACP convention; Codex sends a session-cumulative total
          // in the same field. See the note on `AcpUsageEnvelope` before
          // changing this payload's shape.
          if (usageEnvelope.scope === "model-call" && !fromSessionLoad) {
            liveUsageNotification = acpUsageNotification({
              envelope: {
                ...(model ? { model } : {}),
                scope: "model-call",
                tokenUsage: usageEnvelope.tokenUsage,
              },
              threadId: sessionId,
              totalTokenUsage: tokenUsage,
              turnId,
            });
          }
        }
        const completedUsage =
          updateKind === "turn_finished" && turnId
            ? this.liveTurnUsage.get(
                [agent.backendId, sessionId, turnId].join(":"),
              )
            : undefined;
        const usageNotification = completedUsage
          ? acpUsageNotification({
              envelope: {
                ...(completedUsage.model
                  ? { model: completedUsage.model }
                  : {}),
                scope: "turn",
                tokenUsage: completedUsage.tokenUsage,
              },
              threadId: sessionId,
              totalTokenUsage: completedUsage.tokenUsage,
              turnId,
            })
          : liveUsageNotification;
        const agentMessageDelta =
          updateKind === "agent_message_chunk"
            ? readAcpUpdateText(update)
            : undefined;
        const resolvedToolUpdate = fromSessionLoad
          ? undefined
          : this.liveToolUpdateResolver.resolve({
              backendId: agent.backendId,
              threadId: sessionId,
              turnId,
              update,
            });
        const toolNotifications = resolvedToolUpdate
          ? acpToolUpdateNotifications({
              threadId: sessionId,
              turnId,
              update: resolvedToolUpdate,
            }).filter((notification) =>
              this.shouldEmitLiveToolNotification(agent.backendId, notification),
            )
          : [];
        const deferredTerminalToolNotifications =
          updateKind === "turn_finished" && turnId && !fromSessionLoad
            ? this.liveToolUpdateResolver
                .drainDeferredTerminalUpdates({
                  backendId: agent.backendId,
                  threadId: sessionId,
                  turnId,
                })
                .flatMap((deferredUpdate) =>
                  acpToolUpdateNotifications({
                    threadId: sessionId,
                    turnId,
                    update: deferredUpdate,
                  }),
                )
                .filter((notification) =>
                  this.shouldEmitLiveToolNotification(agent.backendId, notification),
                )
            : [];
        if (title) {
          await this.emit({
            backend: agent.backendId,
            notification: {
              method: "thread/name/updated",
              params: {
                threadId: sessionId,
                threadName: title,
              },
            },
          });
        }
        if (updateKind === "available_commands_update") {
          await this.emit({
            backend: agent.backendId,
            notification: {
              method: "thread/availableCommands/updated",
              params: {
                threadId: sessionId,
                commands:
                  this.getSession(agent.backendId, sessionId)?.availableCommands ??
                  [],
              },
            },
          });
        }
        const kimiYoloExecutionMode =
          agent.registryId === "kimi"
            ? readKimiYoloExecutionModeFromText(readAcpUpdateText(update) ?? "")
            : undefined;
        if (kimiYoloExecutionMode) {
          const metadata = this.getSession(agent.backendId, sessionId);
          if (
            metadata &&
            (metadata.executionMode ?? "default") !== kimiYoloExecutionMode
          ) {
            this.acpSessionStore?.upsertSession?.({
              ...metadata,
              executionMode: kimiYoloExecutionMode,
              updatedAt: fromSessionLoad
                ? metadata.updatedAt
                : Math.max(metadata.updatedAt, Date.now()),
            });
            await this.emit({
              backend: agent.backendId,
              notification: {
                method: "thread/executionMode/updated",
                params: {
                  threadId: sessionId,
                  executionMode: kimiYoloExecutionMode,
                },
              },
            });
          }
        }
        if (
          turnId &&
          (updateKind === "agent_message_chunk" ||
            (updateKind === "agent_thought_chunk" &&
              shouldSurfaceAcpThoughtsAsMessages(agent.backendId)))
        ) {
          const delta = agentMessageDelta ?? readAcpUpdateText(update);
          // The client deliberately leaves the item ID unset when a provider
          // sends a whitespace-only chunk after a tool boundary. Do not revive
          // that skipped chunk under the legacy fallback ID: doing so creates
          // a blank live assistant card even though replay normalization drops
          // the same artifact. Preserve whitespace only when it continues an
          // already-active assistant item.
          if (delta && (assistantMessageItemId || delta.trim())) {
            const phase =
              updateKind === "agent_thought_chunk" ? "commentary" : "final";
            await this.emit({
              backend: agent.backendId,
              notification: {
                method: "item/agentMessage/delta",
                params: {
                  threadId: sessionId,
                  turnId,
                  itemId:
                    assistantMessageItemId ?? `assistant:${turnId ?? sessionId}`,
                  delta,
                  phase,
                },
              },
            });
          }
        }
        for (const notification of [
          ...toolNotifications,
          ...deferredTerminalToolNotifications,
        ]) {
          await this.emit({
            backend: agent.backendId,
            notification,
          });
        }
        if (usageNotification) {
          await this.emit({
            backend: agent.backendId,
            notification: usageNotification,
          });
        }
        if (updateKind === "turn_finished" && turnId) {
          this.liveTurnUsage.delete(
            [agent.backendId, sessionId, turnId].join(":"),
          );
          this.clearLiveToolNotificationFingerprints({
            backend: agent.backendId,
            threadId: sessionId,
            turnId,
          });
          this.liveToolUpdateResolver.clearTurn({
            backendId: agent.backendId,
            threadId: sessionId,
            turnId,
          });
          const outputText = readAcpUpdateText(update);
          await this.emit({
            backend: agent.backendId,
            notification: {
              method: "turn/completed",
              params: {
                threadId: sessionId,
                turnId,
                turn: {
                  id: turnId,
                  status: "completed",
                  completedAt: Date.now(),
                  output: outputText ? [{ type: "text", text: outputText }] : [],
                },
              },
            },
          });
        }
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: sessionId,
              status: {
                type: replay.threadStatus ?? "unknown",
              },
            },
          },
        });
      },
      onPromptError: async ({ sessionId, turnId, error }) => {
        this.liveTurnUsage.delete(
          [agent.backendId, sessionId, turnId].join(":"),
        );
        this.liveToolUpdateResolver.clearTurn({
          backendId: agent.backendId,
          threadId: sessionId,
          turnId,
        });
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "turn/failed",
            params: {
              threadId: sessionId,
              turnId,
              turn: {
                id: turnId,
                status: "failed",
                completedAt: Date.now(),
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
              },
            },
          },
        });
      },
      onRuntimeCapabilities: async ({
        fromSessionLoad,
        runtimeCapabilities,
        runtimeState,
        sessionId,
      }) => {
        const now = Date.now();
        const current = this.getInstalledAgent(agent.backendId) ?? agent;
        this.acpAgentStore?.upsertInstalledAgent({
          ...current,
          runtimeCapabilities,
          lastDiscoveredAt: runtimeCapabilities.discoveredAt ?? now,
          lastDiscoveryError: runtimeCapabilities.lastError,
          updatedAt: Math.max(current.updatedAt, now),
        });
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "backend/acpRuntimeCapabilities/updated",
            params: {
              backend: agent.backendId,
            },
          },
        });
        if (sessionId && runtimeState && this.acpSessionStore?.upsertSession) {
          const metadata = this.getSession(agent.backendId, sessionId);
          if (metadata) {
            this.acpSessionStore.upsertSession({
              ...metadata,
              acpRuntime: {
                ...metadata.acpRuntime,
                ...runtimeState,
                configValues: {
                  ...(metadata.acpRuntime?.configValues ?? {}),
                  ...(runtimeState.configValues ?? {}),
                },
              },
              updatedAt: fromSessionLoad
                ? metadata.updatedAt
                : Math.max(
                    metadata.updatedAt,
                    runtimeState.updatedAt ?? now,
                  ),
            });
          }
        }
      },
      onSessionRuntimeStateChange: async ({
        fromSessionLoad,
        sessionId,
        runtimeState,
      }) => {
        if (!this.acpSessionStore?.upsertSession) {
          return;
        }
        const metadata = this.getSession(agent.backendId, sessionId);
        if (!metadata) {
          return;
        }
        const acpRuntime = {
          ...metadata.acpRuntime,
          ...runtimeState,
          configValues: {
            ...(metadata.acpRuntime?.configValues ?? {}),
            ...(runtimeState.configValues ?? {}),
          },
        };
        this.acpSessionStore.upsertSession({
          ...metadata,
          acpRuntime,
          updatedAt: fromSessionLoad
            ? metadata.updatedAt
            : Math.max(
                metadata.updatedAt,
                runtimeState.updatedAt ?? Date.now(),
              ),
        });
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "thread/acpRuntime/updated",
            params: {
              threadId: sessionId,
              acpRuntime,
            },
          },
        });
      },
      onRequest: async (request) =>
        await this.handleServerRequest(agent.backendId, request),
      mcpServers: async ({
        backendId,
        runtimeCapabilities,
        sessionId,
      }): Promise<
        AcpMcpServerRegistration
        | ReturnType<typeof buildAutomationInspectionAcpMcpServers>
      > => {
        let baseRegistration: AcpMcpServerRegistration | undefined;
        if (
          this.agentToolMcpServer
          && acpRuntimeSupportsHttpMcp(runtimeCapabilities)
        ) {
          try {
            const registration = await this.agentToolMcpServer.registerClient({
              backend: backendId,
              threadId: sessionId,
            });
            baseRegistration = {
              servers: [registration.server],
              bindThread: registration.bindThread,
            };
          } catch (error) {
            acpBackendAdapterLog.warn("agent_tool_mcp_start_failed", {
              backend: backendId,
              error: error instanceof Error ? error.message : String(error),
              sessionId: sessionId ?? null,
            });
          }
        }
        const fallbackRegistration = buildAutomationInspectionAcpMcpServers({
            backend: backendId,
            command: this.automationInspectionMcpCommand,
            runtimeCapabilities,
            threadId: sessionId,
          });
        baseRegistration ??= Array.isArray(fallbackRegistration)
          ? { servers: fallbackRegistration }
          : fallbackRegistration;
        const connectionRegistration =
          await this.resolveMcpConnectionServers?.({ backendId, sessionId });
        return mergeMcpServerRegistrations(
          baseRegistration,
          connectionRegistration,
        );
      },
    });
  }
}
