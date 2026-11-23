import { type MonitorCommandAction, readStringValue } from "./messaging-command-helpers";
import { codexSpeedOptions } from "@pwragent/shared/codex-speed";
import { isMessagingLaunchpadContext, type MessagingLaunchpadDirectory, type MessagingNewThreadNavigation } from "./messaging-launchpad-context";

import {
  applyNavigationLaunchpadProviderSettingsPatch,
  isAcpBackendId,
  isAppServerBackendKind,
  parseThreadIdentityKey,
} from "@pwragent/shared/contracts/navigation";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  CodexEnvironmentOption,
  LaunchpadWorkMode,
  NavigationLaunchpadConfiguration,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type {
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendModelOption,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type {
  DesktopAuthorizedContact,
  DesktopMessagingFullAccessWarningGlobalPolicy,
} from "@pwragent/shared/contracts/settings";
import type { FederatedThreadRef } from "@pwragent/shared/contracts/federation";
import type { MessagingToolUpdateMode } from "@pwragent/shared/contracts/messaging";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingApprovalDecision, MessagingChannelKind, MessagingChannelRef, MessagingDefaultAgentScope, MessagingInboundCallbackEvent, MessagingJsonValue, MessagingManagedTopicRecord, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import { directoryForProjectSelection as legacyDirectoryForProjectSelection } from "./messaging-resume-browser.js";
import { messagingStreamingResponsesEnabled } from "./messaging-status-card.js";
import { isMessagingThreadContext, type MessagingNavigationContext } from "./messaging-thread-state.js";
import { type MessagingTurnInputEvent } from "./messaging-turn-admission.js";

export type PreparedInputStartResult = "failed" | "queued" | "started";

export function findThreadForBinding(
  navigation: MessagingNavigationContext | undefined,
  binding: MessagingBindingRecord,
): NavigationThreadSummary | undefined {
  const threads = navigation && isMessagingThreadContext(navigation) ? (navigation.thread ? [navigation.thread] : []) : navigation?.threads;
  return threads?.find(
    (thread) =>
      thread.source === binding.backend &&
      thread.id === binding.threadId &&
      federationRefsMatch(thread.federation?.ref, binding.federatedThread),
  );
}

export function federationRefsMatch(
  left: FederatedThreadRef | undefined,
  right: FederatedThreadRef | undefined,
): boolean {
  const leftTarget = left?.target ?? { scope: "local" as const };
  const rightTarget = right?.target ?? { scope: "local" as const };
  return leftTarget.scope === rightTarget.scope &&
    (leftTarget.scope === "local" ||
      (rightTarget.scope === "remote" &&
        leftTarget.instanceId === rightTarget.instanceId));
}

export type MessagingFullAccessControls = {
  allowEscalation: boolean;
  allowThreadResume: boolean;
  warningPolicy: DesktopMessagingFullAccessWarningGlobalPolicy;
  authorizedUsers?: Partial<Record<MessagingChannelKind, DesktopAuthorizedContact[]>>;
  dismissWarning?: (params: {
    actorId: string;
    channel: MessagingChannelKind;
  }) => Promise<void>;
  canDismissWarning?: (params: {
    actorId: string;
    channel: MessagingChannelKind;
  }) => boolean | Promise<boolean>;
};

export type FullAccessEscalationContext =
  | {
      backend: AppServerBackendKind;
      binding?: MessagingBindingRecord;
      kind: "thread";
      threadId: ThreadIdentifier;
    }
  | {
      kind: "new-thread";
      pendingPrompt?: boolean;
      session: MessagingBrowseSessionRecord;
    }
  | {
      backend: AppServerBackendKind;
      federatedThread?: FederatedThreadRef;
      kind: "resume-thread";
      session: MessagingBrowseSessionRecord;
      threadId: ThreadIdentifier;
    };

export type FullAccessRiskWarningContext =
  | {
      bindingId: string;
      kind: "thread";
      threadId: ThreadIdentifier;
    }
  | {
      kind: "new-thread";
      pendingPrompt?: boolean;
      sessionId: string;
    }
  | {
      backend: AppServerBackendKind;
      federationInstanceId?: string;
      kind: "resume-thread";
      sessionId: string;
      threadId: ThreadIdentifier;
    };

export type AcpRuntimeRiskWarningContext =
  | {
      kind: "new-thread";
      label: string;
      optionId: string;
      sessionId: string;
      source: BackendAcpRuntimeOptionSource;
      value: string;
    }
  | {
      bindingId: string;
      kind: "thread";
      label: string;
      optionId: string;
      source: BackendAcpRuntimeOptionSource;
      threadId: ThreadIdentifier;
      value: string;
    };

export type FullAccessWarningResolution = {
  canDismiss: boolean;
  policy: DesktopMessagingFullAccessWarningGlobalPolicy;
  shouldWarn: boolean;
};

export type QueuedTurnAction = {
  entryId: string;
  kind: "cancel" | "steer" | "retry";
};

export type PrivateReplyAction =
  | { kind: "cancel"; requestId: string }
  | { kind: "reply"; optionIndex: number; requestId: string };

/**
 * Per-binding tracking of a posted "permissions queued" audit message so
 * we can edit it in place when the queue resolves (cancelled / applied).
 * One controller-side map keyed by `buildThreadIdentityKey` is enough —
 * only one queued mode change can exist per thread at a time, and the
 * registry's queueCleared notification is per-thread.
 */
export type PendingQueueAuditMessage = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** ULID-shaped queueId from the registry, used for the cancel button action id. */
  queueId: string;
  fromExecutionMode: ThreadExecutionMode;
  toExecutionMode: ThreadExecutionMode;
  queuedAt: number;
  /** Surface refs for every binding we successfully posted to. */
  surfaces: Map<string, MessagingSurfaceRef>;
};

