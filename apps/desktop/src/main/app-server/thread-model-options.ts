import { findAcpPermissionModeConfigOption } from "@pwragent/shared";
import {
  type AppServerAvailableCommandSummary,
  type AppServerBackendKind,
  type BackendAccountSummary,
  type BackendAcpRuntimeCapabilities,
  type BackendAcpSessionRuntimeState,
  type BackendCapabilities,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendRateLimitSummary,
  type BackendRuntimeBuild,
  type BackendSummary,
  type NavigationLaunchpadDefaults,
  type ThreadExecutionMode,
  isAcpBackendId,
} from "@pwragent/shared";
import {
  acpRuntimeValueLooksPrivileged,
  type AcpRuntimeClient,
} from "./acp-backend-adapter";
import { formatRateLimitWindowName } from "../codex-app-server/desktop-client";
import { resolveCodexProtocolCompatibility } from "../codex-app-server/protocol-compatibility";
import { managedCodexTagForCommand } from "../codex-build-channel";
import {
  type BackendClient,
  type CodexFastModeMismatchWarning,
  type InitializeResult,
  type ModelSettings,
} from "./backend-registry-types";
import {
  firstDefinedStringLike,
  readBooleanLike,
  readRecord,
  readStringLike,
} from "./backend-registry-notification-values";


export const BACKEND_LABELS: Record<AppServerBackendKind, string> = {
  codex: "OpenAI",
  claude: "Claude",
};

/** Who publishes each Codex channel's builds. Deliberately not
 *  `BACKEND_LABELS.codex`: that names the backend in the UI, and renaming a
 *  display label must never change a claim about who built a binary. */
export const CODEX_VENDOR_PUBLISHER = "OpenAI";
export const CODEX_MANAGED_PUBLISHER = "PwrDrvr";

/**
 * Who built the Codex executable PwrAgent launches. Decided from the resolved
 * command's path: a managed download lives under the PwrAgent Codex channel's
 * `versions/<tag>/` root, and anything else on this machine is OpenAI's own
 * release. Returns `undefined` until a command has been resolved — "OpenAI" is
 * a claim about a specific binary, not a fallback.
 */
export function codexRuntimeBuild(
  selectedCommand?: string,
): BackendRuntimeBuild | undefined {
  if (!selectedCommand) {
    return undefined;
  }
  return managedCodexTagForCommand(selectedCommand) === undefined
    ? { channel: "vendor", publisher: CODEX_VENDOR_PUBLISHER }
    : { channel: "pwragent", publisher: CODEX_MANAGED_PUBLISHER };
}

export const OPENAI_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
export const OPENAI_GPT56_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const OPENAI_GPT56_ULTRA_REASONING_EFFORTS = [
  ...OPENAI_GPT56_REASONING_EFFORTS,
  "ultra",
];
export const DEFAULT_REASONING_EFFORT = "medium";

export const OPENAI_FALLBACK_MODELS: BackendModelOption[] = [
  {
    id: "gpt-6-astra",
    label: "GPT-6-Astra",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_GPT56_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1-Sol",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_GPT56_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6-Sol",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: ["none", ...OPENAI_GPT56_REASONING_EFFORTS],
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6-Luna",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: ["none", ...OPENAI_GPT56_REASONING_EFFORTS],
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_GPT56_ULTRA_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_GPT56_ULTRA_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_GPT56_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    current: true,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    reasoningEfforts: OPENAI_REASONING_EFFORTS,
    supportsReasoning: true,
    supportsSteering: true,
  },
];

export const EXECUTION_MODE_SUMMARIES: Record<
  ThreadExecutionMode,
  {
    label: string;
    approvalPolicy: string;
    approvalsReviewer: "user" | "auto_review";
    sandbox: string;
  }
