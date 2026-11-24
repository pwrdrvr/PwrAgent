import { codexSpeedOptions, codexSpeedSettings, nextCodexSpeed } from "@pwragent/shared/codex-speed";
import { isAcpBackendId } from "@pwragent/shared/contracts/navigation";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendAcpSessionRuntimeState, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  NavigationLaunchpadDefaults,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { MESSAGING_CALLBACK_HANDLE_TTL_MS } from "@pwragent/messaging-interface";
import type {
  MessagingBindingRecord, MessagingCapabilityProfile, MessagingConfirmationIntent, MessagingDeliveryResult,
  MessagingInboundCallbackEvent, MessagingInboundEvent, MessagingPendingIntentRecord, MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import type { MessagingAccessControl } from "./messaging-access-control";
import { acpBackendDeclaresExecutionMode, buildMessagingAcpRuntimeModeSummary, messagingAcpRuntimeValueLooksPrivileged } from "./messaging-acp-runtime.js";
import type { MessagingBackendBridge } from "./messaging-adapter";
import { federationTargetForBinding, type MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import type { MessagingBindingService } from "./messaging-binding-service";
import {
  ACP_RUNTIME_RISK_ACTION_PREFIX, defaultBackendModel, findThreadForBinding, readAcpRuntimeOptionSource,
  readMessagingToolUpdateModeValue, readThreadExecutionModeValue, reasoningEffortsForModel,
  resolveReasoningEffortForModel, type AcpRuntimeRiskWarningContext,
} from "./messaging-callback-helpers";
import { readStringValue } from "./messaging-command-helpers";
import { resolveExecutionModeForThread, type ExecutionModeResolution } from "./messaging-inbound-helpers";
import type { MessagingInboundTurns } from "./messaging-inbound-turns";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import {
  buildStatusAcpRuntimeModePickerIntent, buildStatusModelPickerIntent, buildStatusPermissionsPickerIntent,
  buildStatusReasoningPickerIntent, buildStatusResponseModePickerIntent, buildStatusToolUpdateModePickerIntent,
  messagingToolUpdateModeChoices, nextMessagingStreamingResponseMode, resolveMessagingStreamingResponseMode,
  resolveMessagingToolUpdateMode,
} from "./messaging-status-card.js";
import type { MessagingStoreLike } from "./messaging-storage";
import type { MessagingNavigationContext, MessagingThreadContext } from "./messaging-thread-state.js";

interface MessagingThreadSettingsContext {
  readonly backend: Pick<MessagingBackendBridge, "setThreadModelSettings" | "setThreadExecutionMode" | "setAcpSessionRuntimeOption">;
  readonly store: Pick<MessagingStoreLike, "getBinding" | "getBrowseSession" | "upsertBrowseSession" | "upsertPendingIntent" | "upsertBinding">;
  readonly accessControl: Pick<MessagingAccessControl, "deliverFullAccessPolicyError" | "ensureFullAccessEscalationAllowed" | "requirePermission" | "resolveFullAccessControls" | "resolveFullAccessWarning">;
  readonly bindingService: Pick<MessagingBindingService, "clearActiveBindingSubmodeIntent" | "deliverAndStoreStatusSubmode" | "renderBindingStatus" | "resolveToolUpdateDefaultMode" | "updateBindingPreferences">;
  readonly inboundTurns: Pick<MessagingInboundTurns, "responseModeForConversation">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly streamingResponsesDefault: boolean;
  readonly now: () => number;
  readonly newIntentId: (prefix: string) => string;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly deliverInvalidStatusSelection: (event: MessagingInboundEvent) => Promise<void>;
  readonly getBackendSummary: (backend: AppServerBackendKind, federationTarget?: FederationTarget) => Promise<BackendSummary | undefined>;
  readonly readBoundThreadConfiguration: (binding: MessagingBindingRecord) => Promise<{ kind: "thread"; thread: NavigationThreadSummary; defaults: NavigationLaunchpadDefaults }>;
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number }) => Promise<MessagingPendingIntentRecord>;
}

export class MessagingThreadSettings {
  constructor(private readonly context: MessagingThreadSettingsContext) {}

