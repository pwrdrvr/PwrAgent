import { randomUUID } from "node:crypto";
import {
  buildThreadIdentityKey,
  isAcpBackendId,
  type ThreadPermissionTransition,
} from "@pwragent/shared/contracts/navigation";
import { findAcpPermissionModeConfigOption } from "@pwragent/shared/acp-permission-mode";
import {
  type AcpBackendId,
  type AppServerBackendKind,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  type BackendAcpRuntimeOptionSource,
  type BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import {
  type SetAcpSessionRuntimeOptionRequest,
  type SetAcpSessionRuntimeOptionResponse,
} from "@pwragent/shared/contracts/agent";
import { getMainLogger } from "../log";
import {
  acpRuntimeValueLooksPrivileged,
  formatAcpRuntimeLabel,
  mergeAcpRuntimeState,
  type AcpBackendAdapter,
  type AcpRuntimeClient,
} from "./acp-backend-adapter";
import { MAX_QUEUE_FLUSH_ATTEMPTS } from "./backend-registry-runtime-helpers";
import type { BackendRegistryOverlayStoreLike } from "./backend-registry-types";
import type { RegistryContext, RegistryHost } from "./registry-context";
import type { RegistryHostPorts } from "./registry-host-ports";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export interface AcpSessionRuntimeOptionsHost extends Pick<RegistryHostPorts, "threadHasActiveTurn"> {
  appendPermissionTransition(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    transition: ThreadPermissionTransition;
  }): Promise<void>;
}

type AcpRuntimeOptionProvider = Pick<AcpBackendAdapter, "getSession" | "getInstalledAgent" | "upsertSession"> & {
  getClientForSession(...args: Parameters<AcpBackendAdapter["getClientForSession"]>):
    Promise<Pick<AcpRuntimeClient, "ensureSession" | "setRuntimeOption">>;
};

/** Owns the runtime selection and queued provider write for each ACP session. */
export class AcpSessionRuntimeOptions {
  constructor(
    private readonly acpBackend: AcpRuntimeOptionProvider,
    private readonly overlayStore: Pick<BackendRegistryOverlayStoreLike, "setThreadExecutionMode">,
    private readonly emit: RegistryContext["emit"],
    private readonly host: RegistryHost<AcpSessionRuntimeOptionsHost>,
  ) {}

  private readonly queuedAcpRuntimeOptions = new Map<
    string,
    {
      source: BackendAcpRuntimeOptionSource;
      optionId: string;
      value: string;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
      fromValue?: string;
      fromLabel?: string;
      toLabel?: string;
    }
  >();
  private readonly queuedAcpRuntimeOptionFlushes = new Map<string, Promise<void>>();

