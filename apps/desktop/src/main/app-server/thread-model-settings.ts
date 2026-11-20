import { buildThreadIdentityKey, isAcpBackendId } from "@pwragent/shared/contracts/navigation";
import {
  parseCodexProviderModelId,
  type CodexModelProviderSettings,
} from "@pwragent/shared/codex-model-providers";
import { providerPickerValue } from "@pwragent/shared/provider-picker";
import { type AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import {
  type ApplyThreadModelMigrationRequest,
  type ApplyThreadModelMigrationResponse,
  type SetThreadModelSettingsRequest,
  type SetThreadModelSettingsResponse,
} from "@pwragent/shared/contracts/agent";
import {
  type DesktopProviderModelDefaults,
  type DesktopProviderThreadModelMigration,
} from "@pwragent/shared/contracts/settings";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import { findAcpModelConfigOption, findAcpThoughtLevelConfigOption, type AcpBackendAdapter } from "./acp-backend-adapter";
import type { BackendClient, ModelSettings } from "./backend-registry-types";
import type { RegistryContext, RegistryHost } from "./registry-context";
import type { RegistryHostPorts } from "./registry-host-ports";
import type { ThreadInfoStore } from "./thread-info-store";
import { assertThreadModelSettingsAvailable } from "./thread-model-admission";
import { executionModeQueueKey } from "./thread-turn-keys";

export interface ThreadModelSettingsHost extends Pick<RegistryHostPorts,
  "findThreadForWorkspaceHandoff" | "getBackendLaunchpadOptions" | "resolveModelSettings" | "threadHasActiveTurn"
> {
  readonly acpSessionPromptLocks: Pick<PerKeyAsyncLock, "run">;
  readonly threadInfoStore: Pick<ThreadInfoStore, "getSummary">;
}

type ThreadModelSettingsConfiguration = {
  resolveProviderModelDefaultsFn(): Record<string, DesktopProviderModelDefaults>;
  resolveProviderThreadModelMigrationsFn(): Record<string, DesktopProviderThreadModelMigration>;
  resolveCodexModelProvidersFn(): CodexModelProviderSettings[];
};

/** Owns the thread model mutation and migration queue. */
export class ThreadModelSettings {
  private readonly threadModelSettingsLocks = new PerKeyAsyncLock();

  constructor(
    private readonly overlayStore: Pick<RegistryContext["stores"]["threads"], "getThreadOverlayState" | "setThreadModelSettings">,
    private readonly codexClient: Pick<BackendClient, "modelProviderForThread" | "readThreadModelSettings" | "reportedModelProviderForThread">,
    private readonly acpBackend: Pick<AcpBackendAdapter, "getClientForSession" | "getInstalledAgent" | "getSession">,
    private readonly configuration: ThreadModelSettingsConfiguration,
    private readonly emit: RegistryContext["emit"],
    private readonly host: RegistryHost<ThreadModelSettingsHost>,
  ) {}

  async setThreadModelSettings(
    params: SetThreadModelSettingsRequest
  ): Promise<SetThreadModelSettingsResponse> {
    const modelSettingsManuallyUpdatedAt =
      "model" in params || "reasoningEffort" in params
        ? Date.now()
        : undefined;
    return await this.threadModelSettingsLocks.run(
      buildThreadIdentityKey(params.backend, params.threadId),
      async () => {
        const observedCodexSettings = await this.assertRequestedThreadModelAvailable(params);
        return await this.setThreadModelSettingsInternal(
          params,
          modelSettingsManuallyUpdatedAt === undefined ? {} : { modelSettingsManuallyUpdatedAt },
          observedCodexSettings,
        );
      },
    );
  }

  private async setThreadModelSettingsInternal(
    params: SetThreadModelSettingsRequest,
    metadata: {
      modelMigrationRevision?: string;
      modelSettingsManuallyUpdatedAt?: number;
    },
    observedCodexSettings?: { model?: string; reasoningEffort?: string },
  ): Promise<SetThreadModelSettingsResponse> {
    const identity = {
      backend: params.backend,
      threadId: params.threadId,
    };
    const current = await this.overlayStore.getThreadOverlayState(identity);
    const acpBackend = isAcpBackendId(params.backend) ? params.backend : undefined;
    const requestedModel = params.model;
    const hasExplicitEffort = "reasoningEffort" in params;
    // Older or externally created threads may lack a PwrAgent model overlay.
    const needsProviderSettings = !hasExplicitEffort && (
      current?.model === undefined
      || (requestedModel !== undefined && requestedModel !== current.model && current.reasoningEffort === undefined)
    );
    const liveCodexSettings = needsProviderSettings && params.backend === "codex"
      ? observedCodexSettings ?? await this.codexClient.readThreadModelSettings?.({ threadId: params.threadId })
        .catch(() => undefined)
      : undefined;
    const acpRuntime = needsProviderSettings && acpBackend
      ? this.acpBackend.getSession(acpBackend, params.threadId)?.acpRuntime
      : undefined;
    const acpCapabilities = acpRuntime && acpBackend
      ? this.acpBackend.getInstalledAgent(acpBackend)?.runtimeCapabilities
      : undefined;
    const acpModelOption = findAcpModelConfigOption(acpCapabilities);
    const acpEffortOption = findAcpThoughtLevelConfigOption(acpCapabilities);
    const cachedSettings = needsProviderSettings ? this.host().threadInfoStore.getSummary(identity) : undefined;
    const acpModel = (acpModelOption && acpRuntime?.configValues?.[acpModelOption.id])
      ?? acpRuntime?.currentModelId;
    const currentModel = current?.model
      ?? liveCodexSettings?.model
      ?? acpModel
      ?? cachedSettings?.model;
    // A provider can still report the previous model until the next turn.
    // Use an observed effort only if its source model matches the current one.
    const currentEffort = current?.reasoningEffort
      ?? (currentModel === undefined ? undefined
        : (liveCodexSettings?.model === currentModel ? liveCodexSettings.reasoningEffort : undefined)
          ?? (acpModel === currentModel
            ? (acpEffortOption && acpRuntime?.configValues?.[acpEffortOption.id]) ?? acpRuntime?.reasoningEffort
            : undefined)
          ?? (cachedSettings?.model === currentModel ? cachedSettings.reasoningEffort : undefined));
    const modelChanged =
      requestedModel !== undefined && requestedModel !== currentModel;
    let fallbackReasoningEfforts: ModelSettings["fallbackReasoningEfforts"];
    if (modelChanged && !hasExplicitEffort) {
      const providerKey = providerPickerValue(params.backend, requestedModel);
      const configured = this.configuration.resolveProviderModelDefaultsFn()[providerKey];
      fallbackReasoningEfforts = [
        configured?.reasoningEffortsByModel[requestedModel],
        currentEffort,
      ];
    }
    const modelSettings = await this.host().resolveModelSettings(
      params.backend,
      {
        model: "model" in params ? params.model : currentModel,
        reasoningEffort:
          hasExplicitEffort
            ? params.reasoningEffort
            : modelChanged
              ? undefined
              : currentEffort,
        reasoningEffortsByModel: current?.reasoningEffortsByModel,
        fallbackReasoningEfforts,
        serviceTier:
          "serviceTier" in params
            ? params.serviceTier
            : "fastMode" in params
              ? undefined
              : current?.serviceTier,
        fastMode: "fastMode" in params ? params.fastMode : current?.fastMode,
      },
      "settings-refresh",
    );
    const acpRuntimeModelChanged =
      modelSettings.model !== current?.model ||
      modelSettings.reasoningEffort !== current?.reasoningEffort;
    const persistModelSettings = async (): Promise<void> => {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: params.threadId,
        ...modelSettings,
        ...metadata,
      });
    };
    if (acpBackend && modelSettings.model && acpRuntimeModelChanged) {
      const runtimeModel = modelSettings.model;
      await this.host().acpSessionPromptLocks.run(
        executionModeQueueKey(acpBackend, params.threadId),
        async () => {
          if (!this.host().threadHasActiveTurn(params.threadId, acpBackend)) {
            const session = this.acpBackend.getSession(
              acpBackend,
              params.threadId,
            );
            if (!session) {
              throw new Error(`ACP session not found: ${params.threadId}`);
            }
            const client = await this.acpBackend.getClientForSession(
              acpBackend,
              params.threadId,
            );
            await client.ensureSession?.(session);
            await client.setRuntimeOption?.({
              sessionId: params.threadId,
              source: "model",
              optionId: "model",
              value: runtimeModel,
              reasoningEffort: modelSettings.reasoningEffort,
            });
          }
          await persistModelSettings();
        },
      );
    } else {
      await persistModelSettings();
    }

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/modelSettings/updated",
        params: {
          threadId: params.threadId,
          ...modelSettings,
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      ...modelSettings,
    };
  }

  async applyThreadModelMigration(
    params: ApplyThreadModelMigrationRequest,
  ): Promise<ApplyThreadModelMigrationResponse> {
    // Keep the eligibility check and revision write in the same queue as
    // manual model settings, including speed changes that read the provider.
    return await this.threadModelSettingsLocks.run(
      buildThreadIdentityKey(params.backend, params.threadId),
      () => this.applyThreadModelMigrationInternal(params),
    );
  }

  private async applyThreadModelMigrationInternal(
    params: ApplyThreadModelMigrationRequest,
  ): Promise<ApplyThreadModelMigrationResponse> {
    const current = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const migrations = this.configuration.resolveProviderThreadModelMigrationsFn();
    const providerSummary = params.backend === "codex"
      && !current?.model && !params.threadModel && Object.keys(migrations).length > 0
      ? await this.host().findThreadForWorkspaceHandoff({
          backend: params.backend, threadId: params.threadId, callerReason: "thread-model-migration",
        })
      : undefined;
    const providerKey = providerPickerValue(params.backend, current?.model ?? params.threadModel ?? providerSummary?.model);
    const migration = migrations[providerKey];
    if (!migration || providerPickerValue(params.backend, migration.model) !== providerKey) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "none",
      };
    }

    if (current?.modelMigrationRevision === migration.revision) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "already-applied",
        revision: migration.revision,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
      };
    }

    if (
      current?.modelSettingsManuallyUpdatedAt !== undefined
      && current.modelSettingsManuallyUpdatedAt >= migration.createdAt
    ) {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: params.threadId,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        serviceTier: current.serviceTier,
        fastMode: current.fastMode,
        modelMigrationRevision: migration.revision,
        modelSettingsManuallyUpdatedAt:
          current.modelSettingsManuallyUpdatedAt,
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "acknowledged-manual-change",
        revision: migration.revision,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
      };
    }

    const migrationUsesSourceFilter =
      migration.sourceModels !== undefined
      || migration.includeThreadsWithoutModel === true;
    const needsThreadSummary =
      params.threadCreatedAt === undefined
      || (
        migrationUsesSourceFilter
        && current?.model === undefined
        && params.threadModel === undefined
      );
    const threadSummary = providerSummary ?? (needsThreadSummary
      ? await this.host().findThreadForWorkspaceHandoff({
          backend: params.backend,
          callerReason: "thread-model-migration",
          threadId: params.threadId,
        })
      : undefined);
    const threadCreatedAt =
      params.threadCreatedAt ?? threadSummary?.createdAt;
    if (threadCreatedAt === undefined) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "metadata-unavailable",
        revision: migration.revision,
        model: current?.model,
        reasoningEffort: current?.reasoningEffort,
      };
    }

    if (threadCreatedAt > migration.createdAt) {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: params.threadId,
        model: current?.model,
        reasoningEffort: current?.reasoningEffort,
        serviceTier: current?.serviceTier,
        fastMode: current?.fastMode,
        modelMigrationRevision: migration.revision,
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "acknowledged-new-thread",
        revision: migration.revision,
        model: current?.model,
        reasoningEffort: current?.reasoningEffort,
      };
    }

    const sourceModel =
      current?.model
      ?? params.threadModel
      ?? threadSummary?.model;
    const sourceModelSelected =
      !migrationUsesSourceFilter
      || (
        sourceModel
          ? migration.sourceModels?.includes(sourceModel) === true
          : migration.includeThreadsWithoutModel === true
      );
    if (!sourceModelSelected) {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: params.threadId,
        model: current?.model,
        reasoningEffort: current?.reasoningEffort,
        serviceTier: current?.serviceTier,
        fastMode: current?.fastMode,
        modelMigrationRevision: migration.revision,
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "acknowledged-source-model",
        revision: migration.revision,
        model: current?.model ?? sourceModel,
        reasoningEffort: current?.reasoningEffort,
      };
    }

    const resolved = await this.host().resolveModelSettings(
      params.backend,
      {
        model: migration.model,
        reasoningEffort: migration.reasoningEffort,
      },
      "settings-refresh",
    );
    if (
      resolved.model !== migration.model
      || (
        migration.reasoningEffort !== undefined
        && resolved.reasoningEffort !== migration.reasoningEffort
      )
    ) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        status: "unavailable",
        revision: migration.revision,
        model: migration.model,
        reasoningEffort: migration.reasoningEffort,
      };
    }

    const response = await this.setThreadModelSettingsInternal(
      {
        backend: params.backend,
        threadId: params.threadId,
        model: migration.model,
        reasoningEffort: resolved.reasoningEffort,
      },
      {
        modelMigrationRevision: migration.revision,
      },
    );
    return {
      ...response,
      status: "applied",
      revision: migration.revision,
    };
  }

  async assertRequestedThreadModelAvailable(params: {
    backend: AppServerBackendKind;
    threadId: string;
    model?: string;
  }): Promise<{ model?: string; reasoningEffort?: string } | undefined> {
    if (params.model === undefined) return;
    assertThreadModelSettingsAvailable(params.backend,
      await this.host().getBackendLaunchpadOptions(params.backend, "model-override-admission"),
      { model: params.model });
    if (params.backend === "codex") {
      let observedCodexSettings: { model?: string; reasoningEffort?: string } | undefined;
      if (this.configuration.resolveCodexModelProvidersFn().length > 0
        && this.codexClient.reportedModelProviderForThread
        && !this.codexClient.reportedModelProviderForThread(params.threadId)) {
        observedCodexSettings = await this.codexClient.readThreadModelSettings?.({ threadId: params.threadId }) ?? {};
      }
      this.assertCodexModelKeepsThreadProvider(params.threadId, params.model);
      return observedCodexSettings;
    }
  }

  /**
   * Codex fixes a thread's model provider when the thread starts; turn/start
   * cannot change it. A model from another provider would fail on the next
   * turn, after the operator had moved on, so refuse it here with the way out.
   */
  private assertCodexModelKeepsThreadProvider(threadId: string, model: string): void {
    const threadProvider = this.codexClient.modelProviderForThread?.(threadId);
    const requestedProvider = parseCodexProviderModelId(model).providerId;
    if (threadProvider === requestedProvider) return;
    const providers = this.configuration.resolveCodexModelProvidersFn();
    const label = (id: string | undefined): string =>
      id ? providers.find((provider) => provider.id === id)?.name ?? id : "Codex's default provider";
    throw new Error(
      `This thread runs on ${label(threadProvider)}, so it cannot switch to a ${label(requestedProvider)} model. `
      + "Hand the thread off to a new thread to use that model.",
    );
  }
}