  async presentModelPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    if (models.length === 0) {
      await this.context.deliver(
        buildErrorIntent({
          id: this.context.newIntentId("status-models-unavailable"),
          createdAt: this.context.now(),
          title: "Models unavailable",
          body: "This backend did not report model choices. Use /status to refresh.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const currentModelId =
      thread?.model ??
      binding.preferences?.model ??
      navigation.defaults.model ??
      models.find((model) => model.current)?.id;

    await this.context.deliver(
      buildStatusModelPickerIntent({
        id: this.context.newIntentId("status-model-picker"),
        capabilityProfile: this.context.capabilityProfile,
        binding,
        createdAt: this.context.now(),
        currentModelId,
        models,
        menuValue: event.kind === "callback" ? event.value : undefined,
      }),
      binding,
      event,
    );
  }

  async presentReasoningPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === thread?.model) ??
      models.find((model) => model.id === binding.preferences?.model) ??
      models.find((model) => model.id === navigation.defaults.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    if (summary && efforts.length === 0) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const fallbackEfforts = efforts.length > 0 ? efforts : ["low", "medium", "high"];
    const currentReasoningEffort =
      resolveReasoningEffortForModel(summary, modelOption, [
        thread?.reasoningEffort,
        binding.preferences?.reasoningEffort,
        navigation.defaults.reasoningEffort,
      ]);

    await this.context.deliver(
      buildStatusReasoningPickerIntent({
        id: this.context.newIntentId("status-reasoning-picker"),
        capabilityProfile: this.context.capabilityProfile,
        binding,
        createdAt: this.context.now(),
        currentReasoningEffort,
        efforts: fallbackEfforts,
      }),
      binding,
      event,
    );
  }

  async presentStatusAcpRuntimeModePicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const runtimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: thread?.acpRuntime ?? binding.preferences?.acpRuntime,
    });
    if (!summary || runtimeMode.choices.length === 0) {
      await this.context.deliver(
        buildErrorIntent({
          id: this.context.newIntentId("status-runtime-unavailable"),
          createdAt: this.context.now(),
          title: "Permissions unavailable",
          body: "This ACP backend did not report permissions choices. Use /status to refresh.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    await this.context.bindingService.deliverAndStoreStatusSubmode(
      buildStatusAcpRuntimeModePickerIntent({
        id: this.context.newIntentId("status-runtime-picker"),
        capabilityProfile: this.context.capabilityProfile,
        binding,
        choices: runtimeMode.choices,
        createdAt: this.context.now(),
        prompt: summary.kind === "acp:antigravity" ? "Select Agent mode" : "Select Permissions",
      }),
      binding,
      event,
    );
  }

  async presentPermissionsPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    await this.context.bindingService.deliverAndStoreStatusSubmode(
      buildStatusPermissionsPickerIntent({
        id: this.context.newIntentId("status-permissions-picker"),
        capabilityProfile: this.context.capabilityProfile,
        binding,
        createdAt: this.context.now(),
        currentMode,
      }),
      binding,
      event,
    );
  }

  async presentToolUpdateModePicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const currentMode = resolveMessagingToolUpdateMode(
      binding,
      await this.context.bindingService.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
    );
    await this.context.bindingService.deliverAndStoreStatusSubmode(
      buildStatusToolUpdateModePickerIntent({
        id: this.context.newIntentId("status-tools-picker"),
        capabilityProfile: this.context.capabilityProfile,
        binding,
        choices: messagingToolUpdateModeChoices(currentMode),
        createdAt: this.context.now(),
      }),
      binding,
      event,
    );
  }