export const PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX = "permissions:queue:cancel:";

export const FULL_ACCESS_RISK_ACTION_PREFIX = "full-access-risk:";

export const ACP_RUNTIME_RISK_ACTION_PREFIX = "acp-runtime-risk:";

export type PendingNewThreadPromptWindow = {
  events: MessagingTurnInputEvent[];
  session: MessagingBrowseSessionRecord;
  timer?: ReturnType<typeof setTimeout>;
};

export type PendingNewThreadPromptBundle = {
  events: MessagingTurnInputEvent[];
  session: MessagingBrowseSessionRecord;
  confirmationExpiresAt?: number;
};

export function readCommandAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const match = /^command:([a-z0-9_-]+)$/i.exec(actionId);
  return match?.[1]?.toLowerCase();
}

export function readBrowseAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("browse:") ? actionId : undefined;
}

export function readHelpNavAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (
    actionId === "help:page:next"
    || actionId === "help:page:prev"
    || actionId === "help:cancel"
  ) {
    return actionId;
  }
  return undefined;
}

/**
 * Read the target page index from a help-nav callback's value
 * payload. Returns 0 (first page) when the value is missing or
 * malformed — clamping in `paginateHelpCatalog` will pin to the
 * first/last page anyway, so an absent value never crashes the
 * re-render.
 */
export function readHelpPageIndex(event: MessagingInboundCallbackEvent): number {
  const value = event.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).pageIndex;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return 0;
}

export function readStatusAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("status:")
    || actionId.startsWith("handoff:")
    || actionId.startsWith("skills:")
    ? actionId
    : undefined;
}

export function readMonitorAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("monitor:") ? actionId : undefined;
}

export function normalizeMonitorCallbackAction(actionId: string): MonitorCommandAction {
  if (actionId === "monitor:interval") {
    return { kind: "cycle-interval" };
  }
  if (actionId === "monitor:pins") {
    return { kind: "cycle-pinned" };
  }
  if (actionId === "monitor:recent") {
    return { kind: "cycle-recent" };
  }
  if (actionId === "monitor:status") {
    return { kind: "toggle-status-line" };
  }
  if (actionId === "monitor:snippet") {
    return { kind: "toggle-snippet" };
  }
  return { kind: "refresh" };
}

