import { directoryForProjectSelection, resolveNewThreadWorkMode, canCreateNewThreadWorktree, resolveNewThreadBaseBranch, sanitizeBranchLabel, newThreadOptionsForSession, type NewThreadOptionsSummary, defaultBackendModel, reasoningEffortsForModel, resolveNewThreadCodexEnvironmentId, normalizeNewThreadSessionForBackend, type AcpRuntimeRiskWarningContext } from "./messaging-callback-helpers";
import { readStringValue } from "./messaging-command-helpers";
import { selectedCodexSpeed } from "@pwragent/shared/codex-speed";
import { buildMessagingModelMenuActions } from "./messaging-model-menu";
import { readMessagingLaunchpadContext, type MessagingLaunchpadDirectory, type MessagingLaunchpadContext, type MessagingNewThreadNavigation } from "./messaging-launchpad-context";
import { isAcpBackendId } from "@pwragent/shared/contracts/navigation";
import { resolveNewThreadBackend, selectableNewThreadBackends } from "@pwragent/shared/backend-selection";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendAcpSessionRuntimeState, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { MessagingToolUpdateMode } from "@pwragent/shared/contracts/messaging";
import type { UpdateDirectoryLaunchpadRequest } from "@pwragent/shared/contracts/agent";
import type { MessagingBrowseSessionRecord, MessagingInboundCallbackEvent, MessagingInboundEvent } from "@pwragent/messaging-interface";
import { MESSAGING_CALLBACK_HANDLE_TTL_MS } from "@pwragent/messaging-interface";
import { buildConfirmationIntent, buildErrorIntent } from "./messaging-renderer.js";
import { isNewAgentThreadLaunchAction, isNewThreadLaunchAction, selectProjectFromValue } from "./messaging-resume-browser.js";
import { buildNewThreadEnvironmentPickerIntent, buildBranchPickerPage, formatMessagingToolUpdateModeLabel, formatPermissionsActionDisplayLabel, formatPermissionsLineDisplayLabel, messagingToolUpdateModeChoices, shouldShowStreamingControl } from "./messaging-status-card.js";
import { acpBackendDeclaresExecutionMode, acpBackendUsesExecutionModePermissions, buildMessagingAcpRuntimeModeSummary, messagingAcpRuntimeValueLooksPrivileged } from "./messaging-acp-runtime.js";
import { DEFAULT_MESSAGING_AGENT_NAME } from "./messaging-inbound-helpers";
import type { MessagingNewThreadContext } from "./messaging-new-thread-context";
import { readNullableStringValue, readThreadExecutionModeValue, readAcpRuntimeOptionSource } from "./messaging-callback-helpers";

const NEW_THREAD_PROMPT_CAPTURE_TTL_MS = MESSAGING_CALLBACK_HANDLE_TTL_MS;