  async setAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    if (!isAcpBackendId(params.backend)) {
      throw new Error("ACP runtime options are only available for ACP backends");
    }
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }

    const currentValue = this.readAcpRuntimeOptionValue(session.acpRuntime, params);
    if (currentValue === params.value) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        runtimeState: session.acpRuntime,
      };
    }

    if (this.host().threadHasActiveTurn(params.threadId, params.backend)) {
      await this.queueAcpSessionRuntimeOption(params, currentValue);
      return {
        backend: params.backend,
        threadId: params.threadId,
        runtimeState: session.acpRuntime,
      };
    }

    return await this.applyAcpSessionRuntimeOption(params);
  }

  private async queueAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
    fromValue: string | undefined,
  ): Promise<void> {
    if (!isAcpBackendId(params.backend)) {
      return;
    }
    const queuedAt = Date.now();
    const queueId = randomUUID();
    const queueKey = this.buildAcpRuntimeQueueKey(params.backend, params.threadId);
    const fromLabel = this.formatAcpRuntimeOptionLabel(params.backend, params, fromValue);
    const toLabel = this.formatAcpRuntimeOptionLabel(params.backend, params, params.value);
    this.queuedAcpRuntimeOptions.set(queueKey, {
      source: params.source,
      optionId: params.optionId,
      value: params.value,
      queuedAt,
      queueId,
      flushAttempts: 0,
      fromValue,
      fromLabel,
      toLabel,
    });

    await this.host().appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: acpRuntimeValueLooksPrivileged(fromValue)
          ? "full-access"
          : "default",
        toExecutionMode: acpRuntimeValueLooksPrivileged(params.value)
          ? "full-access"
          : "default",
        fromLabel,
        toLabel,
        status: "queued",
        occurredAt: queuedAt,
        queueId,
      },
    });

    backendRegistryLog.info("queued ACP runtime option change", {
      backend: params.backend,
      threadId: params.threadId,
      source: params.source,
      optionId: params.optionId,
      from: fromValue,
      to: params.value,
      queueId,
    });
  }

  private async applyAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
    options?: {
      fromQueue?: boolean;
      queueId?: string;
      fromValue?: string;
      fromLabel?: string;
      toLabel?: string;
    },
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    if (!isAcpBackendId(params.backend)) {
      throw new Error("ACP runtime options are only available for ACP backends");
    }
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }
    const client = await this.acpBackend.getClientForSession(
      params.backend,
      params.threadId,
    );
    await client.ensureSession?.(session);
    const fromValue =
      options?.fromValue ?? this.readAcpRuntimeOptionValue(session.acpRuntime, params);
    const runtimeState = this.normalizeAcpRuntimeSelectionState(
      params,
      await client.setRuntimeOption?.({
        sessionId: params.threadId,
        source: params.source,
        optionId: params.optionId,
        value: params.value,
        // Below, the requested value is recorded and broadcast as applied.
        // A thought level the client skipped was never sent, so it must fail
        // here instead, as the agent's own refusal did.
        rejectUnofferedThoughtLevel: true,
      }),
    );
    const mergedRuntime = mergeAcpRuntimeState(session.acpRuntime, runtimeState);
    const changesExecutionMode = this.isAcpRuntimeExecutionModeOption(params);
    const nextExecutionMode = changesExecutionMode
      ? acpRuntimeValueLooksPrivileged(params.value)
        ? "full-access"
        : "default"
      : session.executionMode;
    const updatedAt = Math.max(
      session.updatedAt,
      runtimeState?.updatedAt ?? Date.now(),
    );
    this.acpBackend.upsertSession({
      ...session,
      acpRuntime: mergedRuntime,
      executionMode: nextExecutionMode,
      updatedAt,
    });
    if (changesExecutionMode) {
      await this.overlayStore.setThreadExecutionMode({
        backend: params.backend,
        threadId: params.threadId,
        executionMode: nextExecutionMode ?? "default",
        updatedAt,
      });
    }

    const fromLabel =
      options?.fromLabel ??
      this.formatAcpRuntimeOptionLabel(params.backend, params, fromValue);
    const toLabel =
      options?.toLabel ??
      this.formatAcpRuntimeOptionLabel(params.backend, params, params.value);
    await this.host().appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: changesExecutionMode
          ? acpRuntimeValueLooksPrivileged(fromValue) ? "full-access" : "default"
          : session.executionMode ?? "default",
        toExecutionMode: nextExecutionMode ?? "default",
        fromLabel,
        toLabel,
        status: "applied",
        occurredAt: Date.now(),
        queueId: options?.queueId,
      },
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/acpRuntime/updated",
        params: {
          threadId: params.threadId,
          acpRuntime: mergedRuntime,
        },
      },
    });
    if (nextExecutionMode !== session.executionMode) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/executionMode/updated",
          params: {
            threadId: params.threadId,
            executionMode: nextExecutionMode,
          },
        },
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      runtimeState: mergedRuntime,
    };
  }

  async flushQueuedAcpRuntimeOptionIfPresent(
    backend: AcpBackendId,
    threadId: string,
  ): Promise<void> {
    const queueKey = this.buildAcpRuntimeQueueKey(backend, threadId);
    const activeFlush = this.queuedAcpRuntimeOptionFlushes.get(queueKey);
    if (activeFlush) {
      await activeFlush;
      return;
    }
    const queue = this.queuedAcpRuntimeOptions.get(queueKey);
    if (!queue) {
      return;
    }
    if (!this.queuedAcpRuntimeOptions.delete(queueKey)) {
      return;
    }
    const flush = this.applyClaimedQueuedAcpRuntimeOption(backend, threadId, queue);
    this.queuedAcpRuntimeOptionFlushes.set(queueKey, flush);
    try {
      await flush;
    } finally {
      if (this.queuedAcpRuntimeOptionFlushes.get(queueKey) === flush) {
        this.queuedAcpRuntimeOptionFlushes.delete(queueKey);
      }
    }
  }

  private async applyClaimedQueuedAcpRuntimeOption(
    backend: AcpBackendId,
    threadId: string,
    queue: {
      source: BackendAcpRuntimeOptionSource;
      optionId: string;
      value: string;
      queueId: string;
      flushAttempts: number;
      fromValue?: string;
      fromLabel?: string;
      toLabel?: string;
    },
  ): Promise<void> {
    try {
      await this.applyAcpSessionRuntimeOption(
        {
          backend,
          threadId,
          source: queue.source,
          optionId: queue.optionId,
          value: queue.value,
        },
        {
          fromQueue: true,
          queueId: queue.queueId,
          fromValue: queue.fromValue,
          fromLabel: queue.fromLabel,
          toLabel: queue.toLabel,
        },
      );
    } catch (error) {
      const attempts = queue.flushAttempts + 1;
      if (attempts >= MAX_QUEUE_FLUSH_ATTEMPTS) {
        await this.host().appendPermissionTransition({
          backend,
          threadId,
          transition: {
            id: randomUUID(),
            fromExecutionMode: acpRuntimeValueLooksPrivileged(queue.fromValue)
              ? "full-access"
              : "default",
            toExecutionMode: acpRuntimeValueLooksPrivileged(queue.value)
              ? "full-access"
              : "default",
            fromLabel: queue.fromLabel,
            toLabel: queue.toLabel,
            status: "cancelled",
            occurredAt: Date.now(),
            queueId: queue.queueId,
            note: `auto-cancelled after ${MAX_QUEUE_FLUSH_ATTEMPTS} failed flush attempts`,
          },
        });
        backendRegistryLog.error(
          "auto-cancelling queued ACP runtime option change after repeated failures",
          {
            backend,
            threadId,
            queueId: queue.queueId,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return;
      }
      this.queuedAcpRuntimeOptions.set(this.buildAcpRuntimeQueueKey(backend, threadId), {
        ...queue,
        queuedAt: Date.now(),
        flushAttempts: attempts,
      });
      backendRegistryLog.warn("queued ACP runtime option flush failed; will retry", {
        backend,
        threadId,
        queueId: queue.queueId,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildAcpRuntimeQueueKey(backend: AcpBackendId, threadId: string): string {
    return buildThreadIdentityKey(backend, threadId);
  }

  private readAcpRuntimeOptionValue(
    runtime: BackendAcpSessionRuntimeState | undefined,
    params: Pick<SetAcpSessionRuntimeOptionRequest, "backend" | "source" | "optionId">,
  ): string | undefined {
    if (
      params.source === "configOption" &&
      runtime?.currentModeId &&
      this.acpRuntimeConfigOptionMirrorsMode(params.backend, params.optionId)
    ) {
      return runtime.currentModeId;
    }
    if (params.source === "configOption") {
      return runtime?.configValues?.[params.optionId];
    }
    return params.source === "mode"
      ? runtime?.currentModeId
      : runtime?.currentModelId;
  }

  private normalizeAcpRuntimeSelectionState(
    params: SetAcpSessionRuntimeOptionRequest,
    runtimeState: BackendAcpSessionRuntimeState | undefined,
  ): BackendAcpSessionRuntimeState {
    const updatedAt = runtimeState?.updatedAt ?? Date.now();
    const selectedState: BackendAcpSessionRuntimeState =
      params.source === "model"
        ? {
            currentModelId: params.value,
            updatedAt,
          }
        : params.source === "mode" ||
            this.acpRuntimeConfigOptionMirrorsMode(params.backend, params.optionId)
          ? {
              configValues:
                params.source === "configOption"
                  ? { [params.optionId]: params.value }
                  : runtimeState?.configValues,
              currentModeId: params.value,
              updatedAt,
            }
          : {
              configValues: { [params.optionId]: params.value },
              updatedAt,
            };
    return mergeAcpRuntimeState(runtimeState, selectedState) ?? selectedState;
  }

  private isAcpRuntimeModeConfigOption(
    backend: AppServerBackendKind,
    optionId: string,
  ): boolean {
    if (!isAcpBackendId(backend)) {
      return false;
    }
    const agent = this.acpBackend.getInstalledAgent(backend);
    return (
      agent?.runtimeCapabilities?.configOptions?.some(
        (option) => option.id === optionId && option.category === "mode",
      ) ?? false
    );
  }

  private acpRuntimeConfigOptionMirrorsMode(
    backend: AppServerBackendKind,
    optionId: string,
  ): boolean {
    const capabilities = isAcpBackendId(backend)
      ? this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities
      : undefined;
    return this.isAcpRuntimeModeConfigOption(backend, optionId)
      && findAcpPermissionModeConfigOption(capabilities)?.id !== optionId;
  }

  private isAcpRuntimeExecutionModeOption(
    params: Pick<SetAcpSessionRuntimeOptionRequest, "backend" | "source" | "optionId">,
  ): boolean {
    const agent = isAcpBackendId(params.backend)
      ? this.acpBackend.getInstalledAgent(params.backend)
      : undefined;
    if (agent?.registryId === "grok") {
      return params.source === "configOption"
        && params.optionId === findAcpPermissionModeConfigOption(agent.runtimeCapabilities)?.id;
    }
    return (
      params.source === "mode" ||
      this.isAcpRuntimeModeConfigOption(params.backend, params.optionId)
    );
  }

  private formatAcpRuntimeOptionLabel(
    backend: AcpBackendId,
    params: Pick<SetAcpSessionRuntimeOptionRequest, "source" | "optionId">,
    value: string | undefined,
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    const runtime = this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities;
    if (params.source === "configOption") {
      const option = runtime?.configOptions?.find((item) => item.id === params.optionId);
      const label = option?.values.find((item) => item.value === value)?.label;
      return formatAcpRuntimeLabel(label ?? value);
    }
    if (params.source === "model") {
      const label = runtime?.models?.availableModels.find((model) => model.id === value)?.label;
      return formatAcpRuntimeLabel(label ?? value);
    }
    const label = runtime?.modes?.availableModes.find((mode) => mode.id === value)?.label;
    return formatAcpRuntimeLabel(label ?? value);
  }
}