export function topicChannelRef(topic: MessagingManagedTopicRecord, connectionId?: string): MessagingChannelRef {
  return {
    channel: topic.channel,
    ...(connectionId === undefined ? {} : { connectionId }),
    conversation: topic.conversation,
  };
}

/**
 * Match the cancel button on a "Permissions queued" audit message. The
 * action id is `permissions:queue:cancel:${queueId}`; the queueId is
 * encoded so multiple queue posts in the same conversation can't
 * collide. Returns the parsed queueId on match, undefined otherwise.
 *
 * The queueId is what the controller-side tracking map keys against,
 * so the cancel handler can detect stale clicks (the apply has
 * already happened, or a different queue has replaced this one) and
 * respond with explicit feedback rather than silently no-op'ing
 * through the registry's `cancelThreadExecutionModeQueue` call.
 */
export function readPermissionsQueueCancelAction(
  event: MessagingInboundCallbackEvent,
): { queueId: string } | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX)) {
    return undefined;
  }
  const queueId = actionId.slice(PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX.length);
  if (!queueId) {
    return undefined;
  }
  return { queueId };
}

export function readFullAccessRiskAction(
  event: MessagingInboundCallbackEvent,
): "accept" | "dismiss" | "cancel" | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(FULL_ACCESS_RISK_ACTION_PREFIX)) {
    return undefined;
  }
  const action = actionId.slice(FULL_ACCESS_RISK_ACTION_PREFIX.length);
  return action === "accept" || action === "dismiss" || action === "cancel"
    ? action
    : undefined;
}

export function readAcpRuntimeRiskAction(
  event: MessagingInboundCallbackEvent,
): "accept" | "dismiss" | "cancel" | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(ACP_RUNTIME_RISK_ACTION_PREFIX)) {
    return undefined;
  }
  const action = actionId.slice(ACP_RUNTIME_RISK_ACTION_PREFIX.length);
  return action === "accept" || action === "dismiss" || action === "cancel"
    ? action
    : undefined;
}

export function readAcpRuntimeRiskContext(
  value: MessagingJsonValue | undefined,
): AcpRuntimeRiskWarningContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source =
    value.source === "mode" ||
    value.source === "configOption" ||
    value.source === "model"
      ? value.source
      : undefined;
  if (
    value.kind === "new-thread" &&
    typeof value.sessionId === "string" &&
    typeof value.optionId === "string" &&
    typeof value.value === "string" &&
    typeof value.label === "string" &&
    source
  ) {
    return {
      kind: "new-thread",
      label: value.label,
      optionId: value.optionId,
      sessionId: value.sessionId,
      source,
      value: value.value,
    };
  }
  if (
    value.kind === "thread" &&
    typeof value.bindingId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.optionId === "string" &&
    typeof value.value === "string" &&
    typeof value.label === "string" &&
    source
  ) {
    return {
      bindingId: value.bindingId,
      kind: "thread",
      label: value.label,
      optionId: value.optionId,
      source,
      threadId: value.threadId,
      value: value.value,
    };
  }
  return undefined;
}

export function readFullAccessRiskContext(
  value: MessagingJsonValue | undefined,
): FullAccessRiskWarningContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (value.kind === "new-thread" && typeof value.sessionId === "string") {
    return {
      kind: "new-thread",
      ...(value.pendingPrompt === true ? { pendingPrompt: true } : {}),
      sessionId: value.sessionId,
    };
  }
  if (
    value.kind === "resume-thread" &&
    typeof value.backend === "string" &&
    isAppServerBackendKind(value.backend) &&
    typeof value.sessionId === "string" &&
    typeof value.threadId === "string"
  ) {
    return {
      backend: value.backend,
      ...(typeof value.federationInstanceId === "string"
        ? { federationInstanceId: value.federationInstanceId }
        : {}),
      kind: "resume-thread",
      sessionId: value.sessionId,
      threadId: value.threadId,
    };
  }
  if (
    value.kind === "thread" &&
    typeof value.bindingId === "string" &&
    typeof value.threadId === "string"
  ) {
    return {
      bindingId: value.bindingId,
      kind: "thread",
      threadId: value.threadId,
    };
  }
  return undefined;
}