> = {
  default: {
    label: "Default Access",
    approvalsReviewer: "user",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  auto: {
    label: "Auto",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  },
  "full-access": {
    label: "Full Access",
    approvalsReviewer: "user",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
};

export function codexAutoExecutionMode(available: boolean, version?: string): BackendSummary["executionModes"][number] {
  const supported = resolveCodexProtocolCompatibility(version).supportsAutoReview;
  return {
    mode: "auto",
    label: EXECUTION_MODE_SUMMARIES.auto.label,
    available: available && supported,
    ...(!supported ? { unavailableReason: "Auto access requires Codex 0.153.0 or later." } : {}),
  };
}

export const GEMINI_PRIVILEGED_APPROVAL_MODES = new Set([
  "yolo",
]);

export function acpRuntimeStateRequiresFullAccess(params: {
  runtime?: BackendAcpSessionRuntimeState;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
}): boolean {
  const { runtime, runtimeCapabilities } = params;
  if (!runtime) {
    return false;
  }
  if (acpRuntimeValueLooksPrivileged(runtime.currentModeId)) {
    return true;
  }

  const configValues = runtime.configValues ?? {};
  const modeOptionIds = new Set(
    runtimeCapabilities?.configOptions
      ?.filter((option) => option.category === "mode")
      .map((option) => option.id) ?? [],
  );
  for (const key of ["mode", "approval-mode", "approval_mode"]) {
    modeOptionIds.add(key);
  }

  for (const optionId of modeOptionIds) {
    if (acpRuntimeValueLooksPrivileged(configValues[optionId])) {
      return true;
    }
  }

  return false;
}

export function acpRuntimeModeDefaultsFromCapabilities(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
  now: number,
): BackendAcpSessionRuntimeState | undefined {
  const modeConfigOptions =
    runtimeCapabilities?.configOptions?.filter(
      (option) => option.category === "mode",
    ) ?? [];
  const configValues = Object.fromEntries(
    modeConfigOptions.flatMap((option) =>
      typeof option.currentValue === "string"
        ? [[option.id, option.currentValue] as const]
        : [],
    ),
  );
  const hasMirroredModeConfigOption = modeConfigOptions.some(
    (option) => option.id !== findAcpPermissionModeConfigOption(runtimeCapabilities)?.id,
  );
  const state: BackendAcpSessionRuntimeState = {
    updatedAt: now,
    ...(Object.keys(configValues).length > 0 ? { configValues } : {}),
    ...(!hasMirroredModeConfigOption && runtimeCapabilities?.modes?.currentModeId
      ? { currentModeId: runtimeCapabilities.modes.currentModeId }
      : {}),
  };
  return Object.keys(state).length > 1 ? state : undefined;
}

export function sanitizeAcpRuntimeForExecutionMode(params: {
  backend: AppServerBackendKind;
  executionMode: ThreadExecutionMode;
  runtime?: BackendAcpSessionRuntimeState;
}): BackendAcpSessionRuntimeState | undefined {
  const { backend, executionMode, runtime } = params;
  if (backend !== "acp:gemini" || executionMode !== "default" || !runtime) {
    return runtime;
  }

  let changed = false;
  const configValues = runtime.configValues
    ? { ...runtime.configValues }
    : undefined;
  if (
    configValues?.["approval-mode"] &&
    GEMINI_PRIVILEGED_APPROVAL_MODES.has(configValues["approval-mode"])
  ) {
    configValues["approval-mode"] = "default";
    changed = true;
  }

  const currentModeId =
    runtime.currentModeId &&
    GEMINI_PRIVILEGED_APPROVAL_MODES.has(runtime.currentModeId)
      ? "default"
      : runtime.currentModeId;
  if (currentModeId !== runtime.currentModeId) {
    changed = true;
  }

  return changed
    ? {
        ...runtime,
        ...(configValues ? { configValues } : {}),
        ...(currentModeId ? { currentModeId } : {}),
      }
    : runtime;
}

export function buildCapabilities(
  methods: string[],
  backend: AppServerBackendKind,
  serverVersion?: string,
): BackendCapabilities {
  const supported = new Set(methods);
  const assumeCodexAppServerSurface = backend === "codex" && methods.length === 0;
  const reviewCodexSubAgent = supported.has("review/start") || assumeCodexAppServerSurface;
  // A managed review child is an ephemeral thread plus one turn, so Codex
  // can review for another provider's thread even on builds whose native
  // review/start is absent.
  const reviewRunner =
    (supported.has("thread/start")
      || supported.has("thread/new")
      || assumeCodexAppServerSurface)
    && (supported.has("turn/start") || assumeCodexAppServerSurface);

  return {
    listThreads:
      supported.has("thread/list") ||
      supported.has("thread/loaded/list") ||
      assumeCodexAppServerSurface,
    createThread:
      supported.has("thread/start") ||
      supported.has("thread/new") ||
      assumeCodexAppServerSurface,
    // Empty Codex method lists are emitted by older supported app-server
    // surfaces that predate method discovery. PwrAgent's supported Codex
    // floor includes thread/fork, so keep the legacy "assume app-server
    // surface" behavior for empty lists while respecting explicit method
    // lists from feature-gated builds.
    forkThread: supported.has("thread/fork") || assumeCodexAppServerSurface,
    resumeThread: supported.has("thread/resume") || assumeCodexAppServerSurface,
    archiveThread: supported.has("thread/archive") || assumeCodexAppServerSurface,
    restoreThread: supported.has("thread/unarchive") || assumeCodexAppServerSurface,
    archiveWorktree: true,
    restoreWorktree: true,
    renameThread: supported.has("thread/name/set") || assumeCodexAppServerSurface,
    readThread: supported.has("thread/read") || assumeCodexAppServerSurface,
    startTurn: supported.has("turn/start") || assumeCodexAppServerSurface,
    startReview: reviewCodexSubAgent || reviewRunner,
    reviewRunMode: true,
    reviewAutoFix: true,
    reviewCodexSubAgent,
    reviewRunner,
    interruptTurn: supported.has("turn/interrupt"),
    steerTurn: backend === "codex" || supported.has("turn/steer"),
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: true,
    multiDirectoryThreads: backend === "codex",
    // Codex reverts conversation history only and discards the removed turns.
    ...(backend === "codex"
      && resolveCodexProtocolCompatibility(serverVersion).supportsThreadRevert
      ? { threadRewind: { files: false, undo: false } }
      : {}),
  };
}

export function backendMethodCommands(
  backend: AppServerBackendKind,
  methods: string[],
): AppServerAvailableCommandSummary[] {
  if (backend !== "codex") {
    return [];
  }

  const supported = new Set(methods);
  const assumeCodexAppServerSurface = methods.length === 0;
  const commands: AppServerAvailableCommandSummary[] = [];

  if (supported.has("thread/compact/start") || assumeCodexAppServerSurface) {
    commands.push({
      name: "compact",
      description: "Compact this thread's context.",
      backend,
      scope: "backend",
      source: "provider",
    });
  }

  return commands;
}

export function mergeCommandSummaries(
  current: AppServerAvailableCommandSummary[] | undefined,
  incoming: AppServerAvailableCommandSummary[],
): AppServerAvailableCommandSummary[] {
  const merged: AppServerAvailableCommandSummary[] = [];
  const seen = new Set<string>();

  for (const command of [...(current ?? []), ...incoming]) {
    const commandName = command.name.startsWith("/")
      ? command.name.slice(1)
      : command.name;
    const key = `${command.backend ?? ""}:${commandName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(command);
  }

  return merged;
}

export function mergeMethods(results: InitializeResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.methods ?? []))];
}

export function inferSupportsReasoning(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsReasoning === "boolean") {
    return model.supportsReasoning;
  }
  if (model.reasoningEfforts?.length) {
    return true;
  }

  const id = model.id.toLowerCase();
  return (
    id.startsWith("gpt-5")
    || id.startsWith("gpt-6")
    || id.startsWith("o")
  );
}

export function inferSupportsFast(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsFast === "boolean") {
    return model.supportsFast;
  }

  const id = model.id.toLowerCase();
  return backend === "codex" && (id === "gpt-5.5" || id === "gpt-5.4");
}

export function inferSupportsSteering(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsSteering === "boolean") {
    return model.supportsSteering;
  }

  return backend === "codex" || backend === "claude";
}

export function getBackendFallbackModels(backend: AppServerBackendKind): BackendModelOption[] {
  return backend === "codex" ? OPENAI_FALLBACK_MODELS : [];
}

export function getPreferredModelId(
  backend: AppServerBackendKind,
  models?: BackendModelOption[],
): string {
  if (backend !== "codex") {
    return models?.find((model) => model.current)?.id ?? models?.[0]?.id ?? "";
  }

  if (models?.some((model) => model.id === "gpt-5.6-terra")) {
    return "gpt-5.6-terra";
  }

  return "gpt-5.5";
}

export function mergeStringOptions(
  left?: readonly string[],
  right?: readonly string[],
): string[] | undefined {
  const values = [
    ...new Set(
      [...(left ?? []), ...(right ?? [])]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return values.length > 0 ? values : undefined;
}

export function sortReasoningEfforts(
  backend: AppServerBackendKind,
  efforts: readonly string[],
): string[] {
  const order = new Map(
    (backend === "codex"
      ? [
          ...OPENAI_REASONING_EFFORTS,
          ...OPENAI_GPT56_REASONING_EFFORTS,
          "ultra",
        ]
      : efforts
    ).map((effort, index) => [effort, index]),
  );
  return [...efforts].sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right);
  });
}

export function dedupeModelOptions(
  backend: AppServerBackendKind,
  models: BackendModelOption[],
  options: { preferDiscoveredCodexDefault?: boolean } = {},
): BackendModelOption[] {
  const byId = new Map<string, BackendModelOption>();
  for (const model of models) {
    if (!model.id.trim()) {
      continue;
    }

    const normalizedModel = {
      ...model,
      supportsReasoning: inferSupportsReasoning(backend, model),
      supportsFast: inferSupportsFast(backend, model),
      supportsSteering: inferSupportsSteering(backend, model),
    };
    const current = byId.get(model.id);
    byId.set(model.id, {
      ...current,
      ...normalizedModel,
      current: current?.current || normalizedModel.current,
      supportsReasoning: current?.supportsReasoning || normalizedModel.supportsReasoning,
      supportsFast: current?.supportsFast || normalizedModel.supportsFast,
      serviceTiers: normalizedModel.serviceTiers ?? current?.serviceTiers,
      supportsSteering: current?.supportsSteering || normalizedModel.supportsSteering,
      defaultReasoningEffort:
        normalizedModel.defaultReasoningEffort ?? current?.defaultReasoningEffort,
      reasoningEfforts: mergeStringOptions(
        current?.reasoningEfforts,
        normalizedModel.reasoningEfforts,
      ),
    });
  }

  const deduped = [...byId.values()];
  const preferredModelId = getPreferredModelId(
    backend,
    options.preferDiscoveredCodexDefault ? deduped : undefined,
  );
  if (deduped.some((model) => model.id === preferredModelId)) {
    return deduped.map((model) => ({
      ...model,
      current: model.id === preferredModelId,
    }));
  }

  if (deduped.some((model) => model.current)) {
    return deduped;
  }

  return deduped.map((model) => ({
    ...model,
    current: model.id === preferredModelId,
  }));
}

export function buildLaunchpadOptions(
  backend: AppServerBackendKind,
  models: BackendModelOption[],
  options: { allowFallbackModels?: boolean } = {},
): BackendLaunchpadOptions | undefined {
  const allowFallbackModels = options.allowFallbackModels ?? true;
  const hasDiscoveredModels = models.length > 0;
  const normalizedModels = dedupeModelOptions(
    backend,
    hasDiscoveredModels
      ? models
      : allowFallbackModels
        ? getBackendFallbackModels(backend)
        : [],
    { preferDiscoveredCodexDefault: hasDiscoveredModels },
  );
  if (normalizedModels.length === 0) {
    return undefined;
  }

  const supportsReasoning = normalizedModels.some((model) => model.supportsReasoning);
  const supportsFastMode =
    backend === "codex" && normalizedModels.some((model) => model.supportsFast);
  const modelReasoningEfforts = mergeStringOptions(
    normalizedModels.flatMap((model) =>
      model.supportsReasoning ? model.reasoningEfforts ?? [] : [],
    ),
  );

  return {
    models: normalizedModels,
    reasoningEfforts: supportsReasoning
      ? sortReasoningEfforts(
          backend,
          modelReasoningEfforts ??
            (backend === "codex" ? OPENAI_REASONING_EFFORTS : []),
        )
      : undefined,
    supportsFastMode,
  };
}

export async function readClientAccount(
  client: BackendClient
): Promise<BackendAccountSummary | undefined> {
  if (!client.readAccount) {
    return undefined;
  }
  return await client.readAccount();
}

export function isMeaningfulAccountSummary(
  account: BackendAccountSummary | undefined
): account is BackendAccountSummary {
  return Boolean(
    account?.type ||
      account?.email ||
      account?.planType ||
      typeof account?.requiresOpenaiAuth === "boolean"
  );
}

export async function readClientRateLimits(client: BackendClient): Promise<BackendRateLimitSummary[]> {
  if (!client.readRateLimits) {
    return [];
  }
  return await client.readRateLimits();
}

export function isUnauthenticatedCodexProvider(account: BackendAccountSummary | undefined): boolean {
  return account?.requiresOpenaiAuth === false && !account.type;
}

/**
 * Codex names a rolling window by its length, which a sparse update can leave
 * out. Name the merged window from what the store holds.
 */
export function describeCodexRateLimit(limit: BackendRateLimitSummary): BackendRateLimitSummary {
  if (limit.windowKey !== "primary" && limit.windowKey !== "secondary") return limit;
  const name = formatRateLimitWindowName({
    limitId: limit.limitId,
    limitName: limit.limitName,
    windowKey: limit.windowKey,
    windowMinutes: limit.windowMinutes,
  });
  return name === limit.name ? limit : { ...limit, name };
}

export function hasExplicitModelSettings(settings: ModelSettings): boolean {
  return (
    settings.model !== undefined ||
    settings.reasoningEffort !== undefined ||
    settings.serviceTier !== undefined ||
    settings.fastMode !== undefined
  );
}

export function getDefaultModelOption(
  backend: AppServerBackendKind,
  options?: BackendLaunchpadOptions,
): BackendModelOption | undefined {
  const models = options?.models ?? [];
  if (models.length === 0) {
    return undefined;
  }

  const preferredModelId = getPreferredModelId(backend);
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.id === preferredModelId) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

export function getReasoningEffortsForModel(
  options: BackendLaunchpadOptions | undefined,
  model: BackendModelOption | undefined,
): string[] {
  return model?.reasoningEfforts ?? options?.reasoningEfforts ?? [];
}

export function getDefaultReasoningEffort(
  options: BackendLaunchpadOptions | undefined,
  model: BackendModelOption | undefined,
): string | undefined {
  const reasoningEfforts = getReasoningEffortsForModel(options, model);
  if (
    model?.defaultReasoningEffort &&
    reasoningEfforts.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort;
  }
  if (reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)) {
    return DEFAULT_REASONING_EFFORT;
  }
  return reasoningEfforts[0];
}

export const MONITOR_REASONING_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/**
 * The highest effort an agent may request for a Codex monitor. An effort
 * this list does not know, such as `max`, is never accepted.
 */
export const MAX_REQUESTED_MONITOR_REASONING_EFFORT = "medium";

export function isLightweightMonitorReasoningEffort(effort: string): boolean {
  const order: readonly string[] = MONITOR_REASONING_EFFORT_ORDER;
  const index = order.indexOf(effort.toLowerCase());
  return index !== -1
    && index <= order.indexOf(MAX_REQUESTED_MONITOR_REASONING_EFFORT);
}

export function readAcpThoughtLevelValues(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
): string[] {
  return runtimeCapabilities?.configOptions
    ?.find((option) => option.category === "thought_level")
    ?.values.map((value) => value.value) ?? [];
}

export function selectLowestMonitorReasoningEffort(
  reasoningEfforts: string[],
): string | undefined {
  if (reasoningEfforts.length === 0) {
    return undefined;
  }
  const normalized = new Map(
    reasoningEfforts.map((effort) => [effort.toLowerCase(), effort]),
  );
  for (const effort of MONITOR_REASONING_EFFORT_ORDER) {
    const match = normalized.get(effort);
    if (match) {
      return match;
    }
  }
  return reasoningEfforts[0];
}

/**
 * Whether re-sending the model would carry a thought level the session does
 * not already hold.
 *
 * A model write sends no level when none is requested, and the client drops
 * one the session's own menu does not list. Kimi keeps a level across a model
 * switch and ignores one its model does not offer, so in both cases the level
 * a thread records never converges on the request, and a comparison that
 * counted it would re-send the model on every turn for no change.
 */
export function acpModelWriteWouldApplyThoughtLevel(params: {
  client: AcpRuntimeClient;
  currentReasoningEffort: string | undefined;
  reasoningEffort: string | undefined;
  threadId: string;
}): boolean {
  if (
    !params.reasoningEffort
    || params.currentReasoningEffort === params.reasoningEffort
  ) {
    return false;
  }
  // An unknown menu answers true, leaving the decision to the agent.
  return (
    params.client.offersThoughtLevel?.(
      params.threadId,
      params.reasoningEffort,
    ) !== false
  );
}

export function resolveModelSettingsFromOptions(
  backend: AppServerBackendKind,
  options: BackendLaunchpadOptions | undefined,
  settings: ModelSettings,
): ModelSettings {
  const models = options?.models ?? [];
  if (backend === "claude" && settings.model && !models.some((model) => model.id === settings.model)) {
    // A saved explicit model can outlive this process's catalog or belong to
    // the user's CLI configuration. Let the CLI validate it, never silently
    // replace a resumed thread's model with a fallback alias.
    return { model: settings.model, reasoningEffort: settings.reasoningEffort };
  }
  if (models.length === 0 && isAcpBackendId(backend)) {
    return {
      model: settings.model,
      reasoningEffort: undefined,
      serviceTier: settings.serviceTier,
      fastMode: undefined,
    };
  }
  const selectedModel =
    models.find((model) => model.id === settings.model) ??
    getDefaultModelOption(backend, options);
  const supportsReasoning = Boolean(selectedModel?.supportsReasoning);
  const reasoningEfforts = getReasoningEffortsForModel(options, selectedModel);
  const rememberedReasoningEffort = selectedModel
    ? settings.reasoningEffortsByModel?.[selectedModel.id] ??
      settings.providerSettings?.[backend]?.reasoningEffortsByModel?.[
        selectedModel.id
      ]
    : undefined;
  const reasoningEffort = supportsReasoning
    ? reasoningEfforts.includes(settings.reasoningEffort ?? "")
      ? settings.reasoningEffort
      : reasoningEfforts.includes(rememberedReasoningEffort ?? "")
        ? rememberedReasoningEffort
      : getDefaultReasoningEffort(options, selectedModel)
    : undefined;
  const supportsFast = backend === "codex" && Boolean(selectedModel?.supportsFast);
  const shouldClearCodexFastTier =
    backend === "codex" &&
    !supportsFast &&
    (settings.serviceTier === "fast" ||
      settings.serviceTier === "priority" ||
      settings.fastMode === false);

  return {
    model: selectedModel?.id,
    reasoningEffort,
    serviceTier: resolveCodexFastModeServiceTier({
      backend,
      serviceTier: settings.serviceTier,
      fastMode: settings.fastMode,
      supportsFast,
      serviceTiers: selectedModel?.serviceTiers,
    }),
    fastMode: backend === "codex" && settings.serviceTier === "ultrafast"
      ? false
      : supportsFast
        ? settings.fastMode
        : shouldClearCodexFastTier
          ? false
          : undefined,
  };
}

export function resolveCodexFastModeServiceTier(params: {
  backend: AppServerBackendKind;
  fastMode?: boolean;
  serviceTier?: string;
  supportsFast: boolean;
  serviceTiers?: string[];
}): string | undefined {
  if (params.backend !== "codex") {
    return params.serviceTier;
  }
  if (params.serviceTier === "ultrafast") {
    return params.serviceTiers?.includes("ultrafast") ? "ultrafast" : undefined;
  }
  if (params.fastMode === true && params.supportsFast) {
    return "priority";
  }
  if (params.fastMode === false) {
    return params.serviceTier &&
      params.serviceTier !== "fast" &&
      params.serviceTier !== "priority"
      ? params.serviceTier
      : undefined;
  }
  if (
    !params.supportsFast &&
    (params.serviceTier === "fast" || params.serviceTier === "priority")
  ) {
    return undefined;
  }
  return params.serviceTier;
}

export function readObservedCodexFastMode(
  notificationParams: unknown,
): { fastMode?: boolean; serviceTier?: string | null } {
  const params = readRecord(notificationParams);
  const turn = readRecord(params?.turn);
  const config = readRecord(params?.config) ?? readRecord(turn?.config);
  const serviceTier = firstDefinedStringLike(
    readStringLike(params, ["serviceTier", "service_tier"]),
    readStringLike(turn, ["serviceTier", "service_tier"]),
    readStringLike(config, ["service_tier", "serviceTier"]),
  );
  if (serviceTier !== undefined) {
    const normalizedServiceTier =
      typeof serviceTier === "string" ? serviceTier.toLowerCase() : serviceTier;
    return {
      fastMode: normalizedServiceTier === "fast" || normalizedServiceTier === "priority",
      serviceTier,
    };
  }

  const fastMode =
    readBooleanLike(params, ["fastMode", "fast_mode"]) ??
    readBooleanLike(turn, ["fastMode", "fast_mode"]) ??
    readBooleanLike(config, ["fastMode", "fast_mode"]);
  return { fastMode };
}

export function getCodexFastModeMismatchWarning(params: {
  expectedFastMode: boolean;
  notificationParams: unknown;
  threadId: string;
  turnId: string;
}): CodexFastModeMismatchWarning | undefined {
  const observed = readObservedCodexFastMode(params.notificationParams);
  if (observed.fastMode === undefined) {
    return undefined;
  }
  if (observed.fastMode === params.expectedFastMode) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    expectedFastMode: params.expectedFastMode,
    observedFastMode: observed.fastMode,
    observedServiceTier: observed.serviceTier,
  };
}

export function buildCodexFastModeMismatchNotificationParams(
  notificationParams: unknown,
  observedSettings?: { fastMode?: boolean; serviceTier?: string | null },
): unknown {
  const base = readRecord(notificationParams) ?? {};
  if (!observedSettings) {
    return base;
  }
  const hasTerminalFastMode =
    "fastMode" in base ||
    "fast_mode" in base ||
    readRecord(base.turn)?.fastMode !== undefined ||
    readRecord(base.turn)?.fast_mode !== undefined;
  const hasTerminalServiceTier =
    "serviceTier" in base ||
    "service_tier" in base ||
    readRecord(base.turn)?.serviceTier !== undefined ||
    readRecord(base.turn)?.service_tier !== undefined;

  return {
    ...base,
    ...(!hasTerminalFastMode && observedSettings.fastMode !== undefined
      ? { fastMode: observedSettings.fastMode }
      : {}),
    ...(!hasTerminalServiceTier && observedSettings.serviceTier !== undefined
      ? { serviceTier: observedSettings.serviceTier }
      : {}),
  };
}

export function getAvailableExecutionMode(
  backend: BackendSummary,
  preferred: ThreadExecutionMode,
): ThreadExecutionMode {
  return (
    backend.executionModes.find((mode) => mode.available && mode.mode === preferred)?.mode ??
    backend.executionModes.find((mode) => mode.available && mode.isDefault)?.mode ??
    backend.executionModes.find((mode) => mode.available)?.mode ??
    preferred
  );
}

export function launchpadDefaultsEqual(
  left: NavigationLaunchpadDefaults,
  right: NavigationLaunchpadDefaults,
): boolean {
  return (
    left.backend === right.backend &&
    left.executionMode === right.executionMode &&
    left.workMode === right.workMode &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.fastMode === right.fastMode &&
    JSON.stringify(left.acpRuntime ?? {}) === JSON.stringify(right.acpRuntime ?? {})
  );
}
