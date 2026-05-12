import { randomUUID } from "node:crypto";
import {
  resolveActiveProfileName,
} from "./profile";
import { getAppRuntimeInstanceStore } from "./state/app-state";
import type {
  AppRuntimeMessagingDisabledReason,
  AppRuntimeInstanceStore,
  MessagingRuntimeLeaseRecord,
} from "./state/app-runtime-instance-store";
import type {
  DesktopMessagingConfig,
} from "./messaging/messaging-config";
import {
  desktopMessagingConfigHasRunnableAdapters,
  type DesktopMessagingConfigLoadOptions,
} from "./messaging/messaging-config";
import type {
  DesktopMessagingConfigLoader,
  DesktopMessagingRuntime,
} from "./messaging/messaging-runtime";
import {
  resolveRuntimeMessagingOverride,
  type RuntimeMessagingOverride,
} from "./runtime-flags";
import { getMainLogger } from "./log";

export const MESSAGING_LEASE_TTL_MS = 30_000;
export const MESSAGING_LEASE_HEARTBEAT_MS = 10_000;
export const PWRAGENT_INSTANCE_ROOT_ENV = "PWRAGENT_INSTANCE_ROOT";

const leaseLog = getMainLogger("pwragent:messaging-lease");

export type RuntimeMessagingDisabledReasonKind =
  | AppRuntimeMessagingDisabledReason
  | "saved_disabled";

export type RuntimeMessagingLeaseSnapshot = {
  instanceId: string;
  disabledReasonKind?: RuntimeMessagingDisabledReasonKind;
  disabledReason?: string;
  effectiveMessagingEnabled: boolean;
  leaseHeld: boolean;
  leaseHolder?: {
    instanceId: string;
    processId?: number;
    cwdHint?: string;
    startedAt?: number;
    expiresAt: number;
  };
};

export type RuntimeMessagingLeaseApplyResult = {
  enabled: boolean;
  disabledReasonKind?: RuntimeMessagingDisabledReasonKind;
  disabledReason?: string;
  leaseHolder?: RuntimeMessagingLeaseSnapshot["leaseHolder"];
};