export function readQueuedTurnAction(
  event: MessagingInboundCallbackEvent,
): QueuedTurnAction | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const steerPrefix = "queued-turn:steer:";
  if (actionId.startsWith(steerPrefix)) {
    return {
      kind: "steer",
      entryId: actionId.slice(steerPrefix.length),
    };
  }

  const retryPrefix = "queued-turn:retry:";
  if (actionId.startsWith(retryPrefix)) {
    return { kind: "retry", entryId: actionId.slice(retryPrefix.length) };
  }

  const cancelPrefix = "queued-turn:cancel:";
  if (actionId.startsWith(cancelPrefix)) {
    return {
      kind: "cancel",
      entryId: actionId.slice(cancelPrefix.length),
    };
  }

  return undefined;
}

export function readPrivateReplyAction(
  event: MessagingInboundCallbackEvent,
): PrivateReplyAction | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const parts = actionId.split(":");
  if (parts[0] !== "private-reply" || !parts[1] || parts.length < 3) {
    return undefined;
  }
  if (parts[2] === "cancel" && parts.length === 3) {
    return { kind: "cancel", requestId: parts[1] };
  }
  if (parts[2] === "reply" && parts.length === 4 && /^[0-2]$/.test(parts[3] ?? "")) {
    return {
      kind: "reply",
      optionIndex: Number(parts[3]),
      requestId: parts[1],
    };
  }
  return undefined;
}

export function branchPageIndexFromValue(value: MessagingJsonValue | undefined): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const pageIndex = value.pageIndex;
  return typeof pageIndex === "number" && Number.isFinite(pageIndex)
    ? Math.max(0, Math.trunc(pageIndex))
    : 0;
}

export function directoryForProjectSelection(
  navigation: MessagingNewThreadNavigation,
  selectedProject: Parameters<typeof legacyDirectoryForProjectSelection>[1],
): MessagingLaunchpadDirectory | undefined {
  if (!isMessagingLaunchpadContext(navigation)) return legacyDirectoryForProjectSelection(navigation, selectedProject);
  const directory = navigation.directory;
  return directory && (selectedProject.directoryKey ? directory.key === selectedProject.directoryKey : directory.path === selectedProject.path)
    ? directory : undefined;
}

export function normalizeNewThreadSessionForBackend(
  session: MessagingBrowseSessionRecord,
  backend: BackendSummary,
  updatedAt: number,
  navigation: MessagingNewThreadNavigation,
): MessagingBrowseSessionRecord {
  if (!session.preferences) {
    return session;
  }

  const preferences = { ...session.preferences };
  if (isAcpBackendId(backend.kind)) {
    delete preferences.permissionsMode;
  } else {
    delete preferences.acpRuntime;
  }
  const models = backend.launchpadOptions?.models ?? [];
  if (preferences.model !== undefined) {
    const modelIsValid = models.some((model) => model.id === preferences.model);
    if (models.length === 0) {
      delete preferences.model;
    } else if (!modelIsValid) {
      preferences.model = defaultBackendModel(models)?.id;
    }
  }

  const directory = session.selectedProject
    ? directoryForProjectSelection(navigation, session.selectedProject)
    : undefined;
  const selectedModel = newThreadModelForSession(
    { ...session, preferences },
    navigation,
    directory,
    backend,
  );
  const reasoningEfforts = reasoningEffortsForModel(backend, selectedModel);
  if (preferences.reasoningEffort !== undefined) {
    if (reasoningEfforts.length === 0) {
      delete preferences.reasoningEffort;
    } else if (!reasoningEfforts.includes(preferences.reasoningEffort)) {
      const defaultReasoningEffort = defaultReasoningEffortForModel(
        backend,
        selectedModel,
      );
      if (defaultReasoningEffort) {
        preferences.reasoningEffort = defaultReasoningEffort;
      } else {
        delete preferences.reasoningEffort;
      }
    }
  }

  const supportsFast =
    Boolean(backend.launchpadOptions?.supportsFastMode) ||
    Boolean(selectedModel?.supportsFast);
  if (!supportsFast) {
    delete preferences.fastMode;
  }

  const serviceTiers = backend.kind === "codex"
    ? selectedModel?.serviceTiers ?? []
    : backend.launchpadOptions?.serviceTiers ?? [];
  if (preferences.serviceTier !== undefined) {
    if (serviceTiers.length === 0) {
      delete preferences.serviceTier;
    } else if (!serviceTiers.includes(preferences.serviceTier)) {
      if (backend.kind === "codex") {
        delete preferences.serviceTier;
      } else {
        preferences.serviceTier = serviceTiers[0];
      }
    }
  }

  const hasPreferences = Object.keys(preferences).some((key) => key !== "updatedAt");
  return {
    ...session,
    preferences: hasPreferences
      ? {
          ...preferences,
          updatedAt,
        }
      : undefined,
  };
}