  async presentResponseModePicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.bindingService.deliverAndStoreStatusSubmode(
      buildStatusResponseModePickerIntent({
        id: this.context.newIntentId("status-response-mode-picker"),
        capabilityProfile: this.context.capabilityProfile,
        binding,
        createdAt: this.context.now(),
        defaultMode: await this.context.inboundTurns.responseModeForConversation(binding.channel),
      }),
      binding,
      event,
    );
  }

  async setBindingModel(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const model = readStringValue(event.value, "model");
    if (!model) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }

    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption = models.find((candidate) => candidate.id === model);
    if (summary && !modelOption) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }
    let updatedBinding = await this.context.bindingService.updateBindingPreferences(binding, { model });
    const settingsResponse = await this.context.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      model,
      fastMode: updatedBinding.preferences?.fastMode,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    const reasoningEffort = settingsResponse?.reasoningEffort;
    if (
      settingsResponse &&
      reasoningEffort !== updatedBinding.preferences?.reasoningEffort
    ) {
      updatedBinding = await this.context.bindingService.updateBindingPreferences(updatedBinding, {
        reasoningEffort,
      });
    }
    const optimisticNavigation: MessagingThreadContext = {
      ...navigation,
      thread: { ...navigation.thread, model, ...(settingsResponse ? { reasoningEffort } : {}) },
    };
    await this.context.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.context.bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  async setBindingReasoning(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const reasoningEffort = readStringValue(event.value, "reasoningEffort");
    if (!reasoningEffort) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }
    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === thread?.model) ??
      models.find((model) => model.id === binding.preferences?.model) ??
      models.find((model) => model.id === navigation.defaults.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    if (summary && !efforts.includes(reasoningEffort)) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }

    const updatedBinding = await this.context.bindingService.updateBindingPreferences(binding, {
      reasoningEffort,
    });
    await this.context.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      fastMode: updatedBinding.preferences?.fastMode,
      model: updatedBinding.preferences?.model,
      reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    const optimisticNavigation: MessagingThreadContext = {
      ...navigation,
      thread: { ...navigation.thread, reasoningEffort },
    };
    await this.context.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.context.bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  async setBindingAcpRuntimeMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const source = readAcpRuntimeOptionSource(event.value);
    const optionId = readStringValue(event.value, "optionId");
    const value = readStringValue(event.value, "value");
    if (!source || !optionId || !value) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }
    if (!isAcpBackendId(binding.backend) || !this.context.backend.setAcpSessionRuntimeOption) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }

    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentRuntime = thread?.acpRuntime ?? binding.preferences?.acpRuntime;
    const runtimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: currentRuntime,
    });
    const choice = runtimeMode.choices.find(
      (candidate) =>
        candidate.source === source &&
        candidate.optionId === optionId &&
        candidate.value === value,
    );
    if (!choice) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }

    const riskContext: AcpRuntimeRiskWarningContext = {
      bindingId: binding.id,
      kind: "thread",
      label: choice.label,
      optionId,
      source,
      threadId: binding.threadId,
      value,
    };
    if (
      choice.privileged &&
      !messagingAcpRuntimeValueLooksPrivileged(runtimeMode.currentValue)
    ) {
      const allowed = await this.ensureAcpRuntimeModeAllowed(
        riskContext,
        event,
      );
      if (!allowed) {
        return;
      }
    }

    await this.applyBindingAcpRuntimeMode(binding, event, riskContext);
  }

  async applyBindingAcpRuntimeMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    selection: AcpRuntimeRiskWarningContext & { kind: "thread" },
  ): Promise<void> {
    if (!isAcpBackendId(binding.backend) || !this.context.backend.setAcpSessionRuntimeOption) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentRuntime = thread?.acpRuntime ?? binding.preferences?.acpRuntime;
    const acpRuntime: BackendAcpSessionRuntimeState = {
      ...currentRuntime,
      configValues:
        selection.source === "configOption"
          ? {
              ...(currentRuntime?.configValues ?? {}),
              [selection.optionId]: selection.value,
            }
          : currentRuntime?.configValues,
      currentModeId: selection.source === "mode" || selection.source === "configOption"
        ? selection.value
        : currentRuntime?.currentModeId,
      updatedAt: this.context.now(),
    };
    const updatedBinding = await this.context.bindingService.updateBindingPreferences(binding, {
      acpRuntime,
    });
    await this.context.backend.setAcpSessionRuntimeOption({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      source: selection.source,
      optionId: selection.optionId,
      value: selection.value,
    });
    const optimisticNavigation: MessagingThreadContext = {
      ...navigation,
      thread: { ...navigation.thread, acpRuntime },
    };
    await this.context.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.context.bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  async toggleFastMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.context.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    if (
      summary &&
      summary.kind !== "codex"
    ) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentSettings = {
      model: thread?.model ?? binding.preferences?.model,
      fastMode: thread?.fastMode ?? binding.preferences?.fastMode,
      serviceTier: thread?.fastMode !== undefined
        ? thread.serviceTier
        : thread?.serviceTier ?? binding.preferences?.serviceTier,
    };
    const models = summary?.launchpadOptions?.models ?? [];
    const model = models.find((option) => option.id === currentSettings.model)
      ?? defaultBackendModel(models);
    const speeds = codexSpeedOptions(
      model, summary?.codexFastAllowed !== false, summary?.launchpadOptions?.supportsFastMode ?? true,
    );
    if (speeds.length < 2) {
      await this.context.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const speedPatch = codexSpeedSettings(nextCodexSpeed(speeds, currentSettings));
    const updatedBinding = await this.context.bindingService.updateBindingPreferences(binding, speedPatch);
    await this.context.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      ...speedPatch,
      model: updatedBinding.preferences?.model,
      reasoningEffort: updatedBinding.preferences?.reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    // Refresh handled by the thread-state update bus.
  }

  async setBindingPermissionsMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const executionMode = readThreadExecutionModeValue(event.value);
    if (!executionMode) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }
    const navigation = await this.context.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    if (executionMode === currentMode) {
      await this.context.bindingService.clearActiveBindingSubmodeIntent(event, binding);
      await this.context.bindingService.renderBindingStatus(binding, event, navigation);
      return;
    }
    if (
      isAcpBackendId(binding.backend)
      && executionMode !== "default"
      && !acpBackendDeclaresExecutionMode(
        await this.context.getBackendSummary(
          binding.backend,
          federationTargetForBinding(binding),
        ),
        executionMode,
      )
    ) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }
    if (executionMode === "full-access") {
      const allowed = await this.context.accessControl.ensureFullAccessEscalationAllowed(
        {
          backend: binding.backend,
          binding,
          kind: "thread",
          threadId: binding.threadId,
        },
        event,
      );
      if (!allowed) {
        return;
      }
    }
    await this.context.bindingService.updateBindingPreferences(binding, {
      executionMode,
      permissionsMode: executionMode,
    });
    await this.context.bindingService.clearActiveBindingSubmodeIntent(event, binding);
    await this.context.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      executionMode,
    });
  }

  async ensureAcpRuntimeModeAllowed(
    context: AcpRuntimeRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    // RBAC double-gate: a privileged (full-access-equivalent) ACP runtime needs
    // the dedicated danger permission on top of the global Full Access toggle.
    if (
      !(await this.context.accessControl.requirePermission(
        event,
        "thread.execution.full_access",
        "execution:acp-privileged",
      ))
    ) {
      return false;
    }
    const controls = await this.context.accessControl.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.context.accessControl.deliverFullAccessPolicyError(
        context.kind === "thread"
          ? await this.context.store.getBinding(context.bindingId)
          : undefined,
        event,
        `Permissions mode ${context.label} is disabled from messaging by Full Access settings.`,
      );
      return false;
    }

    const warning = await this.context.accessControl.resolveFullAccessWarning(controls, event);
    if (!warning.shouldWarn) {
      return true;
    }

    await this.presentAcpRuntimeRiskWarning(context, event);
    return false;
  }

  private async presentAcpRuntimeRiskWarning(
    context: AcpRuntimeRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const controls = await this.context.accessControl.resolveFullAccessControls();
    const warning = await this.context.accessControl.resolveFullAccessWarning(controls, event);
    const binding =
      context.kind === "thread"
        ? await this.context.store.getBinding(context.bindingId)
        : undefined;
    const session =
      context.kind === "new-thread"
        ? await this.context.store.getBrowseSession(context.sessionId, {
            now: this.context.now(),
          })
        : undefined;
    const surface =
      context.kind === "thread"
        ? binding?.statusSurface ?? binding?.pinnedStatusSurface
        : session?.surface;
    const actions: MessagingConfirmationIntent["actions"] = [
      {
        id: `${ACP_RUNTIME_RISK_ACTION_PREFIX}accept`,
        label: "Yes",
        style: "primary",
        fallbackText: "yes",
        value: context,
      },
      ...(warning.canDismiss
        ? [
            {
              id: `${ACP_RUNTIME_RISK_ACTION_PREFIX}dismiss`,
              label: "Yes - and stop warning me",
              style: "primary" as const,
              fallbackText: "yes and stop warning me",
              value: context,
            },
          ]
        : []),
      {
        id: `${ACP_RUNTIME_RISK_ACTION_PREFIX}cancel`,
        label: "Cancel",
        style: "secondary",
        fallbackText: "cancel",
        value: context,
      },
    ];

    const intent = buildConfirmationIntent({
      id: this.context.newIntentId("acp-runtime-risk"),
      capabilityProfile: this.context.capabilityProfile,
      createdAt: this.context.now(),
      delivery: surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: `Enable ${context.label}?`,
      body: [
        `${context.label} may allow the ACP agent to run commands or edit files with fewer prompts.`,
        "Only enable it for workspaces and prompts you trust.",
      ].join("\n\n"),
      fallbackText: warning.canDismiss
        ? "Reply Yes, Yes - and stop warning me, or Cancel."
        : "Reply Yes or Cancel.",
      actions,
      targetSurface: surface,
    });
    const expiresAt =
      context.kind === "new-thread"
        ? this.context.now() + MESSAGING_CALLBACK_HANDLE_TTL_MS
        : undefined;
    if (expiresAt !== undefined && session) {
      await this.context.store.upsertBrowseSession({
        ...session,
        expiresAt: Math.max(session.expiresAt, expiresAt),
        textInputExpiresAt: session.textInputExpiresAt ?? session.expiresAt,
        updatedAt: this.context.now(),
      });
    }
    const pending = await this.context.storePendingIntent(
      intent,
      binding,
      event,
      expiresAt === undefined ? undefined : { expiresAt },
    );
    const result = await this.context.deliver(intent, binding, event);
    if (result.surface) {
      await this.context.store.upsertPendingIntent({
        ...pending,
        surface: result.surface,
      });
    }
  }

  async cycleToolUpdateMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.presentToolUpdateModePicker(binding, event);
  }

  async setToolUpdateMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const toolUpdateMode = readMessagingToolUpdateModeValue(event.value);
    if (!toolUpdateMode) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }
    const updatedBinding = await this.context.bindingService.updateBindingPreferences(binding, {
      toolUpdateMode,
    });
    await this.context.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.context.bindingService.renderBindingStatus(updatedBinding, event);
  }

  async setBindingResponseMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const selected = readStringValue(event.value, "responseMode");
    if (
      selected !== "inherit" &&
      selected !== "mention_only" &&
      selected !== "every_message"
    ) {
      await this.context.deliverInvalidStatusSelection(event);
      return;
    }
    const {
      responseMode: _previousResponseMode,
      ...preferences
    } = binding.preferences ?? { updatedAt: this.context.now() };
    const updatedBinding = await this.context.store.upsertBinding({
      ...binding,
      preferences: {
        ...preferences,
        ...(selected === "inherit" ? {} : { responseMode: selected }),
        updatedAt: this.context.now(),
      },
      updatedAt: this.context.now(),
    });
    await this.context.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.context.bindingService.renderBindingStatus(updatedBinding, event);
  }

  async cycleStreamingResponseMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const currentMode = resolveMessagingStreamingResponseMode(binding);
    const nextMode = nextMessagingStreamingResponseMode(
      currentMode,
      this.context.streamingResponsesDefault,
    );
    // Sticky-reveal: once streaming has been enabled on this thread (now, or by
    // this toggle), keep the control visible so it can be turned back on/off
    // even after the global setting hides it for other threads.
    const streamingControlRevealed =
      binding.preferences?.streamingControlRevealed ||
      currentMode === "enabled" ||
      nextMode === "enabled";
    const updatedBinding = await this.context.bindingService.updateBindingPreferences(binding, {
      streamingResponses: nextMode,
      ...(streamingControlRevealed ? { streamingControlRevealed: true } : {}),
    });
    await this.context.bindingService.renderBindingStatus(updatedBinding, event);
  }
}

function resolveExecutionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: MessagingNavigationContext,
): ExecutionModeResolution {
  return resolveExecutionModeForThread(
    binding,
    findThreadForBinding(navigation, binding),
  );
}

function executionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: MessagingNavigationContext,
): ThreadExecutionMode | undefined {
  return resolveExecutionModeForBinding(binding, navigation).mode;
}