type RuntimeMessagingLeaseCoordinatorOptions = {
  instanceId?: string;
  profileName?: string;
  processId?: number;
  cwd?: string;
  now?: () => number;
  store?: AppRuntimeInstanceStore;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

export class RuntimeMessagingLeaseCoordinator {
  private readonly instanceId: string;
  private readonly profileName: string;
  private readonly processId: number;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly store: AppRuntimeInstanceStore;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly argv?: readonly string[];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedRecorded = false;
  private leaseHeld = false;

  constructor(options: RuntimeMessagingLeaseCoordinatorOptions = {}) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.profileName = options.profileName ?? resolveActiveProfileName();
    this.processId = options.processId ?? process.pid;
    this.cwd =
      options.cwd
      ?? options.env?.[PWRAGENT_INSTANCE_ROOT_ENV]
      ?? process.env[PWRAGENT_INSTANCE_ROOT_ENV]
      ?? process.cwd();
    this.now = options.now ?? Date.now;
    this.store = options.store ?? getAppRuntimeInstanceStore();
    this.env = options.env;
    this.argv = options.argv;
  }

  get id(): string {
    return this.instanceId;
  }

  async start(
    runtime: DesktopMessagingRuntime,
    loadConfig: DesktopMessagingConfigLoader,
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const override = resolveRuntimeMessagingOverride({
      env: this.env,
      argv: this.argv,
    });
    if (override.disabled) {
      this.recordStart({
        desiredMessagingEnabled: false,
        effectiveMessagingEnabled: false,
        disabledReason: "explicit_override",
      });
      return {
        enabled: false,
        disabledReasonKind: "explicit_override",
        ...(override.reason ? { disabledReason: override.reason } : {}),
      };
    }

    const config = await loadConfig({ logStartupEligibility: true });
    return this.applyResolvedConfig(runtime, config, { allowStart: true });
  }

  async applyLatestConfig(
    runtime: DesktopMessagingRuntime,
    loadConfig: DesktopMessagingConfigLoader,
    options: DesktopMessagingConfigLoadOptions & { allowStart?: boolean } = {},
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const config = await loadConfig({
      logStartupEligibility: options.logStartupEligibility,
      messagingEnabledOverride: options.messagingEnabledOverride,
    });
    return this.applyResolvedConfig(runtime, config, {
      allowStart: options.allowStart ?? true,
    });
  }

  async applyResolvedConfig(
    runtime: DesktopMessagingRuntime,
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const now = this.now();
    const desiredMessagingEnabled = config.enabled !== false;
    this.recordStart({
      desiredMessagingEnabled,
      effectiveMessagingEnabled: false,
      disabledReason: desiredMessagingEnabled ? undefined : "runtime_stopped",
    });

    if (config.enabled === false) {
      await this.stopRuntimeAndRelease(runtime, now, "runtime_stopped");
      return {
        enabled: false,
        disabledReasonKind: "saved_disabled",
        disabledReason: "Messaging is disabled in saved settings.",
      };
    }

    if (!desktopMessagingConfigHasRunnableAdapters(config)) {
      await this.stopRuntimeAndRelease(runtime, now, "no_runnable_adapters");
      return {
        enabled: false,
        disabledReasonKind: "no_runnable_adapters",
        disabledReason: "No messaging platforms are configured for this profile.",
      };
    }

    if (options.allowStart === false && !this.leaseHeld && !runtime.isEnabled()) {
      this.store.markDesiredMessaging({
        instanceId: this.instanceId,
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: false,
        disabledReason: "runtime_stopped",
        now,
      });
      return {
        enabled: false,
        disabledReasonKind: "runtime_stopped",
        disabledReason: "Messaging is stopped for this app instance.",
      };
    }

    const acquire = this.store.acquireMessagingLease({
      instanceId: this.instanceId,
      now,
      ttlMs: MESSAGING_LEASE_TTL_MS,
    });
    if (!acquire.acquired) {
      this.stopHeartbeat();
      await runtime.stop();
      this.leaseHeld = false;
      const leaseHolder = this.describeLeaseHolder(acquire.holder);
      return {
        enabled: false,
        disabledReasonKind: "lease_held",
        disabledReason: "Messaging is already active in another PwrAgent instance for this profile.",
        ...(leaseHolder ? { leaseHolder } : {}),
      };
    }

    this.leaseHeld = true;
    this.startHeartbeat(runtime);
    try {
      await runtime.applyConfig(config, { allowStart: true });
    } catch (error) {
      await this.releaseAfterStartupFailure(runtime, now);
      throw error;
    }
    return { enabled: runtime.isEnabled() };
  }

  async disableForSession(
    runtime: DesktopMessagingRuntime,
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const now = this.now();
    await this.stopRuntimeAndRelease(runtime, now, "runtime_stopped");
    return {
      enabled: false,
      disabledReasonKind: "runtime_stopped",
      disabledReason: "Messaging is stopped for this app instance.",
    };
  }

  async shutdown(runtime: DesktopMessagingRuntime): Promise<void> {
    const now = this.now();
    await this.stopRuntimeAndRelease(runtime, now, "runtime_stopped");
    this.store.markInstanceExited({ instanceId: this.instanceId, now });
  }

  shutdownSync(): void {
    const now = this.now();
    this.stopHeartbeat();
    if (this.leaseHeld) {
      this.store.releaseMessagingLease({ instanceId: this.instanceId, now });
    }
    this.store.markInstanceExited({ instanceId: this.instanceId, now });
    this.leaseHeld = false;
  }

  snapshot(): RuntimeMessagingLeaseSnapshot {
    const instance = this.store.getInstance(this.instanceId);
    const lease = this.store.getMessagingLease();
    const leaseHolder =
      lease
      && lease.status === "active"
      && lease.ownerInstanceId !== this.instanceId
      && lease.expiresAt > this.now()
        ? this.describeLeaseHolder(lease)
        : undefined;
    return {
      instanceId: this.instanceId,
      effectiveMessagingEnabled: instance?.effectiveMessagingEnabled ?? false,
      disabledReasonKind: instance?.disabledReason,
      ...(instance?.disabledReason
        ? { disabledReason: runtimeDisabledReasonMessage(instance.disabledReason) }
        : {}),
      leaseHeld: this.leaseHeld,
      ...(leaseHolder ? { leaseHolder } : {}),
    };
  }

  private recordStart(params: {
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled: boolean;
    disabledReason?: AppRuntimeMessagingDisabledReason;
  }): void {
    const now = this.now();
    if (this.startedRecorded) {
      this.store.markDesiredMessaging({
        instanceId: this.instanceId,
        desiredMessagingEnabled: params.desiredMessagingEnabled,
        effectiveMessagingEnabled: params.effectiveMessagingEnabled,
        disabledReason: params.disabledReason,
        now,
      });
      return;
    }
    this.store.recordInstanceStart({
      instanceId: this.instanceId,
      profileName: this.profileName,
      processId: this.processId,
      cwd: this.cwd,
      startedAt: now,
      desiredMessagingEnabled: params.desiredMessagingEnabled,
      effectiveMessagingEnabled: params.effectiveMessagingEnabled,
      disabledReason: params.disabledReason,
    });
    this.startedRecorded = true;
  }

  private async stopRuntimeAndRelease(
    runtime: DesktopMessagingRuntime,
    now: number,
    disabledReason: AppRuntimeMessagingDisabledReason,
  ): Promise<void> {
    this.stopHeartbeat();
    await runtime.stop();
    if (this.leaseHeld) {
      this.store.releaseMessagingLease({ instanceId: this.instanceId, now });
    }
    this.store.markDesiredMessaging({
      instanceId: this.instanceId,
      desiredMessagingEnabled: disabledReason !== "runtime_stopped",
      effectiveMessagingEnabled: false,
      disabledReason,
      now,
    });
    this.leaseHeld = false;
  }

  private startHeartbeat(runtime: DesktopMessagingRuntime): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const renewed = this.store.renewMessagingLease({
        instanceId: this.instanceId,
        now: this.now(),
        ttlMs: MESSAGING_LEASE_TTL_MS,
      });
      if (!renewed) {
        void this.stopRuntimeAfterLeaseLoss(runtime).catch((error) => {
          leaseLog.error("messaging runtime stop failed after lease loss", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }, MESSAGING_LEASE_HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private async releaseAfterStartupFailure(
    runtime: DesktopMessagingRuntime,
    now: number,
  ): Promise<void> {
    this.stopHeartbeat();
    try {
      await runtime.stop();
    } catch (error) {
      leaseLog.warn("messaging runtime stop failed during startup cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.leaseHeld) {
        this.store.releaseMessagingLease({ instanceId: this.instanceId, now });
      }
      this.store.markDesiredMessaging({
        instanceId: this.instanceId,
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: false,
        disabledReason: "startup_error",
        now,
      });
      this.leaseHeld = false;
    }
  }

  private async stopRuntimeAfterLeaseLoss(
    runtime: DesktopMessagingRuntime,
  ): Promise<void> {
    const now = this.now();
    this.stopHeartbeat();
    this.leaseHeld = false;
    try {
      await runtime.stop();
    } finally {
      const lease = this.store.getMessagingLease();
      const heldByAnotherInstance =
        lease
        && lease.status === "active"
        && lease.ownerInstanceId !== this.instanceId
        && lease.expiresAt > now;
      this.store.markDesiredMessaging({
        instanceId: this.instanceId,
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: false,
        disabledReason: heldByAnotherInstance ? "lease_held" : "runtime_stopped",
        now,
      });
    }
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private describeLeaseHolder(
    lease: MessagingRuntimeLeaseRecord,
  ): RuntimeMessagingLeaseSnapshot["leaseHolder"] {
    const holder = this.store.getInstance(lease.ownerInstanceId);
    return {
      instanceId: lease.ownerInstanceId,
      ...(holder?.processId ? { processId: holder.processId } : {}),
      ...(holder?.cwdHint ? { cwdHint: holder.cwdHint } : {}),
      ...(holder?.startedAt ? { startedAt: holder.startedAt } : {}),
      expiresAt: lease.expiresAt,
    };
  }
}

let coordinator: RuntimeMessagingLeaseCoordinator | null = null;

export function getRuntimeMessagingLeaseCoordinator(): RuntimeMessagingLeaseCoordinator {
  if (!coordinator) {
    coordinator = new RuntimeMessagingLeaseCoordinator();
  }
  return coordinator;
}

export function setRuntimeMessagingLeaseCoordinatorForTests(
  next: RuntimeMessagingLeaseCoordinator | null,
): void {
  coordinator = next;
}

function runtimeDisabledReasonMessage(
  reason: AppRuntimeMessagingDisabledReason,
): string {
  switch (reason) {
    case "explicit_override":
      return "Messaging is disabled for this app instance.";
    case "lease_held":
      return "Messaging is already active in another PwrAgent instance for this profile.";
    case "no_runnable_adapters":
      return "No messaging platforms are configured for this profile.";
    case "startup_error":
      return "Messaging failed during startup for this app instance.";
    case "runtime_stopped":
      return "Messaging is stopped for this app instance.";
  }
}