export function clearNewThreadProviderPreferences(
  session: MessagingBrowseSessionRecord,
  updatedAt: number,
): MessagingBrowseSessionRecord {
  if (!session.preferences) {
    return session;
  }

  const preferences = { ...session.preferences };
  delete preferences.acpRuntime;
  delete preferences.codexEnvironmentActionId;
  delete preferences.codexEnvironmentExecutionTarget;
  delete preferences.codexEnvironmentId;
  delete preferences.codexEnvironmentSetupEnabled;
  delete preferences.executionMode;
  delete preferences.fastMode;
  delete preferences.model;
  delete preferences.permissionsMode;
  delete preferences.reasoningEffort;
  delete preferences.serviceTier;

  const hasPreferences = Object.keys(preferences).some((key) => key !== "updatedAt");
  return {
    ...session,
    preferences: hasPreferences
      ? {
          ...preferences,
          updatedAt,
        }
      : undefined,
  };
}

export function defaultBackendModel(
  models: NonNullable<BackendSummary["launchpadOptions"]>["models"] = [],
) {
  return models.find((model) => model.current) ?? models[0];
}

export function reasoningEffortsForModel(
  backend: BackendSummary | undefined,
  model: BackendModelOption | undefined,
): string[] {
  return model?.reasoningEfforts ?? backend?.launchpadOptions?.reasoningEfforts ?? [];
}

export function defaultReasoningEffortForModel(
  backend: BackendSummary | undefined,
  model: BackendModelOption | undefined,
): string | undefined {
  const efforts = reasoningEffortsForModel(backend, model);
  if (
    model?.defaultReasoningEffort &&
    efforts.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort;
  }
  return efforts[0];
}

export function resolveReasoningEffortForModel(
  backend: BackendSummary | undefined,
  model: BackendModelOption | undefined,
  candidates: Array<string | undefined>,
): string | undefined {
  if (!backend && !model) {
    return candidates.find((candidate): candidate is string => Boolean(candidate));
  }
  const efforts = reasoningEffortsForModel(backend, model);
  const selected = candidates.find((candidate) =>
    candidate ? efforts.includes(candidate) : false,
  );
  return selected ?? defaultReasoningEffortForModel(backend, model);
}

export function normalizeReasoningEffortForModel(
  backend: BackendSummary,
  model: BackendModelOption | undefined,
  candidates: Array<string | undefined>,
): string | undefined {
  if (!candidates.some((candidate) => Boolean(candidate))) {
    return undefined;
  }
  return resolveReasoningEffortForModel(backend, model, candidates);
}

export type NewThreadOptionsSummary = {
  acpRuntime?: BackendAcpSessionRuntimeState;
  backend: AppServerBackendKind;
  backendLabel: string;
  branchName: string;
  codexEnvironmentActionId?: string | null;
  codexEnvironmentExecutionTarget?: "local" | "remote";
  codexEnvironmentId?: string | null;
  codexEnvironmentOptions: CodexEnvironmentOption[];
  executionMode: ThreadExecutionMode;
  executionModeSource: "session" | "directory-launchpad" | "launchpad-defaults";
  fastMode: boolean;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  supportsFast: boolean;
  supportsUltrafast: boolean;
  supportsModel: boolean;
  supportsReasoning: boolean;
  streamingResponses: boolean;
  workMode: LaunchpadWorkMode;
};