function newThreadPromptGateBody(
  session: MessagingBrowseSessionRecord,
  options: NewThreadOptionsSummary,
  backend: BackendSummary,
  toolUpdateMode: MessagingToolUpdateMode,
  showStreaming: boolean,
): string {
  const acpExecutionModePermissions =
    acpBackendUsesExecutionModePermissions(backend);
  const acpRuntimeMode = isAcpBackendId(options.backend)
    && !acpExecutionModePermissions
    ? buildMessagingAcpRuntimeModeSummary({
        backend,
        runtime: options.acpRuntime,
      })
    : undefined;
  const permissionsLabel = formatPermissionsLineDisplayLabel({
    acpRuntimeLabel: acpRuntimeMode?.currentLabel,
    current: options.executionMode,
  });
  return [
    `Send the first instruction for ${session.selectedProject?.label ?? "this project"}.`,
    "The thread will be created when that message arrives.",
    isNewAgentThreadLaunchAction(session.launchAction)
      ? `Agent: ${DEFAULT_MESSAGING_AGENT_NAME}`
      : undefined,
    `Provider: ${backend.label}`,
    `Workspace: ${options.workMode === "worktree" ? "New Worktree" : "Local"}`,
    options.workMode === "worktree" ? `Base branch: ${options.branchName}` : undefined,
    acpRuntimeMode
      || !isAcpBackendId(options.backend)
      || acpExecutionModePermissions
      || options.executionMode === "full-access"
      ? `Permissions: ${permissionsLabel}`
      : undefined,
    options.codexEnvironmentOptions.length > 0 || options.codexEnvironmentId
      ? `Environment: ${formatNewThreadEnvironmentLabel(options)}`
      : undefined,
    options.supportsModel ? `Model: ${options.model}` : undefined,
    options.supportsReasoning && options.reasoningEffort
      ? `Reasoning: ${options.reasoningEffort}`
      : undefined,
    options.supportsUltrafast
      ? `Speed: ${selectedCodexSpeed(options)}`
      : options.supportsFast ? `Fast mode: ${options.fastMode ? "on" : "off"}` : undefined,
    `Working Updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
    showStreaming
      ? `Streaming: ${options.streamingResponses ? "on" : "off"}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatNewThreadEnvironmentLabel(
  options: Pick<
    NewThreadOptionsSummary,
    "codexEnvironmentId" | "codexEnvironmentOptions"
  >,
): string {
  if (!options.codexEnvironmentId) {
    return "None";
  }
  return (
    options.codexEnvironmentOptions.find(
      (environment) => environment.id === options.codexEnvironmentId,
    )?.name ?? options.codexEnvironmentId
  );
}

function newThreadBranchChoices(
  session: MessagingBrowseSessionRecord,
  navigation: MessagingNewThreadNavigation,
  directory: MessagingLaunchpadDirectory | undefined,
): string[] {
  const defaultBranch = resolveNewThreadBaseBranch(session, navigation, directory);
  const branches = [
    defaultBranch,
    ...(directory?.gitStatus?.baseBranches ?? []),
    ...(directory?.gitStatus?.branches ?? []),
    directory?.gitStatus?.currentBranch,
  ].flatMap((branch) => {
    const sanitized = sanitizeBranchLabel(branch);
    return sanitized ? [sanitized] : [];
  });
  return branches.filter((branch, index) => branches.indexOf(branch) === index);
}

export class MessagingNewThreadWorkflow {
  constructor(private readonly context: MessagingNewThreadContext) {}

  async updateNewThreadStickySettings(
    session: MessagingBrowseSessionRecord,
    patch: UpdateDirectoryLaunchpadRequest["patch"],
    stickySettingsChanged = true,
  ): Promise<void> {
    // Remote launch choices remain in this viewer's browse session; the final
    // materialization carries them to the explicit owner.
    if (session.selectedProject?.federationTarget?.scope === "remote") return;
    const directoryKey = session.selectedProject?.directoryKey;
    if (!directoryKey || !this.context.backend.updateDirectoryLaunchpad) {
      return;
    }

    try {
      await this.context.backend.updateDirectoryLaunchpad({
        directoryKey,
        patch,
        stickySettingsChanged,
      });
    } catch (error) {
      this.context.logger.debug?.("messaging new-thread sticky launchpad update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async resolveNewThreadToolUpdateMode(
    session: MessagingBrowseSessionRecord,
    directory?: MessagingLaunchpadDirectory,
  ): Promise<MessagingToolUpdateMode> {
    if (session.preferences?.toolUpdateMode) {
      return session.preferences.toolUpdateMode;
    }
    if (isNewAgentThreadLaunchAction(session.launchAction)) {
      return await this.context.host().resolveToolUpdateDefaultMode("agent_thread");
    }
    return (
      directory?.launchpad?.messagingToolUpdateMode
      ?? await this.context.host().resolveToolUpdateDefaultMode("thread")
    );
  }

  async loadNewThreadBackendChoices(
    event: MessagingInboundEvent,
  ): Promise<{ backends: BackendSummary[]; selectable: BackendSummary[] } | undefined> {
    try {
      const response = await this.context.backend.listBackends?.({
        includeUnavailable: true,
      });
      if (!response) {
        throw new Error("backend discovery is unavailable");
      }
      const selectable = selectableNewThreadBackends(response.backends);
      if (selectable.length === 0) {
        await this.context.host().deliver(
          buildErrorIntent({
            id: this.context.host().newIntentId("new-thread-no-backends"),
            createdAt: this.context.now(),
            title: "No backends available",
            body: "No backends are available to create a thread right now.",
            recoverable: true,
          }),
          undefined,
          event,
        );
        return undefined;
      }
      return {
        backends: response.backends,
        selectable,
      };
    } catch (error) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-backends-unavailable"),
          createdAt: this.context.now(),
          title: "Backends unavailable",
          body: "Backend choices are unavailable right now. Try /new again in a moment.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      this.context.logger.debug?.("messaging new-thread backend discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async resolveNewThreadBackendForSession(
    params: {
      launchpadBackend: AppServerBackendKind;
      preferredBackend?: string;
      requirePreferred?: boolean;
      session?: MessagingBrowseSessionRecord;
    },
    event: MessagingInboundEvent,
  ): Promise<BackendSummary | undefined> {
    const choices = await this.loadNewThreadBackendChoices(event);
    if (!choices) {
      return undefined;
    }

    if (params.requirePreferred) {
      const selected = choices.selectable.find(
        (backend) => backend.kind === params.preferredBackend,
      );
      if (!selected) {
        await this.context.host().deliverInvalidBrowseSelection(event);
        return undefined;
      }
      return selected;
    }

    return resolveNewThreadBackend(
      choices.backends,
      params.session?.backend ?? params.launchpadBackend,
    );
  }

  async ensureNewThreadProjectLaunchpad(
    session: MessagingBrowseSessionRecord,
    _navigation: MessagingNewThreadNavigation,
    preferredBackend?: AppServerBackendKind,
  ): Promise<{ directory?: MessagingLaunchpadDirectory; navigation: MessagingLaunchpadContext }> {
    const navigation = await readMessagingLaunchpadContext({ backend: this.context.backend,
      project: session.selectedProject, ensureBackend: preferredBackend ?? session.backend });
    return { directory: navigation.directory, navigation };
  }

  async startNewThreadFromProject(
    event: MessagingInboundCallbackEvent,
    session: MessagingBrowseSessionRecord,
    navigation: MessagingNewThreadNavigation,
    project: NonNullable<ReturnType<typeof selectProjectFromValue>>,
  ): Promise<void> {
    if (!await this.context.host().requireRemoteScope(event, project.federationTarget, "messaging-project-create")) return;
    if (!this.context.backend.materializeDirectoryLaunchpad && !this.context.backend.startThread) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-unavailable"),
          createdAt: this.context.now(),
          title: "New thread unavailable",
          body: "This backend does not support starting a thread from messaging yet.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    navigation = await readMessagingLaunchpadContext({ backend: this.context.backend, project });
    project = { ...project, directoryKey: navigation.directory?.key ?? project.directoryKey };
    const directory = directoryForProjectSelection(navigation, project);
    const selectedBackend = await this.resolveNewThreadBackendForSession(
      {
        launchpadBackend: navigation.launchpadDefaults.backend,
        session,
      },
      event,
    );
    if (!selectedBackend) {
      return;
    }
    const workMode = resolveNewThreadWorkMode({
      requestedWorkMode:
        session.workMode ??
        directory?.launchpad?.workMode ??
        navigation.launchpadDefaults.workMode ??
        "local",
      directory,
    });
    await this.presentNewThreadPromptGate(
      normalizeNewThreadSessionForBackend(
        this.withNewThreadPromptCaptureExpiry({
          ...session,
          backend: selectedBackend.kind,
          mode: "new_thread_options",
          pageIndex: 0,
          workMode,
          branchName: workMode === "worktree" ? session.branchName : undefined,
          selectedProject: { ...project, directoryKey: directory?.key ?? project.directoryKey },
          updatedAt: this.context.now(),
          expiresAt: this.context.now() + this.context.pendingIntentTtlMs,
        }),
        selectedBackend,
        this.context.now(),
        navigation,
      ),
      event,
      navigation,
    );
  }

  withNewThreadPromptCaptureExpiry(
    session: MessagingBrowseSessionRecord,
  ): MessagingBrowseSessionRecord {
    if (
      !isNewThreadLaunchAction(session.launchAction) ||
      session.mode !== "new_thread_options" ||
      !session.selectedProject
    ) {
      return session;
    }

    const expiresAt = this.context.now() + NEW_THREAD_PROMPT_CAPTURE_TTL_MS;
    return {
      ...session,
      expiresAt: Math.max(session.expiresAt, expiresAt),
      textInputExpiresAt: Math.max(
        session.textInputExpiresAt ?? session.expiresAt,
        expiresAt,
      ),
    };
  }

  async presentNewThreadPromptGate(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    _navigation?: MessagingNewThreadNavigation,
  ): Promise<void> {
    let snapshot: MessagingNewThreadNavigation = await readMessagingLaunchpadContext({
      backend: this.context.backend, project: session.selectedProject,
    });
    const backendChoices = await this.loadNewThreadBackendChoices(event);
    if (!backendChoices) {
      return;
    }
    const selectedBackend = session.backend
      ? backendChoices.selectable.find((backend) => backend.kind === session.backend)
      : resolveNewThreadBackend(
          backendChoices.backends,
          snapshot.launchpadDefaults.backend,
    );
    if (!selectedBackend) {
      await this.deliverSelectedNewThreadBackendUnavailable(event);
      return;
    }
    const effectiveSession = normalizeNewThreadSessionForBackend(
      {
        ...session,
        backend: selectedBackend.kind,
      },
      selectedBackend,
      this.context.now(),
      snapshot,
    );
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      effectiveSession,
      snapshot,
      selectedBackend.kind,
    );
    snapshot = ensured.navigation;
    const directory = ensured.directory ?? (effectiveSession.selectedProject
      ? directoryForProjectSelection(snapshot, effectiveSession.selectedProject)
      : undefined);
    const options = newThreadOptionsForSession(
      effectiveSession,
      snapshot,
      directory,
      this.context.streamingResponsesDefault,
      selectedBackend,
    );
    const canCreateWorktree = canCreateNewThreadWorktree(directory);
    const fullAccessControls = await this.context.host().resolveFullAccessControls();
    const hasMultipleBackends = backendChoices.selectable.length > 1;
    const supportsModel = (selectedBackend.launchpadOptions?.models?.length ?? 0) > 0;
    const supportsReasoning =
      (selectedBackend.launchpadOptions?.reasoningEfforts?.length ?? 0) > 0 ||
      Boolean(
        selectedBackend.launchpadOptions?.models?.some(
          (model) => model.supportsReasoning,
        ),
      );
    const acpExecutionModePermissions =
      acpBackendUsesExecutionModePermissions(selectedBackend);
    const supportsPermissionsControls =
      !isAcpBackendId(selectedBackend.kind) ||
      acpExecutionModePermissions ||
      options.executionMode === "full-access";
    const acpRuntimeMode = isAcpBackendId(selectedBackend.kind)
      && !acpExecutionModePermissions
      ? buildMessagingAcpRuntimeModeSummary({
          backend: selectedBackend,
          runtime: options.acpRuntime,
        })
      : undefined;
    const permissionsLabel = formatPermissionsActionDisplayLabel({
      acpRuntimeLabel: acpRuntimeMode?.currentLabel,
      current: options.executionMode,
    });
    const environmentLabel = formatNewThreadEnvironmentLabel(options);
    const supportsEnvironment =
      options.codexEnvironmentOptions.length > 0 ||
      Boolean(options.codexEnvironmentId);
    const toolUpdateMode = await this.resolveNewThreadToolUpdateMode(
      effectiveSession,
      directory,
    );
    const showStreaming = shouldShowStreamingControl(
      effectiveSession.preferences?.streamingResponses ?? "inherit",
      await this.context.host().resolveShowStreamingOption(),
      effectiveSession.preferences?.streamingControlRevealed,
    );
    await this.context.store.upsertBrowseSession(effectiveSession);
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-ready"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: effectiveSession.id,
      createdAt: this.context.now(),
      delivery: effectiveSession.surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: "Ready to start",
      body: newThreadPromptGateBody(
        effectiveSession,
        options,
        selectedBackend,
        toolUpdateMode,
        showStreaming,
      ),
      fallbackText: "Send your first instruction, or use the option buttons before sending it.",
      targetSurface: effectiveSession.surface,
      actions: [
        ...(hasMultipleBackends
          ? [
              {
                id: "browse:new:backend",
                label: `Provider: ${selectedBackend.label}`,
                style: "secondary" as const,
                fallbackText: "provider",
              },
            ]
          : []),
        ...(canCreateWorktree
          ? [
              {
                id: "browse:new:workspace:toggle",
                label: `Start In: ${
                  options.workMode === "worktree" ? "New Worktree" : "Local"
                }`,
                style: "secondary" as const,
                fallbackText: "start in",
              },
            ]
          : []),
        ...(options.workMode === "worktree"
          ? [
              {
                id: "browse:new:base-branch",
                label: `Base: ${options.branchName}`,
                style: "secondary" as const,
                fallbackText: "base",
              },
            ]
          : []),
        ...(((supportsPermissionsControls &&
          (options.executionMode === "full-access" ||
            fullAccessControls.allowEscalation)) ||
          (acpRuntimeMode && acpRuntimeMode.choices.length > 0))
          ? [
              {
                id: "browse:new:permissions",
                label: `Permissions: ${permissionsLabel}`,
                style: "secondary" as const,
                fallbackText: "permissions",
              },
            ]
          : []),
        ...(supportsEnvironment
          ? [
              {
                id: "browse:new:environment",
                label: `Environment: ${environmentLabel}`,
                style: "secondary" as const,
                fallbackText: "environment",
              },
            ]
          : []),
        ...(options.supportsFast || options.supportsUltrafast
          ? [
              {
                id: "browse:new:fast",
                label: options.supportsUltrafast
                  ? `Speed: ${selectedCodexSpeed(options)}`
                  : options.fastMode ? "Fast: on" : "Fast: off",
                style: "secondary" as const,
                fallbackText: "fast",
              },
            ]
          : []),
        {
          id: "browse:new:working-updates",
          label: `Working Updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
          style: "secondary",
          fallbackText: "working updates",
        },
        ...(showStreaming
          ? [
              {
                id: "browse:new:streaming",
                label: options.streamingResponses ? "Stream: on" : "Stream: off",
                style: "secondary" as const,
                fallbackText: "stream",
              },
            ]
          : []),
        ...(supportsModel
          ? [
              {
                id: "browse:new:model",
                label: "Model",
                style: "secondary" as const,
                fallbackText: "model",
              },
            ]
          : []),
        ...(supportsReasoning && options.reasoningEffort
          ? [
              {
                id: "browse:new:reasoning",
                label: `Reasoning: ${options.reasoningEffort}`,
                style: "secondary" as const,
                fallbackText: "reasoning",
              },
            ]
          : []),
        {
          id: "browse:mode:new",
          label: "Back",
          style: "navigation",
          fallbackText: "back",
        },
        {
          id: "browse:cancel",
          label: "Cancel",
          style: "secondary",
          fallbackText: "cancel",
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (!result.surface) {
      return;
    }

    const updatedSession = {
      ...effectiveSession,
      workMode: options.workMode,
      branchName: options.workMode === "worktree" ? options.branchName : undefined,
      surface: result.surface,
      updatedAt: this.context.now(),
    };
    await this.context.store.upsertBrowseSession(updatedSession);
    await this.context.store.upsertPendingIntent({
      id: intent.id,
      channel: event.channel,
      intent,
      allowedActorIds: [event.actor.platformUserId],
      createdAt: this.context.now(),
      expiresAt: this.context.now() + this.context.pendingIntentTtlMs,
      surface: result.surface,
    });
  }

  async presentNewThreadBackendPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const choices = await this.loadNewThreadBackendChoices(event);
    if (!choices) {
      return;
    }
    const selectedBackend =
      choices.selectable.find((backend) => backend.kind === session.backend) ??
      resolveNewThreadBackend(choices.backends, navigation.launchpadDefaults.backend);
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-backend"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select provider",
      body: "Choose the provider for the new thread.",
      fallbackText: "Choose a provider, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...choices.selectable.map((backend, index) => ({
          id: "browse:new:set-backend",
          label: `${backend.label}${backend.kind === selectedBackend?.kind ? " ✓" : ""}`,
          style: backend.kind === selectedBackend?.kind
            ? "primary" as const
            : "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { backend: backend.kind },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async deliverSelectedNewThreadBackendUnavailable(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.host().deliver(
      buildErrorIntent({
        id: this.context.host().newIntentId("new-thread-selected-backend-unavailable"),
        createdAt: this.context.now(),
        title: "Backend unavailable",
        body: "The selected backend is no longer available to create a thread. Use /new to start again.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  async presentNewThreadBranchPicker(
    session: MessagingBrowseSessionRecord,
    navigation: MessagingNewThreadNavigation,
    event: MessagingInboundEvent,
    pageIndex = 0,
  ): Promise<void> {
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const branches = newThreadBranchChoices(session, navigation, directory);
    const page = buildBranchPickerPage({
      branches,
      branchActionId: "browse:new:set-base-branch",
      branchValue: (branchName) => ({ branchName }),
      capabilityProfile: this.context.capabilityProfile,
      navActionCountBase: 2,
      navActionCountMultipage: 4,
      nextActionId: "browse:new:branches:next",
      pageIndex,
      previousActionId: "browse:new:branches:previous",
    });
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-branch"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: "Pick base branch",
      body: [
        `New worktree base for ${session.selectedProject?.label ?? "this project"}.`,
        page.totalPages > 1
          ? `Page ${page.pageIndex + 1}/${page.totalPages}.`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      fallbackText: [
        "Choose a branch, or reply back.",
        ...page.branchChoices.map((choice) => choice.label),
      ].join("\n"),
      targetSurface: session.surface,
      actions: [
        ...page.branchChoices,
        ...page.pageActions,
        {
          id: "browse:new:workspace:worktree",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
        {
          id: "browse:cancel",
          label: "Cancel",
          style: "secondary" as const,
          fallbackText: "cancel",
          priority: 2,
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async presentNewThreadModelPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    backend: AppServerBackendKind,
  ): Promise<void> {
    const summary = await this.context.host().getBackendSummary(backend);
    const models = summary?.launchpadOptions?.models ?? [];
    if (models.length === 0) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-models-unavailable"),
          createdAt: this.context.now(),
          title: "Models unavailable",
          body: "This backend did not report model choices.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-model"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select model",
      body: "Choose the model for the new thread.",
      fallbackText: "Choose a model, or reply back.",
      targetSurface: session.surface,
      actions: buildMessagingModelMenuActions({
        kind: backend,
        models,
        menuValue: event.kind === "callback" ? event.value : undefined,
        menuActionId: "browse:new:model",
        selectActionId: "browse:new:set-model",
        capabilityProfile: this.context.capabilityProfile,
        backAction: {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      }),
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async presentNewThreadAcpRuntimeModePicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    backend: AppServerBackendKind,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const summary = await this.context.host().getBackendSummary(backend);
    if (!summary) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-runtime-unavailable"),
          createdAt: this.context.now(),
          title: "Permissions unavailable",
          body: "This ACP backend did not report permissions choices.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const options = newThreadOptionsForSession(
      session,
      navigation,
      directory,
      this.context.streamingResponsesDefault,
      summary,
    );
    const runtimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: options.acpRuntime,
    });
    if (runtimeMode.choices.length === 0) {
      await this.context.host().deliver(
        buildErrorIntent({
          id: this.context.host().newIntentId("new-thread-runtime-unavailable"),
          createdAt: this.context.now(),
          title: "Permissions unavailable",
          body: "This ACP backend did not report permissions choices.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-runtime"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select permissions",
      body: "Choose the permissions mode for the new thread.",
      fallbackText: "Choose a permissions option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...runtimeMode.choices.map((choice, index) => ({
          id: "browse:new:set-runtime-mode",
          label: `${choice.label}${choice.selected ? " (current)" : ""}`,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: {
            optionId: choice.optionId,
            source: choice.source,
            value: choice.value,
          },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async presentNewThreadPermissionsPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const backend = await this.resolveNewThreadBackendForSession(
      {
        launchpadBackend: navigation.launchpadDefaults.backend,
        preferredBackend: session.backend,
        session,
      },
      event,
    );
    const currentMode = backend
      ? newThreadOptionsForSession(
          session,
          navigation,
          directory,
          this.context.streamingResponsesDefault,
          backend,
        ).executionMode
      : session.preferences?.executionMode ?? "default";
    const choices: Array<{ label: string; mode: ThreadExecutionMode }> = [
      { label: "Default", mode: "default" },
      { label: "Full Access", mode: "full-access" },
    ];
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-permissions"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select permissions",
      body: "Choose the permissions mode for the new thread.",
      fallbackText: "Choose a permissions option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...choices.map((choice, index) => ({
          id: "browse:new:set-permissions",
          label: `${choice.label}${choice.mode === currentMode ? " (current)" : ""}`,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { executionMode: choice.mode },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async setNewThreadPermissions(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundCallbackEvent,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const executionMode = readThreadExecutionModeValue(event.value);
    if (!executionMode) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const currentMode =
      session.preferences?.executionMode ??
      directory?.launchpad?.executionMode ??
      navigation.launchpadDefaults.executionMode;
    if (executionMode === currentMode) {
      await this.presentNewThreadPromptGate(session, event, navigation);
      return;
    }
    const backendKind = session.backend ?? navigation.launchpadDefaults.backend;
    if (
      isAcpBackendId(backendKind)
      && executionMode !== "default"
      && !acpBackendDeclaresExecutionMode(
        await this.context.host().getBackendSummary(backendKind),
        executionMode,
      )
    ) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }
    if (executionMode === "full-access") {
      const allowed = await this.context.host().ensureFullAccessEscalationAllowed(
        { kind: "new-thread", session },
        event,
      );
      if (!allowed) {
        return;
      }
    }
    await this.updateNewThreadStickySettings(session, {
      executionMode,
    });
    await this.presentNewThreadPromptGate(
      {
        ...session,
        preferences: {
          ...session.preferences,
          executionMode,
          permissionsMode: executionMode,
          updatedAt: this.context.now(),
        },
      },
      event,
      navigation,
    );
  }

  async presentNewThreadEnvironmentPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      session,
      navigation,
      session.backend ?? navigation.launchpadDefaults.backend,
    );
    const directory = ensured.directory ?? (session.selectedProject
      ? directoryForProjectSelection(ensured.navigation, session.selectedProject)
      : undefined);
    const options = directory?.launchpad?.codexEnvironmentOptions ?? [];
    const currentEnvironmentId = resolveNewThreadCodexEnvironmentId(
      session,
      directory?.launchpad,
    );
    if (options.length === 0 && !currentEnvironmentId) {
      await this.presentNewThreadPromptGate(session, event, navigation);
      return;
    }
    const intent = buildNewThreadEnvironmentPickerIntent({
      id: this.context.host().newIntentId("new-thread-environment"),
      browseSessionId: session.id,
      capabilityProfile: this.context.capabilityProfile,
      createdAt: this.context.now(),
      currentEnvironmentId,
      options,
      targetSurface: session.surface,
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async setNewThreadEnvironment(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundCallbackEvent,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      session,
      navigation,
      session.backend ?? navigation.launchpadDefaults.backend,
    );
    const directory = ensured.directory ?? (session.selectedProject
      ? directoryForProjectSelection(ensured.navigation, session.selectedProject)
      : undefined);
    const environmentId = readNullableStringValue(event.value, "environmentId");
    if (environmentId === undefined) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }
    const environment = environmentId === null
      ? undefined
      : directory?.launchpad?.codexEnvironmentOptions?.find(
          (candidate) => candidate.id === environmentId,
        );
    if (environmentId !== null && !environment) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }
    const codexEnvironmentActionId =
      environment && directory?.launchpad?.codexEnvironmentId === environment.id
        ? directory.launchpad.codexEnvironmentActionId
        : undefined;
    await this.updateNewThreadStickySettings(session, {
      codexEnvironmentId: environment?.id,
      codexEnvironmentExecutionTarget: environment ? "local" : undefined,
      codexEnvironmentActionId,
    });
    await this.presentNewThreadPromptGate(
      {
        ...session,
        preferences: {
          ...session.preferences,
          codexEnvironmentId: environment?.id ?? null,
          codexEnvironmentExecutionTarget: environment ? "local" : undefined,
          codexEnvironmentActionId: codexEnvironmentActionId ?? null,
          updatedAt: this.context.now(),
        },
      },
      event,
      ensured.navigation,
    );
  }

  async setNewThreadAcpRuntimeMode(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundCallbackEvent,
    navigation: MessagingNewThreadNavigation,
  ): Promise<void> {
    const source = readAcpRuntimeOptionSource(event.value);
    const optionId = readStringValue(event.value, "optionId");
    const value = readStringValue(event.value, "value");
    if (!source || !optionId || !value) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }

    const backend = session.backend ?? navigation.launchpadDefaults.backend;
    const summary = await this.context.host().getBackendSummary(backend);
    if (!summary) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const options = newThreadOptionsForSession(
      session,
      navigation,
      directory,
      this.context.streamingResponsesDefault,
      summary,
    );
    const currentRuntime = options.acpRuntime;
    const currentRuntimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: currentRuntime,
    });
    const choice = currentRuntimeMode.choices.find(
      (candidate) =>
        candidate.source === source &&
        candidate.optionId === optionId &&
        candidate.value === value,
    );
    if (!choice) {
      await this.context.host().deliverInvalidBrowseSelection(event);
      return;
    }

    const riskContext: AcpRuntimeRiskWarningContext = {
      kind: "new-thread",
      label: choice.label,
      optionId,
      sessionId: session.id,
      source,
      value,
    };
    if (
      choice.privileged &&
      !messagingAcpRuntimeValueLooksPrivileged(currentRuntimeMode.currentValue)
    ) {
      const allowed = await this.context.host().ensureAcpRuntimeModeAllowed(
        riskContext,
        event,
      );
      if (!allowed) {
        return;
      }
    }

    await this.applyNewThreadAcpRuntimeMode(session, event, navigation, riskContext);
  }

  async applyNewThreadAcpRuntimeMode(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: MessagingNewThreadNavigation,
    selection: AcpRuntimeRiskWarningContext & { kind: "new-thread" },
  ): Promise<void> {
    const backend = session.backend ?? navigation.launchpadDefaults.backend;
    const summary = await this.context.host().getBackendSummary(backend);
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const currentRuntime = summary
      ? newThreadOptionsForSession(
          session,
          navigation,
          directory,
          this.context.streamingResponsesDefault,
          summary,
        ).acpRuntime
      : session.preferences?.acpRuntime;
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
    const executionMode = messagingAcpRuntimeValueLooksPrivileged(selection.value)
      ? "full-access"
      : "default";
    await this.updateNewThreadStickySettings(session, {
      acpRuntime,
      executionMode,
    });
    await this.presentNewThreadPromptGate(
      {
        ...session,
        preferences: {
          ...session.preferences,
          acpRuntime,
          executionMode,
          permissionsMode: executionMode,
          updatedAt: this.context.now(),
        },
      },
      event,
      navigation,
    );
  }

  async presentNewThreadReasoningPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    backend: AppServerBackendKind,
  ): Promise<void> {
    const summary = await this.context.host().getBackendSummary(backend);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === session.preferences?.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    const fallbackEfforts = efforts.length > 0 ? efforts : ["low", "medium", "high"];
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-reasoning"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select reasoning",
      body: "Choose the reasoning effort for the new thread.",
      fallbackText: "Choose a reasoning option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...fallbackEfforts.map((effort, index) => ({
          id: "browse:new:set-reasoning",
          label: effort,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { reasoningEffort: effort },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }

  async presentNewThreadWorkingUpdatesPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    currentMode: MessagingToolUpdateMode,
  ): Promise<void> {
    const intent = buildConfirmationIntent({
      id: this.context.host().newIntentId("new-thread-working-updates"),
      capabilityProfile: this.context.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.context.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Working Updates",
      body:
        "How much of the agent's in-progress work is bridged to this chat.\n\n"
        + "None: only final answers and questions.\n"
        + "Less / Some / More: coalesced batches that respect platform rate limits.\n"
        + "All: the most (the rate budget may still hold some back).",
      fallbackText: "Choose a Working Updates option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...messagingToolUpdateModeChoices(currentMode).map((choice, index) => ({
          id: "browse:new:set-working-updates",
          label: `${choice.label}${choice.current ? " (current)" : ""}`,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { toolUpdateMode: choice.mode },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.context.host().storePendingIntent(intent, undefined, event);
    const result = await this.context.host().deliver(intent, undefined, event);
    if (result.surface) {
      await this.context.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.context.now(),
      });
    }
  }
}