export function newThreadModelForSession(
  session: MessagingBrowseSessionRecord,
  navigation: MessagingNewThreadNavigation,
  directory: MessagingLaunchpadDirectory | undefined,
  backend: BackendSummary,
): BackendModelOption | undefined {
  const launchpadDefaults = applyNavigationLaunchpadProviderSettingsPatch(
    navigation.launchpadDefaults,
    { backend: backend.kind },
  );
  const directoryLaunchpad = directory?.launchpad
    ? applyNavigationLaunchpadProviderSettingsPatch(directory.launchpad, { backend: backend.kind })
    : undefined;
  const models = backend.launchpadOptions?.models ?? [];
  return models.find((model) => model.id === session.preferences?.model)
    ?? models.find((model) => model.id === directoryLaunchpad?.model)
    ?? models.find((model) => model.id === launchpadDefaults.model)
    ?? defaultBackendModel(models);
}

export function newThreadOptionsForSession(
  session: MessagingBrowseSessionRecord,
  navigation: MessagingNewThreadNavigation,
  directory: MessagingLaunchpadDirectory | undefined,
  streamingResponsesDefault: boolean,
  backend: BackendSummary,
): NewThreadOptionsSummary {
  const launchpadDefaults = applyNavigationLaunchpadProviderSettingsPatch(
    navigation.launchpadDefaults,
    { backend: backend.kind },
  );
  const directoryLaunchpad = directory?.launchpad
    ? applyNavigationLaunchpadProviderSettingsPatch(directory.launchpad, {
        backend: backend.kind,
      })
    : undefined;
  const workMode = resolveNewThreadWorkMode({
    requestedWorkMode:
      session.workMode ??
      directoryLaunchpad?.workMode ??
      launchpadDefaults.workMode ??
      "local",
    directory,
  });
  const streamingMode = session.preferences?.streamingResponses ?? "inherit";
  const models = backend.launchpadOptions?.models ?? [];
  const modelOption = newThreadModelForSession(session, navigation, directory, backend);
  const reasoningEfforts = reasoningEffortsForModel(backend, modelOption);
  const reasoningEffort = resolveReasoningEffortForModel(backend, modelOption, [
    session.preferences?.reasoningEffort,
    directoryLaunchpad?.reasoningEffort,
    launchpadDefaults.reasoningEffort,
  ]);
  const serviceTiers = backend.kind === "codex"
    ? modelOption?.serviceTiers ?? []
    : backend.launchpadOptions?.serviceTiers ?? [];
  // Selecting Standard or Fast clears the tier instead of inheriting Ultrafast.
  const serviceTierCandidates = backend.kind === "codex" && session.preferences?.fastMode !== undefined
    ? [session.preferences.serviceTier]
    : [session.preferences?.serviceTier, directoryLaunchpad?.serviceTier, launchpadDefaults.serviceTier];
  const serviceTier = serviceTierCandidates.find((candidate) => candidate ? serviceTiers.includes(candidate) : false);
  const supportsFast =
    Boolean(backend.launchpadOptions?.supportsFastMode) ||
    Boolean(modelOption?.supportsFast);
  const supportsReasoning =
    reasoningEfforts.length > 0 || Boolean(modelOption?.supportsReasoning);
  const acpRuntime = isAcpBackendId(backend.kind)
    ? session.preferences?.acpRuntime ??
      directoryLaunchpad?.acpRuntime ??
      launchpadDefaults.acpRuntime
    : undefined;
  const executionMode =
    session.preferences?.executionMode ??
    directoryLaunchpad?.executionMode ??
    launchpadDefaults.executionMode;
  const executionModeSource = session.preferences?.executionMode
    ? "session"
    : directoryLaunchpad?.executionMode
      ? "directory-launchpad"
      : "launchpad-defaults";
  const codexEnvironmentOptions = directoryLaunchpad?.codexEnvironmentOptions ?? [];
  const codexEnvironmentId = resolveNewThreadCodexEnvironmentId(
    session,
    directoryLaunchpad,
  );
  const selectedEnvironment = codexEnvironmentOptions.find(
    (environment) => environment.id === codexEnvironmentId,
  );
  return {
    backend: backend.kind,
    backendLabel: backend.label,
    acpRuntime,
    branchName: resolveNewThreadBaseBranch(session, navigation, directory),
    codexEnvironmentActionId: selectedEnvironment
      ? session.preferences?.codexEnvironmentActionId ??
        directoryLaunchpad?.codexEnvironmentActionId
      : undefined,
    codexEnvironmentExecutionTarget: selectedEnvironment
      ? session.preferences?.codexEnvironmentExecutionTarget ??
        directoryLaunchpad?.codexEnvironmentExecutionTarget ??
        "local"
      : undefined,
    codexEnvironmentId: selectedEnvironment?.id ?? (codexEnvironmentId === null ? null : undefined),
    codexEnvironmentOptions,
    executionMode,
    executionModeSource,
    fastMode:
      supportsFast
        ? session.preferences?.fastMode ??
          directoryLaunchpad?.fastMode ??
          launchpadDefaults.fastMode ??
          false
        : false,
    model: session.preferences?.model ?? modelOption?.id ?? "default",
    reasoningEffort,
    serviceTier,
    supportsFast,
    supportsUltrafast: backend.kind === "codex"
      && codexSpeedOptions(modelOption, backend.codexFastAllowed !== false).includes("ultrafast"),
    supportsModel: models.length > 0,
    supportsReasoning,
    streamingResponses: messagingStreamingResponsesEnabled(
      streamingMode,
      streamingResponsesDefault,
    ),
    workMode,
  };
}

export function canCreateNewThreadWorktree(
  directory: MessagingLaunchpadDirectory | undefined,
): boolean {
  if (!directory?.path || directory.kind !== "directory") {
    return false;
  }
  if (directory.gitStatus?.worktreeCreationAvailable !== undefined) {
    return directory.gitStatus.worktreeCreationAvailable;
  }
  return Boolean(
    directory.gitStatus?.currentBranch
    || (directory.gitStatus?.baseBranches?.length ?? 0) > 0
    || (directory.gitStatus?.branches?.length ?? 0) > 0,
  );
}

export function resolveNewThreadWorkMode(params: {
  requestedWorkMode: LaunchpadWorkMode;
  directory: MessagingLaunchpadDirectory | undefined;
}): LaunchpadWorkMode {
  return params.requestedWorkMode === "worktree" &&
    canCreateNewThreadWorktree(params.directory)
    ? "worktree"
    : "local";
}

export function resolveNewThreadCodexEnvironmentId(
  session: MessagingBrowseSessionRecord,
  launchpad: Pick<NavigationLaunchpadConfiguration, "codexEnvironmentId"> | undefined,
): string | null | undefined {
  if (session.preferences?.codexEnvironmentId === null) {
    return null;
  }
  return (
    session.preferences?.codexEnvironmentId ??
    launchpad?.codexEnvironmentId
  );
}

export function resolveNewThreadBaseBranch(
  session: MessagingBrowseSessionRecord,
  navigation: MessagingNewThreadNavigation,
  directory?: MessagingLaunchpadDirectory,
): string {
  const selectedDirectory =
    directory ??
    (session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined);
  return (
    sanitizeBranchLabel(session.branchName) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.defaultBranch) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.baseBranches?.[0]) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.branches?.[0]) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.currentBranch) ??
    "main"
  );
}

export function sanitizeBranchLabel(branch: string | undefined): string | undefined {
  const normalized = branch?.replace(/^refs\/heads\//, "").trim();
  return normalized || undefined;
}

export function boundThreadConfirmationBody(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile,
): string {
  const noun = binding.targetKind === "agent_thread" ? "Agent thread" : "thread";
  return [
    `Messages in this conversation will route to the selected ${noun}.`,
    sharedConversationMentionInstruction(binding, capabilityProfile),
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

export function boundThreadFallbackText(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile,
): string {
  return sharedConversationMentionInstruction(binding, capabilityProfile)
    ?? (binding.targetKind === "agent_thread"
      ? "Send a message to continue with the Agent thread."
      : "Send a message to continue the thread.");
}

export function sharedConversationMentionInstruction(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile,
): string | undefined {
  if (
    binding.channel.conversation.kind === "dm" ||
    !capabilityProfile.conversationInput?.sharedConversationRequiresMention
  ) {
    return undefined;
  }
  return capabilityProfile.conversationInput.sharedConversationMentionInstruction;
}

export function formatDefaultAgentScope(scope: MessagingDefaultAgentScope): string {
  switch (scope.kind) {
    case "conversation":
      return "conversation";
    case "parent":
      return "parent conversation";
    case "workspace":
      return "workspace";
    case "provider":
      return `${scope.channel} provider`;
    case "profile":
      return "profile";
  }
}

export function approvalResponseLabel(
  decision: MessagingApprovalDecision | undefined,
): string {
  switch (decision) {
    case "accept":
      return "Approved";
    case "accept_for_session":
      return "Approved for Session";
    case "accept_with_execpolicy_amendment":
      return "Approved and Remembered";
    case "apply_network_policy_amendment":
      return "Network Rule Applied";
    case "decline":
      return "Declined";
    case "cancel":
      return "Canceled";
    case undefined:
      return "Resolved";
  }
}

export function buildQueuedInputPreview(parts: string[]): string {
  const preview = parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return preview || "[attachment]";
}

export function isSameMessagingSurface(
  left: MessagingSurfaceRef,
  right: MessagingSurfaceRef | undefined,
): boolean {
  return Boolean(
    right
    && left.channel === right.channel
    && left.id === right.id,
  );
}

export function readBindingTarget(
  event: MessagingInboundCallbackEvent,
): {
  backend: AppServerBackendKind;
  federatedThread?: FederatedThreadRef;
  threadId: ThreadIdentifier;
} | undefined {
  const fromValue = readBindingTargetFromValue(event.value);
  if (fromValue) {
    return fromValue;
  }

  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith("bind:")) {
    return undefined;
  }
  const identity = parseThreadIdentityKey(actionId.slice("bind:".length));
  return identity?.threadId ? identity : undefined;
}

export function readBindingTargetFromValue(
  value: MessagingJsonValue | undefined,
): {
  backend: AppServerBackendKind;
  federatedThread?: FederatedThreadRef;
  threadId: ThreadIdentifier;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const backend = value.backend;
  const federationInstanceId = value.federationInstanceId;
  const threadId = value.threadId;
  if (typeof backend === "string" && isAppServerBackendKind(backend) && typeof threadId === "string") {
    return {
      backend,
      ...(typeof federationInstanceId === "string"
        ? {
            federatedThread: buildFederatedThreadRef({
              backend,
              instanceId: federationInstanceId,
              threadId,
            }),
          }
        : {}),
      threadId,
    };
  }

  return undefined;
}

export function readMessagingToolUpdateModeValue(
  value: MessagingJsonValue | undefined,
): MessagingToolUpdateMode | undefined {
  const toolUpdateMode = readStringValue(value, "toolUpdateMode");
  return (
    toolUpdateMode === "show_none" ||
      toolUpdateMode === "show_less" ||
      toolUpdateMode === "show_some" ||
      toolUpdateMode === "show_more" ||
      toolUpdateMode === "show_all"
  )
    ? toolUpdateMode
    : undefined;
}

export function readNullableStringValue(
  value: MessagingJsonValue | undefined,
  key: string,
): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = value[key];
  if (result === null) {
    return null;
  }
  return typeof result === "string" ? result : undefined;
}

export function readThreadExecutionModeValue(
  value: MessagingJsonValue | undefined,
): ThreadExecutionMode | undefined {
  const executionMode = readStringValue(value, "executionMode");
  return executionMode === "default" || executionMode === "auto" || executionMode === "full-access"
    ? executionMode
    : undefined;
}

export function readAcpRuntimeOptionSource(
  value: MessagingJsonValue | undefined,
): BackendAcpRuntimeOptionSource | undefined {
  const source = readStringValue(value, "source");
  return source === "mode" || source === "configOption" || source === "model"
    ? source
    : undefined;
}
